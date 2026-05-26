// Shared client config: the worker API base and the per-browser anonymous
// workspace id (BYOK scope). The id is a random UUID kept in localStorage; it
// scopes this browser's stored keys + settings on the worker.
export const API = (import.meta.env.VITE_ORTHA_API as string | undefined) ?? "https://ortha-edge.almahmud-zero.workers.dev";

const WS_KEY = "ortha.workspace";

export function getWorkspaceId(): string {
  if (typeof localStorage === "undefined") return "anon-local";
  let id = localStorage.getItem(WS_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(WS_KEY, id);
  }
  return id;
}
