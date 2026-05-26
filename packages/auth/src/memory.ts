import type { Session, UserId, Workspace } from "@ortha/contracts";
import type { SessionStore, UserRecord, UserStore, WorkspaceStore } from "./auth.js";

/** Map-backed UserStore for tests and local dev. */
export function createMemoryUserStore(): UserStore {
  const byId = new Map<UserId, UserRecord>();
  const idByEmail = new Map<string, UserId>();
  return {
    async findByEmail(email) {
      const id = idByEmail.get(email.toLowerCase());
      return id === undefined ? null : byId.get(id) ?? null;
    },
    async findById(id) {
      return byId.get(id) ?? null;
    },
    async create(user) {
      byId.set(user.id, user);
      idByEmail.set(user.email.toLowerCase(), user.id);
    },
  };
}

/** Map-backed SessionStore for tests and local dev. */
export function createMemorySessionStore(): SessionStore {
  const byToken = new Map<string, Session>();
  return {
    async put(session) {
      byToken.set(session.token, session);
    },
    async get(token) {
      return byToken.get(token) ?? null;
    },
    async del(token) {
      byToken.delete(token);
    },
  };
}

/** Map-backed WorkspaceStore (one workspace per owner) for tests and local dev. */
export function createMemoryWorkspaceStore(): WorkspaceStore {
  const byOwner = new Map<UserId, Workspace>();
  return {
    async findByOwner(userId) {
      return byOwner.get(userId) ?? null;
    },
    async create(workspace, ownerId) {
      byOwner.set(ownerId, workspace);
    },
  };
}
