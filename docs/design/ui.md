# Tide v2 — UI design

Present tense; the code follows this document. Principle: **the thread is the primary
object; the code is the thread's worktree, shown as a review-and-intervention surface.**
Tide is an orchestrator that includes an editor, not an editor with a chat panel.

## Shell

Desktop (≥ 720px): `[Strip 44px][Rail 280px, drag 240–360][main]` under a 36px top bar, over a 24px status
bar. `⌘B` (or the strip's Inbox button) collapses the rail; the strip stays. The phone layout
(`components/mobile`) is separate.

| Region | Width | Content |
|---|---|---|
| Top bar | 36px | logo (→ Mission Control) · `Project › Thread` breadcrumb, or the page heading (`--fs-md --fw-medium`) · right: env chip (multi-environment only), connection dot, theme toggle, `search` icon = command palette (`⌘K`). No project switcher: projects are picked in the rail. Carries `data-tauri-drag-region`. |
| Strip | 44px | `--surface`, hairline right border. Top: Mission Control (`⌘0`), Inbox (toggles the rail; amber badge = threads that need you), Pull requests (badge = open PRs), Usage, Experts (new session). Bottom: Environments (only with more than one environment; → Settings › Environments), Settings (`⌘,`). 36×36 icon buttons, `title="Name (shortcut)"`; the active page has `aria-current="page"`, `--selection` fill and a 2px `--selection-bar` on the left edge. |
| Rail | 280px, resizable 240–360 (persisted) | see **Rail anatomy** |
| Thread | flexible, primary | header: one 32px row = state chip · title (inline rename: double-click or ✎) · branch chip (mono, tooltip = worktree path, `main checkout` when none) \| Terminal · Fork (latest settled turn) · `⋯` (below ~560px container width Terminal and Fork fold into `⋯`; Stop lives only in the composer) (New child, Roll back last turn…, Snooze ▸, Copy thread ID, Copy branch, Remove worktree…, Archive thread…); a 24px sub-row exists only when it has chips (PR / merge, lineage `forked from <title>`, `Limited` menu, `Rolling back…`, delegates, rate limit) · pinned plan progress while running · stream of messages + activities · inline cards (approval, user-input, proposed plan) · composer |
| Workbench | flexible, secondary | tabs: **Changes** (default) · open files (Monaco) · tree toggle · terminal drawer |
| Status bar | 24px | `⎇ branch (worktree)` · context % + cost · diff stats · provider health · connection |

Focus modes: `⌘1` Thread only · `⌘2` Split (default 45/55, draggable) · `⌘3` Workbench only.
Rail toggle `⌘B`. Terminal drawer `` ⌘` ``. Palette `⌘K`.

### Rail anatomy

**Projects are a filter, not a tree.** The rail is one flat list of threads for the current scope
(All, or one project); there is no project node to expand.

1. **Header**: search field (`search` icon, "Search threads"; `/` focuses it, Esc clears) and one `New`
   split button: the main half starts a thread in the scoped project (or asks which project when the
   scope is All); the chevron offers Thread · Experts session · Team… · Add project… (a dialog).
2. **Project chips** (hidden with exactly one project): `All`, then per project `icon Name · n` (n = threads
   in Inbox + Needs you), a `--st-running` dot when something runs and a `--st-needs` dot when something
   waits. Click scopes the rail (`selectedProjectId`); right-click or `…` opens the project menu (new
   thread / Experts, rename, icon, linked repositories, copy path, Project settings…, Archive project…).
   The row scrolls horizontally and fades past five chips.
3. **Groups**, in order: **Needs you · Inbox · Working · Snoozed · Settled · Archived**. A label row is
   `--fs-xs` uppercase + count + chevron; the fold is remembered per group (Settled and Archived start
   folded); Archived has `Clear` (deletes empty archived threads). Pinned threads lead the Inbox. An
   Experts session sits in its lead's group with its expert and lead threads nested; delegates and
   children nest under their parent. Empty groups are not drawn.
4. **Thread row** (`--row-h`): 20px status slot (the glyph; on hover the settle checkbox) · title
   (`--fs-base`, ellipsis) · meta column (`--fs-sm --muted`: harness monogram, project initial when the
   scope is All with more than one project, relative time). A second line only when there is a tag:
   settle reason, `PR #n`, merge state, delegate role / outcome, snoozed-until, or a search snippet.
   Hover actions: merge back (`merge`, when the thread has an unmerged branch and is not running) and
   `…`. Selected: `--selection` fill + 2px `--selection-bar`; multi-selected the same; ⌘-click toggles,
   shift-click extends, a bulk bar (Settle · Snooze · Regenerate titles) appears above the list.
5. **Search**: the local filter (title, project, harness) applies on every keystroke; from two characters
   `threads.search` also runs on every connected environment (debounced 250ms). While a query is active
   the groups give way to one **Results · n** list: local matches first, then server hits not already
   listed, each with its snippet (a `search` icon marks a message match). "Nothing matches" when empty.
6. **Empty states**: no project → "Add a repository" card with one button (opens the Add project dialog);
   a project with no threads → "New thread"; a search with no results.

Merge back from the rail sends `thread.merge` with no strategy, so the server applies Settings › Git;
when `confirmMergeBack` is on, a dialog asks first.

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

**Thread**: one chronological stream. Messages are plain (the user's as a quiet labelled block,
the assistant's as unboxed prose, both on one left edge). Activities are single lines
`▸ Read src/foo.ts` / `❯ Bash pnpm test  2.1s ✓`, expandable; consecutive activities collapse into a
group ("read 4 files", "5 tool calls  Bash, Read, Edit…"). Subagent /
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

### Thread layout and type

- **Column and measure.** Every stream item sits in one centred column `min(100%, 960px)` and shares its
  left edge; there is no left/right chat alignment. Prose (paragraphs, lists, headings, quotes, the user
  block, tool lines) caps at `--measure` (720px) inside it; code blocks, tables, diagrams, diffs and
  cards may use the full column and scroll sideways rather than wrap. The composer sits at the same left
  edge and `--measure` width.
- **User message.** A tiny `You` label (`--fs-xs`, `--muted`, the turn's ⋯ menu at its right) over a
  `--surface-2` block with a hairline and `--radius`, full measure, `white-space: pre-wrap` so the
  user's own line breaks survive. Assistant text has no box.
- **Markdown.** Body `--fs-base`, `line-height: 1.6`, normal white-space: a single newline is a soft
  break (no `remark-breaks`), a blank line starts a paragraph. `p` margin `0 0 .75em`; `h1` `--fs-lg`,
  `h2` `--fs-md`, `h3`–`h6` `--fs-base`, all `--fw-semibold`, margin `1.25em 0 .5em`; lists `.25em 0 .75em`,
  indent `1.25em`, disc / decimal markers at every depth, `li + li` `.2em`, nested lists tighter;
  inline `code` `--fs-sm` mono on `--surface-2`, 3px radius; `pre` on `--surface` with a hairline,
  `--radius`, `--sp-3` padding, `--fs-sm`, horizontal scroll; `blockquote` a 2px `--border-strong`
  bar, muted; tables compact, hairline cells, `--fs-sm`, `--fw-medium` headers; `hr` a hairline;
  links accent, underlined on hover only; `strong` `--fw-semibold`. First child has no top margin,
  last child no bottom margin.
- **Tool lines.** A collapsed group is a 24px inline line as wide as its text: chevron, the summary,
  up to three distinct tool names (most recent first, `…` past three) in `--fs-sm --muted`, the summed
  duration. No fill; hover is `--surface-hover`. Expanded rows hang under a 1px `--border` rail. A tool
  row: glyph, name `--fw-medium`, target `--fs-sm` mono muted on one line with an ellipsis (the full
  path or every line of the command in its `title`), duration, then a fixed 16px status column
  (`check` / `close` icon, the live `…` while it runs).
- **Turns.** The settled turn's footer is one `--fs-xs --muted` line `--sp-4` under the reply; each
  new turn's prompt opens `--sp-6` below the previous turn. No rules between turns. Thinking stays a
  collapsed 24px line like a tool group (it opens itself only while the model thinks and nothing else
  is on screen).
- **Composer.** `--surface`, hairline (accent while focused), `--radius-lg`; the textarea is
  borderless inside it at `--fs-base`, `line-height: 1.5`, 2 rows growing to 12; toolbar pills `--fs-sm`.
- **New text.** Output that lands while the reader is scrolled up raises a `⌄ New text` pill at the
  bottom centre; it jumps to the end and goes away once the stream is at the bottom.

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
Keyboard, Environments (this machine, pairing, other machines, relay).

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
`--fs-xs` + `--fw-semibold` + `letter-spacing: .06em` (uppercase, `--text-2`) is the section header
(`--fs-section/--fw-section/--ls-section` are aliases); **no text is smaller than 11px**.

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
- Type: system UI stack, `--fs-base` (13px); monospace for paths, commands, diffs. Titles and selected states use
  weight 500-600; metadata is `--fs-sm` `--muted`. Full scale under "Visual system".
- Flat surfaces, hairline borders, no nested cards, no shadows except popovers.
- Motion only for state: streaming caret and fade, live shimmer, drawer slide. Rules under "Motion".
- Density: rows 28px in rail/lists, 24px activity lines, 32px thread header.

## Visual system

### Type scale

Every `font-size` is a token; `styles/tokens.test.ts` fails on a `px` literal anywhere but `tokens.css`.

| Token | Size | Role |
|---|---|---|
| `--fs-xs` | 11px | group/section labels (uppercase, `--fw-semibold`, `letter-spacing: .06em`); monospace inline content (paths, diffs, code, branch names), which reads a size larger than sans |
| `--fs-sm` | 12px | meta: times, durations, pills, help text, status bar, small buttons |
| `--fs-base` | 13px | body, rows, inputs, card titles (`--font-size-base` is an alias) |
| `--fs-md` | 14px | page section titles; phone body text |
| `--fs-lg` | 18px | page titles, the wordmark |
| `--fs-display` | 28px | one-off display: a pairing code, the phone back chevron |
| `--fs-touch-input` | 16px | phone inputs only (iOS zooms the page below 16px) |

Line height `--lh-body: 1.45` for text, `--lh-tight: 1.2` for titles and single-line chips. Weights
`--fw-regular: 400`, `--fw-medium: 500` (titles, selected rows), `--fw-semibold: 600` (section labels, page titles).

### Spacing and measure

4-grid: `--sp-1..7` = 4, 8, 12, 16, 24, 32, 48. Rows: `--row-h: 28px` (rail, lists), `--row-h-nav: 32px`
(settings nav, icon strip), `--activity-h: 24px` (stream lines). Settings and prose pages cap content at
`--measure: 720px`.

### Surfaces and elevation

`--bg < --surface < --surface-2 < --surface-raised` (table above). Hover on a row or quiet control is
`--surface-hover` (4% white in dark, 4% slate in light), laid over whatever surface the row sits on.
`--shadow-pop` stays reserved for popovers, menus and dialogs.

### Selection and focus

- Selected row: `--selection` background (accent at 10%) plus a 2px `--selection-bar` (accent) on the
  leading edge. Never a filled accent row.
- Keyboard focus: `--focus-ring` (2px `--bg` gap, then 2px accent) as a `box-shadow` on every interactive
  element (`button`, `[role=button]`, `a`, `input`, `select`, `textarea`, `[tabindex]`) via `:focus-visible`
  in `global.css`. A control keeps its own radius; bare ones get `--radius-sm`. No focus ring on mouse click.

### Icons

- `components/ui/Icon.tsx`: `<Icon name="inbox" />`, inline SVG, 24×24 viewBox drawn at 16px (12px inside
  dense text), `currentColor` stroke 1.75, round caps and joins, no fill. Path data lives in `icons.ts`.
- Decorative by default (`aria-hidden`); pass `label` when the icon is the only content of a control
  (`role="img"` + `aria-label`), or label the button itself.
- UI chrome (toggles, menus, close, nav, attachment chips) uses icons, never Unicode glyphs (`▸ ▾ ⋯ ✕ ⚙`).
  The turn footer's token arrows are data and stay text; tool lines mark ok / failed with the `check` / `close` icons.

## Motion

- Durations `--dur-fast: 120ms` (hover, small fades, tail words) and `--dur: 200ms` (drawers, popovers,
  panels), easing `--ease: cubic-bezier(0.2, 0, 0, 1)`. Under `prefers-reduced-motion: reduce` both are 0ms.
- Motion only reports state; nothing loops unless work is in progress.
- **Live shimmer** (`thread/LiveLabel`): a label for work that is happening (a running tool call's name,
  "Thinking…" before the first answer text) is drawn `--muted`, and a 4.5rem window of the same text in
  `--text`, masked soft at both edges, sweeps left to right in 2.2s with `steps(30)`, forever. The window
  moves with `left`; the copy inside counter-translates by the same amount so its glyphs sit on the muted
  ones. The bright copy comes from a CSS `attr()`, so the text exists once in the DOM. It replaces the old
  opacity pulse.
- **Pause off screen:** every loop reads `animation-play-state: var(--visible-animation-state)`.
  `lib/visibleAnimation.ts` sets it to `running` only while the element intersects the viewport, the tab is
  visible, and neither reduced motion nor forced colours is on: one shared IntersectionObserver plus one
  `visibilitychange` listener, attached by ref callback (`ref={observeVisibleAnimation}`).
- **Streaming fade** (assistant replies, `MessageItem`): while a reply streams, its markdown carries
  `data-streaming` and each newly rendered block fades in once (opacity, 600ms ease-out, via
  `@starting-style`). The last 12 words of a plain paragraph line are held out of the markdown as spans keyed
  by their offset in the reply, so each new word fades in over `--dur-fast` and the text flows rather than
  popping per paragraph. The split is skipped (block fade only) inside an open code fence, when the last
  block is a list, quote, heading, table or indented, when the line has fewer than 4 words, and when the
  tail holds any markdown syntax. Words already on screen never fade again. A settled reply renders exactly
  as plain markdown: no attributes, no held-out tail, nothing replays.
- **Caret:** a 2px `--accent` bar that breathes (opacity 0.35 to 1, 1.2s ease-in-out); static under
  reduced motion.
- Reduced motion / forced colours: no shimmer window (the muted label alone), no fades, static caret.

## Component inventory (apps/web/src/components)

`shell/` TopBar, Strip, Rail (RailHeader, ProjectChips, RailGroups, RailThreadRow, RailSearch, RailEmpty), StatusBar, SplitPane, FocusModeSwitch · `mission/` MissionControl, Inbox, ProjectCard, ProjectLinks ·
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

`shell/ThemeToggle` sits in the top bar's right cluster, `FocusModeSwitch` beside the bar; the top row carries
`data-tauri-drag-region` and `<html data-desktop="mac|win|linux">` reserves the
traffic-light inset.

## Keyboard map

`⌘K` palette · `⌘N` new thread · `⌘0` Mission Control · `⌘1/2/3` focus modes · `⌘B` rail ·
`` ⌘` `` terminal · `↵` send and stay · `⌘↵` idle: send in the background (back to Mission Control); while a turn runs: send in the other follow-up mode (Steer ↔ Queue) · `⌥↵` the other mode · `Esc` stop turn / close · `y`/`n` approve/deny focused card ·
`⌘S` in the composer: stash the draft / apply the latest stash · `⌘Z` undo the last settle (while its toast is up or the rail/thread has focus) · `⌘⇧E` in the thread column: cycle reasoning effort (in the workbench: toggle file tree) ·
`/` at the start of a line: slash commands + skills of the thread's harness · `@` mention a worktree file ·
`⌘P` open file in worktree · `⌘S` save · `⌘⇧D` toggle unified/split diff · `[` `]` prev/next turn ·
`⌘⇧L` toggle light/dark.

Rail keys (single keys, never while a text field has focus; rebindable through
`UserSettings.keybindings`, ids in `lib/keybindings.ts` `RAIL_BINDINGS`): `/` search (`rail.search`) ·
`j`/`k` next/previous row (`rail.next`, `rail.prev`) · `↵` open (`rail.open`) · `e` settle / unsettle
(`rail.settle`) · `s` snooze menu (`rail.snooze`) · `m` merge back (`rail.merge`) · `x` toggle selection
(`rail.select`) · `Esc` clears the search, then the selection.
