// Mock transport: replays a realistic TraceEvent stream so the console runs
// standalone (no backend). Mirrors the real DO→client contract and the agent
// loop's permission gate, so swapping in a real WebSocket later is a drop-in.
import type { PermissionResponse, TraceEvent } from "@ortha/contracts";

export interface TurnDeps {
  onEvent: (e: TraceEvent) => void;
  requestPermission: (e: Extract<TraceEvent, { type: "permission_required" }>) => Promise<PermissionResponse>;
  rawStore: Map<string, unknown>;
  startCents: number;
  capCents: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const id = (p: string): string => `${p}_${(++seq).toString(36)}`;

export async function runMockTurn(_userText: string, deps: TurnDeps): Promise<void> {
  const { onEvent, requestPermission, rawStore, capCents } = deps;
  let session = deps.startCents;
  const cost = (): TraceEvent => ({
    type: "cost_update",
    sessionCents: session,
    capCents,
    workspaceRemainingCents: Math.max(0, 100_00 - session),
  });

  // 1) Discover a tool.
  onEvent({ type: "tool_search", query: "enrich person by company role", resultCount: 3 });
  await sleep(450);

  // 2) Free/cheap read: enrich the person.
  const s1 = id("step");
  onEvent({ type: "tool_call_started", stepId: s1, api: "apollo", path: "/v1/people/match", estCents: 3 });
  await sleep(600);
  const r1 = id("run");
  rawStore.set(r1, { name: "Patrick Collison", title: "CEO", company: "Stripe", linkedin: "in/patrickcollison" });
  onEvent({ type: "tool_result", stepId: s1, requestId: r1, summary: "Patrick Collison · CEO · Stripe", priceCents: 3, latencyMs: 240, ok: true });
  session += 3;
  onEvent(cost());
  await sleep(300);

  // 3) Premium call crosses the session cap → ask permission.
  const s2 = id("step");
  const decision = await requestPermission({
    type: "permission_required",
    stepId: s2,
    kind: "cost",
    estCents: 40,
    sessionCents: session,
    capCents,
  });
  onEvent({ type: "permission_resolved", stepId: s2, approved: decision.decision === "approve" || decision.decision === "raise_cap" });

  if (decision.decision === "skip" || decision.decision === "cancel") {
    await streamAnswer(onEvent, "I found Patrick Collison (CEO, Stripe). I skipped the paid news lookup, so I don't have recent headlines — ask me to run it if you want them.");
    onEvent({ type: "done", stopReason: "end" });
    return;
  }

  // 4) Premium news search — first provider fails, self-heal to an alternate.
  onEvent({ type: "tool_call_started", stepId: s2, api: "linkup", path: "/v1/search", estCents: 40 });
  await sleep(700);
  onEvent({ type: "tool_result", stepId: s2, requestId: id("run"), summary: "provider timed out", priceCents: 0, latencyMs: 8000, ok: false });
  onEvent({ type: "self_heal", failedProvider: "linkup", altProvider: "exa" });
  await sleep(400);
  const s3 = id("step");
  onEvent({ type: "tool_call_started", stepId: s3, api: "exa", path: "/search", estCents: 40 });
  await sleep(650);
  const r3 = id("run");
  rawStore.set(r3, { results: [{ title: "Stripe expands stablecoin payments", url: "https://example.com/a" }, { title: "Collison on AI agents", url: "https://example.com/b" }] });
  onEvent({ type: "tool_result", stepId: s3, requestId: r3, summary: "2 recent articles via exa", priceCents: 38, latencyMs: 520, ok: true });
  session += 38;
  onEvent(cost());
  await sleep(300);

  // 5) Stream the synthesized answer.
  await streamAnswer(
    onEvent,
    "Stripe's CEO is Patrick Collison. Recent coverage: Stripe is expanding stablecoin payments, and Collison has been speaking about AI agents reshaping software. Want the full articles? Open the trace results on the right.",
  );
  onEvent({ type: "done", stopReason: "end" });
}

async function streamAnswer(onEvent: (e: TraceEvent) => void, text: string): Promise<void> {
  for (const word of text.split(" ")) {
    onEvent({ type: "token", text: word + " " });
    await sleep(28);
  }
}
