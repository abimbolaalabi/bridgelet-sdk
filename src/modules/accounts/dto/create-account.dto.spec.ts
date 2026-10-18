import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateAccountDto } from './create-account.dto.js';

// A real Ed25519 Stellar public key (valid StrKey checksum), plus
// deliberately mis-sized variants for the length-boundary tests below.
const VALID_KEY = 'GDV3BRGE2BXK5JMGAEDGE5QWAY2DBK5V2KEG762Y5GH4LPC5RSPRPTTJ'; // 56 chars  ✓
const SHORT_KEY = 'G' + 'A'.repeat(54); // 55 chars  ✗
const LONG_KEY = 'G' + 'A'.repeat(56); // 57 chars  ✗

// A fully valid base object — all tests override only the field under test
const validBase = {
  fundingSource: VALID_KEY,
  recovery_address: VALID_KEY,
  amount: '100',
  asset_code: 'USDC',
  asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  expiresIn: 3600,
};

function makeDto(overrides: Record<string, unknown>): CreateAccountDto {
  return plainToInstance(CreateAccountDto, { ...validBase, ...overrides });
}

async function errorsFor(
  overrides: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(makeDto(overrides));
  return errors.map((e) => e.property);
}

// ─── fundingSource ────────────────────────────────────────────────────────────

describe('CreateAccountDto — fundingSource', () => {
  it('accepts a valid Stellar public key (56 chars, starts with G, uppercase alphanumeric)', async () => {
    const errors = await errorsFor({ fundingSource: VALID_KEY });
    expect(errors).not.toContain('fundingSource');
  });

  it('rejects a key that is too short (55 chars)', async () => {
    const errors = await errorsFor({ fundingSource: SHORT_KEY });
    expect(errors).toContain('fundingSource');
  });

  it('rejects a key that is too long (57 chars)', async () => {
    const errors = await errorsFor({ fundingSource: LONG_KEY });
    expect(errors).toContain('fundingSource');
  });

  it('rejects a key that starts with a lowercase letter', async () => {
    const errors = await errorsFor({ fundingSource: 'g' + 'A'.repeat(55) });
    expect(errors).toContain('fundingSource');
  });

  it('rejects a key that starts with a non-G uppercase letter (e.g. A)', async () => {
    const errors = await errorsFor({ fundingSource: 'A' + 'A'.repeat(55) });
    expect(errors).toContain('fundingSource');
  });

  it('rejects a key containing a special character', async () => {
    const errors = await errorsFor({
      fundingSource: 'G' + 'A'.repeat(54) + '!',
    });
    expect(errors).toContain('fundingSource');
  });

  it('rejects an empty string', async () => {
    const errors = await errorsFor({ fundingSource: '' });
    expect(errors).toContain('fundingSource');
  });
});

// ─── recovery_address ─────────────────────────────────────────────────────────

describe('CreateAccountDto — recovery_address', () => {
  it('accepts a valid Stellar public key', async () => {
    const errors = await errorsFor({ recovery_address: VALID_KEY });
    expect(errors).not.toContain('recovery_address');
  });

  it('rejects a key that is too short', async () => {
    const errors = await errorsFor({ recovery_address: SHORT_KEY });
    expect(errors).toContain('recovery_address');
  });

  it('rejects a key that is too long', async () => {
    const errors = await errorsFor({ recovery_address: LONG_KEY });
    expect(errors).toContain('recovery_address');
  });

  it('rejects a key not starting with G', async () => {
    const errors = await errorsFor({ recovery_address: 'A' + 'A'.repeat(55) });
    expect(errors).toContain('recovery_address');
  });

  it('rejects an empty string', async () => {
    const errors = await errorsFor({ recovery_address: '' });
    expect(errors).toContain('recovery_address');
  });

  it('rejects when missing', async () => {
    const errors = await errorsFor({ recovery_address: undefined });
    expect(errors).toContain('recovery_address');
  });
});

// ─── asset_code ───────────────────────────────────────────────────────────────

describe('CreateAccountDto — asset_code', () => {
  it('accepts a valid uppercase asset code', async () => {
    const errors = await errorsFor({ asset_code: 'USDC' });
    expect(errors).not.toContain('asset_code');
  });

  it('accepts a single-character code', async () => {
    const errors = await errorsFor({
      asset_code: 'X',
      asset_issuer: undefined,
    });
    expect(errors).not.toContain('asset_code');
  });

  it('accepts a 12-character code (max length)', async () => {
    const errors = await errorsFor({ asset_code: 'ABCDEFGHIJ12' });
    expect(errors).not.toContain('asset_code');
  });

  it('rejects a lowercase code', async () => {
    const errors = await errorsFor({ asset_code: 'usdc' });
    expect(errors).toContain('asset_code');
  });

  it('rejects a code longer than 12 characters', async () => {
    const errors = await errorsFor({ asset_code: 'TOOLONGCODE1X' });
    expect(errors).toContain('asset_code');
  });

  it('rejects a code with special characters', async () => {
    const errors = await errorsFor({ asset_code: 'USD!' });
    expect(errors).toContain('asset_code');
  });

  it('is optional — omitting it produces no error', async () => {
    const errors = await errorsFor({
      asset_code: undefined,
      asset_issuer: undefined,
    });
    expect(errors).not.toContain('asset_code');
  });
});

// ─── asset_issuer ─────────────────────────────────────────────────────────────

describe('CreateAccountDto — asset_issuer', () => {
  it('accepts a valid Stellar public key as issuer', async () => {
    const errors = await errorsFor({
      asset_code: 'USDC',
      asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    });
    expect(errors).not.toContain('asset_issuer');
  });

  it('rejects an invalid issuer key (wrong length)', async () => {
    const errors = await errorsFor({
      asset_code: 'USDC',
      asset_issuer: 'GBADISSUER',
    });
    expect(errors).toContain('asset_issuer');
  });

  it('rejects an issuer not starting with G', async () => {
    const errors = await errorsFor({
      asset_code: 'USDC',
      asset_issuer: 'ABBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    });
    expect(errors).toContain('asset_issuer');
  });

  it('is not required when asset_code is absent', async () => {
    const errors = await errorsFor({
      asset_code: undefined,
      asset_issuer: undefined,
    });
    expect(errors).not.toContain('asset_issuer');
  });
});

// ─── asset_code / asset_issuer combinations ────────────────────────────────
// Verified for #924 (duplicate of the already-resolved #638/#699, fixed in
// PR #771). These are the four exhaustive presence combinations for the two
// optional fields.
// asset_issuer's @ValidateIf only requires it when asset_code is set, so:
// - asset_code alone correctly fails validation (asset_issuer required) —
//   AccountsService.create() would otherwise fall back to `asset_code` as a
//   bare string with no issuer.
// - asset_issuer alone passes validation untouched (the actual gap):
//   AccountsService.create() then falls back to `asset_code ?? 'native'`,
//   silently dropping the issuer entirely.
describe('CreateAccountDto — asset_code/asset_issuer combination', () => {
  it('accepts both asset_code and asset_issuer when they are valid', async () => {
    const errors = await errorsFor({});

    expect(errors).not.toContain('asset_code');
    expect(errors).not.toContain('asset_issuer');
  });

  it('does not flag asset_issuer when asset_code is missing (silently dropped later)', async () => {
    const errors = await errorsFor({
      asset_code: undefined,
      asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    });
    expect(errors).not.toContain('asset_issuer');
    expect(errors).not.toContain('asset_code');
  });

  it('flags asset_issuer as required when asset_code is provided alone', async () => {
    const errors = await errorsFor({
      asset_code: 'USDC',
      asset_issuer: undefined,
    });
    expect(errors).not.toContain('asset_code');
    expect(errors).toContain('asset_issuer');
  });

  it('accepts neither field, falling back to native in the service', async () => {
    const errors = await errorsFor({
      asset_code: undefined,
      asset_issuer: undefined,
    });

    expect(errors).not.toContain('asset_code');
    expect(errors).not.toContain('asset_issuer');
  });
});
