import { execFileSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";
import { EDIT_TRIGGER, FINAL_TEXT, NEW_CONTENT, STREAM_CHUNKS } from "../fixtures/script.ts";
import { readState, startServer, stopServer, writeState, type E2EState } from "../fixtures/server.ts";

/**
 * One walk through the real app: production web bundle served by tide-server started from
 * source, a throwaway git repo, and a scripted ACP agent (`fixtures/fake-agent.ts`) instead of
 * a real harness. Steps share one page and run in order; a failed step skips the rest.
 */

test.describe.configure({ mode: "serial" });

const PROMPT = `${EDIT_TRIGGER} so it greets the e2e world`;
const STREAMED = STREAM_CHUNKS.join("");
const FOLLOW_UP = "are you still there?";

let state: E2EState;
let context: BrowserContext;
let page: Page;
/** the server this worker restarted in the reconnect step (global teardown owns the first one) */
let restarted: ChildProcess | undefined;
const pageErrors: string[] = [];

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: state.repo, encoding: "utf8", env: { ...process.env, HOME: state.home } }).trim();
}

const thread = (): Locator => page.getByRole("region", { name: "Thread" });
const workbench = (): Locator => page.getByRole("region", { name: "Workbench" });
const messages = (): Locator => thread().getByRole("listitem");
const composer = (): Locator => thread().getByRole("textbox", { name: "Message" });
const send = (): Locator => thread().getByRole("button", { name: "Send", exact: true });
const assistantReply = (text: string): Locator => messages().filter({ hasText: text }).filter({ has: page.getByRole("button", { name: "Copy reply" }) });

test.beforeAll(async ({ browser }) => {
  state = readState();
  context = await browser.newContext({ baseURL: `http://127.0.0.1:${state.port}` });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
});

test.afterAll(async () => {
  await context?.close();
  if (restarted) await stopServer(restarted);
});

test("a. boot: the first-run checklist shows only once the first snapshot is in", async () => {
  // hold the socket ticket so the app is observably "loading" (no first snapshot yet)
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let ticketAsked: () => void = () => undefined;
  const asked = new Promise<void>((done) => {
    ticketAsked = done;
  });
  await page.route("**/api/auth/ws-ticket", async (route: Route) => {
    ticketAsked();
    await held;
    await route.continue();
  });
  await page.goto(`/?token=${state.token}`);
  await asked;
  const checklist = page.getByRole("list", { name: "Getting started" });
  await expect(page.getByRole("status", { name: "Loading Mission Control" })).toBeVisible();
  await expect(checklist).toBeHidden();
  await expect(page.getByRole("button", { name: "Add repository" })).toHaveCount(0);

  release();
  await expect(checklist.getByRole("button", { name: "Add repository" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading Mission Control" })).toBeHidden();
  await expect(checklist).toContainText("Ready: E2E Agent");
  await page.unroute("**/api/auth/ws-ticket");
});

test("b. add the temp repo as a project through the Add repository dialog", async () => {
  await page.getByRole("list", { name: "Getting started" }).getByRole("button", { name: "Add repository" }).click();
  const dialog = page.getByRole("dialog", { name: "Add project" });
  await expect(dialog.getByRole("radio", { name: "Existing repository" })).toBeChecked();
  // a typed path names the project after the folder ("repo")
  await dialog.getByRole("textbox", { name: "Project root path" }).fill(state.repo);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("article", { name: /^Project / })).toContainText("0 threads");
});

test("c. a thread on the fake harness streams text and shows a tool row", async () => {
  await page.getByRole("navigation", { name: "Navigation" }).getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New thread" });
  await expect(dialog.getByRole("combobox", { name: "Thread provider" })).toContainText("E2E Agent");
  await expect(dialog.getByRole("combobox", { name: "Thread permissions" })).toContainText("Ask first");
  await expect(dialog.getByRole("checkbox", { name: "Use a worktree" })).toBeChecked();
  await dialog.getByRole("button", { name: "Create thread" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("contentinfo")).toContainText("(worktree)");

  await composer().fill(PROMPT);
  await send().click();
  await expect(messages().filter({ hasText: "You" }).filter({ hasText: PROMPT })).toBeVisible();
  // the streamed chunks are on screen while the turn is still waiting on the user
  await expect(messages().filter({ hasText: STREAMED }).first()).toBeVisible();
  await expect(thread().getByRole("button", { name: /^Edit hello\.txt/ })).toBeVisible();
  await expect(thread().getByText("Needs you").first()).toBeVisible();
});

test("d. the edit asks permission; approving it completes the turn", async () => {
  const card = thread().getByRole("region", { name: "Approval: Edit hello.txt" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("+hello e2e world");
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(card).toBeHidden();
  await expect(messages().filter({ hasText: "Allowed Edit hello.txt" })).toBeVisible();
  await expect(assistantReply(FINAL_TEXT)).toBeVisible();
  await expect(messages().filter({ hasText: "ended · 1 tool call" })).toBeVisible();
  await expect(thread().getByRole("img", { name: "done" })).toBeVisible();
  await expect(send()).toBeVisible();
});

test("e. Workbench › Changes lists the file with its diff", async () => {
  await expect(workbench().getByRole("tab", { name: "Changes", selected: true })).toBeVisible();
  const files = workbench().getByRole("listbox", { name: "Changed files" });
  await expect(files.getByRole("option", { name: /hello\.txt \+1 −1/ })).toBeVisible();
  await files.getByRole("option", { name: /hello\.txt/ }).click();
  // Monaco's diff editor: the added line is rendered in the modified pane
  await expect(workbench().getByText("hello e2e world").first()).toBeVisible();
});

test("f. merge back from the thread; the base branch has the change", async () => {
  const before = git("rev-parse", "main");
  await workbench().getByRole("button", { name: "Merge", exact: true }).click();
  const confirm = page.getByRole("dialog").filter({ hasText: "tide/new-thread → main" });
  await expect(confirm.getByRole("radio", { name: /^Squash/ })).toBeChecked();
  await confirm.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(thread().getByRole("img", { name: "merged" })).toBeVisible();
  await expect(messages().filter({ hasText: /Merged tide\/new-thread into main/ })).toBeVisible();

  expect(git("rev-parse", "main")).not.toBe(before);
  expect(`${git("show", "main:hello.txt")}\n`).toBe(NEW_CONTENT);
  // nothing was pushed anywhere: the repo has no remote and the default leaves the merge local
  expect(git("remote")).toBe("");
});

test("g1. server killed: the quiet pill shows, never the boot overlay; send is disabled with a reason", async () => {
  const pid = state.serverPid;
  expect(pid, "global setup records the server pid").toBeDefined();
  process.kill(pid as number, "SIGKILL");

  const pill = page.getByRole("status", { name: "Connection" });
  await expect(pill).toContainText("Reconnecting…");
  await expect(page.getByText("Could not reach the Tide server")).toHaveCount(0);
  await composer().fill(FOLLOW_UP);
  await expect(send()).toBeDisabled();
  const reason = await send().getAttribute("title");
  expect(reason, "the disabled Send says why").toBeTruthy();
  await expect(thread().getByRole("status")).toContainText(`${reason}. Sending resumes when it reconnects`);
});

test("g2. server back on the same port and home: the pill lifts, the thread is intact, a new message goes through", async () => {
  restarted = await startServer(state);
  writeState(join(state.root, "state.json"), { ...state, ...(restarted.pid !== undefined ? { serverPid: restarted.pid } : {}) });
  await expect(page.getByRole("status", { name: "Connection" })).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText("Could not reach the Tide server")).toHaveCount(0);
  // the draft typed while offline is still there and can be sent again
  await expect(composer()).toHaveValue(FOLLOW_UP);
  await expect(send()).toBeEnabled();
  await composer().fill("");

  // a fresh page load reads everything from the restarted server (event log replay)
  await page.reload();
  await page.getByRole("region", { name: "Settled" }).getByRole("button", { name: /^Settled/ }).click();
  await page.getByRole("button", { name: new RegExp(`^Merged ${PROMPT}`) }).click();
  await expect(messages().filter({ hasText: PROMPT }).first()).toBeVisible();
  await expect(messages().filter({ hasText: STREAMED }).first()).toBeVisible();
  await expect(assistantReply(FINAL_TEXT)).toBeVisible();
  await expect(thread().getByRole("img", { name: "merged" })).toBeVisible();

  // a merged thread has no worktree any more (the server refuses new turns there), so the
  // "can still send" check runs on a new thread: it also proves a fresh agent session spawns
  await page.getByRole("navigation", { name: "Navigation" }).getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New thread" });
  await dialog.getByRole("button", { name: "Create thread" }).click();
  await expect(dialog).toBeHidden();
  await expect(thread().getByRole("heading", { name: "Start by describing the task" })).toBeVisible();
  await composer().fill(FOLLOW_UP);
  await send().click();
  await expect(messages().filter({ hasText: "You" }).filter({ hasText: FOLLOW_UP })).toBeVisible();
  await expect(assistantReply(`Echo: ${FOLLOW_UP}`)).toBeVisible();
});

test("h. Copy reply puts the assistant's text on the clipboard", async ({ browserName }) => {
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://127.0.0.1:${state.port}` });
  } catch (error) {
    test.skip(true, `the ${browserName} channel refused clipboard permissions: ${String(error)}`);
  }
  await assistantReply(`Echo: ${FOLLOW_UP}`).getByRole("button", { name: "Copy reply" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`Echo: ${FOLLOW_UP}`);
});

test("i. Settings › Git: push-after-merge is off; Esc leaves a field, then closes Settings", async () => {
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("region", { name: "Settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Git", exact: true }).click();
  await expect(settings.getByRole("switch", { name: "Push the base branch after merging" })).not.toBeChecked();

  const search = settings.getByRole("searchbox", { name: "Search settings" });
  await search.focus();
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).not.toBeFocused();
  await expect(settings).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
});

test("no uncaught page errors during the walk", () => {
  expect(pageErrors).toEqual([]);
});
