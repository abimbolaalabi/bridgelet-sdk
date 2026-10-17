import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as StellarSdk from '@stellar/stellar-sdk';
import { rpc as SorobanRpc } from '@stellar/stellar-sdk';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Histogram } from 'prom-client';

export const EXPIRY_BUFFER_LEDGERS = 10;

/**
 * #827: base funding for a fresh ephemeral account, and the additional base
 * reserve the network charges for the trustline an issued-asset account needs.
 * Stellar's current base reserve is 0.5 XLM per ledger entry.
 */
export const EPHEMERAL_ACCOUNT_BASE_BALANCE = '2';
export const TRUSTLINE_BASE_RESERVE = '0.5';

@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  private server: StellarSdk.Horizon.Server;
  private sorobanServer: SorobanRpc.Server;
  private network: string;

  constructor(
    private configService: ConfigService,
    @InjectMetric('soroban_rpc_latency_seconds')
    private readonly sorobanRpcLatency: Histogram<string>,
  ) {
    const horizonUrl =
      this.configService.getOrThrow<string>('stellar.horizonUrl');
    const sorobanRpcUrl = this.configService.getOrThrow<string>(
      'stellar.sorobanRpcUrl',
    );
    this.network = this.configService.getOrThrow<string>('stellar.network');
    this.server = new StellarSdk.Horizon.Server(horizonUrl);
    this.sorobanServer = new SorobanRpc.Server(sorobanRpcUrl);

    this.logger.log(`Initialized Stellar service for ${this.network}`);
  }

  /**
   * Fetches the current ledger sequence number from Horizon.
   * Used to convert wall-clock expiry times to ledger-based expiry
   * required by EphemeralAccount.initialize() on-chain.
   *
   * Stellar closes a ledger approximately every 5 seconds.
   * Conversion: expiry_ledger = current_ledger + Math.ceil(expiresInSeconds / 5)
   */
  async getCurrentLedger(): Promise<number> {
    const ledgerPage = await this.server
      .ledgers()
      .order('desc')
      .limit(1)
      .call();

    const sequence = ledgerPage.records[0].sequence;
    this.logger.debug(`Current ledger sequence: ${sequence}`);
    return sequence;
  }

  /**
   * Converts a seconds-based expiry duration to a Stellar ledger sequence number.
   * Adds a small buffer (10 ledgers) to account for submission latency.
   *
   * Expiry split: the contract enforces expiry on-chain via this ledger value
   * (authoritative). The DB-side `expiresAt` (computed in AccountsService from the
   * same `expiresIn`) is deliberately not passed here; it only drives the
   * SchedulerService sweep that triggers `expireAccount()` and updates DB status.
   */
  async toExpiryLedger(expiresInSeconds: number): Promise<number> {
    const currentLedger = await this.getCurrentLedger();
    return (
      currentLedger + Math.ceil(expiresInSeconds / 5) + EXPIRY_BUFFER_LEDGERS
    );
  }

  /**
   * Generates the ephemeral account keypair.
   *
   * ## Randomness source (audited, #654, #715, re-confirmed #868)
   *
   * This returns the actual secret key for an account that will hold funds, so
   * the entropy source matters. Keypair.random() uses a CSPRNG and no intermediate
   * helper in this codebase substitutes a weaker RNG. The full chain, verified against
   * the installed dependency tree, is:
   *
   *   StellarSdk.Keypair.random()                  @stellar/stellar-base
   *     -> ed25519.utils.randomPrivateKey()        @noble/curves/ed25519
   *       -> randomSecretKey(seed = randomBytes(32))
   *         -> randomBytes()                       @noble/hashes/utils
   *           -> crypto.getRandomValues()          Web Crypto CSPRNG
   *
   * `@noble/hashes` falls back to Node's `crypto.randomBytes()` on older
   * runtimes and otherwise **throws** (`'crypto.getRandomValues must be
   * defined'`). It never silently degrades to a weaker generator, so there is
   * no path here that yields predictable key material.
   *
   * No intermediate helper in this codebase substitutes its own RNG: this method
   * delegates straight to the SDK, and `Math.random()` appears nowhere in the
   * key-generation path. `stellar.service.spec.ts` asserts that, so a future
   * change that introduces one fails the suite rather than shipping quietly.
   *
   * If this ever needs to become deterministic for tests, inject a seed
   * explicitly rather than swapping the generator - `Keypair.fromRawEd25519Seed()`
   * is the supported way in.
   */
  generateKeypair(): StellarSdk.Keypair {
    return StellarSdk.Keypair.random();
  }

  /**
   * Creates a funded ephemeral Stellar account, deploys a dedicated
   * EphemeralAccount contract instance for it and initializes that instance
   * with expiry and recovery restrictions.
   *
   * The three operations are:
   * 1. Horizon: CreateAccount operation (funds the account with base reserve)
   * 2. Soroban: contract deployment (new instance from the configured WASM hash)
   * 3. Soroban: EphemeralAccount.initialize() on that new instance
   *
   * #811: EphemeralAccount is one-instance-per-account — `initialize` returns
   * `Error::AlreadyInitialized` (Contract error #1) on a second call and all
   * on-chain state (status, expiry, recorded payments, swept_to) lives in that
   * instance. A single shared contract ID therefore allowed exactly one
   * account per deployment. Every account now gets its own instance, deployed
   * with a random 32-byte salt, and the instance ID is what is persisted in
   * `accounts.contractId`.
   *
   * If deployment or contract initialization fails after the Horizon
   * transaction succeeds, an error is thrown so the caller (AccountsService)
   * can avoid persisting a record for an unrestricted account.
   *
   * ⚠️ MVP Note: True atomicity between Horizon and Soroban is not possible.
   * A failed deploy/initialize() after a successful createAccount() will leave an
   * unrestricted funded account on-chain. Issue #15 tracks the compensation strategy.
   *
   * @returns the Horizon funding transaction hash and the contract ID of the
   *          instance deployed for this account.
   */
  async createEphemeralAccount(params: {
    publicKey: string;
    amount: string;
    asset: string;
    expiresIn: number;
    recoveryAddress: string;
    sweepControllerContractId: string;
    fundingKeypairSecret?: string;
    // #827: required for a non-native (issued) asset, so the trustline can be
    // signed by the new account.
    ephemeralSecret?: string;
  }): Promise<{ txHash: string; contractId: string }> {
    this.logger.log(`Creating ephemeral account: ${params.publicKey}`);

    const fundingSecret =
      params.fundingKeypairSecret ??
      this.configService.getOrThrow<string>('stellar.fundingSecret');
    const fundingKeypair = StellarSdk.Keypair.fromSecret(fundingSecret);

    // Step 1: Create account on Stellar classic (Horizon)
    const fundingAccount = await this.server.loadAccount(
      fundingKeypair.publicKey(),
    );

    // #827: an issued asset needs a trustline on the ephemeral account before
    // any payment of that asset can be received; the trustline also needs the
    // account to hold an extra base reserve.
    const issuedAsset = this.parseIssuedAsset(params.asset);
    let ephemeralKeypair: StellarSdk.Keypair | undefined;
    if (issuedAsset) {
      if (!params.ephemeralSecret) {
        throw new Error(
          `Cannot fund issued asset ${params.asset}: the ephemeral ` +
            "account's secret is required to establish its trustline.",
        );
      }
      ephemeralKeypair = StellarSdk.Keypair.fromSecret(params.ephemeralSecret);
    }

    const transactionBuilder = new StellarSdk.TransactionBuilder(
      fundingAccount,
      {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.getNetworkPassphrase(),
      },
    ).addOperation(
      StellarSdk.Operation.createAccount({
        destination: params.publicKey,
        startingBalance: issuedAsset
          ? String(
              Number(EPHEMERAL_ACCOUNT_BASE_BALANCE) +
                Number(TRUSTLINE_BASE_RESERVE),
            )
          : EPHEMERAL_ACCOUNT_BASE_BALANCE,
      }),
    );

    if (issuedAsset && ephemeralKeypair) {
      transactionBuilder.addOperation(
        StellarSdk.Operation.changeTrust({
          asset: new StellarSdk.Asset(issuedAsset.code, issuedAsset.issuer),
          source: params.publicKey,
        }),
      );
    }

    const transaction = transactionBuilder.setTimeout(30).build();

    transaction.sign(fundingKeypair);
    if (ephemeralKeypair) {
      transaction.sign(ephemeralKeypair);
    }
    const result = await this.server.submitTransaction(transaction);
    this.logger.log(`Horizon account created: ${result.hash}`);

    // Step 2: Deploy a dedicated contract instance for this account (#811).
    // The shared `stellar.contracts.ephemeralAccount` ID is deliberately not
    // used here — it can only ever be initialized once.
    const contractId =
      await this.deployEphemeralAccountContract(fundingKeypair);

    // Step 3: Initialize the newly deployed contract with restrictions
    const expiryLedger = await this.toExpiryLedger(params.expiresIn);

    const contract = new StellarSdk.Contract(contractId);
    const sourceAccount = await this.sorobanServer.getAccount(
      fundingKeypair.publicKey(),
    );

    const initTransaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.getNetworkPassphrase(),
    })
      .addOperation(
        contract.call(
          'initialize',
          StellarSdk.Address.fromString(fundingKeypair.publicKey()).toScVal(), // creator
          StellarSdk.xdr.ScVal.scvU32(expiryLedger), // expiry_ledger
          StellarSdk.Address.fromString(params.recoveryAddress).toScVal(), // recovery_address
          StellarSdk.Address.fromString(
            params.sweepControllerContractId,
          ).toScVal(), // authorized_controller
          StellarSdk.Address.fromString(fundingKeypair.publicKey()).toScVal(),
        ),
      )
      .setTimeout(30)
      .build();

    const preparedTx =
      await this.sorobanServer.prepareTransaction(initTransaction);
    preparedTx.sign(fundingKeypair);

    const endTimer = this.sorobanRpcLatency.startTimer();
    let initResult: SorobanRpc.Api.SendTransactionResponse;
    try {
      initResult = await this.sorobanServer.sendTransaction(preparedTx);
    } finally {
      endTimer();
    }

    if (initResult.status === 'ERROR') {
      this.logger.error(
        `Contract initialize() failed for contract ${contractId} (${params.publicKey}): ${JSON.stringify(initResult.errorResult)}`,
      );
      throw new Error(
        `Contract initialization failed for contract ${contractId}: ${JSON.stringify(initResult.errorResult ?? 'unknown')}`,
      );
    }

    // Poll for confirmation
    await this.waitForTransaction(initResult.hash);

    this.logger.log(
      `Contract ${contractId} initialized for ${params.publicKey}, expiry ledger: ${expiryLedger}`,
    );
    return { txHash: result.hash, contractId };
  }

  /**
   * Deploys a fresh EphemeralAccount contract instance for one account (#811).
   *
   * `Operation.createCustomContract` derives the contract ID from
   * (network, deployer address, salt), so a random 32-byte salt guarantees a
   * distinct instance per account. The network reports the new contract ID as
   * the transaction's return value, which is read back once the deployment is
   * confirmed.
   *
   * @returns the contract ID of the newly deployed instance.
   */
  private async deployEphemeralAccountContract(
    fundingKeypair: StellarSdk.Keypair,
  ): Promise<string> {
    const wasmHash = this.configService.getOrThrow<string>(
      'stellar.contracts.ephemeralAccountWasmHash',
    );

    const sourceAccount = await this.sorobanServer.getAccount(
      fundingKeypair.publicKey(),
    );

    const deployTransaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.getNetworkPassphrase(),
    })
      .addOperation(
        StellarSdk.Operation.createCustomContract({
          address: StellarSdk.Address.fromString(fundingKeypair.publicKey()),
          wasmHash: Buffer.from(wasmHash.trim(), 'hex'),
          salt: crypto.randomBytes(32),
        }),
      )
      .setTimeout(30)
      .build();

    const preparedTx =
      await this.sorobanServer.prepareTransaction(deployTransaction);
    preparedTx.sign(fundingKeypair);

    const endTimer = this.sorobanRpcLatency.startTimer();
    let deployResult: SorobanRpc.Api.SendTransactionResponse;
    try {
      deployResult = await this.sorobanServer.sendTransaction(preparedTx);
    } finally {
      endTimer();
    }

    if (deployResult.status === 'ERROR') {
      this.logger.error(
        `EphemeralAccount contract deployment failed for ${fundingKeypair.publicKey()}: ${JSON.stringify(deployResult.errorResult)}`,
      );
      throw new Error(
        `Contract deployment failed: ${JSON.stringify(deployResult.errorResult ?? 'unknown')}`,
      );
    }

    await this.waitForTransaction(deployResult.hash);

    const confirmed = await this.sorobanServer.getTransaction(
      deployResult.hash,
    );
    // `returnValue` is only present on a successful response. A confirmed
    // deployment always carries the new contract ID there.
    const returnValue =
      confirmed.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS
        ? confirmed.returnValue
        : undefined;
    if (!returnValue) {
      this.logger.error(
        `Contract deployment tx ${deployResult.hash} returned no contract ID`,
      );
      throw new Error(
        `Contract deployment returned no contract ID for transaction ${deployResult.hash}`,
      );
    }

    const contractId = StellarSdk.Address.fromScVal(returnValue).toString();
    this.logger.log(
      `Deployed EphemeralAccount contract ${contractId} (tx: ${deployResult.hash})`,
    );

    return contractId;
  }

  /**
   * Calls EphemeralAccount.record_payment() on the Soroban contract.
   *
   * Should be called when an inbound payment is detected on the ephemeral
   * account's Stellar address (via Horizon payment stream — see Issue #9).
   *
   * Contract error mapping:
   * - Error::InvalidAmount     → throws — payment amount must be positive
   * - Error::DuplicateAsset    → throws — that asset already recorded, not retryable
   * - Error::TooManyPayments   → throws — 10 asset limit reached, not retryable
   * - Error::NotInitialized    → throws — contract not initialized, system error
   */
  async recordPayment(params: {
    contractId: string;
    amount: bigint; // i128 in contract — use bigint to avoid precision loss
    assetAddress: string; // Stellar contract address of the asset
    signerSecret: string;
  }): Promise<void> {
    const signerKeypair = StellarSdk.Keypair.fromSecret(params.signerSecret);
    const contract = new StellarSdk.Contract(params.contractId);
    const sourceAccount = await this.sorobanServer.getAccount(
      signerKeypair.publicKey(),
    );

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.getNetworkPassphrase(),
    })
      .addOperation(
        contract.call(
          'record_payment',
          StellarSdk.xdr.ScVal.scvI128(
            new StellarSdk.xdr.Int128Parts({
              hi: StellarSdk.xdr.Int64.fromString(
                (params.amount >> 64n).toString(),
              ),
              lo: StellarSdk.xdr.Uint64.fromString(
                (params.amount & 0xffffffffffffffffn).toString(),
              ),
            }),
          ),
          StellarSdk.Address.fromString(params.assetAddress).toScVal(),
        ),
      )
      .setTimeout(30)
      .build();

    const preparedTx = await this.sorobanServer.prepareTransaction(transaction);
    preparedTx.sign(signerKeypair);

    const endTimer = this.sorobanRpcLatency.startTimer();
    let result: SorobanRpc.Api.SendTransactionResponse;
    try {
      result = await this.sorobanServer.sendTransaction(preparedTx);
    } finally {
      endTimer();
    }

    if (result.status === 'ERROR') {
      this.logger.error(
        `record_payment failed for contract ${params.contractId}: ${JSON.stringify(result.errorResult)}`,
      );
      throw new Error(
        `record_payment failed: ${JSON.stringify(result.errorResult ?? 'unknown')}`,
      );
    }

    await this.waitForTransaction(result.hash);
    this.logger.log(
      `Payment recorded on contract ${params.contractId}, amount: ${params.amount}`,
    );
  }

  /**
   * Calls SweepController.execute_sweep() to transfer funds from an ephemeral
   * account to the recipient's permanent wallet.
   *
   * The SweepController internally calls EphemeralAccount.sweep() which
   * validates state and updates the account status on-chain.
   *
   * ⚠️ MVP Note: The contract updates state and emits events but does NOT yet
   * execute token transfers on-chain. Actual fund movement is not implemented
   * in bridgelet-core at this stage. See bridgelet-core known limitations.
   *
   * Contract error mapping:
   * - Error::AlreadySwept          → terminal, do not retry
   * - Error::AccountExpired        → terminal, trigger expiry flow instead
   * - Error::UnauthorizedDestination → destination doesn't match locked mode config
   * - Error::AuthorizationFailed   → signature invalid
   */
  async executeSweep(params: {
    sweepControllerContractId: string;
    ephemeralAccountContractId: string;
    destination: string;
    authSignature: Buffer; // 64 bytes
    signerSecret: string;
  }): Promise<void> {
    const signerKeypair = StellarSdk.Keypair.fromSecret(params.signerSecret);
    const contract = new StellarSdk.Contract(params.sweepControllerContractId);
    const sourceAccount = await this.sorobanServer.getAccount(
      signerKeypair.publicKey(),
    );

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.getNetworkPassphrase(),
    })
      .addOperation(
        contract.call(
          'execute_sweep',
          StellarSdk.Address.fromString(
            params.ephemeralAccountContractId,
          ).toScVal(),
          StellarSdk.Address.fromString(params.destination).toScVal(),
          StellarSdk.xdr.ScVal.scvBytes(params.authSignature),
        ),
      )
      .setTimeout(30)
      .build();

    const preparedTx = await this.sorobanServer.prepareTransaction(transaction);
    preparedTx.sign(signerKeypair);

    const endTimer = this.sorobanRpcLatency.startTimer();
    let result: SorobanRpc.Api.SendTransactionResponse;
    try {
      result = await this.sorobanServer.sendTransaction(preparedTx);
    } finally {
      endTimer();
    }

    if (result.status === 'ERROR') {
      const errStr = JSON.stringify(result.errorResult);
      this.logger.error(
        `execute_sweep failed for ${params.ephemeralAccountContractId}: ${errStr}`,
      );

      // Surface terminal errors explicitly so callers don't retry
      if (errStr.includes('AlreadySwept')) throw new Error('ALREADY_SWEPT');
      if (errStr.includes('AccountExpired')) throw new Error('ACCOUNT_EXPIRED');

      throw new Error(`execute_sweep failed: ${errStr}`);
    }

    await this.waitForTransaction(result.hash);
    this.logger.log(
      `Sweep executed: ${params.ephemeralAccountContractId} → ${params.destination}`,
    );
  }

  /**
   * Calls EphemeralAccount.expire() to close an unclaimed account after its
   * expiry ledger has been reached, directing funds to the recovery address.
   *
   * Should be called by a scheduled job monitoring accounts whose expiresAt
   * timestamp has passed. The scheduler is tracked separately (not in scope here).
   *
   * ⚠️ MVP Note: Fund recovery to recovery_address depends on token transfer
   * implementation in the contract, which is not yet complete in bridgelet-core.
   *
   * Contract error mapping:
   * - Error::NotExpired     → non-fatal race condition, ledger not yet reached
   * - Error::InvalidStatus  → terminal, account already swept or expired
   * - Error::NotInitialized → system error, contract was never initialized
   */
  async expireAccount(params: {
    contractId: string;
    signerSecret: string;
  }): Promise<void> {
    // Guard: check ledger before calling to avoid unnecessary transactions
    const currentLedger = await this.getCurrentLedger();
    const accountInfo = await this.getAccountInfo(params.contractId);

    if (currentLedger < accountInfo.expiry_ledger) {
      this.logger.warn(
        `expireAccount called too early for ${params.contractId}. ` +
          `Current: ${currentLedger}, expiry: ${accountInfo.expiry_ledger}`,
      );
      return; // non-fatal, scheduler will retry
    }

    const signerKeypair = StellarSdk.Keypair.fromSecret(params.signerSecret);
    const contract = new StellarSdk.Contract(params.contractId);
    const sourceAccount = await this.sorobanServer.getAccount(
      signerKeypair.publicKey(),
    );

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.getNetworkPassphrase(),
    })
      .addOperation(contract.call('expire'))
      .setTimeout(30)
      .build();

    const preparedTx = await this.sorobanServer.prepareTransaction(transaction);
    preparedTx.sign(signerKeypair);

    const endTimer = this.sorobanRpcLatency.startTimer();
    let result: SorobanRpc.Api.SendTransactionResponse;
    try {
      result = await this.sorobanServer.sendTransaction(preparedTx);
    } finally {
      endTimer();
    }

    if (result.status === 'ERROR') {
      const errStr = JSON.stringify(result.errorResult);
      if (errStr.includes('InvalidStatus')) {
        throw new Error('ACCOUNT_ALREADY_TERMINAL');
      }
      throw new Error(`expire() failed: ${errStr}`);
    }

    await this.waitForTransaction(result.hash);
    this.logger.log(`Account expired on-chain: ${params.contractId}`);
  }

  /**
   * Calls EphemeralAccount.get_info() and returns the full on-chain account state.
   * Used by the sweep and claims modules to verify account readiness before acting,
   * and internally by expireAccount() to check expiry ledger before submitting.
   */
  async getAccountInfo(contractId: string): Promise<{
    status: string;
    expiry_ledger: number;
    payment_received: boolean;
    payment_count: number;
    recovery_address: string;
  }> {
    const contract = new StellarSdk.Contract(contractId);

    // get_info is a read-only call — use simulateTransaction, no signing needed
    const dummyKeypair = StellarSdk.Keypair.random();
    const sourceAccount = new StellarSdk.Account(dummyKeypair.publicKey(), '0');

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.getNetworkPassphrase(),
    })
      .addOperation(contract.call('get_info'))
      .setTimeout(30)
      .build();

    const endTimer = this.sorobanRpcLatency.startTimer();
    let simResult: SorobanRpc.Api.SimulateTransactionResponse;
    try {
      simResult = await this.sorobanServer.simulateTransaction(transaction);
    } finally {
      endTimer();
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`get_info simulation failed: ${simResult.error}`);
    }

    // Parse the returned ScVal - shape mirrors AccountInfo struct in bridgelet-core.
    // ScVal is an XDR union; inspect its discriminant with switch() and read
    // the active arm through its generated accessor.
    const returnVal = simResult.result?.retval;
    if (!returnVal)
      throw new Error(`get_info returned no value for ${contractId}`);

    if (returnVal.type !== 'scvMap' || !returnVal.map) {
      throw new Error(
        `get_info returned unexpected ScVal type for ${contractId}`,
      );
    }

    const symToString = (sym: string | { toString(): string }): string =>
      typeof sym === 'string'
        ? sym
        : sym instanceof Uint8Array
          ? Buffer.from(sym).toString('utf8')
          : sym.toString();

    const fields = returnVal.map.map((entry) => ({
      key: entry.key.type === 'scvSymbol' ? symToString(entry.key.sym) : '',
      val: entry.val,
    }));

    const get = (key: string) => fields.find((f) => f.key === key)?.val;

    const asU32 = (val: ReturnType<typeof get>) =>
      val?.type === 'scvU32' ? val.u32 : undefined;

    const asBool = (val: ReturnType<typeof get>) =>
      val?.type === 'scvBool' ? val.b : undefined;

    const recoveryVal = get('recovery_address');
    if (!recoveryVal) {
      throw new Error(
        `get_info missing recovery_address field for ${contractId}`,
      );
    }

    return {
      status: asU32(get('status'))?.toString() ?? 'unknown',
      expiry_ledger: asU32(get('expiry_ledger')) ?? 0,
      payment_received: asBool(get('payment_received')) ?? false,
      payment_count: asU32(get('payment_count')) ?? 0,
      recovery_address: StellarSdk.Address.fromScVal(recoveryVal).toString(),
    };
  }

  /**
   * Reads the SweepController's current sweep nonce via a read-only simulation
   * of `get_nonce()` — no signing, no transaction (#812).
   *
   * The nonce is a single global counter: `initialize()` sets it to 0 and every
   * successful `execute_sweep()`/`claim()` increments it. `verify_sweep_auth`
   * rebuilds the signed message from the value in storage, so the signature
   * produced for a stale nonce is rejected on-chain. Callers must read it
   * immediately before signing.
   */
  async getSweepNonce(sweepControllerContractId: string): Promise<bigint> {
    const contract = new StellarSdk.Contract(sweepControllerContractId);

    // get_nonce is a read-only call — use simulateTransaction, no signing needed
    const dummyKeypair = StellarSdk.Keypair.random();
    const sourceAccount = new StellarSdk.Account(dummyKeypair.publicKey(), '0');

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.getNetworkPassphrase(),
    })
      .addOperation(contract.call('get_nonce'))
      .setTimeout(30)
      .build();

    const endTimer = this.sorobanRpcLatency.startTimer();
    let simResult: SorobanRpc.Api.SimulateTransactionResponse;
    try {
      simResult = await this.sorobanServer.simulateTransaction(transaction);
    } finally {
      endTimer();
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`get_nonce simulation failed: ${simResult.error}`);
    }

    const returnVal = simResult.result?.retval;
    if (!returnVal) {
      throw new Error(
        `get_nonce returned no value for ${sweepControllerContractId}`,
      );
    }

    // The contract returns u64 (Rust `u64`); inspect the XDR union arm before
    // reading its generated accessor.
    if (returnVal.type !== 'scvU64') {
      throw new Error(
        `get_nonce returned unexpected ScVal type for ${sweepControllerContractId}`,
      );
    }

    // Convert via the decimal string form: `SweepSignerUtil.buildMessage`
    // feeds the nonce to `Buffer.writeBigUInt64BE`, which throws a TypeError
    // on anything that is not a real bigint.
    return BigInt(returnVal.u64.toString());
  }

  /**
   * Polls Soroban RPC until a transaction is confirmed or fails.
   * Used after sendTransaction() which is async by nature.
   */
  private async waitForTransaction(
    txHash: string,
    maxAttempts = 10,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const endTimer = this.sorobanRpcLatency.startTimer();
      let status: SorobanRpc.Api.GetTransactionResponse;
      try {
        status = await this.sorobanServer.getTransaction(txHash);
      } finally {
        endTimer();
      }

      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) return;
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction ${txHash} failed on-chain`);
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(
      `Transaction ${txHash} not confirmed after ${maxAttempts} attempts`,
    );
  }

  private getNetworkPassphrase(): string {
    return this.network === 'mainnet'
      ? StellarSdk.Networks.PUBLIC
      : StellarSdk.Networks.TESTNET;
  }

  /**
   * #827: parse a `CODE:ISSUER` asset string. Returns `null` for the native
   * asset and throws on a malformed string so a bad asset never silently
   * skips the trustline.
   */
  private parseIssuedAsset(
    asset: string,
  ): { code: string; issuer: string } | null {
    if (!asset || asset === 'native' || asset === 'XLM') {
      return null;
    }

    const parts = asset.split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid asset format: ${asset}`);
    }

    return { code: parts[0], issuer: parts[1] };
  }
}
