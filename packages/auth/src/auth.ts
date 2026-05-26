import {
  asUserId,
  asWorkspaceId,
  ErrorCode,
  OrthaError,
  type AuthService,
  type Session,
  type UserId,
  type Workspace,
  type WorkspaceId,
} from "@ortha/contracts";
import { hashPassword, randomToken, verifyPassword } from "./crypto.js";

/** A persisted user with its email/password credentials. */
export interface UserRecord {
  readonly id: UserId;
  readonly email: string;
  readonly displayName: string | null;
  readonly createdAt: number;
  /** Present for email/password users; absent for OAuth-only users. */
  readonly saltB64?: string;
  readonly hashB64?: string;
}

/** Injectable user store. Lookup is by lowercased email and by id. */
export interface UserStore {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: UserId): Promise<UserRecord | null>;
  create(user: UserRecord): Promise<void>;
}

/** Injectable session store. */
export interface SessionStore {
  put(session: Session): Promise<void>;
  get(token: string): Promise<Session | null>;
  del(token: string): Promise<void>;
}

/** Injectable workspace store. One workspace per user is created on first auth. */
export interface WorkspaceStore {
  findByOwner(userId: UserId): Promise<Workspace | null>;
  create(workspace: Workspace, ownerId: UserId): Promise<void>;
}

/** Exchanges a Google OAuth authorization code for the user's verified email. */
export type GoogleCodeExchanger = (oauthCode: string) => Promise<{ email: string }>;

export interface AuthServiceDeps {
  readonly users: UserStore;
  readonly sessions: SessionStore;
  readonly workspaces: WorkspaceStore;
  readonly exchangeGoogleCode: GoogleCodeExchanger;
  /** Session lifetime. Defaults to 7 days. */
  readonly sessionTtlMs?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
  /** Injectable id factory (defaults to random tokens). */
  readonly newId?: () => string;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const authError = (message: string): OrthaError => new OrthaError(ErrorCode.AUTH, message);
const badRequest = (message: string): OrthaError => new OrthaError(ErrorCode.BAD_REQUEST, message);
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { users, sessions, workspaces, exchangeGoogleCode } = deps;
  const ttlMs = deps.sessionTtlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomToken(16));

  /** Find-or-create the user's single workspace, returning its id. */
  async function ensureWorkspace(user: UserRecord): Promise<WorkspaceId> {
    const existing = await workspaces.findByOwner(user.id);
    if (existing) return existing.id;
    const workspace: Workspace = {
      id: asWorkspaceId(`ws_${newId()}`),
      name: `${user.email}'s workspace`,
      createdAt: now(),
    };
    await workspaces.create(workspace, user.id);
    return workspace.id;
  }

  async function mintSession(userId: UserId, workspaceId: WorkspaceId): Promise<Session> {
    const session: Session = {
      userId,
      workspaceId,
      token: randomToken(32),
      expiresAt: now() + ttlMs,
    };
    await sessions.put(session);
    return session;
  }

  async function startSession(user: UserRecord): Promise<Session> {
    const workspaceId = await ensureWorkspace(user);
    return mintSession(user.id, workspaceId);
  }

  return {
    async signupEmail(email, password) {
      const normalized = normalizeEmail(email);
      if (!normalized.includes("@")) throw badRequest("invalid email");
      if (password.length < 8) throw badRequest("password must be at least 8 characters");
      if (await users.findByEmail(normalized)) throw authError("email already registered");

      const { saltB64, hashB64 } = await hashPassword(password);
      const user: UserRecord = {
        id: asUserId(`usr_${newId()}`),
        email: normalized,
        displayName: null,
        createdAt: now(),
        saltB64,
        hashB64,
      };
      await users.create(user);
      return startSession(user);
    },

    async loginEmail(email, password) {
      const normalized = normalizeEmail(email);
      const user = await users.findByEmail(normalized);
      if (!user || user.saltB64 === undefined || user.hashB64 === undefined) {
        throw authError("invalid email or password");
      }
      const ok = await verifyPassword(password, { saltB64: user.saltB64, hashB64: user.hashB64 });
      if (!ok) throw authError("invalid email or password");
      return startSession(user);
    },

    async loginGoogle(oauthCode) {
      let email: string;
      try {
        ({ email } = await exchangeGoogleCode(oauthCode));
      } catch (cause) {
        throw new OrthaError(ErrorCode.AUTH, "google code exchange failed", { cause });
      }
      const normalized = normalizeEmail(email);
      if (!normalized.includes("@")) throw authError("google returned no usable email");

      let user = await users.findByEmail(normalized);
      if (!user) {
        user = {
          id: asUserId(`usr_${newId()}`),
          email: normalized,
          displayName: null,
          createdAt: now(),
        };
        await users.create(user);
      }
      return startSession(user);
    },

    async session(token) {
      const session = await sessions.get(token);
      if (!session) return null;
      if (session.expiresAt <= now()) {
        await sessions.del(token);
        return null;
      }
      return session;
    },
  };
}
