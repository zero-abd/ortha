// @ortha/auth — KeyVault (BYOK secret store) + AuthService, built on WebCrypto
// only (globalThis.crypto.subtle), so the same code runs on Node 22 and
// Cloudflare Workers with no native crypto dependency. Keys are AES-256-GCM
// encrypted at rest; passwords are PBKDF2-hashed; getKey decrypts server-side
// only and never appears in metadata, logs, or API responses.
export { createKeyVault, type KeyVaultDeps } from "./vault.js";
export {
  createAuthService,
  type AuthServiceDeps,
  type GoogleCodeExchanger,
  type SessionStore,
  type UserRecord,
  type UserStore,
  type WorkspaceStore,
} from "./auth.js";
export {
  createMemorySessionStore,
  createMemoryUserStore,
  createMemoryWorkspaceStore,
} from "./memory.js";
export { createMemoryStore, type KVStore } from "./store.js";
