import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { COST_TRIGGER } from "../fixtures/script.ts";
import { readState, startServer, stopServer, writeState, type E2EState } from "../fixtures/server.ts";

/**
 * R20 usage quotas, after `devices.e2e.ts` (a project dependency: this spec reuses the smoke
 * walk's project, "repo"). The project gets a $0.10 weekly cap that holds new turns; one turn of
 * the scripted agent reports $0.50, so the composer blocks once it settles and Mission Control
 * lists the project as held. Lift until reset frees it; Remove takes the quota away.
 *
 * Screenshots for a human look go to `TIDE_E2E_SHOTS` (default: `e2e-shots` under the OS temp dir).
 */

test.describe.configure({ mode: "serial" });

const PROJECT = "repo";
const COSTLY = `${COST_TRIGGER} some money`;
const AFTER_LIFT = "still allowed after the lift?";
const SHOTS = process.env["TIDE_E2E_SHOTS"] ?? join(tmpdir(), "e2e-shots");

let state: E2EState;
/** started here only when the earlier spec's server is gone (its worker stops the one it restarted) */
let started: ChildProcess | undefined;
let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const settings = (): Locator => page.getByRole("region", { name: "Settings" });
const thread = (): Locator => page.getByRole("region", { name: "Thread" });
const messages = (): Locator => thread().getByRole("listitem");
const composer = (): Locator => thread().getByRole("textbox", { name: "Message" });
const send = (): Locator => thread().getByRole("button", { name: "Send", exact: true });
const assistantReply = (text: string): Locator => messages().filter({ hasText: text }).filter({ has: page.getByRole("button", { name: "Copy reply" }) });
const block = (): Locator => thread().getByRole("status", { name: "Quota reached" });
const editor = (): Locator => settings().getByRole("group", { name: `Usage quota of ${PROJECT}` });

async function openProjects(): Promise<Locator> {
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "Settings" }).click();
  await settings().getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Projects", exact: true }).click();
  return settings();
}

async function closeSettings(): Promise<void> {
  await settings().getByRole("button", { name: /^Close/ }).click();
  await expect(settings()).toBeHidden();
}

test.beforeAll(async ({ browser }) => {
  state = readState();
  if (!alive(state.serverPid)) {
    started = await startServer(state);
    writeState(join(state.root, "state.json"), { ...state, ...(started.pid !== undefined ? { serverPid: started.pid } : {}) });
  }
  context = await browser.newContext({ baseURL: `http://127.0.0.1:${state.port}` });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
});

test.afterAll(async () => {
  await context?.close();
  if (started) await stopServer(started);
});

test("m. Settings › Projects: a $0.10 weekly cap that holds new turns", async () => {
  await page.goto(`/?token=${state.token}`);
  const projects = await openProjects();
  await projects.getByRole("button", { name: `Actions for ${PROJECT}` }).click();
  await page.getByRole("menuitem", { name: "Usage quota…" }).click();

  await expect(editor().getByRole("switch")).toBeChecked();
  await editor().getByLabel("Amount per week").fill("0.10");
  await editor().getByRole("combobox", { name: "At the cap" }).click();
  await page.getByRole("option", { name: /^Hold new turns/ }).click();
  await expect(editor().getByRole("combobox", { name: "At the cap" })).toContainText("Hold new turns");
  await page.screenshot({ path: join(SHOTS, "editor.png") });

  await editor().getByRole("button", { name: "Save", exact: true }).click();
  // saved: the project carries a quota, so the editor offers Remove and shows its meter
  await expect(editor().getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await expect(editor().getByRole("meter", { name: `Quota of ${PROJECT}` })).toBeVisible();
  await closeSettings();
});

test("n. one costly turn crosses the cap: the composer shows the block and Send is off", async () => {
  await page.getByRole("navigation", { name: "Navigation" }).getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New thread" });
  await dialog.getByRole("button", { name: "Create thread" }).click();
  await expect(dialog).toBeHidden();
  await expect(thread().getByRole("heading", { name: "Start by describing the task" })).toBeVisible();

  await composer().fill(COSTLY);
  await send().click();
  await expect(assistantReply(`Echo: ${COSTLY}`)).toBeVisible();

  await expect(block()).toBeVisible();
  await expect(block()).toContainText("Project quota reached (");
  await expect(block().getByRole("button", { name: "Lift until reset" })).toBeEnabled();
  await expect(block().getByRole("button", { name: "Edit quota" })).toBeEnabled();
  await expect(thread().getByText("Held by quota")).toBeVisible();
  await composer().fill(AFTER_LIFT);
  await expect(send()).toBeDisabled();
  await page.screenshot({ path: join(SHOTS, "block.png") });
});

test("o. Mission Control lists the project as held, with its meter", async () => {
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "Mission Control" }).click();
  const held = page.getByRole("region", { name: "Held by quota" });
  const row = held.getByRole("listitem", { name: `Held project ${PROJECT}` });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Held by quota");
  await expect(row.getByRole("meter", { name: `Quota of ${PROJECT}` })).toBeVisible();
  await expect(page.getByRole("article", { name: `Project ${PROJECT}` }).getByRole("meter", { name: `Quota of ${PROJECT}` })).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "mission.png") });
});

test("p. Lift until reset: the block goes and a new message is answered", async () => {
  // the thread's rail row ("<status> <title> <age>") comes before its Settle / Actions buttons
  await page.getByRole("navigation", { name: "Navigation" }).getByRole("button", { name: new RegExp(COSTLY) }).first().click();
  await expect(block()).toBeVisible();
  await block().getByRole("button", { name: "Lift until reset" }).click();
  await expect(block()).toBeHidden();
  await expect(composer()).toHaveValue(AFTER_LIFT);
  await expect(send()).toBeEnabled();
  await send().click();
  await expect(assistantReply(`Echo: ${AFTER_LIFT}`)).toBeVisible();
  await expect(block()).toBeHidden();
});

test("q. Remove in Settings takes the quota and its meter away", async () => {
  await openProjects();
  await editor().getByRole("button", { name: "Remove", exact: true }).click();
  await expect(settings().getByRole("meter", { name: `Quota of ${PROJECT}` })).toHaveCount(0);
  await expect(editor()).toHaveCount(0);
  await closeSettings();
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "Mission Control" }).click();
  await expect(page.getByRole("article", { name: `Project ${PROJECT}` })).toBeVisible();
  await expect(page.getByRole("meter", { name: `Quota of ${PROJECT}` })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Held by quota" })).toHaveCount(0);
});

test("no uncaught page errors during the quota walk", () => {
  expect(pageErrors).toEqual([]);
});
