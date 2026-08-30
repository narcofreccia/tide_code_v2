import type { ReadModel } from "./domain.ts";
import type { DomainEvent, EventRecord } from "./events.ts";

// Pure projector shared by server and clients. Returns a new model; never
// mutates input. Unknown event types are ignored so old clients survive.

export function applyEvent(model: ReadModel, event: DomainEvent): ReadModel {
  switch (event.type) {
    case "project.created":
      return { ...model, projects: { ...model.projects, [event.project.id]: event.project } };
    case "project.updated": {
      const p = model.projects[event.projectId];
      if (!p) return model;
      return {
        ...model,
        projects: {
          ...model.projects,
          [p.id]: { ...p, ...(event.title !== undefined ? { title: event.title } : {}), updatedAt: event.updatedAt },
        },
      };
    }
    case "project.archived": {
      const p = model.projects[event.projectId];
      if (!p) return model;
      return { ...model, projects: { ...model.projects, [p.id]: { ...p, archivedAt: event.archivedAt, updatedAt: event.archivedAt } } };
    }
    case "thread.created":
      return {
        ...model,
        threads: { ...model.threads, [event.thread.id]: event.thread },
        threadMessages: { ...model.threadMessages, [event.thread.id]: [] },
      };
    case "thread.updated": {
      const t = model.threads[event.threadId];
      if (!t) return model;
      return { ...model, threads: { ...model.threads, [t.id]: { ...t, ...event.patch, updatedAt: event.updatedAt } } };
    }
    case "thread.archived": {
      const t = model.threads[event.threadId];
      if (!t) return model;
      return { ...model, threads: { ...model.threads, [t.id]: { ...t, archivedAt: event.archivedAt, updatedAt: event.archivedAt } } };
    }
    case "thread.status-changed": {
      const t = model.threads[event.threadId];
      if (!t) return model;
      return { ...model, threads: { ...model.threads, [t.id]: { ...t, status: event.status, updatedAt: event.updatedAt } } };
    }
    case "turn.requested": {
      const t = model.threads[event.turn.threadId];
      const list = model.threadMessages[event.turn.threadId] ?? [];
      return {
        ...model,
        turns: { ...model.turns, [event.turn.id]: event.turn },
        messages: { ...model.messages, [event.userMessage.id]: event.userMessage },
        threadMessages: { ...model.threadMessages, [event.turn.threadId]: [...list, event.userMessage.id] },
        threads: t
          ? { ...model.threads, [t.id]: { ...t, latestTurnId: event.turn.id, status: "running", updatedAt: event.turn.requestedAt } }
          : model.threads,
      };
    }
    case "turn.started": {
      const turn = model.turns[event.turnId];
      if (!turn) return model;
      return { ...model, turns: { ...model.turns, [turn.id]: { ...turn, status: "running", startedAt: event.startedAt } } };
    }
    case "assistant.delta": {
      const existing = model.messages[event.messageId];
      const msg = existing
        ? { ...existing, text: existing.text + event.delta }
        : { id: event.messageId, threadId: event.threadId, turnId: event.turnId, role: "assistant" as const, text: event.delta, createdAt: event.at, streaming: true };
      const list = model.threadMessages[event.threadId] ?? [];
      return {
        ...model,
        messages: { ...model.messages, [msg.id]: msg },
        threadMessages: existing ? model.threadMessages : { ...model.threadMessages, [event.threadId]: [...list, msg.id] },
      };
    }
    case "turn.settled": {
      const turn = model.turns[event.turnId];
      const t = model.threads[event.threadId];
      // finalize streaming messages of this turn
      let messages = model.messages;
      for (const id of model.threadMessages[event.threadId] ?? []) {
        const m = messages[id];
        if (m && m.turnId === event.turnId && m.streaming) messages = { ...messages, [id]: { ...m, streaming: false } };
      }
      return {
        ...model,
        messages,
        turns: turn
          ? { ...model.turns, [turn.id]: { ...turn, status: event.status, settledAt: event.settledAt, ...(event.error !== undefined ? { error: event.error } : {}) } }
          : model.turns,
        threads: t
          ? { ...model.threads, [t.id]: { ...t, status: event.status === "completed" ? "idle" : event.status, updatedAt: event.settledAt } }
          : model.threads,
      };
    }
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return model;
    }
  }
}

export function applyRecord(model: ReadModel, rec: EventRecord): ReadModel {
  if (rec.seq <= model.seq) return model; // idempotent replay
  return { ...applyEvent(model, rec.event), seq: rec.seq };
}

export function replay(model: ReadModel, records: Iterable<EventRecord>): ReadModel {
  let m = model;
  for (const r of records) m = applyRecord(m, r);
  return m;
}
