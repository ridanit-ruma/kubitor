import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

/**
 * Raise these to strengthen new hashes; existing hashes keep verifying because
 * the parameters travel inside the stored string.
 *
 * N = 2^14 costs roughly 16 MB per hash. Higher is stronger, but it also
 * multiplies the memory a login flood can pin, and this server runs in a small
 * pod. Per-IP throttling is what bounds concurrency.
 */
export const SCRYPT_PARAMS: ScryptParams = { N: 1 << 14, r: 8, p: 1, keylen: 32 };

/**
 * Ceilings applied when reading parameters back out of a stored hash. Without
 * them a stored value with an absurd N would make verification allocate
 * gigabytes before failing.
 */
const LIMITS = { N: 1 << 16, r: 32, p: 16, keylen: 64 };

const SCHEME = 'scrypt';

function derive(plain: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      // Normalize so the same typed password matches regardless of how the
      // client encoded its accents.
      plain.normalize('NFKC'),
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(
  plain: string,
  params: ScryptParams = SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(plain, salt, params);

  return [SCHEME, params.N, params.r, params.p, salt.toString('hex'), key.toString('hex')].join(
    '$',
  );
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return false;

  try {
    const key = await derive(plain, parsed.salt, parsed.params);
    return key.length === parsed.expected.length && timingSafeEqual(key, parsed.expected);
  } catch {
    return false;
  }
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  expected: Buffer;
}

function parseStored(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6) return null;

  const [scheme, rawN, rawR, rawP, saltHex, hashHex] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (scheme !== SCHEME) return null;

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!isBoundedInteger(N, LIMITS.N) || !isBoundedInteger(r, LIMITS.r)) return null;
  if (!isBoundedInteger(p, LIMITS.p)) return null;
  // scrypt requires N to be a power of two greater than one.
  if ((N & (N - 1)) !== 0 || N < 2) return null;

  const salt = fromHex(saltHex);
  const expected = fromHex(hashHex);
  if (!salt || !expected || salt.length === 0) return null;
  if (expected.length === 0 || expected.length > LIMITS.keylen) return null;

  return { params: { N, r, p, keylen: expected.length }, salt, expected };
}

function isBoundedInteger(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= max;
}

function fromHex(value: string): Buffer | null {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(value)) return null;
  return Buffer.from(value, 'hex');
}
