# Tide v2 — UI design

Present tense; the code follows this document. Principle: **the thread is the primary
object; the code is the thread's worktree, shown as a review-and-intervention surface.**
Tide is an orchestrator that includes an editor, not an editor with a chat panel.

## Shell

Three regions + top bar + status bar. Two regions collapse.

| Region | Width | Content |
|---|---|---|
| Top bar | 36px | `⌘K` palette button · project switcher · thread title (inline rename) · right: provider / model / mode / interaction pills · turn state (Stop) |
| Rail | 240px → 48px icons | **Inbox** (approvals, questions, plans-ready across all threads, with count) · projects → threads (child threads nested) · `+ thread` per project · bottom: Settings, connection |
| Thread | flexible, primary | header (branch/worktree, PR badge, actions: open in terminal, new child, archive, detach worktree) · pinned plan progress while running · stream of messages + activities · inline cards (approval, user-input, proposed plan) · composer |
| Workbench | flexible, secondary | tabs: **Changes** (default) · open files (Monaco) · tree toggle · terminal drawer |
| Status bar | 24px | `⎇ branch (worktree)` · context % + cost · diff stats · provider health · connection |

Focus modes: `⌘1` Thread only · `⌘2` Split (default 45/55, draggable) · `⌘3` Workbench only.
Rail toggle `⌘B`. Terminal drawer `` ⌘` ``. Palette `⌘K`.

## Views

**Mission Control** (no thread selected, or `⌘0`): grid/list of all active threads across
projects with status glyph, provider, last activity, needs-attention badge; the Inbox at the
top. This is the landing view. "New thread" from here asks project → provider → worktree?.

"Open in terminal" copies the harness's own resume command to the clipboard (`claude --resume
<id>` / `codex resume` / `opencode` in the worktree) until it opens a PTY tab directly.

**Thread**: one chronological stream. Messages are plain (user right-aligned muted block,
assistant as prose). Activities are single lines `▸ Read src/foo.ts` / `▸ Bash pnpm test ✓ 2.1s`,
expandable; consecutive activities collapse into a group ("read 4 files"). Subagent /
collab children render as an indented group with a "open as thread" link. Cards:
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
`✕ error` · `⏸ interrupted` · `✓ PR merged`. Rail sorts needs-you first within a project.

## Design language

- Tokens in `styles/tokens.css`: `--bg`, `--surface`, `--surface-2`, `--border`, `--text`,
  `--muted`, `--accent` (single hue), `--ok`, `--warn`, `--danger`; radii 4/6/10; spacing 4-grid.
  Dark default (settings default is `dark`, stamped pre-paint by an inline script in
  `index.html`), light via `prefers-color-scheme` when the user picks System, or an
  explicit toggle. `--shadow-pop` is the only shadow, and only on popovers.
- Type: system UI stack 13px base; monospace for paths, commands, diffs.
- Flat surfaces, hairline borders, no nested cards, no shadows except popovers.
- Motion only for state: streaming caret, running pulse, drawer slide (120ms).
- Density: rows 28px in rail/lists, 24px activity lines.

## Component inventory (apps/web/src/components)

`shell/` TopBar, Rail, StatusBar, SplitPane, FocusModeSwitch · `mission/` MissionControl, Inbox, ProjectCard, ProjectLinks ·
`thread/` ThreadHeader, ThreadLinkChips, Stream, MessageItem, ActivityRow, ActivityGroup, ApprovalCard,
UserInputCard, PlanCard, PlanProgress, Composer, MentionPicker · `workbench/` Workbench,
ChangesTab, DiffView, FileTab (Monaco), FileTree, TerminalDrawer · `experts/` Board, ExpertCard,
FindingsFeed · `settings/` … · `ui/` Button, Pill, Select, Checkbox/Radio (`Choice`), Menu,
Popover, Dialog, Toast, Kbd.

`Select` is one custom listbox (portalled, `position: fixed`, viewport-clamped via
`ui/useAnchoredPanel.ts`, which `Popover` and `Menu` share) — never a native `<select>`.
Two looks: `variant="pill"` (default, 20px, `size="sm"`) for the top bar and composer
pills, `variant="field"` (28px, full width, `size="md"`) for dialogs and settings rows.
It grows a filter box when `searchable` or past eight options, and takes `description`,
`group`, `icon`, `disabled` + `title` per option. `Checkbox`/`Radio` replace bare
`<input type=checkbox|radio>` everywhere.

`shell/ThemeToggle` sits next to `FocusModeSwitch`; the top row carries
`data-tauri-drag-region` and `<html data-desktop="mac|win|linux">` reserves the
traffic-light inset.

## Keyboard map

`⌘K` palette · `⌘N` new thread · `⌘0` Mission Control · `⌘1/2/3` focus modes · `⌘B` rail ·
`` ⌘` `` terminal · `⌘↵` send · `Esc` stop turn / close · `y`/`n` approve/deny focused card ·
`⌘P` open file in worktree · `⌘S` save · `⌘⇧D` toggle unified/split diff · `[` `]` prev/next turn ·
`⌘⇧L` toggle light/dark.
