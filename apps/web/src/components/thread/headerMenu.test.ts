import { afterEach, describe, expect, it } from "vitest";
import { headerMenu } from "./headerMenu.ts";
import { defaultUserSettings, useServerSettings } from "../../state/serverSettings.ts";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  resetUi();
  useServerSettings.setState({ settings: defaultUserSettings() });
});

const LABEL = "Auto-allow routine approvals (this thread)";

function enable(sites: Partial<ReturnType<typeof defaultUserSettings>["decisions"]["sites"]> = {}, hasKey = true): void {
  const base = defaultUserSettings();
  useServerSettings.setState({ settings: { ...base, decisions: { ...base.decisions, enabled: true, hasKey, sites: { ...base.decisions.sites, ...sites } } } });
}

describe("headerMenu: auto-allow routine approvals", () => {
  it("toggles the thread's opt-in", () => {
    enable();
    const thread = makeThread("t1");
    const fake = attachFakeStore(modelWith({ threads: { t1: thread } }));
    const item = headerMenu(fake.store.getState().model, thread).find((i) => i.label === LABEL);
    expect(item).toMatchObject({ checked: false, disabled: false });
    item?.onSelect?.();
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.update", threadId: "t1", autoAllowRoutine: true });
    const on = makeThread("t1", { autoAllowRoutine: true });
    const again = headerMenu(fake.store.getState().model, on).find((i) => i.label === LABEL);
    expect(again?.checked).toBe(true);
    again?.onSelect?.();
    expect(fake.dispatch).toHaveBeenLastCalledWith({ type: "thread.update", threadId: "t1", autoAllowRoutine: false });
  });

  it("is disabled with a hint without a key or with the approvals site off", () => {
    const thread = makeThread("t1");
    const fake = attachFakeStore(modelWith({ threads: { t1: thread } }));
    const model = fake.store.getState().model;
    enable({}, false);
    expect(headerMenu(model, thread).find((i) => i.label === LABEL)).toMatchObject({ disabled: true, hint: "needs a Jev key" });
    enable({ approvals: false });
    expect(headerMenu(model, thread).find((i) => i.label === LABEL)).toMatchObject({ disabled: true, hint: "approvals judge is off" });
  });
});

describe("headerMenu: settle", () => {
  it("settles, unsettles and toggles auto-settle", () => {
    const thread = makeThread("t1");
    const fake = attachFakeStore(modelWith({ threads: { t1: thread } }));
    const model = fake.store.getState().model;
    headerMenu(model, thread).find((i) => i.label === "Settle")?.onSelect?.();
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.settle", threadId: "t1" });
    const settled = makeThread("t1", { settledAt: 2, settleReason: "user" });
    headerMenu(model, settled).find((i) => i.label === "Unsettle")?.onSelect?.();
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.unsettle", threadId: "t1" });
    const auto = headerMenu(model, thread).find((i) => i.label === "Auto-settle this thread");
    expect(auto?.checked).toBe(true);
    auto?.onSelect?.();
    expect(fake.dispatch).toHaveBeenLastCalledWith({ type: "thread.update", threadId: "t1", autoSettle: false });
    const off = headerMenu(model, makeThread("t1", { autoSettle: false })).find((i) => i.label === "Auto-settle this thread");
    expect(off?.checked).toBe(false);
  });
});

describe("headerMenu: folded Terminal item", () => {
  it("says why it is off: no session yet, or a harness with no resume command (ACP)", () => {
    const fresh = makeThread("t1");
    const fake = attachFakeStore(modelWith({ threads: { t1: fresh } }));
    const model = fake.store.getState().model;
    expect(headerMenu(model, fresh, Date.now(), { terminal: undefined, fork: undefined }).find((i) => i.label === "Terminal")).toMatchObject({ disabled: true, hint: "no session yet" });
    const acp = makeThread("t1", { provider: "acp", nativeSessionId: "sess_1" });
    expect(headerMenu(model, acp, Date.now(), { terminal: undefined, fork: undefined }).find((i) => i.label === "Terminal")).toMatchObject({ disabled: true, hint: "this harness has no terminal resume command" });
    expect(headerMenu(model, acp, Date.now(), { terminal: "x --resume 1", fork: undefined }).find((i) => i.label === "Terminal")).toMatchObject({ disabled: false });
  });
});
