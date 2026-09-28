import { pbkdf2, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt nativo do Node: sem dependência nativa extra. Formato: scrypt$N$r$p$salt$hash (base64url)
const N = 16384, R = 8, P = 1, KEYLEN = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/**
 * Senhas trazidas do app antigo (artefato): PBKDF2-SHA256, 120 mil iterações, sal em
 * texto. Guardadas como legacy-pbkdf2$<sal>$<hex> e trocadas por scrypt no primeiro login.
 */
export const LEGACY_PREFIX = 'legacy-pbkdf2$';
export const isLegacyHash = (stored: string) => stored.startsWith(LEGACY_PREFIX);

function verifyLegacy(password: string, stored: string): Promise<boolean> {
  const [, salt, hex] = stored.split('$');
  if (!salt || !/^[0-9a-f]{64}$/.test(hex ?? '')) return Promise.resolve(false);
  return new Promise((resolve, reject) =>
    pbkdf2(Buffer.from(password, 'utf8'), Buffer.from(salt, 'utf8'), 120000, 32, 'sha256', (err, key) => {
      if (err) return reject(err);
      const expected = Buffer.from(hex, 'hex');
      resolve(key.length === expected.length && timingSafeEqual(key, expected));
    }));
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (isLegacyHash(stored)) return verifyLegacy(password, stored);
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Hash fixo usado quando o usuário não existe, para o login levar o mesmo tempo. */
export const DUMMY_HASH = await hashPassword('senha-que-ninguem-usa');
