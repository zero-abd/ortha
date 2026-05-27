import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionResponse, TraceEvent } from "@ortha/contracts";
import { DEFAULT_MODEL_ID } from "@ortha/contracts";
import { ApprovalChip } from "./components/ApprovalChip.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { CostMeter } from "./components/CostMeter.tsx";
import { DiscoverModal } from "./components/DiscoverModal.tsx";
import { Dropdown } from "./components/Dropdown.tsx";
import { SlashMenu, type SlashNav } from "./components/SlashMenu.tsx";
import { Logo, Spinner } from "./components/Logo.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { RightPanel } from "./components/RightPanel.tsx";
import { SettingsModal } from "./components/SettingsModal.tsx";
import { SideEffectModal } from "./components/SideEffectModal.tsx";
import { SkillsModal } from "./components/SkillsModal.tsx";
import { ConnectorsModal } from "./components/ConnectorsModal.tsx";
import { BatchModal } from "./components/BatchModal.tsx";
import { collectRow, type RowResult } from "./lib/batch.ts";
import { type Attachment, buildPromptWithAttachments, isTextFile } from "./lib/attachments.ts";
import { TraceBlock } from "./components/TraceBlock.tsx";
import { Sources } from "./components/Sources.tsx";
import { useTheme } from "./lib/useTheme.ts";
import { runTurn } from "./transport.ts";
import { fetchHistory } from "./live.ts";
import { AuthScreen } from "./components/AuthScreen.tsx";
import { loginGoogle, logout, me, type AuthUser } from "./lib/auth.ts";
import { API } from "./lib/config.ts";
import { deleteConversation, getSettings, listConversations, listSkills, putSettings, renameConversation, type ApiSettings, type Conversation, type Skill } from "./lib/api.ts";
import { modelInfo, modelsForProvider, PROVIDERS, defaultModelOf, providerOfModel } from "./lib/providers.ts";
import { runCommand, setSkillCommands, skillCommand, type Command, type CommandContext } from "./lib/commands.ts";
import { wrapResearch } from "./lib/research.ts";
import type { AgentRun, ChatMessage, CostState, RawArtifact, TraceStep } from "./types.ts";
import { AgentsPanel } from "./components/AgentsPanel.tsx";
import { applyTraceEventToRun, finishRun, newAgentRun } from "./lib/agentRuns.ts";

const DEFAULT_SETTINGS: ApiSettings = {
  sessionCapCents: 500,
  perCallWarnCents: 25,
  monthlyCapCents: 10_000,
  model: DEFAULT_MODEL_ID,
  theme: "system",
  cacheTtlSeconds: 300,
};

// First-run greeting.
const GREETINGS = ["Tea and Ortha time?"];

// Expandable example categories: clicking a chip reveals that category's prompts.
const EXAMPLE_CATS: { label: string; items: string[] }[] = [
  {
    label: "Go-to-market",
    items: [
      "Find VPs of Sales at Stripe and get their verified emails",
      "Enrich stripe.com with funding, team size, and tech stack",
      "List companies that recently raised a Series A in fintech",
      "Find recent job openings at Stripe",
      "Find decision makers at companies hiring Rust engineers",
      "Send an outbound email from an AgentMail inbox to jane@stripe.com",
    ],
  },
  {
    label: "Investors",
    items: [
      "List AI infra startups that raised a Series A in 2026",
      "Get funding rounds for openai.com",
      "Show recent investments into YC W26 companies",
      "Get founder backgrounds for the team at openai.com",
      "Find companies similar to Anthropic by employee growth",
      'Pull news tagged "investment" for openai.com',
    ],
  },
  {
    label: "Marketing",
    items: [
      "Find skincare creators on Instagram with 50k to 500k followers",
      "Pull the Instagram profile for @glossier",
      "Scrape stripe.com and return clean markdown",
      "Search the web for skincare trends in 2026",
      "Generate a knowledge card on skincare market growth in 2026",
      "Find the top skincare creators on TikTok",
    ],
  },
  {
    label: "Recruiting",
    items: [
      "Find staff engineers in NYC with Rust experience",
      "Pull LinkedIn profiles for staff engineers at OpenAI",
      "Find companies similar to Anthropic for sourcing",
      "Find Jane Doe's email at Stripe",
      'Search LinkedIn posts about "rust hiring"',
      "Send a recruiting outreach to jane@example.com",
    ],
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
  // Rotating first-run greeting: pick once per page load.
  const [greeting] = useState(() => GREETINGS[Math.floor(Math.random() * GREETINGS.length)]!);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState("");
  // Data URLs for images attached to the next message (vision input).
  const [attached, setAttached] = useState<string[]>([]);
  // Text-document attachments for the next message. Their contents ride in the
  // prompt (see `send`); the chat bubble stays clean (original text + a chip).
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Deep-research mode: when on, the turn gets a research-directive-wrapped
  // prompt while the chat bubble still shows the user's original text.
  const [deepResearch, setDeepResearch] = useState(false);
  // Web search: on by default. Sent per turn so the agent can ground answers.
  const [webSearch, setWebSearch] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [userSkills, setUserSkills] = useState<Skill[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
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

  // Persist a specific model id (from the in-composer model picker).
  const changeModel = useCallback((modelId: string) => {
    setSettings((prev) => {
      const next = { ...prev, model: modelId };
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

  // ── Agent-run tracking (drives the Agents activity panel) ──
  const startAgentRun = useCallback((title: string, kind: AgentRun["kind"]): string => {
    const id = crypto.randomUUID();
    setAgentRuns((prev) => [newAgentRun(id, title, kind), ...prev].slice(0, 40));
    return id;
  }, []);
  const pushAgentEvent = useCallback((id: string, e: TraceEvent) => {
    setAgentRuns((prev) => prev.map((r) => (r.id === id ? applyTraceEventToRun(r, e) : r)));
  }, []);
  const finishAgentRun = useCallback((id: string, override?: { status?: AgentRun["status"]; error?: string }) => {
    setAgentRuns((prev) => prev.map((r) => (r.id === id ? finishRun(r, override) : r)));
  }, []);

  const send = useCallback(
    async (text: string, imageArg?: string[], opts?: { displayText?: string }) => {
      // Images default to whatever is attached in the composer; example cards and
      // commands call send(text) with no images and behave exactly as before.
      const images = imageArg ?? attached;
      const files = attachments;
      // Allow an image- or file-only message (no text), e.g. "what's in this?".
      if ((!text.trim() && images.length === 0 && files.length === 0) || running) return;
      // The bubble shows the ORIGINAL text (+ image thumbnails / a 📎 file chip), or a
      // short label when one is provided (e.g. "Run skill: find-leads" — so a skill's
      // long SKILL.md goes to the model but never floods the chat). The model gets file
      // contents prepended, then wrapped with the research directive when deep-research
      // is on; images ride alongside as vision input.
      const displayContent = opts?.displayText ?? text;
      let turnText = files.length > 0 ? buildPromptWithAttachments(text, files) : text;
      if (deepResearch) turnText = wrapResearch(turnText);
      setDraft("");
      setAttached([]);
      setAttachments([]);
      stepApi.current = {};
      setMessages((prev) => [
        ...prev,
        {
          id: `u_${Date.now()}`,
          role: "user",
          content: displayContent,
          steps: [],
          streaming: false,
          ...(images.length > 0 ? { images } : {}),
          ...(files.length > 0 ? { attachmentNames: files.map((f) => f.name) } : {}),
        },
        { id: `a_${Date.now()}`, role: "assistant", content: "", steps: [], streaming: true },
      ]);
      setRunning(true);
      const runId = startAgentRun(displayContent || files.map((f) => f.name).join(", "), "chat");
      try {
        await runTurn(turnText, {
          onEvent: (e) => {
            if (e.type === "tool_call_started") stepApi.current[e.stepId] = e.api;
            onEvent(e);
            pushAgentEvent(runId, e);
          },
          requestPermission,
          rawStore: rawStore.current,
          startCents: cost.sessionCents,
          capCents: cost.capCents,
          conversationId: activeId,
        }, images, deepResearch, webSearch);
        finishAgentRun(runId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Couldn't reach Ortha. Check your connection and try again.";
        patchActive((m) => ({ ...m, error: { code: "PROVIDER_DOWN", message }, streaming: false }));
        finishAgentRun(runId, { status: "error", error: message });
      } finally {
        setRunning(false);
        refreshConversations();
      }
    },
    [running, attached, attachments, deepResearch, webSearch, onEvent, requestPermission, cost.sessionCents, cost.capCents, activeId, refreshConversations, patchActive, startAgentRun, pushAgentEvent, finishAgentRun],
  );

  // Run one batch row as an isolated turn: a fresh conversation id (so rows run
  // concurrently without contending), cost gates auto-confirmed and write
  // (side-effect) gates skipped (a batch runs unattended), events folded into a
  // single row result. Server-side caps still bound spend.
  const runBatchRow = useCallback(
    async (prompt: string, label?: string): Promise<RowResult> => {
      const events: TraceEvent[] = [];
      const runId = startAgentRun(label ?? prompt, "batch");
      try {
        await runTurn(prompt, {
          onEvent: (e) => {
            events.push(e);
            pushAgentEvent(runId, e);
          },
          requestPermission: async (e) => ({ stepId: e.stepId, decision: e.kind === "side_effect" ? "skip" : "approve" }),
          rawStore: new Map<string, unknown>(),
          startCents: 0,
          capCents: settings.sessionCapCents,
          conversationId: crypto.randomUUID(),
        });
        const result = collectRow(events);
        finishAgentRun(runId, result.ok ? undefined : { status: "error", ...(result.error ? { error: result.error } : {}) });
        return result;
      } catch (err) {
        finishAgentRun(runId, { status: "error", error: err instanceof Error ? err.message : "run failed" });
        throw err;
      }
    },
    [settings.sessionCapCents, startAgentRun, pushAgentEvent, finishAgentRun],
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
    // `/skill` commands run the skill straight away — no variable form. The full skill
    // text goes to the model; the chat shows a short "Run skill: …" label. Any text typed
    // after the trigger rides along as the skill's input (else the agent just asks).
    runSkill: (skill, arg) => {
      const input = (arg ?? "").trim();
      const prompt = input ? `${skill.template}\n\n${input}` : skill.template;
      void send(prompt, undefined, { displayText: `Run skill: ${skill.name}${input ? ` — ${input}` : ""}` });
    },
  };
  const commandCtx = useRef<CommandContext>({
    send: (t) => ctxImpl.current.send(t),
    setDraft: (t) => ctxImpl.current.setDraft(t),
    newChat: () => ctxImpl.current.newChat(),
    changeProvider: (p) => ctxImpl.current.changeProvider(p),
    openSettings: () => ctxImpl.current.openSettings(),
    clearChat: () => ctxImpl.current.clearChat(),
    openBatch: () => ctxImpl.current.openBatch(),
    runSkill: (s, arg) => ctxImpl.current.runSkill(s, arg),
  }).current;

  // Load saved skills and expose them as `/` slash commands; rebuild on change.
  const refreshSkills = useCallback(() => { void listSkills().then(setUserSkills); }, []);
  useEffect(() => { refreshSkills(); }, [refreshSkills]);
  useEffect(() => { setSkillCommands(userSkills); }, [userSkills]);

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
  const agentsRunning = agentRuns.filter((r) => r.status === "running").length;

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

        <button className="discover-btn" onClick={() => { setSidebarOpen(false); setDiscoverOpen(true); }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span>Discover APIs</span>
        </button>

        <button className="discover-btn" onClick={() => { setSidebarOpen(false); setSkillsOpen(true); }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          <span>Skills</span>
        </button>

        <button className="discover-btn" onClick={() => { setSidebarOpen(false); setConnectorsOpen(true); }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 2v4" />
            <path d="M15 2v4" />
            <rect x="6" y="6" width="12" height="6" rx="2" />
            <path d="M12 12v4a4 4 0 0 1-4 4H7" />
          </svg>
          <span>Connectors</span>
        </button>

        <button className="discover-btn" onClick={() => { setSidebarOpen(false); setBatchOpen(true); }}>
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
          <button className="acct" onClick={() => { setSidebarOpen(false); setSettingsOpen(true); }} aria-label="Account and settings">
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
          <span className="default-picker">
            <span className="default-picker__label">Default</span>
            <Dropdown
              value={providerOfModel(model)}
              options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
              onChange={changeProvider}
              ariaLabel="Default provider"
            />
          </span>
          <button className="iconbtn" onClick={toggle} aria-label="Toggle theme">{applied === "dark" ? "☀" : "☾"}</button>
          <button
            className="iconbtn agents-toggle"
            onClick={() => setAgentsOpen((o) => !o)}
            aria-label="Toggle agents panel"
            aria-pressed={agentsOpen}
            title="Agents"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
            {agentsRunning > 0 && <span className="agents-toggle__badge">{agentsRunning}</span>}
          </button>
        </header>

        {empty ? (
          <div className="stream-wrap">
            <div className="welcome">
              <h1 className="welcome__title">
                <span className="welcome__mark"><Logo size={30} /></span>
                {greeting}
              </h1>
              <div style={{ width: "100%", maxWidth: 720 }}>
                <AskBox
                  value={draft}
                  onChange={setDraft}
                  onSend={() => send(draft)}
                  onCommand={onCommand}
                  disabled={running}
                  attached={attached}
                  onAttach={setAttached}
                  attachments={attachments}
                  onAttachmentsChange={setAttachments}
                  deepResearch={deepResearch}
                  onToggleDeepResearch={() => setDeepResearch((v) => !v)}
                  webSearch={webSearch}
                  onToggleWebSearch={() => setWebSearch((v) => !v)}
                  openSkills={() => setSkillsOpen(true)}
                  openConnectors={() => setConnectorsOpen(true)}
                  model={model}
                  onModelChange={changeModel}
                  autoFocus
                  tall
                />
              </div>
              <ExampleChips onPick={(p) => void send(p)} />
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
              <AskBox
                value={draft}
                onChange={setDraft}
                onSend={() => send(draft)}
                onCommand={onCommand}
                disabled={running}
                attached={attached}
                onAttach={setAttached}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                deepResearch={deepResearch}
                onToggleDeepResearch={() => setDeepResearch((v) => !v)}
                webSearch={webSearch}
                onToggleWebSearch={() => setWebSearch((v) => !v)}
                openSkills={() => setSkillsOpen(true)}
                openConnectors={() => setConnectorsOpen(true)}
                model={model}
                onModelChange={changeModel}
              />
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

      <SkillsModal
        open={skillsOpen}
        onClose={() => setSkillsOpen(false)}
        onRun={(prompt, displayText) => void send(prompt, undefined, displayText ? { displayText } : undefined)}
        onSkillsChanged={(s) => setUserSkills(s)}
      />
      <ConnectorsModal open={connectorsOpen} onClose={() => setConnectorsOpen(false)} />
      <BatchModal open={batchOpen} onClose={() => setBatchOpen(false)} runRow={runBatchRow} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} ctx={commandCtx} />
      <AgentsPanel
        runs={agentRuns}
        open={agentsOpen}
        onClose={() => setAgentsOpen(false)}
        onClear={() => setAgentRuns([])}
        onOpenRaw={openRaw}
        rawStore={rawStore.current}
      />
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
        <div className="msg__body">
          {m.images && m.images.length > 0 && (
            <div className="msg__images" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: m.content ? 8 : 0 }}>
              {m.images.map((src, i) => (
                <img key={i} src={src} alt="attachment" style={{ maxWidth: 220, maxHeight: 220, borderRadius: 8, objectFit: "cover" }} />
              ))}
            </div>
          )}
          {m.content}
        </div>
        {m.attachmentNames && m.attachmentNames.length > 0 && (
          <div className="msg__attachments">
            {m.attachmentNames.map((name) => (
              <span key={name} className="filechip filechip--sent" title={name}>
                <span className="filechip__icon" aria-hidden="true">📎</span>
                <span className="filechip__name">{name}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  const showCostChip = pending?.event.kind === "cost";
  // Contextual label for the persistent "working" spinner shown the whole time a turn
  // is live (thinking → running a tool → responding), so there's always an indication
  // something is happening.
  const runningStep = m.steps.find((s: TraceStep) => s.status === "running");
  const workingLabel = runningStep
    ? runningStep.api === "web"
      ? /search/i.test(runningStep.path ?? "")
        ? "Searching the web…"
        : "Reading the web…"
      : `Running ${runningStep.api}…`
    : m.content
      ? "Responding…"
      : "Thinking…";
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
        {m.content && <Markdown content={m.content} />}
        <Sources steps={m.steps} />
        {m.streaming && (
          <div className="thinking">
            <Spinner size={16} />
            <span>{workingLabel}</span>
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

// Claude-style category chips: a row of chips; clicking one expands a panel of
// that category's example prompts. Only one panel is open at a time; an X closes it.
function ExampleChips({ onPick }: { onPick: (prompt: string) => void }) {
  const [openLabel, setOpenLabel] = useState<string | null>(null);
  const active = EXAMPLE_CATS.find((c) => c.label === openLabel) ?? null;

  return (
    <div className="cats">
      <div className="cats__row" role="group" aria-label="Example categories">
        {EXAMPLE_CATS.map((c) => (
          <button
            key={c.label}
            type="button"
            className={`cat-chip${openLabel === c.label ? " cat-chip--active" : ""}`}
            aria-expanded={openLabel === c.label}
            onClick={() => setOpenLabel((cur) => (cur === c.label ? null : c.label))}
          >
            {c.label}
          </button>
        ))}
      </div>
      {active && (
        <div className="cat-panel" role="region" aria-label={`${active.label} examples`}>
          <div className="cat-panel__head">
            <span className="cat-panel__title">{active.label}</span>
            <button className="iconbtn iconbtn--sm" aria-label="Close examples" onClick={() => setOpenLabel(null)}>✕</button>
          </div>
          <div className="cat-panel__list">
            {active.items.map((ex) => (
              <button key={ex} type="button" className="examplecard" onClick={() => onPick(ex)}>{ex}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Vision attach limits (mirror the server-side gate in conversation-do.ts).
const MAX_IMAGES = 2;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function readImageDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

// Each attached file is capped at ~200KB read client-side.
const MAX_ATTACH_BYTES = 200 * 1024;

// Combined picker accept list: images + the existing text-document types.
const FILE_ACCEPT =
  "image/*,text/*,.txt,.text,.md,.markdown,.rst,.log,.csv,.tsv,.json,.jsonl,.ndjson,.yaml,.yml,.toml,.ini,.env,.xml,.html,.htm,.css,.scss,.svg,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.rb,.go,.rs,.java,.kt,.c,.h,.cc,.cpp,.hpp,.cs,.php,.swift,.sh,.bash,.zsh,.sql,.graphql,.gql,.vue,.svelte";

function AskBox({
  value,
  onChange,
  onSend,
  onCommand,
  disabled,
  attachments,
  onAttachmentsChange,
  deepResearch,
  onToggleDeepResearch,
  webSearch,
  onToggleWebSearch,
  openSkills,
  openConnectors,
  model,
  onModelChange,
  autoFocus,
  attached = [],
  onAttach,
  tall,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onCommand?: (cmd: Command, arg: string) => void;
  disabled: boolean;
  attachments?: Attachment[];
  onAttachmentsChange?: (files: Attachment[]) => void;
  deepResearch?: boolean;
  onToggleDeepResearch?: () => void;
  webSearch?: boolean;
  onToggleWebSearch?: () => void;
  openSkills?: () => void;
  openConnectors?: () => void;
  model?: string;
  onModelChange?: (modelId: string) => void;
  autoFocus?: boolean;
  attached?: string[];
  onAttach?: (images: string[]) => void;
  /** Taller initial input for the centered home screen (Claude-style). */
  tall?: boolean;
}) {
  // The slash menu is shown when the draft starts with "/" and isn't yet a
  // full "command + space + arg" line being typed past the menu. We keep it
  // open while the user is still on the command word or just past it.
  const slashOpen = onCommand != null && value.startsWith("/");
  const navRef = useRef<SlashNav | null>(null);

  const files = attachments ?? [];
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Inline notice when a non-text / too-large file is rejected.
  const [attachNotice, setAttachNotice] = useState<string | null>(null);

  const runActive = () => {
    const nav = navRef.current;
    if (nav?.hasResults) {
      nav.run();
      return true;
    }
    return false;
  };

  // One combined picker: images ride as vision input (capped at MAX_IMAGES);
  // text files are read and kept as {name, content} (prepended to the prompt).
  // Anything else surfaces a friendly notice. Both behaviors preserved, one entry.
  const onPickCombined = (list: FileList | null) => {
    if (!list) return;
    setAttachNotice(null);
    const picked = Array.from(list);
    let imageRoom = onAttach ? MAX_IMAGES - attached.length : 0;
    const addedImages: string[] = [];
    const addedFiles: Attachment[] = [];
    let pending = picked.length;
    const finish = () => {
      pending -= 1;
      if (pending > 0) return;
      if (addedImages.length > 0 && onAttach) onAttach([...attached, ...addedImages].slice(0, MAX_IMAGES));
      if (addedFiles.length > 0 && onAttachmentsChange) onAttachmentsChange([...(attachments ?? []), ...addedFiles]);
    };
    for (const file of picked) {
      if (file.type.startsWith("image/")) {
        if (!onAttach || imageRoom <= 0) {
          setAttachNotice(`Up to ${MAX_IMAGES} images per message.`);
          finish();
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          setAttachNotice(`"${file.name}" is too large (max 4MB).`);
          finish();
          continue;
        }
        imageRoom -= 1;
        void readImageDataUrl(file)
          .then((url) => {
            if (url) addedImages.push(url);
          })
          .catch(() => {})
          .finally(finish);
        continue;
      }
      if (!onAttachmentsChange || !isTextFile(file.name, file.type)) {
        setAttachNotice(`"${file.name}" isn't supported — images or text files only.`);
        finish();
        continue;
      }
      if (file.size > MAX_ATTACH_BYTES) {
        setAttachNotice(`"${file.name}" is too large (max 200KB).`);
        finish();
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        addedFiles.push({ name: file.name, content: typeof reader.result === "string" ? reader.result : "" });
        finish();
      };
      reader.onerror = () => {
        setAttachNotice(`Couldn't read "${file.name}".`);
        finish();
      };
      reader.readAsText(file);
    }
  };

  const removeImage = (idx: number) => onAttach?.(attached.filter((_, i) => i !== idx));
  const removeAttachment = (name: string) => {
    onAttachmentsChange?.(files.filter((f) => f.name !== name));
  };

  const canAttach = !!onAttach || !!onAttachmentsChange;

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
      {onAttach && attached.length > 0 && (
        <div className="ask__chips" style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "8px 4px 0" }}>
          {attached.map((src, i) => (
            <span key={i} style={{ position: "relative", display: "inline-block" }}>
              <img src={src} alt="attachment" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, display: "block" }} />
              <button
                type="button"
                aria-label="Remove image"
                onClick={() => removeImage(i)}
                style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", border: "none", background: "rgba(0,0,0,0.7)", color: "#fff", cursor: "pointer", lineHeight: "16px", fontSize: 12, padding: 0 }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {onAttachmentsChange && (files.length > 0 || attachNotice) && (
        <div className="attach-tray">
          {files.map((f) => (
            <span key={f.name} className="filechip" title={f.name}>
              <span className="filechip__icon" aria-hidden="true">📎</span>
              <span className="filechip__name">{f.name}</span>
              <button
                type="button"
                className="filechip__remove"
                aria-label={`Remove ${f.name}`}
                onClick={() => removeAttachment(f.name)}
              >
                &times;
              </button>
            </span>
          ))}
          {attachNotice && <span className="attach-notice">{attachNotice}</span>}
        </div>
      )}
      {/* Show a notice for the image-only composer (no text-file tray) too. */}
      {!onAttachmentsChange && attachNotice && (
        <div className="attach-tray"><span className="attach-notice">{attachNotice}</span></div>
      )}
      <div className={`ask${tall ? " ask--tall" : ""}`}>
        {canAttach && (
          <input
            ref={fileInputRef}
            type="file"
            className="attach-input"
            multiple
            accept={FILE_ACCEPT}
            onChange={(e) => {
              onPickCombined(e.target.files);
              e.target.value = "";
            }}
          />
        )}
        {(canAttach || onToggleWebSearch || onToggleDeepResearch || openSkills || openConnectors) && (
          <ComposerMenu
            disabled={disabled}
            canAttach={canAttach}
            onAddFiles={() => fileInputRef.current?.click()}
            webSearch={webSearch}
            onToggleWebSearch={onToggleWebSearch}
            deepResearch={deepResearch}
            onToggleDeepResearch={onToggleDeepResearch}
            openSkills={openSkills}
            openConnectors={openConnectors}
          />
        )}
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
        {model && onModelChange && <ComposerModelPicker model={model} onChange={onModelChange} />}
        <button className="ask__send" onClick={onSend} disabled={disabled} aria-label="Send">↑</button>
      </div>
    </div>
  );
}

// Claude-style "+" popover: one menu for attachments, web search, deep research,
// skills, and connectors. Closes on outside-click or Escape.
function ComposerMenu({
  disabled,
  canAttach,
  onAddFiles,
  webSearch,
  onToggleWebSearch,
  deepResearch,
  onToggleDeepResearch,
  openSkills,
  openConnectors,
}: {
  disabled: boolean;
  canAttach: boolean;
  onAddFiles: () => void;
  webSearch?: boolean | undefined;
  onToggleWebSearch?: (() => void) | undefined;
  deepResearch?: boolean | undefined;
  onToggleDeepResearch?: (() => void) | undefined;
  openSkills?: (() => void) | undefined;
  openConnectors?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="composer-menu" ref={ref}>
      <button
        type="button"
        className="ask__plus"
        aria-label="Add files and tools"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Add files and tools"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {open && (
        <div className="composer-menu__pop" role="menu">
          {canAttach && (
            <button
              type="button"
              className="composer-menu__item"
              role="menuitem"
              disabled={disabled}
              onClick={() => {
                close();
                onAddFiles();
              }}
            >
              <span className="composer-menu__icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </span>
              <span className="composer-menu__label">Add files or photos</span>
            </button>
          )}
          {onToggleWebSearch && (
            <button
              type="button"
              className="composer-menu__item"
              role="menuitemcheckbox"
              aria-checked={!!webSearch}
              onClick={() => onToggleWebSearch()}
            >
              <span className="composer-menu__icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" />
                </svg>
              </span>
              <span className="composer-menu__label">Web search</span>
              {webSearch && <span className="composer-menu__check">✓</span>}
            </button>
          )}
          {onToggleDeepResearch && (
            <button
              type="button"
              className="composer-menu__item"
              role="menuitemcheckbox"
              aria-checked={!!deepResearch}
              onClick={() => onToggleDeepResearch()}
            >
              <span className="composer-menu__icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <span className="composer-menu__label">Deep research</span>
              {deepResearch && <span className="composer-menu__check">✓</span>}
            </button>
          )}
          {(openSkills || openConnectors) && <div className="composer-menu__sep" />}
          {openSkills && (
            <button
              type="button"
              className="composer-menu__item"
              role="menuitem"
              onClick={() => {
                close();
                openSkills();
              }}
            >
              <span className="composer-menu__icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </span>
              <span className="composer-menu__label">Skills</span>
            </button>
          )}
          {openConnectors && (
            <button
              type="button"
              className="composer-menu__item"
              role="menuitem"
              onClick={() => {
                close();
                openConnectors();
              }}
            >
              <span className="composer-menu__icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 7V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v3" />
                  <rect x="4" y="7" width="16" height="13" rx="2" />
                  <line x1="9" y1="13" x2="15" y2="13" />
                </svg>
              </span>
              <span className="composer-menu__label">Connectors</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// In-composer model selector (Claude-style pill): shows the current model's
// displayName; the menu lists models grouped by provider with the active one ticked.
function ComposerModelPicker({ model, onChange }: { model: string; onChange: (modelId: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = modelInfo(model);
  // Providers that actually have a model in the catalog, in catalog order.
  const groups = PROVIDERS.map((p) => ({ provider: p, models: modelsForProvider(p.id) })).filter((g) => g.models.length > 0);

  return (
    <div className="model-pick" ref={ref}>
      <button
        type="button"
        className="model-pick__trigger"
        aria-label="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="model-pick__name">{current?.displayName ?? model}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="model-pick__pop" role="listbox" aria-label="Model">
          {groups.map((g) => (
            <div className="model-pick__group" key={g.provider.id}>
              <div className="model-pick__grouplabel">{g.provider.label}</div>
              {g.models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={m.id === model}
                  className={`model-pick__opt${m.id === model ? " model-pick__opt--active" : ""}`}
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                >
                  <span className="model-pick__opt-label">{m.displayName}</span>
                  {m.id === model && <span className="model-pick__check">✓</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function mergeSpend(list: { api: string; cents: number }[], api: string, cents: number): { api: string; cents: number }[] {
  const existing = list.find((x) => x.api === api);
  if (existing) return list.map((x) => (x.api === api ? { ...x, cents: x.cents + cents } : x));
  return [...list, { api, cents }];
}
