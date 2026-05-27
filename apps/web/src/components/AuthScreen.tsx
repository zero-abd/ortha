import { useState, type FormEvent } from "react";
import { GOOGLE_CLIENT_ID } from "../lib/config.ts";
import { login, me, signup, type AuthUser } from "../lib/auth.ts";
import { Logo } from "./Logo.tsx";

/** Login / signup gate. Required before the app loads. */
export function AuthScreen({ onAuthed }: { onAuthed: (u: AuthUser) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") await signup(email.trim(), password);
      else await login(email.trim(), password);
      const u = await me();
      if (u) onAuthed(u);
      else setError("Signed in, but couldn't load your account. Try again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  // Redirect to Google's consent screen; the app handles the returned ?code= on load.
  const startGoogle = (): void => {
    const redirectUri = window.location.origin + window.location.pathname;
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      prompt: "select_account",
      state: crypto.randomUUID(),
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  };

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={(e) => void submit(e)}>
        <div className="auth__brand">
          <Logo size={26} />
          <span className="brand__word">Ortha</span>
        </div>
        <h1 className="auth__title">{mode === "login" ? "Welcome back" : "Create your account"}</h1>
        <p className="auth__sub">
          {mode === "login" ? "Sign in to pick up your chats on any device." : "Sign up to save and sync your chats across devices."}
        </p>

        {GOOGLE_CLIENT_ID ? (
          <>
            <button type="button" className="auth__google" onClick={startGoogle} disabled={busy}>
              <GoogleMark />
              <span>Continue with Google</span>
            </button>
            <div className="auth__or">
              <span>or</span>
            </div>
          </>
        ) : null}

        <input
          className="input"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="input"
          type="password"
          placeholder={mode === "signup" ? "Choose a password (8+ characters)" : "Password"}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        {error ? <div className="auth__error">{error}</div> : null}
        <button className="btn-primary auth__submit" type="submit" disabled={busy}>
          <span className="btn-primary__label">{busy ? "…" : mode === "login" ? "Sign in" : "Create account"}</span>
        </button>
        <button
          type="button"
          className="auth__toggle"
          onClick={() => {
            setMode((m) => (m === "login" ? "signup" : "login"));
            setError(null);
          }}
        >
          {mode === "login" ? "New to Ortha? Create an account" : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.3 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.1 5.5c4.2-3.9 6.6-9.6 6.6-16z" />
      <path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.7-2.9-.7-4.7s.3-3.3.7-4.7l-7.9-6.1C1 16.3 0 20 0 24s1 7.7 2.6 10.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.1-5.5c-2 1.3-4.5 2.1-8.8 2.1-6.3 0-11.6-3.8-13.5-9.3l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
