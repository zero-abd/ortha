import { runMockTurn, type TurnDeps } from "./mock/transport.ts";
import { runLiveTurn } from "./live.ts";

// Default to the deployed worker; override with VITE_ORTHA_API, or force the
// offline mock with VITE_USE_MOCK=1.
const API = (import.meta.env.VITE_ORTHA_API as string | undefined) ?? "https://ortha-edge.almahmud-zero.workers.dev";
const FORCE_MOCK = import.meta.env.VITE_USE_MOCK === "1";

export interface RunDeps extends TurnDeps {
  conversationId: string;
}

/** Streams a turn live from the worker; falls back to the offline mock on failure. */
export async function runTurn(text: string, deps: RunDeps): Promise<void> {
  if (!FORCE_MOCK && API) {
    try {
      await runLiveTurn(text, deps, API);
      return;
    } catch {
      // Connection failed — degrade gracefully to the offline mock so the demo still works.
    }
  }
  await runMockTurn(text, deps);
}
