/**
 * Admin authentication (SPEC §10.9): the password check and the signed session cookie.
 *
 * - The password is compared in constant time: both strings are HMAC'd with a per-process random key and the
 *   digests compared with a branch-free loop, so neither the content nor the length of ADMIN_PASSWORD leaks.
 * - The session is stateless: `v1.<expiresAt>.<nonce>.<sig>` where `sig = HMAC-SHA256(key, "v1.<exp>.<nonce>")` and
 *   `key = HMAC-SHA256(SERVER_SECRET, "admin-session:" + ADMIN_PASSWORD)`. Rotating either secret logs every admin out.
 *   Logout revokes the nonce in memory until the cookie would have expired anyway.
 *
 * Web Crypto only (no `node:*`), so it ports to Workers unchanged.
 */

export const SESSION_COOKIE = 'g2g_admin';
export const SESSION_TTL_MS = 12 * 60 * 60_000;

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret: string | Uint8Array): Promise<CryptoKey> {
  const raw = typeof secret === 'string' ? enc.encode(secret) : new Uint8Array(secret);
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function hmac(key: CryptoKey, message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Branch-free equality of two byte arrays of equal length (false for different lengths). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

let compareKey: Promise<CryptoKey> | null = null;

/** Constant-time string comparison (via HMAC digests of a random per-process key). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  compareKey ??= hmacKey(crypto.getRandomValues(new Uint8Array(32)));
  const key = await compareKey;
  const [da, db] = await Promise.all([hmac(key, a), hmac(key, b)]);
  return bytesEqual(da, db);
}

export class AdminSessions {
  private readonly key: Promise<CryptoKey>;
  /** Revoked nonces → their expiry. */
  private readonly revoked = new Map<string, number>();

  constructor(
    serverSecret: string,
    adminPassword: string,
    private readonly clock: () => number,
    readonly ttlMs = SESSION_TTL_MS,
  ) {
    this.key = hmacKey(serverSecret).then(async (k) => hmacKey(await hmac(k, `admin-session:${adminPassword}`)));
  }

  /** A new session cookie value and its expiry. */
  async issue(): Promise<{ value: string; expiresAt: number }> {
    const expiresAt = this.clock() + this.ttlMs;
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const payload = `v1.${expiresAt}.${nonce}`;
    return { value: `${payload}.${b64url(await hmac(await this.key, payload))}`, expiresAt };
  }

  /** The expiry of a valid, unexpired, unrevoked cookie value; null otherwise. */
  async verify(value: string | undefined | null): Promise<{ expiresAt: number; nonce: string } | null> {
    if (!value || value.length > 200) return null;
    const m = /^v1\.(\d{1,16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!m) return null;
    const expiresAt = Number(m[1]);
    const nonce = m[2]!;
    const expected = b64url(await hmac(await this.key, `v1.${m[1]}.${nonce}`));
    if (!bytesEqual(enc.encode(expected), enc.encode(m[3]!))) return null;
    const now = this.clock();
    if (expiresAt <= now || expiresAt > now + this.ttlMs) return null;
    if (this.revoked.has(nonce)) return null;
    return { expiresAt, nonce };
  }

  /** Logout: the nonce stops working before its natural expiry. */
  revoke(nonce: string, expiresAt: number): void {
    const now = this.clock();
    for (const [n, exp] of this.revoked) if (exp <= now) this.revoked.delete(n);
    this.revoked.set(nonce, expiresAt);
  }
}
