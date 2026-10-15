import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { buildSpawn } from "../src/index.ts";
import { activeBranch, branchTurnStarts, type PiEntry } from "../src/turns.ts";
import { baseScript, type BaseOverrides, type FakePi } from "./fake-pi.ts";
import { collect, open, options, tick } from "./harness.ts";

/** Appends one message entry on a single linear branch and returns its id. */
function append(entries: PiEntry[], role: string, stopReason?: string): string {
  const id = `e${entries.length + 1}`;
  entries.push({ type: "message", id, parentId: entries.at(-1)?.id ?? null, message: { role, ...(stopReason ? { stopReason } : {}) } });
  return id;
}

/** A pi whose every `prompt` appends user → assistant(stop) and settles at once. */
function linearPi(entries: PiEntry[]) {
  return (command: Record<string, unknown>, pi: FakePi) => {
    if (command["type"] !== "prompt") return;
    append(entries, "user");
    append(entries, "assistant", "stop");
    pi.emitLine({ type: "response", id: command["id"], command: "prompt", success: true, data: { disposition: "started" } });
    pi.emitLine({ type: "agent_settled" });
  };
}

async function openWith(script: Parameters<typeof open>[0], base: BaseOverrides, overrides: Parameters<typeof open>[1] = {}) {
  return open(script, overrides, baseScript(base));
}

describe("PiSession.steer", () => {
  it("sends pi's steer command into the running turn, which keeps streaming and settles once", async () => {
    let promptId: unknown;
    const { session, pi } = await openWith((command, self) => {
      if (command["type"] === "prompt") {
        promptId = command["id"];
        self.emitLine({ type: "response", id: promptId, command: "prompt", success: true, data: { disposition: "started" } });
      }
      if (command["type"] === "steer") {
        self.emitLine({ type: "response", id: command["id"], command: "steer", success: true, data: { disposition: "queued" } });
        self.emitLine({ type: "message_start", message: { role: "assistant" } });
        self.emitLine({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "steered" } });
        self.emitLine({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        self.emitLine({ type: "agent_settled" });
      }
    }, {});
    const events: NormalizedEvent[] = [];
    const done = (async () => {
      for await (const event of session.send({ text: "start" })) events.push(event);
    })();
    await tick();
    await session.steer?.({ text: "do this instead", images: [{ mediaType: "image/png", data: "AAAA" }] });
    await done;
    expect(pi().sent.find((command) => command["type"] === "steer")).toMatchObject({
      type: "steer",
      message: "do this instead",
      images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
    expect(events.some((event) => event.type === "assistant.delta" && event.delta === "steered")).toBe(true);
    expect(events.filter((event) => event.type === "settled")).toEqual([{ type: "settled", status: "completed" }]);
    await session.close();
  });

  it("rejects when no turn is running", async () => {
    const { session, pi } = await openWith(() => undefined, {});
    await expect(session.steer?.({ text: "late" })).rejects.toThrow(/no turn is running/);
    expect(pi().sent.some((command) => command["type"] === "steer")).toBe(false);
    await session.close();
  });

  it("rejects when pi refuses the steer (e.g. an extension command)", async () => {
    const { session } = await openWith((command, self) => {
      if (command["type"] === "prompt") self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
      if (command["type"] === "steer") self.emitLine({ type: "response", id: command["id"], command: "steer", success: false, error: 'Extension command "/deploy" cannot be queued.' });
    }, {});
    const turn = collect(session.send({ text: "start" }));
    await tick();
    await expect(session.steer?.({ text: "/deploy" })).rejects.toThrow(/cannot be queued/);
    await session.close();
    await turn;
  });
});

describe("PiSession.rollback", () => {
  it("forks before the first dropped turn's prompt and follows the new session file", async () => {
    const entries: PiEntry[] = [];
    const { session, pi } = await openWith(linearPi(entries), { entries });
    await collect(session.send({ text: "one" }));
    await collect(session.send({ text: "two" }));
    await collect(session.send({ text: "three" }));
    expect(session.nativeSessionId).toBe("/tmp/pi-sessions/thread.jsonl");

    await session.rollback?.(2);
    expect(pi().sent.filter((command) => command["type"] === "fork")).toEqual([expect.objectContaining({ entryId: "e3" })]);
    expect(session.nativeSessionId).toBe("/tmp/pi-sessions/fork-1.jsonl");
    // this process's records were enough: no full get_entries read
    expect(pi().sent.filter((command) => command["type"] === "get_entries" && command["since"] === undefined)).toHaveLength(1);

    // the ledger continues on the new file: one more turn, then dropping it cuts at its prompt
    await collect(session.send({ text: "four" }));
    await session.rollback?.(1);
    expect(pi().sent.filter((command) => command["type"] === "fork").at(-1)).toMatchObject({ entryId: "e3" });
    expect(session.nativeSessionId).toBe("/tmp/pi-sessions/fork-2.jsonl");
    await session.close();
  });

  it("counts a steered turn as one turn", async () => {
    const entries: PiEntry[] = [];
    const { session, pi } = await openWith((command, self) => {
      if (command["type"] === "prompt") {
        append(entries, "user");
        append(entries, "assistant", "stop");
        self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
        if (command["message"] !== "steer me") self.emitLine({ type: "agent_settled" });
      }
      if (command["type"] === "steer") {
        // steered after the model's final answer: the case the history heuristic can't see
        append(entries, "user");
        append(entries, "assistant", "stop");
        self.emitLine({ type: "response", id: command["id"], command: "steer", success: true, data: { disposition: "queued" } });
        self.emitLine({ type: "agent_settled" });
      }
    }, { entries });
    await collect(session.send({ text: "one" }));
    const steered = collect(session.send({ text: "steer me" }));
    await tick();
    await session.steer?.({ text: "and this" });
    await steered;
    await collect(session.send({ text: "three" }));

    await session.rollback?.(2);
    expect(pi().sent.find((command) => command["type"] === "fork")).toMatchObject({ entryId: "e3" });
    await session.close();
  });

  it("reads the branch for turns from before this process (resume / --fork), skipping mid-run steers", async () => {
    const entries: PiEntry[] = [];
    append(entries, "user"); // e1: turn 1
    append(entries, "assistant", "stop");
    entries.push({ type: "model_change", id: "e3", parentId: "e2" });
    append(entries, "user"); // e4: turn 2
    append(entries, "assistant", "toolUse");
    append(entries, "toolResult");
    append(entries, "user"); // e7: a steer delivered mid-run
    append(entries, "assistant", "stop");
    const { session, pi } = await openWith(linearPi(entries), { entries }, { resume: "/tmp/pi-sessions/thread.jsonl" });
    await collect(session.send({ text: "turn 3" })); // e9

    await session.rollback?.(2);
    expect(pi().sent.find((command) => command["type"] === "fork")).toMatchObject({ entryId: "e4" });
    await session.close();
  });

  it("drops a handled send without forking", async () => {
    const entries: PiEntry[] = [];
    const { session, pi } = await openWith((command, self) => {
      if (command["type"] === "prompt") self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true, data: { disposition: "handled" } });
    }, { entries });
    await collect(session.send({ text: "/my-extension-command" }));
    await session.rollback?.(1);
    expect(pi().sent.some((command) => command["type"] === "fork")).toBe(false);
    await session.close();
  });

  it("refuses more turns than the session has, a running turn, and an extension's cancel", async () => {
    const entries: PiEntry[] = [];
    const { session } = await openWith(linearPi(entries), { entries });
    await collect(session.send({ text: "one" }));
    await expect(session.rollback?.(2)).rejects.toThrow(/cannot roll back 2 turns/);
    await session.close();

    const { session: busy } = await openWith((command, self) => {
      if (command["type"] === "prompt") self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
    }, {});
    const turn = collect(busy.send({ text: "long" }));
    await tick();
    await expect(busy.rollback?.(1)).rejects.toThrow(/busy/);
    await busy.close();
    await turn;

    const cancelled: PiEntry[] = [];
    const { session: guarded } = await openWith(linearPi(cancelled), { entries: cancelled, cancelFork: true });
    await collect(guarded.send({ text: "one" }));
    await expect(guarded.rollback?.(1)).rejects.toThrow(/cancelled/);
    expect(guarded.nativeSessionId).toBe("/tmp/pi-sessions/thread.jsonl");
    await guarded.close();
  });

  it("re-applies a live mode change the fork's fresh runtime forgot", async () => {
    const entries: PiEntry[] = [];
    const { session, pi } = await openWith((command, self) => {
      if (command["type"] === "prompt" && String(command["message"]).startsWith("/tide-config")) {
        self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true, data: { disposition: "handled" } });
        return;
      }
      linearPi(entries)(command, self);
    }, { entries, commands: [{ name: "tide-config", source: "extension" }] });
    await collect(session.send({ text: "one" }));
    expect(await session.reconfigure?.({ mode: "full-access", interaction: "default" })).toBe("applied");
    await session.rollback?.(1);
    const configs = pi().sent.filter((command) => command["type"] === "prompt" && String(command["message"]).startsWith("/tide-config"));
    expect(configs).toHaveLength(2);
    await session.close();
  });
});

describe("fork (openSession forkFrom)", () => {
  it("spawns pi with --fork and never --session", () => {
    const { args } = buildSpawn({ ...options, forkFrom: "/tmp/pi-sessions/source.jsonl", resume: "/tmp/ignored.jsonl" }, {}, undefined);
    expect(args).toContain("--fork");
    expect(args[args.indexOf("--fork") + 1]).toBe("/tmp/pi-sessions/source.jsonl");
    expect(args).not.toContain("--session");
  });

  it("takes the forked copy's session file as its native id", async () => {
    const { session } = await openWith(() => undefined, { sessionFile: "/tmp/pi-sessions/copy.jsonl" }, { forkFrom: "/tmp/pi-sessions/source.jsonl" });
    expect(session.nativeSessionId).toBe("/tmp/pi-sessions/copy.jsonl");
    await session.close();
  });
});

describe("turn starts from the session tree", () => {
  it("follows the active branch, not abandoned siblings", () => {
    const entries: PiEntry[] = [
      { type: "message", id: "a", parentId: null, message: { role: "user" } },
      { type: "message", id: "b", parentId: "a", message: { role: "assistant", stopReason: "stop" } },
      { type: "message", id: "c", parentId: "b", message: { role: "user" } },
      { type: "message", id: "d", parentId: "b", message: { role: "user" } },
      { type: "message", id: "e", parentId: "d", message: { role: "assistant", stopReason: "aborted" } },
    ];
    const branch = activeBranch(entries, "e");
    expect(branch.map((entry) => entry.id)).toEqual(["a", "b", "d", "e"]);
    expect(branchTurnStarts(branch)).toEqual(["a", "d"]);
  });
});
