import { API } from "./lib/config.ts";
import { runLiveTurn } from "./live.ts";
import type { TurnDeps } from "./types.ts";

export interface RunDeps extends TurnDeps {
  conversationId: string;
}

/**
 * Streams a turn live from the deployed worker over WebSocket. There is no offline
 * mock or demo fallback — a connection failure or a missing-keys error surfaces to
 * the caller (rendered as an error bubble) so the user always sees the real state.
 */
export async function runTurn(text: string, deps: RunDeps, images?: readonly string[]): Promise<void> {
  await runLiveTurn(text, deps, API, images);
}
