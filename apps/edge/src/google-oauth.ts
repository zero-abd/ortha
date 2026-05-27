// Google OAuth: exchange an authorization code for the user's verified email.
// Implements @ortha/auth's GoogleCodeExchanger. Feature-flagged on GOOGLE_CLIENT_ID/SECRET.
import type { GoogleCodeExchanger } from "@ortha/auth";
import type { Env } from "./env.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Build an exchanger bound to this request's `redirect_uri` (Google requires the
 * token-exchange redirect_uri to match the one used in the consent request). Returns
 * null when Google sign-in isn't configured, so the route can 501 cleanly.
 */
export function makeGoogleExchanger(env: Env, redirectUri: string): GoogleCodeExchanger | null {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return async (code: string) => {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!res.ok) throw new Error(`google token exchange ${res.status}`);
    const data = (await res.json()) as { id_token?: string };
    if (!data.id_token) throw new Error("google response missing id_token");
    const claims = decodeJwtPayload(data.id_token);
    const email = claims?.["email"];
    if (typeof email !== "string") throw new Error("google id_token missing email");
    if (claims?.["email_verified"] === false) throw new Error("google email not verified");
    return { email };
  };
}

/**
 * Decode (not cryptographically verify) a JWT payload. The id_token arrives over TLS
 * directly from Google's token endpoint — not via the client — so the channel is the
 * trust anchor here. Full JWKS signature verification is a hardening follow-up.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
