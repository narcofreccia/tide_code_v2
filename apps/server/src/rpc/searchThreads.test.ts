import { describe, expect, it } from "vitest";
import { emptyReadModel, type ReadModel, type Thread } from "@tide/contracts";
import { searchThreads, SNIPPET_MAX } from "./searchThreads.ts";

function build(spec: { id: string; title: string; projectId?: string; archived?: boolean; updatedAt?: number; msgs?: [string, number][] }[]): ReadModel {
  const model = emptyReadModel();
  for (const s of spec) {
    model.threads[s.id] = { id: s.id, projectId: s.projectId ?? "p1", title: s.title, provider: "claude", mode: "approval-required", interaction: "default", status: "idle", createdAt: 1, updatedAt: s.updatedAt ?? 1, ...(s.archived ? { archivedAt: 5 } : {}) } as Thread;
    model.threadMessages[s.id] = [];
    (s.msgs ?? []).forEach(([text, at], i) => {
      const id = `${s.id}-m${i}`;
      model.messages[id] = { id, threadId: s.id, turnId: "u", role: "user", text, createdAt: at } as ReadModel["messages"][string];
      model.threadMessages[s.id]?.push(id);
    });
  }
  return model;
}

describe("searchThreads", () => {
  it("requires every term in the same thread, case-insensitively, across title and messages", () => {
    const m = build([
      { id: "a", title: "Fix Login", msgs: [["the OAuth redirect is broken", 10]] },
      { id: "b", title: "Other", msgs: [["login only", 20]] },
    ]);
    expect(searchThreads(m, { q: "LOGIN oauth" }).map((h) => h.threadId)).toEqual(["a"]);
    expect(searchThreads(m, { q: "nothing" })).toEqual([]);
    expect(searchThreads(m, { q: "   " })).toEqual([]);
  });

  it("prefers a title match, else the most recent matching message", () => {
    const m = build([
      { id: "a", title: "Deploy script", updatedAt: 99, msgs: [["deploy now", 10]] },
      { id: "b", title: "Chat", msgs: [["old deploy note", 10], ["newer deploy note", 30], ["unrelated", 40]] },
    ]);
    const hits = searchThreads(m, { q: "deploy" });
    expect(hits[0]).toMatchObject({ threadId: "a", field: "title", snippet: "Deploy script", at: 99 });
    expect(hits[1]).toMatchObject({ threadId: "b", field: "message", snippet: "newer deploy note", at: 30 });
  });

  it("names the message a message hit came from; a title hit carries none", () => {
    const m = build([
      { id: "a", title: "Deploy script", msgs: [["deploy now", 10]] },
      { id: "b", title: "Chat", msgs: [["old deploy note", 10], ["newer deploy note", 30], ["unrelated", 40]] },
    ]);
    const hits = searchThreads(m, { q: "deploy" });
    expect(hits.find((h) => h.threadId === "b")?.messageId).toBe("b-m1");
    expect(hits.find((h) => h.threadId === "a")?.messageId).toBeUndefined();
  });

  it("excludes archived threads unless the query starts with archived:", () => {
    const m = build([{ id: "a", title: "old thing", archived: true }, { id: "b", title: "thing" }]);
    expect(searchThreads(m, { q: "thing" }).map((h) => h.threadId)).toEqual(["b"]);
    expect(searchThreads(m, { q: "archived: thing" }).map((h) => h.threadId).sort()).toEqual(["a", "b"]);
    expect(searchThreads(m, { q: "archived:" })).toEqual([]);
  });

  it("filters by project, sorts newest first and honours the limit", () => {
    const m = build([
      { id: "a", title: "x", projectId: "p1", updatedAt: 1 },
      { id: "b", title: "x", projectId: "p2", updatedAt: 3 },
      { id: "c", title: "x", projectId: "p1", updatedAt: 2 },
    ]);
    expect(searchThreads(m, { q: "x" }).map((h) => h.threadId)).toEqual(["b", "c", "a"]);
    expect(searchThreads(m, { q: "x", projectId: "p1" }).map((h) => h.threadId)).toEqual(["c", "a"]);
    expect(searchThreads(m, { q: "x", limit: 1 }).map((h) => h.threadId)).toEqual(["b"]);
  });

  it("returns the matching line, centred on the term and at most 160 chars", () => {
    const long = `${"a".repeat(300)} needle ${"b".repeat(300)}`;
    const m = build([{ id: "a", title: "t", msgs: [[`first line\n${long}\nlast`, 1]] }]);
    const snippet = searchThreads(m, { q: "needle" })[0]?.snippet ?? "";
    expect(snippet.length).toBe(SNIPPET_MAX);
    expect(snippet).toContain("needle");
    const i = snippet.indexOf("needle");
    expect(Math.abs(i + 3 - SNIPPET_MAX / 2)).toBeLessThanOrEqual(2);
    expect(snippet).not.toContain("\n");
  });
});
