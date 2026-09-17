# Ortha — Design System

Source of truth for Ortha's UI. Every frontend agent builds to this. Locked via
`/plan-design-review` (3/10 → 8/10). If you need to deviate, change THIS file first.

Ortha is an **app console**, not a marketing page. The product's wow is
*transparency* — the user watches a real agent discover and call real tools — so the
UI's job is to make that legible without burying the answer. The look is
clean, professional, calm — a light monochrome
surface, hairline borders, thin icons, generous whitespace. No gradients, no glass,
no aurora. (We tried that; it read as AI slop. This is the corrected direction.)

### Layout
- **Left sidebar** (`--sidebar`, 256px): logo + "Ortha" wordmark → account switcher →
  **`+ New chat`** → **conversations list** ("Recent") → bottom: **session cost**,
  "Get free credits ↗", and the **account button (avatar + name + ⚙) which opens
  Settings**. Settings lives bottom-left with the account.
- **Main** (white): minimal top bar (model picker · theme toggle · live cost meter
  during a turn). Empty state = centered **"Welcome to Ortha"** + subtitle + large
  **"Ask Ortha"** input + **categorized example cards** (Recruiting, Enrichment) that
  showcase the API catalog. In-conversation = message stream + inline agent-trace
  + bottom Ask box.

## 1. Aesthetic

Clean, **light-first** (the hero) with a fully-supported dark toggle. Calm monochrome:
white canvas, near-black ink + primary, neutral grays, hairline borders. Theme follows
system by default, manual toggle persisted per user. The only saturated color is a
sparing `--accent` (indigo) for the active conversation, links, and the running
trace/spinner — everything else is neutral.

### Color tokens

CSS variables; never hardcode hex. `:root` is light (default); `:root[data-theme="dark"]`
overrides.

| Token | Light (default) | Dark |
|---|---|---|
| `--bg` (canvas) | `#FFFFFF` | `#0F0F11` |
| `--sidebar` | `#FBFBFA` | `#131315` |
| `--surface` / `--raised` | `#FFFFFF` | `#161618` / `#1C1C1F` |
| `--ink` | `#18181B` | `#F4F4F5` |
| `--muted` | `#71717A` | `#A1A1AA` |
| `--hairline` | `#ECECEB` | `#262629` |
| `--primary` (buttons/send/active) | `#18181B` | `#F4F4F5` |
| `--accent` (sparing: links/active/spinner) | `#4F46E5` | `#818CF8` |
| `--ok` / `--warn` / `--danger` | `#16A34A` / `#D97706` / `#DC2626` | brightened |

Contrast: all body text ≥ 4.5:1 in **both** themes.

### Logo
Code-only inline SVG (`components/Logo.tsx`): an Ortha monogram, a black **"O" ring**
on a light rounded tile, next to a solid-ink "Ortha" wordmark (no gradient). The
loading spinner is the same ring drawn as an accent-colored rotating arc. The favicon
(`apps/web/public/favicon.svg`) uses the same monogram.

### Typography

- UI typeface: **Geist** (fallback: Söhne, then a neutral grotesque). NEVER `system-ui`,
  Inter, Roboto, or Arial as the primary face.
- Mono typeface (tool-step traces, raw data, code): **Geist Mono** (fallback JetBrains Mono).
- Scale (px): body 16 · small 14 · h3 18 · h2 24 · h1 32. Line-height 1.5 for body.
- Body never below 16px. Mono trace lines may be 14px.

### Spacing, shape, elevation

- 8px grid: 4 / 8 / 12 / 16 / 24 / 32.
- Border radius: 8px (inputs, blocks, cards-that-earn-it). Pills/chips: full.
- Borders: 1px `--hairline`. Shadows: only for modal and the right panel overlay.
  No decorative shadows on inline elements.

---

## 2. Information architecture

```
┌─ top bar ──────────────────────────────────────────────────────────────┐
│ Ortha  [workspace ▾]      ◉ $0.12 / $1.00  [model ▾]  [☾/☀]  ⚙        │
├──────────────┬───────────────────────────────────────┬──────────────────┤
│ CONVERSATIONS│  CHAT STREAM (primary — the answer)    │  RIGHT PANEL      │
│ + New chat   │   user / assistant messages            │  (on-demand only) │
│ • Stripe …   │   inline agent-trace blocks            │  expanded raw     │
│ • Leads …    │   streaming tokens                     │  tool result /    │
│ [account]    │   composer (pinned)                    │  artifact         │
└──────────────┴───────────────────────────────────────┴──────────────────┘
```

- **Center chat stream is primary** — the answer always wins the hierarchy.
- **Agent trace = inline collapsible blocks in the stream** (Claude-faithful), NOT a
  permanent panel.
- **Right panel is on-demand**, opened only to show a tool call's full raw result /
  artifact (the `expand_result` handle). It overlays; it never shrinks the stream below 640px.
- Top bar: workspace switcher · cost meter · model picker · theme toggle · settings.

---

## 3. Signature component: the agent-trace block

The differentiator. Each agent step renders inline as a compact, collapsible block.

Collapsed (mono):
```
▸ apollo · /people/match · $0.03 · ✓ 240ms
```
Expanded:
```
▾ apollo · /people/match · $0.03 · ✓ 240ms
    params  { email: "ceo@stripe.com" }
    result  Patrick Collison · CEO · Stripe        [ Open raw ↗ ]
```

- "Open raw ↗" opens the full provider JSON in the right panel.
- Step states (icon + label + color, **never color alone**):
  - searching — `⊙` accent, "searching tools…"
  - calling — `◴` accent (animated), "calling apollo…"
  - success — `✓` `--ok`
  - failed — `✕` `--danger` + a self-heal note ("apollo timed out → trying clearbit")
  - skipped — muted badge
- Mono font for the step line. Respect `prefers-reduced-motion` (no spinner animation).

---

## 4. Approvals (friction scales with consequence)

- **Spend gate → inline chip** in the stream (non-modal, keeps flow):
  ```
  Next step ~$0.40 · session $0.82 / $1.00 cap
  [ Approve ]  [ Raise cap ]  [ Skip ]
  ```
- **Side-effect gate → confirmation modal** (focus-trapped). Names the exact action +
  target + cost; explicit `[ Confirm ]` / `[ Cancel ]`. Never auto-approved, never a
  one-click reflex. Used for any tool that writes/sends/changes state in the world.

---

## 5. Cost meter

Top-bar slim meter, always visible (cost-awareness is the brand) but calm:
```
◉ $0.12 / $1.00   ▱▱▰▰▰▰▰▰▰▰   (thin fill bar)
```
- Fill turns `--warn` at 80% of cap, `--danger` at 100%.
- Click → popover with per-tool spend breakdown for the session.

---

## 6. Interaction states (every surface, every state)

| Surface | loading | empty | error | success | partial |
|---|---|---|---|---|---|
| Chat stream | skeleton + "thinking…" | warm first-run + 3 example prompts + key nudge | inline error bubble + retry | streamed tokens | partial answer + "tool failed, continuing" |
| Trace block | step spinner (reduced-motion: static) | — | red step + reason + self-heal note | ✓ + latency + cost | step-skipped badge |
| Right panel (result) | shimmer | "no data returned" + refine | provider error + alt-provider offer | rendered + raw toggle | truncated + "load full" |
| Conversation list | skeleton rows | "Start your first chat" CTA | retry | list | — |
| Auth | button spinner | — | field-level errors, never a white screen | redirect to app | — |
| Settings / keys | — | "Add a provider key to start" | inline invalid-key check | saved toast | — |

**Empty states are features.** First-run chat: a warm one-liner ("Ask Ortha to find
real-world data — it'll discover the right tool live."), 3 click-to-run example prompts,
and a BYOK key-setup nudge if no key is configured. Zero-result tool call:
"Apollo found nothing for that — want me to try a different source?" (ties to self-heal).

---

## 7. Responsive

- **≥1024px**: full three-region; right panel overlays, never shrinks stream < 640px.
- **768–1024px**: right panel becomes a full-height sheet; conversation rail collapses to icons.
- **<768px**: single column; conversation rail = top drawer; right panel = bottom sheet;
  trace blocks stay inline; cost meter compacts to `$0.12 ▸`; composer pinned to bottom;
  all touch targets ≥ 44px.

---

## 8. Accessibility (not optional)

- Full keyboard nav. `⌘K` command palette (new chat, switch model). `Esc` closes panel/modal.
  `Enter` sends, `Shift+Enter` newline.
- Chat stream is an ARIA `log` with `aria-live="polite"` so screen readers announce streamed
  tokens and trace updates without spamming.
- Modals are focus-trapped `dialog`s.
- Contrast ≥ 4.5:1 on body text in both themes.
- Respect `prefers-reduced-motion`: disable token-stream and step animations.
- Tool-step status never relies on color alone — always icon + label too.

---

## 9. Anti-slop — explicit DON'Ts

This is an app console. Do NOT ship:
- Purple / indigo / blue-to-purple gradients
- The 3-column icon-in-circle feature grid
- Centered-everything layouts
- Uniform giant border-radius on everything
- Decorative blobs, floating circles, wavy dividers
- Emoji as UI elements
- Colored left-border cards
- `system-ui` / `-apple-system` as the primary font
- A "Welcome to Ortha" marketing hero
- Cards that don't earn their existence

If deleting 30% of the chrome makes a screen clearer, delete it.
