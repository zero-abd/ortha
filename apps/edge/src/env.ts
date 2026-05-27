/** Cloudflare bindings available to the Worker + Durable Object. */
export interface Env {
  /** Relational mirror / cross-conversation index. */
  DB: D1Database;
  /** Sessions, dedupe/result cache, price index, circuit-breaker state. */
  KV: KVNamespace;
  /** One instance per conversation. */
  CONVERSATION_DO: DurableObjectNamespace;
  /** Master key that encrypts per-device BYOK keys at rest (wrangler secret). */
  KEY_ENCRYPTION_KEY: string;
  /** Google OAuth web client id (public). Unset → Google sign-in disabled. */
  GOOGLE_CLIENT_ID?: string;
  /** Google OAuth client secret (wrangler secret). Required for Google sign-in. */
  GOOGLE_CLIENT_SECRET?: string;
}
