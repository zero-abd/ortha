import { useCallback, useRef, useState } from "react";
import type { PermissionResponse, TraceEvent } from "@ortha/contracts";
import { ApprovalChip } from "./components/ApprovalChip.tsx";
import { Brand, Spinner } from "./components/Logo.tsx";
import { CostMeter } from "./components/CostMeter.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { SideEffectModal } from "./components/SideEffectModal.tsx";
import { TraceBlock } from "./components/TraceBlock.tsx";
import { useTheme } from "./lib/useTheme.ts";
import { runTurn } from "./transport.ts";
import type { ChatMessage, CostState, RawArtifact, TraceStep } from "./types.ts";

const CAP_CENTS = 40;
const MODELS = ["gemini-2.0-flash", "claude-sonnet", "gpt-4o", "openrouter/auto"];
const EXAMPLES = [
  "Who's the CEO of Stripe, and any recent news?",
  "Find the work email for a founder at Vercel",
  "Enrich this company: orthogonal.com",
];

type PermEvent = Extract<TraceEvent, { type: "permission_required" }>;
interface Pending {
  event: PermEvent;
  resolve: (r: PermissionResponse) => void;
}

export function App() {
  const { applied, toggle } = useTheme();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cost, setCost] = useState<CostState>({ sessionCents: 0, capCents: CAP_CENTS, remainingCents: 100_00 });
  const [breakdown, setBreakdown] = useState<{ api: string; cents: number }[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [resolvedPerms, setResolvedPerms] = useState<Record<string, "approved" | "skipped">>({});
  const [panel, setPanel] = useState<RawArtifact | null>(null);
  const [model, setModel] = useState(MODELS[0]);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rawStore = useRef(new Map<string, unknown>());
  const conversationId = useRef(crypto.randomUUID());

  const patchActive = useCallback((fn: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1]!;
      if (last.role !== "assistant") return prev;
      return [...prev.slice(0, -1), fn(last)];
    });
  }, []);

  const onEvent = useCallback(
    (e: TraceEvent) => {
      switch (e.type) {
        case "token":
          patchActive((m) => ({ ...m, content: m.content + e.text }));
          break;
        case "tool_search":
          patchActive((m) => ({
            ...m,
            steps: [...m.steps, { stepId: `search_${m.steps.length}`, api: "search_tools", path: `"${e.query}"`, status: "success", summary: `${e.resultCount} tools found` }],
          }));
          break;
        case "tool_call_started":
          patchActive((m) => ({
            ...m,
            steps: [...m.steps, { stepId: e.stepId, api: e.api, path: e.path, estCents: e.estCents, status: "running" }],
          }));
          break;
        case "tool_result":
          patchActive((m) => ({
            ...m,
            steps: m.steps.map((s) =>
              s.stepId === e.stepId
                ? { ...s, status: e.ok ? "success" : "failed", summary: e.summary, priceCents: e.priceCents, latencyMs: e.latencyMs, requestId: e.requestId }
                : s,
            ),
          }));
          if (e.ok && e.priceCents > 0) {
            patchActive((m) => m); // no-op keeps types happy
            setBreakdown((b) => mergeSpend(b, apiForStep(e.stepId), e.priceCents));
          }
          break;
        case "self_heal":
          patchActive((m) => ({
            ...m,
            steps: m.steps.map((s) => (s.api === e.failedProvider && s.status === "failed" && !s.heal ? { ...s, heal: { failed: e.failedProvider, alt: e.altProvider } } : s)),
          }));
          break;
        case "cost_update":
          setCost({ sessionCents: e.sessionCents, capCents: e.capCents, remainingCents: e.workspaceRemainingCents });
          break;
        case "error":
          patchActive((m) => ({ ...m, error: { code: e.code, message: e.message }, streaming: false }));
          break;
        case "done":
          patchActive((m) => ({ ...m, streaming: false }));
          break;
        // permission_required is delivered via requestPermission(); permission_resolved is informational.
        case "permission_resolved":
        case "permission_required":
          break;
      }
    },
    [patchActive],
  );

  // map stepId → api for spend breakdown (we recorded api on the step)
  const stepApi = useRef<Record<string, string>>({});
  function apiForStep(stepId: string): string {
    return stepApi.current[stepId] ?? "tool";
  }

  const requestPermission = useCallback(
    (e: PermEvent): Promise<PermissionResponse> =>
      new Promise<PermissionResponse>((resolve) => {
        setPending({
          event: e,
          resolve: (r) => {
            setResolvedPerms((prev) => ({ ...prev, [e.stepId]: r.decision === "skip" || r.decision === "cancel" ? "skipped" : "approved" }));
            if (r.decision === "raise_cap" && r.newCapCents) setCost((c) => ({ ...c, capCents: r.newCapCents! }));
            setPending(null);
            resolve(r);
          },
        });
      }),
    [],
  );

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || running) return;
      setDraft("");
      stepApi.current = {};
      const userId = `u_${Date.now()}`;
      const aiId = `a_${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", content: text, steps: [], streaming: false },
        { id: aiId, role: "assistant", content: "", steps: [], streaming: true },
      ]);
      setRunning(true);
      try {
        await runTurn(text, {
          onEvent: (e) => {
            if (e.type === "tool_call_started") stepApi.current[e.stepId] = e.api;
            onEvent(e);
          },
          requestPermission,
          rawStore: rawStore.current,
          startCents: cost.sessionCents,
          capCents: cost.capCents,
          conversationId: conversationId.current,
        });
      } finally {
        setRunning(false);
      }
    },
    [running, onEvent, requestPermission, cost.sessionCents, cost.capCents],
  );

  const openRaw = useCallback((requestId: string) => {
    setPanel({ title: requestId, requestId, data: rawStore.current.get(requestId) ?? { note: "no raw stored" } });
  }, []);

  const empty = messages.length === 0;

  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <Select value="Personal" options={["Personal", "Acme Inc"]} onChange={() => {}} ariaLabel="Workspace" />
        <span className="topbar__spacer" />
        <CostMeter sessionCents={cost.sessionCents} capCents={cost.capCents} breakdown={breakdown} />
        <Select value={model ?? MODELS[0]!} options={MODELS} onChange={setModel} ariaLabel="Model" />
        <button className="iconbtn" onClick={toggle} aria-label="Toggle theme">
          {applied === "dark" ? "☀" : "☾"}
        </button>
        <button className="iconbtn" aria-label="Settings" onClick={() => setSettingsOpen(true)}>⚙</button>
      </header>

      <div className="body">
        <nav className="rail rail--open" aria-label="Conversations">
          <div className="rail__top">
            <button className="btn-sm btn-sm--accent" onClick={() => setMessages([])}>+ New chat</button>
          </div>
          <ul className="rail__list">
            <li className="rail__item">Stripe research</li>
            <li className="rail__item">Lead enrichment</li>
          </ul>
          <div className="rail__account muted">almahmud.zero@gmail.com</div>
        </nav>

        <div className="stream-wrap">
          <div className="stream">
            <div className="stream__inner">
              {empty ? (
                <EmptyState onPick={send} />
              ) : (
                messages.map((m) => (
                  <Message key={m.id} m={m} onOpenRaw={openRaw} pending={pending} resolvedPerms={resolvedPerms} onDecide={(r) => pending?.resolve(r)} cap={cost.capCents} session={cost.sessionCents} />
                ))
              )}
            </div>
          </div>
          <Composer value={draft} onChange={setDraft} onSend={() => send(draft)} disabled={running} />
        </div>

        <RightPanel artifact={panel} onClose={() => setPanel(null)} />
      </div>

      {pending?.event.kind === "side_effect" && (
        <SideEffectModal
          action={pending.event.action ?? "Perform action"}
          target={pending.event.target ?? ""}
          estCents={pending.event.estCents}
          onConfirm={() => pending.resolve({ stepId: pending.event.stepId, decision: "approve" })}
          onCancel={() => pending.resolve({ stepId: pending.event.stepId, decision: "cancel" })}
        />
      )}

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

interface MessageProps {
  m: ChatMessage;
  onOpenRaw: (id: string) => void;
  pending: Pending | null;
  resolvedPerms: Record<string, "approved" | "skipped">;
  onDecide: (r: PermissionResponse) => void;
  cap: number;
  session: number;
}

function Message({ m, onOpenRaw, pending, resolvedPerms, onDecide, cap, session }: MessageProps) {
  if (m.role === "user") {
    return (
      <div className="msg msg--user">
        <div className="msg__role">You</div>
        <div className="msg__body">{m.content}</div>
      </div>
    );
  }
  const showCostChip = pending?.event.kind === "cost";
  return (
    <div className="msg">
      <div className="msg__role">Ortha</div>
      <div className="msg__body">
        {m.steps.map((s: TraceStep) => (
          <TraceBlock key={s.stepId} step={s} onOpenRaw={onOpenRaw} />
        ))}
        {Object.entries(resolvedPerms).map(([stepId, outcome]) => (
          <ApprovalChip key={`r_${stepId}`} stepId={stepId} estCents={0} sessionCents={session} capCents={cap} resolved={outcome} onDecide={onDecide} />
        ))}
        {showCostChip && pending && (
          <ApprovalChip stepId={pending.event.stepId} estCents={pending.event.estCents} sessionCents={pending.event.sessionCents} capCents={pending.event.capCents} onDecide={onDecide} />
        )}
        {m.content && <div className="md">{m.content}</div>}
        {m.streaming && !m.content && m.steps.length === 0 && (
          <div className="thinking">
            <Spinner size={16} />
            <span className="muted">Thinking…</span>
          </div>
        )}
        {m.error && (
          <div className="errbubble">
            <span className="errbubble__icon">!</span>
            <span className="errbubble__text">{m.error.code}: {m.error.message}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="empty">
      <div className="empty__lede">Ask Ortha to find real-world data — it discovers the right tool live.</div>
      <div className="empty__examples">
        {EXAMPLES.map((ex) => (
          <button key={ex} className="example" onClick={() => onPick(ex)}>
            {ex}
          </button>
        ))}
      </div>
      <div className="nudge muted">Tip: add a provider key in Settings to use your own credits (BYOK).</div>
    </div>
  );
}

function Composer({ value, onChange, onSend, disabled }: { value: string; onChange: (v: string) => void; onSend: () => void; disabled: boolean }) {
  return (
    <div className="composer">
      <div className="composer__inner">
        <textarea
          className="composer__input"
          value={value}
          placeholder="Message Ortha…"
          rows={1}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button className="composer__send" onClick={onSend} disabled={disabled} aria-label="Send">
          ↑
        </button>
      </div>
    </div>
  );
}

function Select({ value, options, onChange, ariaLabel }: { value: string; options: string[]; onChange: (v: string) => void; ariaLabel: string }) {
  return (
    <span className="select model-select">
      <select className="select" aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <span className="select__caret caret">▾</span>
    </span>
  );
}

function mergeSpend(list: { api: string; cents: number }[], api: string, cents: number): { api: string; cents: number }[] {
  const existing = list.find((x) => x.api === api);
  if (existing) return list.map((x) => (x.api === api ? { ...x, cents: x.cents + cents } : x));
  return [...list, { api, cents }];
}
