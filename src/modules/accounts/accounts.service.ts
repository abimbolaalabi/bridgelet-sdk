import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Account } from './entities/account.entity.js';
import { CreateAccountDto } from './dto/create-account.dto.js';
import { AccountResponseDto } from './dto/account-response.dto.js';
import { StellarService } from '../stellar/stellar.service.js';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { AccountStatus } from './enums/account-status.enum.js';
import {
  assertValidAccountStatusTransition,
  isValidAccountStatusTransition,
} from './enums/account-status-transition.util.js';
import { SecretEncryptionUtil } from '../../common/crypto/secret-encryption.util.js';
import { KmsKeyProvider } from '../../common/crypto/kms-key.provider.js';
import { WebhooksService } from '../webhooks/webhooks.service.js';
import { sanitizeMetadata } from '../../common/utils/metadata-sanitizer.util.js';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import { AccountLatencyMetricsProvider } from './providers/account-latency-metrics.provider.js';
import {
  ADMIN_CALLER,
  AuthenticatedCaller,
} from '../../common/guards/jwt-auth.guard.js';

/**
 * AccountsService — Service-Level Documentation & Contributor Guidance
 *
 * Lifecycle Overview
 * ------------------
 * This service is an orchestration layer in the Bridgelet flow responsible for
 * ephemeral account creation, funding, claim-token lifecycle management,
 * interaction with the `StellarService`, persistence of account state, and
 * shaping API responses (`AccountResponseDto`). Typical flow:
 *
 * 1. Ephemeral account creation: a keypair is generated and an account is
 *    provisioned/funded on the Stellar network via `StellarService`.
 * 2. Claim generation: a claim token is produced and a hash of that token is
 *    stored on the account record (the plain token is returned in the API
 *    response only). The token is used by end-users to claim the funded
 *    ephemeral account.
 * 3. Claiming: an external request exchanges the token for the secret.
 * 4. Post-claim: account status and destination fields are updated accordingly.
 *
 * Security Notes
 * --------------
 * - Encryption status: `secretKeyEncrypted` is stored as an AES-256-GCM
 *   ciphertext via `SecretEncryptionUtil` (random IV per write, versioned
 *   `aes256gcm:v1:` prefix). Pre-PR #193 rows may still exist in migration
 *   window with either an unprefixed AES-GCM payload (decryption still
 *   succeeds) or the residual MVP `Buffer.from(secret).toString('base64')`
 *   placeholder (decryption throws; operator must run
 *   `npm run migrate:secrets -- --i-have-a-backup --execute` once before any
 *   claim can succeed against those rows). Key rotation is a separate concern
 *   and is NOT covered by this util — it requires a dual-key decrypt path.
 *     - Token signing uses the configured JWT secret; ensure the secret
 *       management and rotation policies meet your security requirements.
 *
 * - Token handling: the service stores only a SHA-256 hash of the claim token
 *   (`claimTokenHash`) rather than the raw token. The raw token is delivered
 *   once to callers via the generated claim URL. Changes to token format,
 *   signing algorithm, or expiry semantics are protocol-sensitive and will
 *   break clients if not coordinated.
 *
 * - Secret storage: `secretKeyEncrypted` is intended to hold an encrypted
 *   secret. Treat the current implementation as a placeholder. Do NOT
 *   replace it with a new encoding/encryption scheme without documenting the
 *   migration plan and ensuring compatibility for any live secrets.
 *
 * Integration Boundaries
 * ----------------------
 * - Assumptions about `StellarService`:
 *     - It provides `generateKeypair()` and `createEphemeralAccount()` with
 *       the semantics expected here (returning a transaction hash when
 *       funding succeeds).
 *     - The format of the public key and secret follow Stellar keypair
 *       conventions; these assumptions are protocol-sensitive.
 *
 * - External integrators rely on stable response fields (e.g., `claimUrl`,
 *   `publicKey`, `txHash`). Response shaping is backward-compatible by
 *   design — avoid renaming or removing fields without a migration/compat
 *   strategy.
 *
 * Mapping & DTO Intent
 * --------------------
 * - Response DTOs intentionally expose only a subset of stored fields. For
 *   example, the raw `secret` is never returned; the `claimUrl` provides a
 *   user-facing way to perform a claim without disclosing secrets.
 * - Conditional fields: some response fields are conditionally populated
 *   (e.g., `claimUrl` only when a claim token exists). Maintain these rules
 *   when changing mapping logic to avoid leaking internal state.
 *
 * Contributor Guidance — Ask If Unsure
 * -----------------------------------
 * ⚠️ This service encodes protocol-level behavior. If you are unsure whether
 * a change affects lifecycle guarantees, consult maintainers before modifying
 * logic.
 *
 * If any behavior is unclear:
 * - Check the repository README for architecture context.
 * - Review the `docs/` directory for protocol expectations.
 * - Ask before making assumptions, especially around: token generation,
 *   expiry semantics, data exposure, or secret handling.
 *
 * When in doubt: document, do not redesign silently.
 */
@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    private configService: ConfigService,
    private jwtService: JwtService,
    private stellarService: StellarService,
    private webhooksService: WebhooksService,
    @InjectMetric('account_creation_total')
    private readonly accountCreationCounter: Counter<string>,
    private latencyMetrics: AccountLatencyMetricsProvider,
    private kmsKeyProvider: KmsKeyProvider,
  ) {}

  public async create(
    createAccountDto: CreateAccountDto,
    caller: AuthenticatedCaller = ADMIN_CALLER,
  ): Promise<AccountResponseDto> {
    this.accountCreationCounter.inc();
    const startMs = Date.now();

    // #825: stamp the account with the sender that owns it. A sender-scoped
    // caller can only ever create accounts for its own wallet, so an explicit
    // `senderAddress` for a different wallet is rejected rather than silently
    // used. An admin caller may tag the account with any address (or none).
    let senderAddress: string | null;
    if (caller.scope === 'sender') {
      if (
        createAccountDto.senderAddress &&
        createAccountDto.senderAddress !== caller.senderAddress
      ) {
        throw new ForbiddenException(
          'senderAddress does not match the authenticated sender',
        );
      }
      senderAddress = caller.senderAddress;
    } else {
      senderAddress = createAccountDto.senderAddress ?? null;
    }

    // Generate ephemeral keypair
    const ephemeralKeypair = this.stellarService.generateKeypair();

    // Calculate expiry timestamp
    const expiresAt = new Date(Date.now() + createAccountDto.expiresIn * 1000);

    // Generate claim token
    const claimToken = this.generateClaimToken(ephemeralKeypair.publicKey());

    // Hash claim token for storage
    const claimTokenHash = crypto
      .createHash('sha256')
      .update(claimToken)
      .digest('hex');

    // Derive combined asset string from asset_code + asset_issuer when provided
    const asset =
      createAccountDto.asset_code && createAccountDto.asset_issuer
        ? `${createAccountDto.asset_code}:${createAccountDto.asset_issuer}`
        : (createAccountDto.asset_code ?? 'native');

    // Save with INITIALIZING status first so we have a DB record for cleanup
    // if the Stellar/contract steps fail
    const account = this.accountsRepository.create({
      publicKey: ephemeralKeypair.publicKey(),
      secretKeyEncrypted: SecretEncryptionUtil.encrypt(
        ephemeralKeypair.secret(),
        this.kmsKeyProvider.getEncryptionKey(),
      ),
      fundingSource: createAccountDto.fundingSource,
      amount: createAccountDto.amount,
      asset,
      senderAddress,
      status: AccountStatus.INITIALIZING,
      claimTokenHash,
      expiresAt,
      metadata: sanitizeMetadata(createAccountDto.metadata),
    });

    await this.accountsRepository.save(account);

    try {
      // #811: no contract ID is passed in — createEphemeralAccount deploys a
      // dedicated EphemeralAccount instance per account and returns its ID.
      const { txHash, contractId } =
        await this.stellarService.createEphemeralAccount({
          publicKey: ephemeralKeypair.publicKey(),
          amount: createAccountDto.amount,
          asset,
          expiresIn: createAccountDto.expiresIn,
          recoveryAddress: createAccountDto.recovery_address,
          sweepControllerContractId: this.configService.getOrThrow<string>(
            'stellar.contracts.sweepController',
          ),
          // #827: needed so an issued-asset account can sign its own
          // trustline during creation.
          ephemeralSecret: ephemeralKeypair.secret(),
        });

      // Both Horizon and contract succeeded — advance to real status.
      // #445: validated against the single source of truth in
      // account-status-transition.util.ts. `account.status` is read live rather
      // than hardcoded so this stays correct if the row is ever re-entered.
      assertValidAccountStatusTransition(
        account.status,
        AccountStatus.PENDING_PAYMENT,
        `accountsService.create accountId=${account.id}`,
      );
      account.status = AccountStatus.PENDING_PAYMENT;
      account.contractId = contractId;
      await this.accountsRepository.save(account);

      await this.webhooksService.triggerEvent('account.created', {
        accountId: account.id,
        publicKey: account.publicKey,
        amount: account.amount,
        asset: account.asset,
        expiresAt: account.expiresAt,
      });

      this.latencyMetrics.record(Date.now() - startMs, true);

      return {
        accountId: account.id,
        publicKey: account.publicKey,
        senderAddress: account.senderAddress ?? null,
        claimUrl: this.generateClaimUrl(claimToken),
        txHash,
        amount: account.amount,
        asset: account.asset,
        status: account.status,
        expiresAt: account.expiresAt,
        createdAt: account.createdAt,
      };
    } catch (error: unknown) {
      this.latencyMetrics.record(Date.now() - startMs, false);

      // Mark as FAILED so the record is traceable but clearly broken.
      //
      // #445: this is a `catch` block handling an unrelated failure, so it
      // deliberately uses the *non-throwing* validator. Throwing here would
      // replace the real underlying error with a status-transition error,
      // hiding the actual cause from both the caller and the logs — strictly
      // worse than leaving the row un-marked. An unexpected source status is
      // therefore logged and the write is still attempted (FAILED is
      // best-effort terminal bookkeeping, not business-critical state).
      if (
        !isValidAccountStatusTransition(account.status, AccountStatus.FAILED)
      ) {
        this.logger.error(
          `Lifecycle bug (#445): ${account.status} -> FAILED is not a valid ` +
            `transition for account ${account.id}. Marking it FAILED anyway, ` +
            `but this should not happen.`,
        );
      }
      account.status = AccountStatus.FAILED;
      await this.accountsRepository.save(account);

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Account creation failed for ${ephemeralKeypair.publicKey()}: ${message}`,
      );
      // preserve original error if it's an Error, otherwise wrap
      if (error instanceof Error) throw error;
      throw new Error(message);
    }
  }

  public async findOne(
    id: string,
    caller: AuthenticatedCaller = ADMIN_CALLER,
  ): Promise<AccountResponseDto> {
    // Soft-deleted accounts are excluded so GET /accounts/:id 404s for them,
    // matching findAll(). Fixed in PR #771 for #637 (re-confirmed #698); the
    // regression test for #923 pins this deletedAt filter.
    const account = await this.accountsRepository.findOne({
      where: { id, deletedAt: IsNull() },
    });

    if (!account) {
      throw new NotFoundException(`Account ${id} not found`);
    }

    // #825: a sender-scoped caller must not be able to tell another sender's
    // account apart from one that does not exist, so an account it does not
    // own 404s exactly like a missing one.
    if (
      caller.scope === 'sender' &&
      account.senderAddress !== caller.senderAddress
    ) {
      throw new NotFoundException(`Account ${id} not found`);
    }

    return this.mapToResponseDto(account);
  }

  public async findAll(
    {
      status,
      limit,
      offset,
    }: {
      status?: AccountStatus;
      limit: number;
      offset: number;
    },
    caller: AuthenticatedCaller = ADMIN_CALLER,
  ): Promise<{ accounts: AccountResponseDto[]; total: number }> {
    const query = this.accountsRepository
      .createQueryBuilder('account')
      .where('account.deletedAt IS NULL');

    // #825: sender-scoped callers only ever see their own accounts; an admin
    // caller keeps the unscoped listing.
    if (caller.scope === 'sender') {
      query.andWhere('account.senderAddress = :senderAddress', {
        senderAddress: caller.senderAddress,
      });
    }

    if (status) {
      query.andWhere('account.status = :status', { status });
    }

    query.skip(offset).take(Math.min(limit, 100));

    const [accounts, total] = await query.getManyAndCount();

    return {
      accounts: accounts.map((acc) => this.mapToResponseDto(acc)),
      total,
    };
  }

  private generateClaimToken(publicKey: string): string {
    /**
     * generateClaimToken
     * ------------------
     * Purpose: Sign a short-lived JWT that encodes the public key and a
     * 'claim' type. The resulting token is handed to callers and is the
     * secret used to claim the ephemeral account.
     *
     * Security notes / contributor guidance:
     * - The token expiry (`app.claimTokenExpiry`) is protocol-sensitive.
     *   Changing expiry semantics requires coordination with clients.
     * - The JWT signing secret must be managed and rotated safely. Do not
     *   switch to a different signing mechanism without an explicit design
     *   and migration plan.
     */
    // const secret =
    //   this.configService.get<string>('app.jwtSecret') ?? 'fallback secret';
    const expiry =
      this.configService.get<number>('app.claimTokenExpiry') ?? 2592000;

    return this.jwtService.sign(
      { publicKey, type: 'claim' },
      { expiresIn: `${expiry}s` },
    );
  }

  private generateClaimUrl(token: string): string {
    // generateClaimUrl
    // ----------------
    // Purpose: Build the user-facing URL used to perform the claim flow.
    // Integration notes:
    // - `CLAIM_BASE_URL` is an environment-level integration point. External
    //   systems and email templates may rely on the shape of this URL.
    const baseUrl = this.configService.getOrThrow<string>('app.claimBaseUrl');
    return `${baseUrl}/c/${token}`;
  }

  private mapToResponseDto(account: Account): AccountResponseDto {
    return {
      accountId: account.id,
      publicKey: account.publicKey,
      senderAddress: account.senderAddress ?? null,
      // Mapping note: we intentionally never return raw tokens here.
      // When a token exists, we return a placeholder claim URL in list/endpoints
      // that shouldn't leak the real token. The single-response `create`
      // operation returns the real `claimUrl` containing the token.
      claimUrl: account.claimTokenHash ? this.generateClaimUrl('***') : null,
      amount: account.amount,
      asset: account.asset,
      status: account.status,
      expiresAt: account.expiresAt,
      createdAt: account.createdAt,
      claimedAt: account.claimedAt,
      destination: account.destinationAddress,
      metadata: account.metadata,
    };
  }
}
