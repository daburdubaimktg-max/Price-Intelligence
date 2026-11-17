import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: SCRYPT.maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** scrypt password hash, encoded as `scrypt$N$r$p$salt$hash` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64!, 'base64url');
  const actual = await scrypt(password, Buffer.from(saltB64!, 'base64url'), Number(n), Number(r), Number(p), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Minimum bar for user-chosen passwords. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters long';
  if (password.length > 200) return 'Password is too long';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return 'Password must contain letters and numbers';
  return null;
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function newToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomPassword(): string {
  // 18 random bytes → 24 url-safe characters, always containing letters and digits by construction below.
  return `${crypto.randomBytes(15).toString('base64url')}7x`;
}

/** Authenticated encryption for integration credentials stored in the database. */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyMaterial: string | Buffer) {
    // Any length of key material is accepted and stretched to 32 bytes.
    this.key = crypto.createHash('sha256').update(keyMaterial).digest();
  }

  encrypt(plaintext: string): { ciphertext: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }

  decrypt(box: { ciphertext: string; iv: string; tag: string }): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
}

/** Uses PIOS_SECRET_KEY when provided; otherwise creates (once) a random key file in the data directory. */
export function loadSecretBox(config: Config): SecretBox {
  if (config.secretKey) return new SecretBox(config.secretKey);
  const keyFile = path.join(config.dataDir, 'secret.key');
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return new SecretBox(fs.readFileSync(keyFile, 'utf8').trim());
}
