# Tide v2 — UI design

Present tense; the code follows this document. Principle: **the thread is the primary
object; the code is the thread's worktree, shown as a review-and-intervention surface.**
Tide is an orchestrator that includes an editor, not an editor with a chat panel.

## Shell

Three regions + top bar + status bar. Two regions collapse.

| Region | Width | Content |
|---|---|---|
| Top bar | 36px | `⌘K` palette button · project switcher (Mission Control) or a `project › thread` breadcrumb (text only, while a thread is open) · focus modes · theme |
| Rail | 240px → 48px icons | Mission Control link · **Needs you · n** (cross-project, from `selectInbox`, hidden when empty) · projects (chevron expands/collapses independently of selection; path in a tooltip; amber `◐ n` / accent `● n` badges only when non-zero) → threads (glyph, title, one trailing meta slot that swaps to `⋯` on hover; needs-you rows tinted) · `+ thread` per project · bottom: Settings, legend |
| Thread | flexible, primary | header: one 32px row = state chip · title (inline rename: double-click or ✎) · branch chip (mono, tooltip = worktree path, `main checkout` when none) \| Terminal · Fork (latest settled turn) · `⋯` (below ~560px container width Terminal and Fork fold into `⋯`; Stop lives only in the composer) (New child, Roll back last turn…, Snooze ▸, Copy thread ID, Copy branch, Remove worktree…, Archive thread…); a 24px sub-row exists only when it has chips (PR / merge, lineage `forked from <title>`, `Limited` menu, `Rolling back…`, delegates, rate limit) · pinned plan progress while running · stream of messages + activities · inline cards (approval, user-input, proposed plan) · composer |
| Workbench | flexible, secondary | tabs: **Changes** (default) · open files (Monaco) · tree toggle · terminal drawer |
| Status bar | 24px | `⎇ branch (worktree)` · context % + cost · diff stats · provider health · connection |

Focus modes: `⌘1` Thread only · `⌘2` Split (default 45/55, draggable) · `⌘3` Workbench only.
Rail toggle `⌘B`. Terminal drawer `` ⌘` ``. Palette `⌘K`.

## Views

**Mission Control** (no thread selected, or `⌘0`), top to bottom in the order you act on it:
**Needs you** (full width, every waiting card inline; one line `✓ Nothing needs you` when empty) ·
**Running now** · **Limited** (threads parked on a usage limit with Resume now / At reset / Wait;
hidden when empty) · **Projects** grid (one column, two from 1100px; counts only when non-zero;
cost and automations behind a `Details` disclosure) · collapsed **Snoozed** (Unsnooze) · **Harnesses**
folded to one line (`4 agents ready · 1 needs login`), expandable to the per-harness chips.
A thread with a linked PR and a watch shows a PR watch pill on its card:
`👁 PR #12 · ✔ · 3 comments`. This is the landing view. "New thread" from here asks project → provider → worktree?.

"Open in terminal" opens a new PTY tab in the terminal drawer, on the thread's worktree (or
the project root), and types the harness's own resume command into it (`claude --resume <id>` /
`codex resume` / `opencode`). When no PTY can be created the command is copied instead.

**Thread**: one chronological stream. Messages are plain (user right-aligned muted block,
assistant as prose). Activities are single lines `▸ Read src/foo.ts` / `▸ Bash pnpm test ✓ 2.1s`,
expandable; consecutive activities collapse into a group ("read 4 files"). Subagent /
collab children render as an indented group with a "open as thread" link. Cards:
While a turn runs, the composer's **Steer | Queue** toggle sets what a send does: Steer delivers
the message into the running turn, Queue runs it after the turn (the primary button reads
"Steer" or "Queue"; `Esc` still stops). A provider that cannot steer disables the toggle, and
every follow-up queues. Queued messages form a **QueueList** above the composer: rows can be
edited, moved, dragged, promoted (`Send now as steer`, only when the harness can steer) or removed
(`×`). A queued user message carries a `queued` pill. Images can be pasted or dropped into the composer (max 8, ~5 MB each) when
the harness accepts them; they show as thumbnails before sending and as `🖼 image/png · 120 KB`
pills on the sent message. Assistant extended thinking renders as a collapsed "Thinking"
disclosure above the answer. A settled turn gets a subtle footer under its last assistant
message: duration, tokens in/out, cost, or the error that ended it. Model / mode / interaction
can be changed mid-turn — they apply from the next turn, and the pill says so.

Stream details: a user message delivered into a running turn carries a `steer` tag. Server-authored
wake-ups (delegate finished, child asked a question, PR changed, restart) render as a notice row,
not a message. A turn that started after a harness change or fork shows a collapsed **Handoff**
card (`Handoff · <strategy> · covers N turns, M omitted`, a delivery pill, `from → to`) that
expands to the handed-over text. A rolled-back turn's messages are dimmed and tagged `rolled back`.
Each settled user message has a per-turn **⋯** menu: `Fork from here…` and
`Rollback to before this turn…`. Rollback asks whether files are restored too.

- Approval: tool, target (path/command), diff preview when it is an edit, `Allow` `Allow for session` `Deny`, keyboard `y/n`.
- User input (AskUserQuestion / codex user-input): options as buttons or free text.
- Proposed plan: markdown, `Implement in new thread ▾` (provider · model · worktree checkbox) · `Keep planning`. Never auto-executes.
Composer: textarea, `@` mentions (worktree files), paste images, mode/provider/model pills mirror the top bar, `⌘↵` send, `Esc` stop.

**Workbench › Changes**: turn selector (`Turn 3 of 5 ▾`, "all turns"), file list with +/−, unified/split toggle, Monaco diff. Actions: revert turn, open file, commit+push+PR.
**Workbench › File**: Monaco, write-enabled, dirty dot, `⌘S`. Open from diff, tree, `@mention`, activity line.
**Workbench › Terminal**: xterm in the worktree; tabs; opened by `` ⌘` ``.
Empty state: tree + "No changes in this thread yet".

**Experts**: a thread whose Thread column shows the board — expert cards (provider, model,
status), shared findings feed, discussion, your messages — and phase control (explore →
discuss → synthesize). Workbench shows what experts read. Synthesis becomes a Proposed plan.

## Linked repositories

A project is one main repo; **links** are secondary repos its threads may reach — Claude
Code's `--add-dir` made durable and cross-harness. Each link carries a label, an absolute
path, a one-line note telling the agent what the repo *is*, and an access level
(read / read & write).

**Project settings › Linked repositories** is the editor: a list of links (label, muted
path, note, `rw`/`ro` pill) with add via the FolderPicker (typing a path also works),
inline edit, and remove behind a confirm. It opens from the project card on Mission
Control ("Links · 2", or "Link a repo" when there are none) and from `⌘K`
("Manage linked repositories…", offered while a project is in scope).

**New thread**: when the project has links, the popover lists them as chips, all on at the
project's default access, each with a read / read+write toggle; a link the project shares
read-only cannot be widened. `thread.create.links` is sent only when the user changes
something — otherwise the thread inherits every project link.

**Thread**: the composer's pill row shows read-only chips `⧉ label rw|ro`; hover gives the
path and the note. A live thread's link set is fixed at creation.

**Workbench › Changes**: files a turn changed in a linked repo are grouped below the main
repo's under a `label — path` header, opened at their absolute path, with
"Revert linked changes" per group (`vcs.linkedRevert`).

**Settings** (route `/settings`): Providers (installed/logged-in/version, default model,
default mode, login hint that opens the terminal), Git (worktree root, PR via gh), Appearance,
Keyboard, Remote (bind host, pairing token).

## States per thread (status glyph)

`○ idle` · `● running` (pulsing) · `◐ needs you` (approval / question / plan ready) ·
`✕ error` · `⏸ interrupted` · `✓ PR merged` · `⛔ limited` (usage window exhausted; the header badge
and the Limited section show it, the status column has no glyph) · `snoozed` (hidden until its time;
only in the collapsed Snoozed section, no glyph). Rail sorts needs-you first within a project.

## Design language

### Tokens (`styles/tokens.css`, dark default, light via `prefers-color-scheme` / `[data-theme]`)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0b0d10` | `#eef1f5` | thread column, Mission Control, page |
| `--surface` | `#13161b` | `#ffffff` | rail, top bar, status bar, composer, cards |
| `--surface-2` | `#1b2028` | `#f3f5f8` | hover, inline fields, neutral chips |
| `--surface-raised` | `#232934` | `#ffffff` + border | selected row, popovers, menus, dialogs, composer box |
| `--border` / `--border-strong` | `#272d37` / `#38404d` | `#d5dbe5` / `#b7c0ce` | hairline dividers / controls and raised surfaces |
| `--text` / `--text-2` / `--muted` | `#e6e9ef` / `#b3bac7` / `#8b93a3` | `#131722` / `#3d4555` / `#6a7285` | content / section headers and secondary text / hints |
| `--accent`, `--accent-soft`, `--on-accent` | `#5b9dff`, 16%, `#fff` | `#2f6fe0`, 12%, `#fff` | one hue; fill only for the primary action |
| `--st-running/needs/error/ok/limited/idle/interrupted` + `-soft` | blue / amber `#f2a93b` / red / green / violet `#a78bfa` / grey / orange `#e0794f`; soft = 14-16% tint | darker variants for contrast; soft = 11-15% tint | the one status language: glyphs, chips, row tints |

Light separates surfaces with borders (raised is white plus `--border-strong`), dark with tone steps.
Radii 4/6/10; spacing 4-grid. `--shadow-pop` is the only shadow, and only on popovers.
`--fs-section: 11px` + weight 600 + `letter-spacing: .06em` (uppercase, `--text-2`) is the section header;
**no text is smaller than 11px**.

### Shape rules: state, setting and action never share a capsule

- **State (read-only)** = `Pill` / the header state chip: borderless, fully rounded, sentence case, `--st-*-soft`
  background with the matching text colour (`tone="running|needs|ok|error|limited|interrupted|idle|accent|muted"`).
  It is never clickable. Providers, phases, counts and PR/merge labels are Pills.
- **Setting** = `Select` trigger (`variant="pill"`, 22px, 4px radius, `--border-strong`, caption + value + chevron;
  the composer slots carry the caption) and the Build | Plan / Steer | Queue segmented toggles (same 4px radius).
- **Action** = `Button`: `primary` (accent fill, `--on-accent` text; at most one per surface: Send, Create thread,
  Add repository), `ghost` (outlined), `quiet`, `link`, `danger` (outline) and `quietDanger`
  (composer Stop).
- Layout: thread column on `--bg`; rail, top bar, composer on `--surface`; the composer's text box, the selected
  row and every popover on `--surface-raised`.

### General

- Dark default (settings default is `dark`, stamped pre-paint by an inline script in `index.html`), light via
  `prefers-color-scheme` when the user picks System, or an explicit toggle.
- Type: system UI stack 13px base; monospace for paths, commands, diffs. Titles and selected states use weight
  500-600; metadata is 11px `--muted`.
- Flat surfaces, hairline borders, no nested cards, no shadows except popovers.
- Motion only for state: streaming caret, running pulse, drawer slide (120ms).
- Density: rows 28px in rail/lists, 24px activity lines, 32px thread header.

## Component inventory (apps/web/src/components)

`shell/` TopBar, Rail, NeedsYouGroup, StatusBar, SplitPane, FocusModeSwitch · `mission/` MissionControl, Inbox, ProjectCard, ProjectLinks ·
`thread/` ThreadHeader, ThreadLinkChips, Stream, MessageItem, ActivityRow, ActivityGroup, ApprovalCard,
UserInputCard, PlanCard, PlanProgress, Composer, MentionPicker · `workbench/` Workbench,
ChangesTab, DiffView, FileTab (Monaco), FileTree, TerminalDrawer · `experts/` Board, ExpertCard,
FindingsFeed · `settings/` … · `ui/` Button, Pill, Select, Checkbox/Radio (`Choice`), Menu,
Popover, Dialog, Toast, Kbd.

`Select` is one custom listbox (portalled, `position: fixed`, viewport-clamped via
`ui/useAnchoredPanel.ts`, which `Popover` and `Menu` share) — never a native `<select>`.
Two looks: `variant="pill"` (default, 22px, 4px radius, `size="sm"`) for the top bar and composer
settings, `variant="field"` (28px, full width, `size="md"`) for dialogs and settings rows.
It grows a filter box when `searchable` or past eight options, and takes `description`,
`group`, `icon`, `disabled` + `title` per option. `Checkbox`/`Radio` replace bare
`<input type=checkbox|radio>` everywhere.

`shell/ThemeToggle` sits next to `FocusModeSwitch`; the top row carries
`data-tauri-drag-region` and `<html data-desktop="mac|win|linux">` reserves the
traffic-light inset.

## Keyboard map

`⌘K` palette · `⌘N` new thread · `⌘0` Mission Control · `⌘1/2/3` focus modes · `⌘B` rail ·
`` ⌘` `` terminal · `⌘↵` send · `⌘↵` while a turn runs: send in the other follow-up mode (Steer ↔ Queue) · `Esc` stop turn / close · `y`/`n` approve/deny focused card ·
`⌘P` open file in worktree · `⌘S` save · `⌘⇧D` toggle unified/split diff · `[` `]` prev/next turn ·
`⌘⇧L` toggle light/dark.
