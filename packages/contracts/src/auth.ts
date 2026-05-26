import type { ProviderId } from "./llm.js";
import type { UserId, WorkspaceId } from "./ids.js";

export interface Session {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly token: string;
  readonly expiresAt: number;
}

export interface AuthService {
  signupEmail(email: string, password: string): Promise<Session>;
  loginEmail(email: string, password: string): Promise<Session>;
  /** Exchange a Google OAuth authorization code for a session. */
  loginGoogle(oauthCode: string): Promise<Session>;
  session(token: string): Promise<Session | null>;
}

/** Keys we hold on a workspace's behalf: the Orthogonal key + per-LLM-provider keys. */
export type KeyProvider = "orthogonal" | ProviderId;

export type KeyStatus = "active" | "revoked";

export interface KeyMetadata {
  readonly provider: KeyProvider;
  readonly version: number;
  readonly status: KeyStatus;
  /** Last 4 chars for display. Plaintext is NEVER returned here. */
  readonly hint: string;
}

/**
 * BYOK secret store. Keys are encrypted at rest (Worker-secret master key) and
 * decrypted only server-side in the harness. `getKey` must never be exposed to a
 * client path, logged, or returned in an API response. Supports rotation/revocation.
 */
export interface KeyVault {
  putKey(workspaceId: WorkspaceId, provider: KeyProvider, plaintext: string): Promise<void>;
  /** Server-only. Returns decrypted plaintext for the active key, or null. */
  getKey(workspaceId: WorkspaceId, provider: KeyProvider): Promise<string | null>;
  rotate(workspaceId: WorkspaceId, provider: KeyProvider, newPlaintext: string): Promise<void>;
  revoke(workspaceId: WorkspaceId, provider: KeyProvider): Promise<void>;
  /** Safe metadata for the settings UI — never plaintext. */
  listKeys(workspaceId: WorkspaceId): Promise<readonly KeyMetadata[]>;
}
