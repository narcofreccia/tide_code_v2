# Multi-harness workflows

Tide runs Claude Code, Codex, OpenCode and Pi side by side. There are three ways to put more
than one of them on the same piece of work. They differ in who drives: you, one agent, or a
saved team.

## 1. By hand: plan, implement, review

You move the work between harnesses yourself. Nothing runs without a click.

1. Start a thread on the harness you want to plan with and switch it to plan mode. The plan
   comes back as a **Plan card**.
2. On the card, **Implement in new thread ▾** picks the harness and model for the build. The
   new thread is a sibling of the planning thread and starts from the plan text.
3. When the build settles, switch the **Agent pill** in that thread's composer to a third
   harness and ask for a review. The next turn carries a Handoff card with the earlier turns,
   and the reviewer works in the same worktree, so it sees the real changes.
4. Merge or open a PR from the Changes tab of the build thread.

Use this when you want to read each step before the next one starts.

## 2. One lead with `tide_delegate`

Any thread can hand work to another harness through the `tide` MCP server attached to every
session. The calling thread is the lead; each call creates a child thread you can open, steer
or stop like any other.

- **`completion: "wait"`** blocks until the child settles and returns its last message. A
  single wait lasts at most 10 minutes (`timeoutMs` up to 600000). On a timeout the child keeps
  running and the lead calls `tide_thread_wait` again.
- **`completion: "async"`** (the default) returns the child's `threadId` at once. Tide wakes the
  lead with a "Delegate … finished" message when the child settles or hits its usage limit,
  and with "Delegate … asks" when the child asks a question. Several results that land close
  together arrive as one message. The lead answers questions with `tide_pending_respond`.
- **`role`** is a free-text label (reviewer, tester, research). It frames the child's prompt
  and shows as a tag on the child.
- **`useWorktree: true`** gives the child its own worktree and branch.
- **`inheritWorktreeFrom: "<threadId>"`** runs the child in another thread's checkout, on that
  thread's branch, with no new worktree. A reviewer or tester reads the implementer's work this
  way. The child records its own checkpoints. It cannot merge or publish: Tide refuses and
  points to the thread that owns the checkout, and that thread does the merge. File restores
  are refused while two threads share a checkout. Archiving one of them leaves the checkout on
  disk until the last one is gone.
- **`tide_thread_diff { threadId }`** shows what a thread changed since its first turn: one
  `path (+added −deleted)` header per file, then the patch, each cut at 8000 characters by
  default (`maxCharsPerFile`). Binary files are listed without a patch.
- **`repo`** runs the child in one of the project's writable linked repositories instead.

A child never gets a broader permission mode than its lead. With no model or mode in the call,
the user's per-harness defaults from Settings apply.

## 3. Team runs

A team is a saved list of stages: stage 1 is the lead, every later stage is a role on a
harness. Each later stage runs in its own worktree (`own`) or in the checkout of an earlier
stage (`inherit`, by default the previous one). Settings ships three presets, shown until you
save a team of your own (saving an empty list brings them back):

| Team | Stages |
|---|---|
| Plan → Build → Review | Claude planner (lead) · Codex implementer, own worktree · OpenCode reviewer in the implementer's checkout |
| Build → Test | Codex implementer (lead) · Claude tester in the lead's checkout |
| Pair review | Claude implementer (lead) · Codex reviewer in the lead's checkout |

Running a team on a task creates one thread, the lead, titled `<team>: <first line of the
task>`. Its first message is a brief that:

- states the task and the lead's own part, with any stage instructions;
- spells out the exact `tide_delegate` call for every later stage (harness, role, model, mode,
  `useWorktree` or `inheritWorktreeFrom`, `completion: "wait"`);
- tells the lead to note each returned `threadId`, because an `inherit` stage needs the
  threadId of the stage it reads from, and to point a reviewer at `tide_thread_diff`;
- tells it to keep calling `tide_thread_wait` on a timeout and never to start a stage before
  the previous one has settled;
- forbids skipping a stage, review and test stages included, and allows sending problems back
  to the implementer and re-running the review at most twice;
- asks for a final report listing every stage, its harness, its threadId, its outcome, and
  the thread whose branch to merge.

Tide does not run the stages itself. The lead does, through its harness's own tool calls, so
every stage is an ordinary delegate thread: it shows under the lead tagged with its role, and
you can open, steer, interrupt or drop to the terminal on any of them. Approvals and questions
from any stage land in the Inbox as usual.

Limits:

- **Depth 2.** A delegate can delegate once more; a third level is refused. Team stages are
  depth 1.
- **Fan-out 4.** A thread has at most four running delegates at a time. Team stages run one
  after another, so a team of up to six stages stays within it.
- **Permissions.** Stage modes are capped at the lead's mode. A lead in `approval-required`
  makes every stage ask for approvals.
- **Plan-mode stages.** `tide_delegate` has no interaction setting, so a stage set to plan is
  told in its prompt to plan and not edit.
- **Merging.** The branch to merge belongs to the stage that owns the worktree (usually the
  implementer). Stages that inherited it cannot merge or publish.

Decision answers from Jev (Settings › Decisions) annotate handoff ranking, delegate outcomes, approvals, experts convergence and stuck threads; they never start or merge a stage on their own.
