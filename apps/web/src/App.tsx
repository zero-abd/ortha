import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionResponse, TraceEvent } from "@ortha/contracts";
import { ApprovalChip } from "./components/ApprovalChip.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { CostMeter } from "./components/CostMeter.tsx";
import { DiscoverModal } from "./components/DiscoverModal.tsx";
import { Dropdown } from "./components/Dropdown.tsx";
import { SlashMenu, type SlashNav } from "./components/SlashMenu.tsx";
import { Logo, Spinner } from "./components/Logo.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { SideEffectModal } from "./components/SideEffectModal.tsx";
import { SkillsModal } from "./components/SkillsModal.tsx";
import { BatchModal } from "./components/BatchModal.tsx";
import { collectRow, type RowResult } from "./lib/batch.ts";
import { TraceBlock } from "./components/TraceBlock.tsx";
import { useTheme } from "./lib/useTheme.ts";
import { runTurn } from "./transport.ts";
import { fetchHistory } from "./live.ts";
import { AuthScreen } from "./components/AuthScreen.tsx";
import { loginGoogle, logout, me, type AuthUser } from "./lib/auth.ts";
import { API } from "./lib/config.ts";
import { deleteConversation, getSettings, listConversations, putSettings, renameConversation, type ApiSettings, type Conversation } from "./lib/api.ts";
import { PROVIDERS, defaultModelOf, providerOfModel } from "./lib/providers.ts";
import { runCommand, type Command, type CommandContext } from "./lib/commands.ts";
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
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const rawStore = useRef(new Map<string, unknown>());
  const [activeId, setActiveId] = useState<string>(() => crypto.randomUUID());
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // Inline-rename state: the conversation id being edited and its working title.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

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
  useEffect(() => {
    if (user) refreshConversations();
  }, [user, refreshConversations]);

  // Required login: resolve the session on mount, handling a Google ?code= return.
  useEffect(() => {
    void (async () => {
      const u = new URL(window.location.href);
      const code = u.searchParams.get("code");
      if (code) {
        try {
          await loginGoogle(code, u.origin + u.pathname);
        } catch {
          /* fall through to me() */
        }
        window.history.replaceState({}, "", u.origin + u.pathname);
      }
      setUser(await me());
      setAuthChecked(true);
    })();
  }, []);

  // Seed caps/remaining from persisted settings once signed in.
  useEffect(() => {
    if (!user) return;
    void (async () => {
      const loaded = (await getSettings()) ?? DEFAULT_SETTINGS;
      setSettings(loaded);
      setCost((c) => ({ ...c, capCents: loaded.sessionCapCents, remainingCents: loaded.monthlyCapCents }));
    })();
  }, [user]);

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

  // Run one batch row as an isolated turn: a fresh conversation id (so rows run
  // concurrently without contending), cost gates auto-confirmed and write
  // (side-effect) gates skipped (a batch runs unattended), events folded into a
  // single row result. Server-side caps still bound spend.
  const runBatchRow = useCallback(
    async (prompt: string): Promise<RowResult> => {
      const events: TraceEvent[] = [];
      await runTurn(prompt, {
        onEvent: (e) => events.push(e),
        requestPermission: async (e) => ({ stepId: e.stepId, decision: e.kind === "side_effect" ? "skip" : "approve" }),
        rawStore: new Map<string, unknown>(),
        startCents: 0,
        capCents: settings.sessionCapCents,
        conversationId: crypto.randomUUID(),
      });
      return collectRow(events);
    },
    [settings.sessionCapCents],
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
    setSidebarOpen(false);
  };

  // /clear: wipe the current view (messages + spend) but stay in the same
  // conversation, unlike /new which spins up a fresh conversation id.
  const clearChat = () => {
    resetSession();
    setDraft("");
  };

  // Context handed to slash commands + the ⌘K palette. We keep a ref to the
  // latest handlers (some close over fresh state like `settings`) and expose a
  // single stable object whose methods read through the ref — so the palette /
  // slash menu never re-subscribe, yet always run the current closures.
  const ctxImpl = useRef<CommandContext>({} as CommandContext);
  ctxImpl.current = {
    send,
    setDraft,
    newChat,
    changeProvider,
    openSettings: () => setSettingsOpen(true),
    clearChat,
    openBatch: () => setBatchOpen(true),
  };
  const commandCtx = useRef<CommandContext>({
    send: (t) => ctxImpl.current.send(t),
    setDraft: (t) => ctxImpl.current.setDraft(t),
    newChat: () => ctxImpl.current.newChat(),
    changeProvider: (p) => ctxImpl.current.changeProvider(p),
    openSettings: () => ctxImpl.current.openSettings(),
    clearChat: () => ctxImpl.current.clearChat(),
    openBatch: () => ctxImpl.current.openBatch(),
  }).current;

  // Run a slash/palette command against the stable context.
  const onCommand = useCallback((cmd: Command, arg: string) => {
    runCommand(cmd, arg, commandCtx);
  }, [commandCtx]);

  // Global ⌘K / Ctrl+K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectConversation = async (id: string) => {
    if (id === activeId || running) return;
    resetSession();
    setActiveId(id);
    setSidebarOpen(false);
    const hist = await fetchHistory(id, API);
    setMessages(
      hist
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m, i) => ({ id: `h_${i}`, role: m.role as "user" | "assistant", content: m.content, steps: [], streaming: false })),
    );
  };

  // Begin inline-editing a conversation title; seed the draft with the current title.
  const startRename = (c: Conversation) => {
    setRenamingId(c.id);
    setRenameDraft(c.title || "");
  };

  // Persist the edited title, then refresh the list. Empty/unchanged titles just cancel.
  const commitRename = async () => {
    const id = renamingId;
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!id || !title) return;
    const current = conversations.find((c) => c.id === id);
    if (current && current.title === title) return;
    try {
      await renameConversation(id, title);
    } finally {
      refreshConversations();
    }
  };

  // Delete after a confirm. If the active conversation is removed, fall back to a new chat.
  const removeConversation = async (id: string) => {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    try {
      await deleteConversation(id);
    } finally {
      if (id === activeId) newChat();
      refreshConversations();
    }
  };

  const empty = messages.length === 0;

  if (!authChecked) {
    return (
      <div className="auth">
        <Spinner size={28} />
      </div>
    );
  }
  if (!user) return <AuthScreen onAuthed={setUser} />;

  return (
    <div className="app">
      {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar${sidebarOpen ? " sidebar--open" : ""}`}>
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

        <button className="discover-btn" onClick={() => setSkillsOpen(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          <span>Skills</span>
        </button>

        <button className="discover-btn" onClick={() => setBatchOpen(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
          <span>Batch run</span>
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
            conversations.map((c) =>
              renamingId === c.id ? (
                <div key={c.id} className={`convo convo--editing${c.id === activeId ? " convo--active" : ""}`}>
                  <input
                    className="convo__rename"
                    value={renameDraft}
                    autoFocus
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                  />
                </div>
              ) : (
                <div
                  key={c.id}
                  className={`convo${c.id === activeId ? " convo--active" : ""}`}
                  onClick={() => void selectConversation(c.id)}
                  title={c.title}
                >
                  <span className="convo__title">{c.title || "Untitled"}</span>
                  <span className="convo__actions">
                    <button
                      className="iconbtn iconbtn--sm"
                      aria-label="Rename conversation"
                      title="Rename"
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(c);
                      }}
                    >
                      &#9998;
                    </button>
                    <button
                      className="iconbtn iconbtn--sm"
                      aria-label="Delete conversation"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeConversation(c.id);
                      }}
                    >
                      &times;
                    </button>
                  </span>
                </div>
              ),
            )
          )}
        </div>

        <div className="sidebar__foot">
          <div className="balance">
            <span>Session</span>
            <span className="balance__amt">${(cost.sessionCents / 100).toFixed(2)} / ${(cost.capCents / 100).toFixed(2)}</span>
          </div>
          <button className="acct" onClick={() => setSettingsOpen(true)} aria-label="Account and settings">
            <span className="acct__avatar">{(user.displayName ?? user.email ?? "U").charAt(0).toUpperCase()}</span>
            <span className="acct__name">{user.displayName ?? user.email ?? "Account"}</span>
            <span className="acct__chev">⚙</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="main__top">
          <button className="hamburger" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="4" y1="9" x2="20" y2="9" />
              <line x1="4" y1="15" x2="13" y2="15" />
            </svg>
          </button>
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
                <AskBox value={draft} onChange={setDraft} onSend={() => send(draft)} onCommand={onCommand} disabled={running} autoFocus />
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
                  <Message key={m.id} m={m} onOpenRaw={openRaw} rawStore={rawStore.current} pending={pending} resolvedPerms={resolvedPerms} onDecide={(r) => pending?.resolve(r)} cap={cost.capCents} session={cost.sessionCents} />
                ))}
              </div>
            </div>
            <div className="composer">
              <AskBox value={draft} onChange={setDraft} onSend={() => send(draft)} onCommand={onCommand} disabled={running} />
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

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={onSettingsSaved}
        user={user}
        onSignOut={async () => {
          await logout();
          setSettingsOpen(false);
          resetSession();
          setUser(null);
        }}
      />

      <DiscoverModal open={discoverOpen} onClose={() => setDiscoverOpen(false)} />

      <SkillsModal open={skillsOpen} onClose={() => setSkillsOpen(false)} onRun={(prompt) => void send(prompt)} />
      <BatchModal open={batchOpen} onClose={() => setBatchOpen(false)} runRow={runBatchRow} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} ctx={commandCtx} />
    </div>
  );
}

interface MessageProps {
  m: ChatMessage;
  onOpenRaw: (id: string) => void;
  rawStore: Map<string, unknown>;
  pending: Pending | null;
  resolvedPerms: Record<string, "approved" | "skipped">;
  onDecide: (r: PermissionResponse) => void;
  cap: number;
  session: number;
}

function Message({ m, onOpenRaw, rawStore, pending, resolvedPerms, onDecide, cap, session }: MessageProps) {
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
          <TraceBlock key={s.stepId} step={s} onOpenRaw={onOpenRaw} raw={s.requestId ? rawStore.get(s.requestId) : undefined} />
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

function AskBox({
  value,
  onChange,
  onSend,
  onCommand,
  disabled,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onCommand?: (cmd: Command, arg: string) => void;
  disabled: boolean;
  autoFocus?: boolean;
}) {
  // The slash menu is shown when the draft starts with "/" and isn't yet a
  // full "command + space + arg" line being typed past the menu. We keep it
  // open while the user is still on the command word or just past it.
  const slashOpen = onCommand != null && value.startsWith("/");
  const navRef = useRef<SlashNav | null>(null);

  const runActive = () => {
    const nav = navRef.current;
    if (nav?.hasResults) {
      nav.run();
      return true;
    }
    return false;
  };

  return (
    <div className="ask-wrap">
      {slashOpen && (
        <SlashMenu
          query={value}
          registerNav={(nav) => {
            navRef.current = nav;
          }}
          onChoose={(cmd) => onCommand?.(cmd, value.replace(/^\/\S*\s*/, ""))}
        />
      )}
      <div className="ask">
        <textarea
          className="ask__input"
          value={value}
          placeholder="Ask Ortha… (/ for commands)"
          rows={1}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // While the slash menu is open with matches, the arrow keys and
            // Enter drive selection instead of the textarea / send.
            if (slashOpen && navRef.current?.hasResults) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                navRef.current.move(1);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                navRef.current.move(-1);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (runActive()) return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button className="ask__send" onClick={onSend} disabled={disabled} aria-label="Send">↑</button>
      </div>
    </div>
  );
}

function mergeSpend(list: { api: string; cents: number }[], api: string, cents: number): { api: string; cents: number }[] {
  const existing = list.find((x) => x.api === api);
  if (existing) return list.map((x) => (x.api === api ? { ...x, cents: x.cents + cents } : x));
  return [...list, { api, cents }];
}
