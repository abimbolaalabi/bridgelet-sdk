import * as crypto from 'crypto';

/**
 * SecretEncryptionUtil
 *
 * Shared AES-256-GCM encryption utility for ephemeral account secret keys.
 * Used by AccountsService (encrypt on creation) and ClaimRedemptionProvider
 * (decrypt on claim redemption). Both must always use this single implementation
 * - never inline encrypt/decrypt logic elsewhere.
 *
 * Encrypted format (v1, current):
 *   aes256gcm:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 *
 * Encrypted format (v2, key-id tagged — used for rotation, see issue #681):
 *   aes256gcm:v2:<keyId>:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 *
 * Format changelog
 * ───────────────
 * • v2 — same AES-256-GCM as v1 but carries the id of the key that produced
 *   it. This is what makes a rotation possible without a flag day: during a
 *   rotation window the decrypt path holds a key ring (current + previous)
 *   and picks the right key from the tag instead of guessing. Written only
 *   when a key id is supplied (see `encryptWithKeyId`); v1 remains the
 *   default so existing deployments keep writing the format they can read.
 * • v1 (current default) ─ `aes256gcm:v1:` prefix + 16-byte random IV + 16-byte
 *   GCM auth tag + ciphertext (all hex-encoded, colon-separated). The prefix
 *   lets us detect format and crash clearly on rows from unknown versions
 *   rather than silently mis-decoding.
 * • unprefixed ─ legacy AES-256-GCM rows from the pre-PR #193 era that did
 *   not carry the version prefix. decrypt() still accepts these for the
 *   migration window, but new writes always emit `v1`.
 * • plain base64 ─ pre-AES MVP placeholder. decrypt() rejects with a
 *   descriptive error pointing operators at scripts/migrate-secrets.ts.
 *
 * Verified for #834: decrypt() accepts v1, v2, and legacy unprefixed
 * ciphertexts, but rejects plain base64 rows with an error directing
 * operators to `src/scripts/migrate-secrets.ts`. Operators can identify
 * remaining legacy rows using `npm run audit:secrets` against an extracted
 * ciphertext set (e.g. `SELECT "secretKeyEncrypted" FROM accounts`), which is
 * the recommended way to determine when the legacy branches can be removed.
 *
 * Key requirements:
 * - Must be a 32-byte value provided as a 64-character hex string
 * - Sourced from ENCRYPTION_KEY environment variable (or the KMS data key)
 * - Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

/** Resolves a key id to its 64-char hex key material. Returns undefined when unknown. */
export type KeyResolver = (keyId: string) => string | undefined;

export class SecretEncryptionUtil {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_LENGTH = 16;
  private static readonly AUTH_TAG_LENGTH = 16;
  private static readonly PREFIX_V1 = 'aes256gcm:v1:';
  private static readonly PREFIX_V2 = 'aes256gcm:v2:';
  private static readonly PREFIX_PATTERN = /^aes256gcm:v(\d+):(.*)$/;
  /** keyId segment: no colons, and not empty — it delimits the v2 body. */
  private static readonly KEY_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

  /**
   * Resolves a key id to its 64-char hex key material. Returns undefined when
   * the id is unknown to the current key ring.
   */

  static encrypt(plaintext: string, encryptionKey: string): string {
    return SecretEncryptionUtil.encryptWithKeyId(
      plaintext,
      encryptionKey,
      undefined,
    );
  }

  /**
   * Encrypts `plaintext`, tagging the output with `keyId` so a later decrypt
   * can select the correct key from a key ring (issue #681).
   *
   * Passing no `keyId` emits the v1 format, which is what
   * {@link encrypt} does and what existing deployments expect.
   */
  static encryptWithKeyId(
    plaintext: string,
    encryptionKey: string,
    keyId?: string,
  ): string {
    const key = SecretEncryptionUtil.parseKey(encryptionKey);
    const iv = crypto.randomBytes(SecretEncryptionUtil.IV_LENGTH);
    const cipher = crypto.createCipheriv(
      SecretEncryptionUtil.ALGORITHM,
      key,
      iv,
    );
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const body = [
      iv.toString('hex'),
      authTag.toString('hex'),
      encrypted.toString('hex'),
    ].join(':');

    if (keyId === undefined) {
      return SecretEncryptionUtil.PREFIX_V1 + body;
    }

    if (!SecretEncryptionUtil.KEY_ID_PATTERN.test(keyId)) {
      throw new Error(
        `Invalid keyId "${keyId}". Must be 1-64 characters of [A-Za-z0-9_.-]; ` +
          'colons are reserved as format separators.',
      );
    }
    return SecretEncryptionUtil.PREFIX_V2 + `${keyId}:${body}`;
  }

  /**
   * Decrypts a stored value.
   *
   * @param encryptedString the stored ciphertext
   * @param encryptionKey the current key, used for v1 / unprefixed / base64 rows
   * @param keyResolver required only for key-id tagged (v2) ciphertext: maps
   *   the embedded key id to its key material. Omit it and a v2 value fails
   *   loudly rather than being mis-decoded with the wrong key.
   */
  static decrypt(
    encryptedString: string,
    encryptionKey: string,
    keyResolver?: KeyResolver,
  ): string {
    const key = SecretEncryptionUtil.parseKey(encryptionKey);

    // Handle v1+ prefixed payloads explicitly. Unknown versions (e.g. v3) must
    // crash loudly so we never silently decode with the wrong algorithm.
    const prefixMatch = encryptedString.match(
      SecretEncryptionUtil.PREFIX_PATTERN,
    );
    if (prefixMatch) {
      const version = parseInt(prefixMatch[1] ?? '', 10);
      const body = prefixMatch[2] ?? '';

      if (version === 2) {
        return SecretEncryptionUtil.decryptKeyIdTagged(body, keyResolver);
      }

      if (version !== 1) {
        throw new Error(
          `Encrypted payload uses aes256gcm:v${version}: which is not supported by this build. ` +
            'Roll forward to a build that supports this format version before redeploying.',
        );
      }
      return SecretEncryptionUtil.decryptBody(body, key, 'aes256gcm:v1');
    }

    // No prefix: either legacy AES-256-GCM hex (3 colon-separated hex parts
    // with correct IV/authTag lengths) or the legacy MVP base64 placeholder.
    // We accept unprefixed AES rows only during the migration window so a
    // half-migrated database still decrypts.
    if (SecretEncryptionUtil.isAesGcmBody(encryptedString)) {
      return SecretEncryptionUtil.decryptBody(
        encryptedString,
        key,
        'unprefixed-aes',
      );
    }

    throw new Error(
      'Invalid encrypted format. Expected aes256gcm:v1:<iv>:<authTag>:<data> ' +
        '(or legacy unprefixed <iv>:<authTag>:<data>). ' +
        'This may be a legacy base64-encoded secret that has not been migrated. ' +
        'Run: npm run migrate:secrets -- --i-have-a-backup --execute',
    );
  }

  /**
   * Splits a v2 body into `<keyId>:<iv>:<authTag>:<data>` and decrypts with
   * the key the resolver returns for that id.
   */
  private static decryptKeyIdTagged(
    body: string,
    keyResolver: KeyResolver | undefined,
  ): string {
    const parts = body.split(':');
    if (parts.length !== 4) {
      throw new Error(
        'Invalid encrypted format (aes256gcm:v2): expected 4 colon-separated ' +
          `parts (keyId:iv:authTag:data), got ${parts.length}.`,
      );
    }
    const [keyId, ...rest] = parts;
    if (!keyId) {
      throw new Error(
        'Invalid encrypted format (aes256gcm:v2): keyId is empty.',
      );
    }
    if (!keyResolver) {
      throw new Error(
        `Encrypted payload is tagged with key id "${keyId}" but no key ring was ` +
          'supplied to resolve it. Pass a keyResolver (see SecretRotationUtil) ' +
          'so the correct key can be selected during a rotation window.',
      );
    }
    const resolved = keyResolver(keyId);
    if (resolved === undefined) {
      throw new Error(
        `Encrypted payload references unknown key id "${keyId}". The key ring ` +
          'does not contain it — either the rotation window has closed and the ' +
          'row still needs migrating, or the wrong key set is loaded.',
      );
    }
    return SecretEncryptionUtil.decryptBody(
      rest.join(':'),
      SecretEncryptionUtil.parseKey(resolved),
      `aes256gcm:v2:${keyId}`,
    );
  }

  /**
   * Pure, side-effect-free classifier used by scripts/migrate-secrets.ts and
   * its spec tests. Returns the bucketed format of a stored ciphertext.
   */
  static classify(encryptedString: string): SecretFormat {
    if (typeof encryptedString !== 'string' || encryptedString.length === 0) {
      return 'corrupt';
    }
    const prefixMatch = encryptedString.match(
      SecretEncryptionUtil.PREFIX_PATTERN,
    );
    if (prefixMatch) {
      const version = parseInt(prefixMatch[1] ?? '', 10);
      const body = prefixMatch[2] ?? '';
      if (version === 1 && SecretEncryptionUtil.isAesGcmBody(body)) {
        return 'prefixed-aes-v1';
      }
      if (version === 2 && SecretEncryptionUtil.isKeyIdTaggedBody(body)) {
        return 'prefixed-aes-v2';
      }
      return 'corrupt';
    }
    if (SecretEncryptionUtil.isAesGcmBody(encryptedString)) {
      return 'unprefixed-aes';
    }
    return 'legacy-base64';
  }

  /** Extracts the key id from a v2 payload, or null if it is not a valid v2. */
  static keyIdOf(encryptedString: string): string | null {
    if (SecretEncryptionUtil.classify(encryptedString) !== 'prefixed-aes-v2') {
      return null;
    }
    const body = encryptedString
      .slice(SecretEncryptionUtil.PREFIX_V2.length)
      .trimStart();
    return body.split(':')[0] ?? null;
  }

  private static decryptBody(
    body: string,
    key: Buffer,
    context: string,
  ): string {
    const parts = body.split(':');
    if (parts.length !== 3) {
      throw new Error(
        `Invalid encrypted format (${context}): expected 3 colon-separated parts (iv:authTag:data), got ${parts.length}.`,
      );
    }
    const [ivHex, authTagHex, dataHex] = parts;
    if (!ivHex || !authTagHex || !dataHex) {
      throw new Error(
        `Invalid encrypted format (${context}): one of iv / authTag / data is empty.`,
      );
    }
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');
    if (iv.length !== SecretEncryptionUtil.IV_LENGTH) {
      throw new Error(
        `Invalid IV length (${context}): expected ${SecretEncryptionUtil.IV_LENGTH} bytes, got ${iv.length}.`,
      );
    }
    if (authTag.length !== SecretEncryptionUtil.AUTH_TAG_LENGTH) {
      throw new Error(
        `Invalid authTag length (${context}): expected ${SecretEncryptionUtil.AUTH_TAG_LENGTH} bytes, got ${authTag.length}.`,
      );
    }
    const decipher = crypto.createDecipheriv(
      SecretEncryptionUtil.ALGORITHM,
      key,
      iv,
    );
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  }

  private static isAesGcmBody(value: string): boolean {
    if (typeof value !== 'string' || value.length === 0) return false;
    const parts = value.split(':');
    if (parts.length !== 3) return false;
    const ivHex = parts[0];
    const authTagHex = parts[1];
    const dataHex = parts[2];
    if (!ivHex || !authTagHex || !dataHex) return false;
    if (ivHex.length !== SecretEncryptionUtil.IV_LENGTH * 2) return false;
    if (authTagHex.length !== SecretEncryptionUtil.AUTH_TAG_LENGTH * 2)
      return false;
    if (ivHex.length === 0 || dataHex.length === 0) return false;
    if (
      !SecretEncryptionUtil.isHex(ivHex) ||
      !SecretEncryptionUtil.isHex(authTagHex) ||
      !SecretEncryptionUtil.isHex(dataHex)
    ) {
      return false;
    }
    return true;
  }

  /** `<keyId>:<iv>:<authTag>:<data>` with a well-formed keyId. */
  private static isKeyIdTaggedBody(value: string): boolean {
    const parts = value.split(':');
    if (parts.length !== 4) return false;
    const [keyId, ...aesParts] = parts;
    if (!keyId || !SecretEncryptionUtil.KEY_ID_PATTERN.test(keyId)) {
      return false;
    }
    return SecretEncryptionUtil.isAesGcmBody(aesParts.join(':'));
  }

  private static isHex(s: string): boolean {
    return /^[0-9a-fA-F]+$/.test(s);
  }

  private static parseKey(hexKey: string): Buffer {
    if (typeof hexKey !== 'string' || hexKey.length === 0) {
      throw new Error(
        'Encryption key must be a non-empty 64-character hex string.',
      );
    }
    const key = Buffer.from(hexKey, 'hex');
    if (key.length !== 32) {
      throw new Error(
        `Encryption key must be 32 bytes (64 hex characters). Got ${key.length} bytes. ` +
          "Generate a valid key with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }
    return key;
  }
}

export type SecretFormat =
  | 'prefixed-aes-v1'
  | 'prefixed-aes-v2'
  | 'unprefixed-aes'
  | 'legacy-base64'
  | 'corrupt';
