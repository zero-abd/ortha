// WebCrypto-only primitives. Uses globalThis.crypto.subtle so the same code runs
// in Node 22 and Cloudflare Workers — no native crypto deps, no Buffer.

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto (crypto.subtle) is not available in this runtime");
  return c.subtle;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

/** base64 <-> bytes without relying on Buffer (Workers-safe). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export const utf8ToBytes = (s: string): Uint8Array => enc.encode(s);
export const bytesToUtf8 = (b: Uint8Array): string => dec.decode(b);

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

// ── AES-256-GCM (per-key envelope encryption for the vault) ──

const AES_IV_BYTES = 12; // 96-bit IV, the GCM standard.

/** Import a 256-bit AES-GCM key from a base64 master secret. */
export async function importAesKey(masterKeyBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(masterKeyBase64);
  if (raw.length !== 32) {
    throw new Error(`masterKeyBase64 must decode to 32 bytes (AES-256), got ${raw.length}`);
  }
  return subtle().importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export interface AesPayload {
  readonly ciphertextB64: string;
  readonly ivB64: string;
}

export async function aesGcmEncrypt(key: CryptoKey, plaintext: string): Promise<AesPayload> {
  const iv = randomBytes(AES_IV_BYTES);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, utf8ToBytes(plaintext) as BufferSource);
  return { ciphertextB64: bytesToBase64(new Uint8Array(ct)), ivB64: bytesToBase64(iv) };
}

export async function aesGcmDecrypt(key: CryptoKey, payload: AesPayload): Promise<string> {
  const iv = base64ToBytes(payload.ivB64);
  const ct = base64ToBytes(payload.ciphertextB64);
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct as BufferSource);
  return bytesToUtf8(new Uint8Array(pt));
}

// ── PBKDF2 password hashing ──

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH_BYTES = 32; // 256-bit derived hash.
const PBKDF2_SALT_BYTES = 16;

export interface PasswordHash {
  readonly saltB64: string;
  readonly hashB64: string;
}

async function derivePbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const baseKey = await subtle().importKey("raw", utf8ToBytes(password) as BufferSource, { name: "PBKDF2" }, false, [
    "deriveBits",
  ]);
  const bits = await subtle().deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    PBKDF2_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const hash = await derivePbkdf2(password, salt);
  return { saltB64: bytesToBase64(salt), hashB64: bytesToBase64(hash) };
}

/** Constant-time-ish verify: re-derive with the stored salt and compare. */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const salt = base64ToBytes(stored.saltB64);
  const candidate = await derivePbkdf2(password, salt);
  const expected = base64ToBytes(stored.hashB64);
  return timingSafeEqual(candidate, expected);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** A random opaque token (base64url) for session/id material. */
export function randomToken(byteLength = 32): string {
  return bytesToBase64(randomBytes(byteLength)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
