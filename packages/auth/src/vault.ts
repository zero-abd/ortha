import type { KeyMetadata, KeyProvider, KeyStatus, KeyVault, WorkspaceId } from "@ortha/contracts";
import { aesGcmDecrypt, aesGcmEncrypt, importAesKey } from "./crypto.js";
import type { KVStore } from "./store.js";

/**
 * The on-disk shape of a stored key. Plaintext is NEVER persisted — only the
 * AES-GCM ciphertext + IV. `hint` is the last-4 of the plaintext, safe to show.
 */
interface StoredKey {
  readonly ciphertext: string;
  readonly iv: string;
  readonly version: number;
  readonly status: KeyStatus;
  readonly hint: string;
}

export interface KeyVaultDeps {
  /** 32-byte AES-256 key, base64-encoded. Supplied as a Worker secret in prod. */
  readonly masterKeyBase64: string;
  readonly store: KVStore;
}

const PREFIX = "key:";
const storeKey = (workspaceId: WorkspaceId, provider: KeyProvider): string =>
  `${PREFIX}${workspaceId}:${provider}`;

/** Last 4 chars of the plaintext, for display. Short secrets are masked entirely. */
const hintOf = (plaintext: string): string => (plaintext.length <= 4 ? "" : plaintext.slice(-4));

export async function createKeyVault(deps: KeyVaultDeps): Promise<KeyVault> {
  const aesKey = await importAesKey(deps.masterKeyBase64);
  const { store } = deps;

  async function read(workspaceId: WorkspaceId, provider: KeyProvider): Promise<StoredKey | null> {
    const raw = await store.get(storeKey(workspaceId, provider));
    return raw === null ? null : (JSON.parse(raw) as StoredKey);
  }

  async function write(
    workspaceId: WorkspaceId,
    provider: KeyProvider,
    plaintext: string,
    version: number,
    status: KeyStatus,
  ): Promise<void> {
    const { ciphertextB64, ivB64 } = await aesGcmEncrypt(aesKey, plaintext);
    const record: StoredKey = {
      ciphertext: ciphertextB64,
      iv: ivB64,
      version,
      status,
      hint: hintOf(plaintext),
    };
    await store.put(storeKey(workspaceId, provider), JSON.stringify(record));
  }

  return {
    async putKey(workspaceId, provider, plaintext) {
      const existing = await read(workspaceId, provider);
      // First write starts at version 1; re-putting keeps the version line going.
      const version = existing ? existing.version + 1 : 1;
      await write(workspaceId, provider, plaintext, version, "active");
    },

    async getKey(workspaceId, provider) {
      const record = await read(workspaceId, provider);
      if (record === null || record.status === "revoked") return null;
      return aesGcmDecrypt(aesKey, { ciphertextB64: record.ciphertext, ivB64: record.iv });
    },

    async rotate(workspaceId, provider, newPlaintext) {
      const existing = await read(workspaceId, provider);
      const version = existing ? existing.version + 1 : 1;
      // Rotation re-activates: a rotated key is the new live key.
      await write(workspaceId, provider, newPlaintext, version, "active");
    },

    async revoke(workspaceId, provider) {
      const existing = await read(workspaceId, provider);
      if (existing === null) return;
      const record: StoredKey = { ...existing, status: "revoked" };
      await store.put(storeKey(workspaceId, provider), JSON.stringify(record));
    },

    async listKeys(workspaceId) {
      const keys = await store.list(`${PREFIX}${workspaceId}:`);
      const out: KeyMetadata[] = [];
      for (const k of keys) {
        const raw = await store.get(k);
        if (raw === null) continue;
        const record = JSON.parse(raw) as StoredKey;
        const provider = k.slice(`${PREFIX}${workspaceId}:`.length) as KeyProvider;
        // Metadata only — ciphertext/iv (and obviously plaintext) are dropped here.
        out.push({
          provider,
          version: record.version,
          status: record.status,
          hint: record.hint,
        });
      }
      return out;
    },
  };
}
