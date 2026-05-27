import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionResponse, TraceEvent } from "@ortha/contracts";
import { ApprovalChip } from "./components/ApprovalChip.tsx";
import { CostMeter } from "./components/CostMeter.tsx";
import { DiscoverModal } from "./components/DiscoverModal.tsx";
import { Dropdown } from "./components/Dropdown.tsx";
import { Logo, Spinner } from "./components/Logo.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { SideEffectModal } from "./components/SideEffectModal.tsx";
import { TraceBlock } from "./components/TraceBlock.tsx";
import { useTheme } from "./lib/useTheme.ts";
import { runTurn } from "./transport.ts";
import { fetchHistory } from "./live.ts";
import { API } from "./lib/config.ts";
import { getSettings, listConversations, putSettings, type ApiSettings, type Conversation } from "./lib/api.ts";
import { PROVIDERS, defaultModelOf, providerOfModel } from "./lib/providers.ts";
import type { ChatMessage, CostState, RawArtifact, TraceStep } from "./types.ts";

const DEFAULT_SETTINGS: ApiSettings = {
  sessionCapCents: 500,
  perCallWarnCents: 25,
  monthlyCapCents: 10_000,
  model: "gemini-2.5-flash",
  theme: "system",
  cacheTtlSeconds: 300,
};

const EXAMPLE_CATS = [
  {
    label: "Recruiting",
    items: ["Find staff engineers in NYC with Rust experience", "Pull LinkedIn profiles for staff engineers at OpenAI"],
  },
  {
    label: "Enrichment & research",
    items: ["Who's the CEO of Stripe, and any recent news?", "Find the work email for a founder at Vercel"],
  },
];

type PermEvent = Extract<TraceEvent, { type: "permission_required" }>;
interface Pending {
  event: PermEvent;
  resolve: (r: PermissionResponse) => void;
}

export function App() {
  const { applied, toggle } = useTheme();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Cap/remaining are seeded from server settings on mount; 0 until loaded so
  // we never flash a misleading hardcoded cap.
  const [cost, setCost] = useState<CostState>({ sessionCents: 0, capCents: 0, remainingCents: 0 });
  const [costLive, setCostLive] = useState(false);
  const [breakdown, setBreakdown] = useState<{ api: string; cents: number }[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [resolvedPerms, setResolvedPerms] = useState<Record<string, "approved" | "skipped">>({});
  const [panel, setPanel] = useState<RawArtifact | null>(null);
  const [settings, setSettings] = useState<ApiSettings>(DEFAULT_SETTINGS);
  const model = settings.model;
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const rawStore = useRef(new Map<string, unknown>());
  const [activeId, setActiveId] = useState<string>(() => crypto.randomUUID());
  const [conversations, setConversations] = useState<Conversation[]>([]);

  const patchActive = useCallback((fn: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1]!;
      if (last.role !== "assistant") return prev;
      return [...prev.slice(0, -1), fn(last)];
    });
  }, []);

  const stepApi = useRef<Record<string, string>>({});
  const apiForStep = (stepId: string): string => stepApi.current[stepId] ?? "tool";

  const refreshConversations = useCallback(() => {
    void listConversations().then(setConversations).catch(() => {});
  }, []);
  useEffect(() => refreshConversations(), [refreshConversations]);

  // Seed caps/remaining from persisted settings.
  useEffect(() => {
    void (async () => {
      const loaded = (await getSettings()) ?? DEFAULT_SETTINGS;
      setSettings(loaded);
      setCost((c) => ({ ...c, capCents: loaded.sessionCapCents, remainingCents: loaded.monthlyCapCents }));
    })();
  }, []);

  // Persist a new model (provider default).
  const changeProvider = useCallback((providerId: string) => {
    const nextModel = defaultModelOf(providerId);
    setSettings((prev) => {
      const next = { ...prev, model: nextModel };
      void putSettings(next).catch(() => {});
      return next;
    });
  }, []);

  // Settings modal saved: adopt new values, reseed caps.
  const onSettingsSaved = useCallback(
    (next: ApiSettings) => {
      setSettings(next);
      setCost((c) => ({ ...c, capCents: next.sessionCapCents, remainingCents: costLive ? c.remainingCents : next.monthlyCapCents }));
    },
    [costLive],
  );

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
          patchActive((m) => ({ ...m, steps: [...m.steps, { stepId: e.stepId, api: e.api, path: e.path, estCents: e.estCents, status: "running" }] }));
          break;
        case "tool_result":
          patchActive((m) => ({
            ...m,
            steps: m.steps.map((s) =>
              s.stepId === e.stepId ? { ...s, status: e.ok ? "success" : "failed", summary: e.summary, priceCents: e.priceCents, latencyMs: e.latencyMs, requestId: e.requestId } : s,
            ),
          }));
          if (e.ok && e.priceCents > 0) setBreakdown((b) => mergeSpend(b, apiForStep(e.stepId), e.priceCents));
          break;
        case "self_heal":
          patchActive((m) => ({
            ...m,
            steps: m.steps.map((s) => (s.api === e.failedProvider && s.status === "failed" && !s.heal ? { ...s, heal: { failed: e.failedProvider, alt: e.altProvider } } : s)),
          }));
          break;
        case "cost_update":
          setCost({ sessionCents: e.sessionCents, capCents: e.capCents, remainingCents: e.workspaceRemainingCents });
          setCostLive(true);
          break;
        case "error":
          patchActive((m) => ({ ...m, error: { code: e.code, message: e.message }, streaming: false }));
          break;
        case "done":
          patchActive((m) => ({ ...m, streaming: false }));
          break;
        case "permission_resolved":
        case "permission_required":
          break;
      }
    },
    [patchActive],
  );

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
      setMessages((prev) => [
        ...prev,
        { id: `u_${Date.now()}`, role: "user", content: text, steps: [], streaming: false },
        { id: `a_${Date.now()}`, role: "assistant", content: "", steps: [], streaming: true },
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
          conversationId: activeId,
        });
      } catch (err) {
        patchActive((m) => ({
          ...m,
          error: { code: "PROVIDER_DOWN", message: err instanceof Error ? err.message : "Couldn't reach Ortha. Check your connection and try again." },
          streaming: false,
        }));
      } finally {
        setRunning(false);
        refreshConversations();
      }
    },
    [running, onEvent, requestPermission, cost.sessionCents, cost.capCents, activeId, refreshConversations, patchActive],
  );

  const openRaw = useCallback((requestId: string) => {
    setPanel({ title: requestId, requestId, data: rawStore.current.get(requestId) ?? { note: "no raw stored" } });
  }, []);

  const resetSession = () => {
    setMessages([]);
    setBreakdown([]);
    setPending(null);
    setPanel(null);
    setCostLive(false);
    setCost({ sessionCents: 0, capCents: settings.sessionCapCents, remainingCents: settings.monthlyCapCents });
  };

  const newChat = () => {
    resetSession();
    setActiveId(crypto.randomUUID());
  };

  const selectConversation = async (id: string) => {
    if (id === activeId || running) return;
    resetSession();
    setActiveId(id);
    const hist = await fetchHistory(id, API);
    setMessages(
      hist
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m, i) => ({ id: `h_${i}`, role: m.role as "user" | "assistant", content: m.content, steps: [], streaming: false })),
    );
  };

  const empty = messages.length === 0;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <Logo size={24} />
          <span className="brand__word">Ortha</span>
        </div>

        <button className="discover-btn" onClick={() => setDiscoverOpen(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span>Discover APIs</span>
        </button>

        <button className="acct-switch">
          <span>◐ Personal Account</span>
          <span className="acct-switch__chev">▾</span>
        </button>

        <button className="new-chat" onClick={newChat}>+ New chat</button>

        <div className="convos">
          <div className="convos__label">Recent</div>
          {conversations.length === 0 ? (
            <div className="convos__empty">Your conversations appear here.</div>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={`convo${c.id === activeId ? " convo--active" : ""}`}
                onClick={() => void selectConversation(c.id)}
                title={c.title}
              >
                {c.title || "Untitled"}
              </div>
            ))
          )}
        </div>

        <div className="sidebar__foot">
          <div className="balance">
            <span>Session</span>
            <span className="balance__amt">${(cost.sessionCents / 100).toFixed(2)} / ${(cost.capCents / 100).toFixed(2)}</span>
          </div>
          <button className="acct" onClick={() => setSettingsOpen(true)} aria-label="Account and settings">
            <span className="acct__avatar">A</span>
            <span className="acct__name">Abdullah Al Mahmud</span>
            <span className="acct__chev">⚙</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="main__top">
          <span className="main__spacer" />
          {!empty && <CostMeter sessionCents={cost.sessionCents} capCents={cost.capCents} breakdown={breakdown} />}
          <Dropdown
            value={providerOfModel(model)}
            options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
            onChange={changeProvider}
            ariaLabel="Provider"
          />
          <button className="iconbtn" onClick={toggle} aria-label="Toggle theme">{applied === "dark" ? "☀" : "☾"}</button>
        </header>

        {empty ? (
          <div className="stream-wrap">
            <div className="welcome">
              <h1 className="welcome__title">Welcome to Ortha</h1>
              <p className="welcome__sub">Describe what you need — Ortha discovers the right tools and runs them.</p>
              <div style={{ width: "100%", maxWidth: 720 }}>
                <AskBox value={draft} onChange={setDraft} onSend={() => send(draft)} disabled={running} autoFocus />
              </div>
              <div className="cats">
                {EXAMPLE_CATS.map((c) => (
                  <div key={c.label} style={{ marginBottom: 18 }}>
                    <div className="cat__label">{c.label}</div>
                    <div className="cat__grid">
                      {c.items.map((ex) => (
                        <button key={ex} className="examplecard" onClick={() => send(ex)}>{ex}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="stream-wrap">
            <div className="stream">
              <div className="stream__inner">
                {messages.map((m) => (
                  <Message key={m.id} m={m} onOpenRaw={openRaw} pending={pending} resolvedPerms={resolvedPerms} onDecide={(r) => pending?.resolve(r)} cap={cost.capCents} session={cost.sessionCents} />
                ))}
              </div>
            </div>
            <div className="composer">
              <AskBox value={draft} onChange={setDraft} onSend={() => send(draft)} disabled={running} />
            </div>
          </div>
        )}

        <RightPanel artifact={panel} onClose={() => setPanel(null)} />
      </main>

      {pending?.event.kind === "side_effect" && (
        <SideEffectModal
          action={pending.event.action ?? "Perform action"}
          target={pending.event.target ?? ""}
          estCents={pending.event.estCents}
          onConfirm={() => pending.resolve({ stepId: pending.event.stepId, decision: "approve" })}
          onCancel={() => pending.resolve({ stepId: pending.event.stepId, decision: "cancel" })}
        />
      )}

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={onSettingsSaved} />

      <DiscoverModal open={discoverOpen} onClose={() => setDiscoverOpen(false)} />
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
          <ApprovalChip stepId={pending.event.stepId} estCents={pending.event.estCents} sessionCents={pending.event.sessionCents} capCents={pending.event.capCents} dynamic={pending.event.dynamic} onDecide={onDecide} />
        )}
        {m.content && <div className="md">{m.content}</div>}
        {m.streaming && !m.content && m.steps.length === 0 && (
          <div className="thinking">
            <Spinner size={16} />
            <span>Thinking…</span>
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

function AskBox({ value, onChange, onSend, disabled, autoFocus }: { value: string; onChange: (v: string) => void; onSend: () => void; disabled: boolean; autoFocus?: boolean }) {
  return (
    <div className="ask">
      <textarea
        className="ask__input"
        value={value}
        placeholder="Ask Ortha…"
        rows={1}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      <button className="ask__send" onClick={onSend} disabled={disabled} aria-label="Send">↑</button>
    </div>
  );
}

function mergeSpend(list: { api: string; cents: number }[], api: string, cents: number): { api: string; cents: number }[] {
  const existing = list.find((x) => x.api === api);
  if (existing) return list.map((x) => (x.api === api ? { ...x, cents: x.cents + cents } : x));
  return [...list, { api, cents }];
}
