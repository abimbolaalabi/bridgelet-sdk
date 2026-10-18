import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { getToken } from '@willsoto/nestjs-prometheus';
import { AccountsService } from './accounts.service.js';
import { Account } from './entities/account.entity.js';
import { StellarService } from '../stellar/stellar.service.js';
import { WebhooksService } from '../webhooks/webhooks.service.js';
import { AccountStatus } from './enums/account-status.enum.js';
import { CreateAccountDto } from './dto/create-account.dto.js';
import { AccountLatencyMetricsProvider } from './providers/account-latency-metrics.provider.js';
import { KmsKeyProvider } from '../../common/crypto/kms-key.provider.js';
import { Registry, register } from 'prom-client';
import {
  ADMIN_CALLER,
  AuthenticatedCaller,
} from '../../common/guards/jwt-auth.guard.js';

const VALID_KEY = 'G' + 'A'.repeat(55);
const VALID_KEY2 = 'G' + 'B'.repeat(55);
// #825: two distinct sender wallets for scope tests
const SENDER_A = 'G' + 'C'.repeat(55);
const SENDER_B = 'G' + 'D'.repeat(55);
const senderACaller: AuthenticatedCaller = {
  scope: 'sender',
  senderAddress: SENDER_A,
};
const senderBCaller: AuthenticatedCaller = {
  scope: 'sender',
  senderAddress: SENDER_B,
};
// #811: contract ID of the instance deployed for one account
const DEPLOYED_CONTRACT_ID =
  'CBVSQFKKFONF6MPNQSZYEXGIHLFEFT3QLNNW2XTFE3PMADLSRDVBC552';

const mockRepo = {
  create: jest.fn(),
  save: jest.fn(),
  findOne: jest.fn(),
  createQueryBuilder: jest.fn(),
};

const mockStellarService = {
  generateKeypair: jest.fn(),
  createEphemeralAccount: jest.fn(),
};

const mockJwtService = {
  sign: jest.fn().mockReturnValue('mock-jwt-token'),
};

const mockConfigService = {
  getOrThrow: jest.fn((key: string) => {
    const cfg: Record<string, string> = {
      'stellar.encryptionKey': 'a'.repeat(64),
      'stellar.contracts.ephemeralAccount': 'CONTRACT123',
      'stellar.contracts.sweepController': 'CONTRACT456',
      'app.claimBaseUrl': 'https://claim.bridgelet.io',
    };
    const v = cfg[key];
    if (!v) throw new Error(`Config key not found: ${key}`);
    return v;
  }),
  get: jest.fn((key: string) => {
    if (key === 'app.claimTokenExpiry') return 2592000;
    return undefined;
  }),
};

const mockWebhooksService = {
  triggerEvent: jest.fn().mockResolvedValue(undefined),
};

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'uuid-1',
    publicKey: VALID_KEY,
    secretKeyEncrypted: 'enc',
    fundingSource: VALID_KEY2,
    amount: '100',
    asset: 'native',
    senderAddress: null,
    status: AccountStatus.PENDING_PAYMENT,
    claimTokenHash: 'hash',
    destinationAddress: null,
    expiresAt: new Date('2099-01-01'),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    claimedAt: null,
    expiredAt: null,
    metadata: null,
    ...overrides,
  } as Account;
}

describe('AccountsService', () => {
  let service: AccountsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default keypair mock
    mockStellarService.generateKeypair.mockReturnValue({
      publicKey: () => VALID_KEY,
      secret: () => 'STEST',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountsService,
        { provide: getRepositoryToken(Account), useValue: mockRepo },
        { provide: StellarService, useValue: mockStellarService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: WebhooksService, useValue: mockWebhooksService },
        AccountLatencyMetricsProvider,
        {
          provide: getToken('account_creation_total'),
          useValue: { inc: jest.fn() },
        },
        {
          provide: KmsKeyProvider,
          useValue: {
            getEncryptionKey: jest.fn().mockReturnValue('a'.repeat(64)),
          },
        },
        {
          provide: Registry,
          useValue: register,
        },
      ],
    }).compile();

    service = module.get<AccountsService>(AccountsService);
  });

  // ─── create ──────────────────────────────────────────────────────────────

  describe('create', () => {
    const dto: CreateAccountDto = {
      fundingSource: VALID_KEY2,
      amount: '100',
      asset: 'native',
      expiresIn: 3600,
    };

    function setupCreateSuccess() {
      const initializingAccount = makeAccount({
        status: AccountStatus.INITIALIZING,
      });
      const savedAccount = makeAccount({
        status: AccountStatus.PENDING_PAYMENT,
      });
      mockRepo.create.mockReturnValue(initializingAccount);
      mockRepo.save
        .mockResolvedValueOnce(initializingAccount) // first save with INITIALIZING
        .mockResolvedValueOnce(savedAccount); // second save with PENDING_PAYMENT
      mockStellarService.createEphemeralAccount.mockResolvedValue({
        txHash: 'txhash-abc',
        contractId: DEPLOYED_CONTRACT_ID,
      });
      return savedAccount;
    }

    it('returns an AccountResponseDto with publicKey and txHash on success', async () => {
      setupCreateSuccess();

      const result = await service.create(dto);

      expect(result.publicKey).toBe(VALID_KEY);
      expect(result.txHash).toBe('txhash-abc');
      expect(result.status).toBe(AccountStatus.PENDING_PAYMENT);
    });

    it('persists the contract ID returned by the deployment', async () => {
      setupCreateSuccess();

      await service.create(dto);

      expect(mockRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ contractId: DEPLOYED_CONTRACT_ID }),
      );
    });

    it('does not read the shared ephemeral-account contract ID', async () => {
      setupCreateSuccess();

      await service.create(dto);

      const configKeys = mockConfigService.getOrThrow.mock.calls.map(
        (call) => call[0],
      );
      expect(configKeys).not.toContain('stellar.contracts.ephemeralAccount');
    });

    it('passes expiresIn to createEphemeralAccount for ledger conversion', async () => {
      setupCreateSuccess();

      await service.create(dto);

      expect(mockStellarService.createEphemeralAccount).toHaveBeenCalledWith(
        expect.objectContaining({ expiresIn: 3600 }),
      );
    });

    it('triggers account.created webhook after success', async () => {
      setupCreateSuccess();

      await service.create(dto);

      expect(mockWebhooksService.triggerEvent).toHaveBeenCalledWith(
        'account.created',
        expect.objectContaining({ publicKey: VALID_KEY }),
      );
    });

    it('includes a claimUrl in the response', async () => {
      setupCreateSuccess();

      const result = await service.create(dto);

      expect(result.claimUrl).toContain('mock-jwt-token');
    });

    it('marks account as FAILED and re-throws when createEphemeralAccount fails', async () => {
      const saved = makeAccount({ status: AccountStatus.INITIALIZING });
      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockStellarService.createEphemeralAccount.mockRejectedValue(
        new Error('Horizon error'),
      );

      await expect(service.create(dto)).rejects.toThrow('Horizon error');
      expect(saved.status).toBe(AccountStatus.FAILED);
      expect(mockRepo.save).toHaveBeenCalledTimes(2); // initial save + failed save
    });

    it('wraps non-Error exceptions thrown by createEphemeralAccount', async () => {
      const saved = makeAccount();
      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockStellarService.createEphemeralAccount.mockRejectedValue(
        'raw string error',
      );

      await expect(service.create(dto)).rejects.toThrow('raw string error');
    });

    // #825: senderAddress stamping / scope enforcement
    it('stamps the caller sender address for a sender-scoped caller', async () => {
      setupCreateSuccess();

      await service.create(dto, senderACaller);

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ senderAddress: SENDER_A }),
      );
    });

    it('rejects a sender-scoped caller that tags a different wallet (#825)', async () => {
      setupCreateSuccess();

      await expect(
        service.create({ ...dto, senderAddress: SENDER_B }, senderACaller),
      ).rejects.toThrow(ForbiddenException);
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it('lets an admin caller stamp an explicit sender address', async () => {
      setupCreateSuccess();

      await service.create({ ...dto, senderAddress: SENDER_B }, ADMIN_CALLER);

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ senderAddress: SENDER_B }),
      );
    });
  });

  // ─── findOne ─────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('returns an AccountResponseDto for an existing account', async () => {
      mockRepo.findOne.mockResolvedValue(makeAccount());

      const result = await service.findOne('uuid-1');

      expect(result.accountId).toBe('uuid-1');
      expect(result.publicKey).toBe(VALID_KEY);
    });

    it('throws NotFoundException when account does not exist', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('missing-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    // #923: soft-deleted rows must 404 on GET /accounts/:id, matching
    // findAll(). TypeORM appends `deletedAt IS NULL` to the query, so the
    // repository returns null for a soft-deleted id.
    it('excludes soft-deleted accounts from findOne (#923)', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('soft-deleted-id')).rejects.toThrow(
        NotFoundException,
      );

      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'soft-deleted-id', deletedAt: IsNull() },
      });
    });

    it('returns null claimUrl when claimTokenHash is absent', async () => {
      mockRepo.findOne.mockResolvedValue(makeAccount({ claimTokenHash: null }));

      const result = await service.findOne('uuid-1');

      expect(result.claimUrl).toBeNull();
    });

    it('returns a masked claimUrl when claimTokenHash is present', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeAccount({ claimTokenHash: 'abc' }),
      );

      const result = await service.findOne('uuid-1');

      expect(result.claimUrl).toContain('***');
    });

    // #825: sender-scoped reads
    it('lets a sender read an account it owns', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeAccount({ senderAddress: SENDER_A }),
      );

      const result = await service.findOne('uuid-1', senderACaller);

      expect(result.accountId).toBe('uuid-1');
    });

    it("returns 404 for another sender's account", async () => {
      // Account belongs to B; caller is scoped to A.
      mockRepo.findOne.mockResolvedValue(
        makeAccount({ senderAddress: SENDER_B }),
      );

      await expect(service.findOne('uuid-1', senderACaller)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lets an admin read any account', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeAccount({ senderAddress: SENDER_B }),
      );

      const result = await service.findOne('uuid-1', ADMIN_CALLER);

      expect(result.accountId).toBe('uuid-1');
    });

    it('hides untagged accounts from a sender-scoped caller', async () => {
      mockRepo.findOne.mockResolvedValue(makeAccount({ senderAddress: null }));

      await expect(service.findOne('uuid-1', senderACaller)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── findAll ─────────────────────────────────────────────────────────────

  describe('findAll', () => {
    function makeQueryBuilder(accounts: Account[], total: number) {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([accounts, total]),
      };
      return qb;
    }

    it('returns accounts and total', async () => {
      const accounts = [makeAccount()];
      mockRepo.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(accounts, 1),
      );
      const result = await service.findAll({ limit: 50, offset: 0 });
      expect(result.total).toBe(1);
      expect(result.accounts).toHaveLength(1);
    });
    it('excludes soft-deleted accounts by default', async () => {
      const qb = makeQueryBuilder([], 0);
      mockRepo.createQueryBuilder.mockReturnValue(qb);
      await service.findAll({ limit: 50, offset: 0 });
      expect(qb.where).toHaveBeenCalledWith('account.deletedAt IS NULL');
    });
    it('applies status filter when provided', async () => {
      const qb = makeQueryBuilder([], 0);
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({
        status: AccountStatus.PENDING_PAYMENT,
        limit: 10,
        offset: 0,
      });

      expect(qb.andWhere).toHaveBeenCalledWith(
        'account.status = :status',
        expect.objectContaining({ status: AccountStatus.PENDING_PAYMENT }),
      );
    });

    it('caps limit at 100', async () => {
      const qb = makeQueryBuilder([], 0);
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({ limit: 999, offset: 0 });

      expect(qb.take).toHaveBeenCalledWith(100);
    });

    it('returns empty list when no accounts match', async () => {
      mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([], 0));

      const result = await service.findAll({ limit: 50, offset: 0 });

      expect(result.total).toBe(0);
      expect(result.accounts).toHaveLength(0);
    });

    // #825: listing scope
    it('filters by the caller sender address for a sender-scoped token', async () => {
      const qb = makeQueryBuilder([], 0);
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({ limit: 50, offset: 0 }, senderACaller);

      expect(qb.andWhere).toHaveBeenCalledWith(
        'account.senderAddress = :senderAddress',
        { senderAddress: SENDER_A },
      );
    });

    it('does not filter by sender for an admin-scoped token', async () => {
      const qb = makeQueryBuilder([], 0);
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({ limit: 50, offset: 0 }, ADMIN_CALLER);

      expect(qb.andWhere).not.toHaveBeenCalledWith(
        'account.senderAddress = :senderAddress',
        expect.anything(),
      );
    });
  });
});
