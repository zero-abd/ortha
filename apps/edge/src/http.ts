export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-ortha-workspace",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

/** Validates the per-browser workspace id supplied by the client (anonymous BYOK scope). */
export function workspaceOf(request: Request): string | null {
  const ws = request.headers.get("x-ortha-workspace");
  return ws && /^[a-zA-Z0-9_-]{6,64}$/.test(ws) ? ws : null;
}
