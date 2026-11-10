import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { readState, startServer, stopServer, writeState, type E2EState } from "../fixtures/server.ts";

/**
 * R19 device access levels, after `smoke.e2e.ts` (a project dependency in the config: this spec
 * reuses its repo, project and threads). The owner pairs a second browser context with a code;
 * that device starts with limited access, then the owner turns Full access on and the device
 * picks it up when its window regains focus, without a reload.
 */

test.describe.configure({ mode: "serial" });

const MACHINE = "e2e";
const LIMIT = `This device has limited access. Turn on Full access for it on ${MACHINE}.`;
const DEVICE_PROMPT = "hello from the paired device";
/** the thread smoke step g2 leaves sendable (a worktree, an echo reply) */
const FOLLOW_UP = "are you still there?";

let state: E2EState;
/** started here only when the smoke spec's server is gone (its worker stops the one it restarted) */
let started: ChildProcess | undefined;
let ownerContext: BrowserContext;
let owner: Page;
let deviceContext: BrowserContext;
let device: Page;
let deviceName = "";
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

async function open(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${state.port}` });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { context, page };
}

const settings = (page: Page): Locator => page.getByRole("region", { name: "Settings" });
const thread = (page: Page): Locator => page.getByRole("region", { name: "Thread" });
const composer = (page: Page): Locator => thread(page).getByRole("textbox", { name: "Message" });
const send = (page: Page): Locator => thread(page).getByRole("button", { name: "Send", exact: true });
const assistantReply = (page: Page, text: string): Locator =>
  thread(page).getByRole("listitem").filter({ hasText: text }).filter({ has: page.getByRole("button", { name: "Copy reply" }) });

async function openSettings(page: Page, section: string): Promise<Locator> {
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: "Settings" }).click();
  await settings(page).getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: section, exact: true }).click();
  return settings(page);
}

/** The workbench "+" menu's New terminal entry (opened, so its state can be read). */
async function newTerminalItem(page: Page): Promise<Locator> {
  await page.getByRole("region", { name: "Workbench" }).getByRole("button", { name: "Open…" }).click();
  return page.getByRole("menuitem", { name: "New terminal" });
}

test.beforeAll(async ({ browser }) => {
  state = readState();
  if (!alive(state.serverPid)) {
    started = await startServer(state);
    writeState(join(state.root, "state.json"), { ...state, ...(started.pid !== undefined ? { serverPid: started.pid } : {}) });
  }
  ({ context: ownerContext, page: owner } = await open(browser));
  ({ context: deviceContext, page: device } = await open(browser));
});

test.afterAll(async () => {
  await deviceContext?.close();
  await ownerContext?.close();
  if (started) await stopServer(started);
});

test("j. the owner mints a pairing code; a fresh browser pairs with it and gets limited access", async () => {
  await owner.goto(`/?token=${state.token}`);
  const mine = await openSettings(owner, "Environments");
  await expect(mine.getByRole("switch", { name: "Full access" })).not.toBeChecked();
  await mine.getByRole("button", { name: "Pair another device" }).click();
  const pairing = mine.getByLabel("Pairing code");
  await expect(pairing).toContainText("pairs with limited access");
  const code = ((await pairing.getByTestId("pairing-code").textContent()) ?? "").trim();
  expect(code).toMatch(/^\d{6}$/);

  // the device opens the server's page with no token (refused), then pairs from Settings › Environments
  await device.goto("/");
  await device.getByRole("button", { name: "Continue without a connection" }).click();
  const theirs = await openSettings(device, "Environments");
  await theirs.getByRole("button", { name: "Add machine" }).click();
  const add = device.getByRole("dialog", { name: "Add machine" });
  await add.getByRole("textbox", { name: "Machine URL" }).fill(`http://127.0.0.1:${state.port}`);
  await add.getByRole("textbox", { name: "Pairing code" }).fill(code);
  await add.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(add).toBeHidden();
  await expect(device.getByRole("contentinfo")).toContainText("connected");

  // the owner's Paired devices list (read when the section opens) shows it as Limited
  const sections = mine.getByRole("navigation", { name: "Settings sections" });
  await sections.getByRole("button", { name: "Git", exact: true }).click();
  await sections.getByRole("button", { name: "Environments", exact: true }).click();
  const access = mine.getByRole("list", { name: "Paired devices" }).getByRole("combobox", { name: /^Access for / });
  await expect(access).toHaveCount(1);
  await expect(access).toContainText("Limited");
  deviceName = ((await access.getAttribute("aria-label")) ?? "").replace(/^Access for /, "");
  expect(deviceName).not.toBe("");
});

test("k. the limited device reads and chats; terminal and settings are off with the reason", async () => {
  await settings(device).getByRole("button", { name: /^Close/ }).click();
  await expect(settings(device)).toBeHidden();
  const rail = device.getByRole("navigation", { name: "Navigation" });
  await expect(rail.getByRole("region", { name: "Settled" })).toBeVisible();
  // the thread the smoke walk left with a worktree (step g2)
  // the row's own button ("<status> <title> <age>") comes before its Settle / Actions buttons
  await rail.getByRole("button", { name: /are you still there\?/ }).first().click();
  await expect(assistantReply(device, `Echo: ${FOLLOW_UP}`)).toBeVisible();

  const terminal = await newTerminalItem(device);
  await expect(terminal).toBeDisabled();
  await expect(terminal).toHaveAttribute("title", LIMIT);
  await device.keyboard.press("Escape");
  await expect(terminal).toBeHidden();

  const git = await openSettings(device, "Git");
  await expect(git.getByRole("note")).toHaveText(`Read-only. ${LIMIT}`);
  await git.getByRole("button", { name: /^Close/ }).click();
  await expect(git).toBeHidden();

  // chat is allowed: the scripted agent answers the device's message
  await composer(device).fill(DEVICE_PROMPT);
  await send(device).click();
  await expect(assistantReply(device, `Echo: ${DEVICE_PROMPT}`)).toBeVisible();
});

test("l. the owner turns Full access on; the device picks it up when its window regains focus", async () => {
  const mine = settings(owner);
  await mine.getByRole("combobox", { name: `Access for ${deviceName}` }).click();
  await owner.getByRole("option", { name: /^Full access/ }).click();
  await expect(mine.getByRole("combobox", { name: `Access for ${deviceName}` })).toContainText("Full access");

  // no reload: the focus event re-reads server.info, which carries the new level
  await device.evaluate(() => window.dispatchEvent(new Event("focus")));
  const terminal = await newTerminalItem(device);
  await expect(terminal).toBeEnabled();
  await expect(terminal).not.toHaveAttribute("title", LIMIT);
  await device.keyboard.press("Escape");
});

test("no uncaught page errors on either page", () => {
  expect(pageErrors).toEqual([]);
});
