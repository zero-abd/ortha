// Production-backed implementations of the @ortha/auth store ports:
//   - users + workspaces → D1 (relational, durable)
//   - sessions → KV with native TTL (fast per-request reads, auto-expiry)
import { asUserId, asWorkspaceId, type Session, type UserId, type Workspace } from "@ortha/contracts";
import type { SessionStore, UserRecord, UserStore, WorkspaceStore } from "@ortha/auth";
import type { AsyncSqlDb, SqlRow } from "@ortha/db";

function toUser(r: SqlRow): UserRecord {
  return {
    id: asUserId(String(r["id"])),
    email: String(r["email"]),
    displayName: r["displayName"] == null ? null : String(r["displayName"]),
    createdAt: Number(r["createdAt"]),
    ...(r["saltB64"] == null ? {} : { saltB64: String(r["saltB64"]) }),
    ...(r["hashB64"] == null ? {} : { hashB64: String(r["hashB64"]) }),
  };
}

/** D1-backed UserStore. Email is the unique login key (idx_users_email). */
export function d1UserStore(db: AsyncSqlDb): UserStore {
  return {
    async findByEmail(email) {
      const row = await db.get(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase()]);
      return row ? toUser(row) : null;
    },
    async findById(id) {
      const row = await db.get(`SELECT * FROM users WHERE id = ?`, [id]);
      return row ? toUser(row) : null;
    },
    async create(user) {
      await db.run(
        `INSERT INTO users (id, email, displayName, createdAt, saltB64, hashB64) VALUES (?, ?, ?, ?, ?, ?)`,
        [user.id, user.email, user.displayName, user.createdAt, user.saltB64 ?? null, user.hashB64 ?? null],
      );
    },
  };
}

/** D1-backed WorkspaceStore. One owner workspace per user, tracked via memberships(role='owner'). */
export function d1WorkspaceStore(db: AsyncSqlDb): WorkspaceStore {
  return {
    async findByOwner(userId: UserId) {
      const row = await db.get(
        `SELECT w.* FROM workspaces w
           JOIN memberships m ON m.workspaceId = w.id
          WHERE m.userId = ? AND m.role = 'owner'`,
        [userId],
      );
      return row ? { id: asWorkspaceId(String(row["id"])), name: String(row["name"]), createdAt: Number(row["createdAt"]) } : null;
    },
    async create(workspace: Workspace, ownerId: UserId) {
      await db.run(`INSERT INTO workspaces (id, name, createdAt) VALUES (?, ?, ?)`, [workspace.id, workspace.name, workspace.createdAt]);
      await db.run(`INSERT INTO memberships (userId, workspaceId, role) VALUES (?, ?, 'owner')`, [ownerId, workspace.id]);
    },
  };
}

/** KV-backed SessionStore. `session:<token>` with native TTL so expired tokens self-evict. */
export function kvSessionStore(kv: KVNamespace, now: () => number = Date.now): SessionStore {
  const key = (token: string): string => `session:${token}`;
  return {
    async put(session) {
      const ttlSec = Math.max(60, Math.floor((session.expiresAt - now()) / 1000));
      await kv.put(key(session.token), JSON.stringify(session), { expirationTtl: ttlSec });
    },
    async get(token) {
      const raw = await kv.get(key(token));
      return raw ? (JSON.parse(raw) as Session) : null;
    },
    async del(token) {
      await kv.delete(key(token));
    },
  };
}
