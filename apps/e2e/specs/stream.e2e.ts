import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { LONG_TRIGGER, PARAGRAPH, STREAM_PARAGRAPHS, THOUGHT_LINE } from "../fixtures/script.ts";
import { readState, startServer, stopServer, writeState, type E2EState } from "../fixtures/server.ts";

/**
 * The stream keeps following while the agent writes (`useStreamScroll.ts`), after `quota.e2e.ts`
 * (it reuses the smoke walk's project). The scripted agent streams a long turn; while it does,
 * a wheel-up over the live reasoning body (a nested scroller that can still go up) and a sideways
 * swipe over a wide code block must leave the stream on the end, and a real wheel-up must leave
 * it where the reader stopped. The controller's debug log (`tide.debug.scroll`) is on, so the
 * spec also checks the transitions, not only where the view ends up.
 */

test.describe.configure({ mode: "serial" });

const LONG = `${LONG_TRIGGER} for the scroll check`;

let state: E2EState;
let started: ChildProcess | undefined;
let context: BrowserContext;
let page: Page;
const pageErrors: string[] = [];
/** `[scroll] released: wheel` and friends, in order */
const transitions: string[] = [];

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const thread = (): Locator => page.getByRole("region", { name: "Thread" });
const composer = (): Locator => thread().getByRole("textbox", { name: "Message" });
const send = (): Locator => thread().getByRole("button", { name: "Send", exact: true });
const stream = (): Locator => thread().locator("ol:has(> li[data-row-key])").first();
/** the n-th occurrence (0-based) of paragraph `i`: each long turn writes the same paragraphs */
const paragraph = (i: number, turn: number): Locator => thread().getByText(`${PARAGRAPH} ${i}:`).nth(turn);

const metrics = (): Promise<{ top: number; height: number; toEnd: number }> =>
  stream().evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, toEnd: el.scrollHeight - el.scrollTop - el.clientHeight }));

/** Waits until the stream has grown by `px` since `height`, then reports where the view is. */
async function afterGrowth(height: number, px: number): Promise<{ top: number; height: number; toEnd: number }> {
  await expect.poll(async () => (await metrics()).height - height, { timeout: 10_000 }).toBeGreaterThan(px);
  return metrics();
}

async function hoverCentre(target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("not on screen");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test.beforeAll(async ({ browser }) => {
  state = readState();
  if (!alive(state.serverPid)) {
    started = await startServer(state);
    writeState(join(state.root, "state.json"), { ...state, ...(started.pid !== undefined ? { serverPid: started.pid } : {}) });
  }
  context = await browser.newContext({ baseURL: `http://127.0.0.1:${state.port}` });
  await context.addInitScript(() => localStorage.setItem("tide.debug.scroll", "1"));
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    const transition = /^\[scroll\] \w+: [\w-]+/.exec(message.text());
    if (message.type() === "debug" && transition) transitions.push(transition[0]);
  });
});

test.afterAll(async () => {
  await context?.close();
  if (started) await stopServer(started);
});

test("r. a first long turn fills the stream past the viewport", async () => {
  await page.goto(`/?token=${state.token}`);
  await page.getByRole("navigation", { name: "Navigation" }).getByRole("button", { name: "New", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New thread" });
  await dialog.getByRole("button", { name: "Create thread" }).click();
  await expect(dialog).toBeHidden();
  await composer().fill(LONG);
  await send().click();
  await expect(paragraph(STREAM_PARAGRAPHS, 0)).toBeVisible({ timeout: 30_000 });
  expect((await metrics()).toEnd).toBeLessThanOrEqual(2);
});

test("s. wheel-up over the live reasoning body (it can still scroll up) keeps the stream on the end", async () => {
  await composer().fill(LONG);
  await send().click();
  // by line 25 the body is past its max height and scrolls on its own
  const reasoning = thread().locator("pre", { hasText: `${THOUGHT_LINE} 25` }).last();
  await expect(reasoning).toBeVisible();
  // the reader had scrolled the reasoning down: a wheel-up goes to it, not to the stream
  expect(await reasoning.evaluate((el) => ((el.scrollTop = el.scrollHeight), el.scrollTop))).toBeGreaterThan(0);
  await hoverCentre(reasoning);
  expect(await reasoning.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  transitions.length = 0;
  const before = await metrics();
  await page.mouse.wheel(0, -120);
  const after = await afterGrowth(before.height, 60);
  expect(after.toEnd).toBeLessThanOrEqual(2);
  expect(transitions.filter((t) => t.startsWith("[scroll] released"))).toEqual([]);
});

test("t. a sideways swipe over a wide code block keeps the stream on the end", async () => {
  await expect(paragraph(2, 1)).toBeVisible({ timeout: 15_000 });
  const code = thread().locator("pre", { hasText: "const wide" }).last();
  await hoverCentre(code);
  transitions.length = 0;
  const before = await metrics();
  await page.mouse.wheel(80, -6);
  const after = await afterGrowth(before.height, 60);
  expect(after.toEnd).toBeLessThanOrEqual(2);
  expect(transitions.filter((t) => t.startsWith("[scroll] released"))).toEqual([]);
});

test("u. a real wheel-up releases, and the view stays where the reader stopped while output lands", async () => {
  await hoverCentre(stream());
  transitions.length = 0;
  await page.mouse.wheel(0, -600);
  await expect.poll(async () => (await metrics()).toEnd).toBeGreaterThan(300);
  // the wheel scrolls smoothly: wait for the view to come to rest
  let last = -1;
  await expect
    .poll(async () => {
      const { top } = await metrics();
      const still = top === last;
      last = top;
      return still;
    }, { intervals: [100] })
    .toBe(true);
  const stopped = await metrics();
  // past the release check (CONFIRM_MS) and a few more paragraphs
  const after = await afterGrowth(stopped.height, 120);
  expect(Math.abs(after.top - stopped.top), transitions.join(" | ")).toBeLessThanOrEqual(1);
  expect(transitions[0]).toBe("[scroll] released: wheel");
  expect(transitions).not.toContain("[scroll] following: unmoved-release");
  // the turn is still streaming at this point: the last paragraph has not landed yet
  await expect(paragraph(STREAM_PARAGRAPHS, 1)).toHaveCount(0);
  await expect(thread().getByRole("button", { name: "New text" })).toBeVisible();
});

test("no uncaught page errors during the scroll walk", async () => {
  await expect(paragraph(STREAM_PARAGRAPHS, 1)).toBeAttached({ timeout: 30_000 });
  expect(pageErrors).toEqual([]);
});
