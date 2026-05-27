// Shared client config: the worker API base, the public Google OAuth client id, and
// the per-device id that scopes device-local BYOK keys (never synced across devices).
export const API = (import.meta.env.VITE_ORTHA_API as string | undefined) ?? "https://ortha-edge.almahmud-zero.workers.dev";

// Public OAuth web client id — safe to ship in the bundle. Empty disables Google sign-in.
export const GOOGLE_CLIENT_ID =
  (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ??
  "1044864752824-4nchd1eg5rrjrnf436ef73mfg5u44g8i.apps.googleusercontent.com";

const DEVICE_KEY = "ortha.device";

/** Stable per-browser id. BYOK keys are scoped to it, so keys never sync across devices. */
export function getDeviceId(): string {
  if (typeof localStorage === "undefined") return "device-local";
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}
