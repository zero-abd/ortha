export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-ortha-device",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

/** Extract the bearer session token from the Authorization header. */
export function bearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

/**
 * Validate the per-device id (the BYOK key scope). Keys are device-local and never
 * sync, so they're keyed by this id rather than the account's workspace.
 */
export function deviceOf(request: Request): string | null {
  const d = request.headers.get("x-ortha-device");
  return d && /^[a-zA-Z0-9_-]{6,64}$/.test(d) ? d : null;
}
