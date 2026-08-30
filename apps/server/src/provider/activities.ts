import type { Activity, DriverActivity } from "@tide/contracts";

export interface ActivityBaseFields {
  id: string;
  threadId: string;
  turnId: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Identity of an activity across the updates a driver streams for it. Approval and
 * user-input rows key on requestId so a later response lands on the same row; tool
 * rows key on toolUseId so the result replaces the running row.
 */
export function activityKey(activity: DriverActivity): string | undefined {
  switch (activity.kind) {
    case "tool":
      return `tool:${activity.toolUseId}`;
    case "approval":
    case "user-input":
      return `req:${activity.requestId}`;
    case "child":
      return `child:${activity.childKey}`;
    default:
      return undefined;
  }
}

const opt = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

/**
 * Folds a driver's partial activity onto the row already in the read model so an
 * update that only carries a status can't blank out the required fields.
 */
export function mergeActivity(previous: Activity | undefined, activity: DriverActivity, base: ActivityBaseFields): Activity {
  const shared = {
    ...base,
    createdAt: previous?.createdAt ?? base.createdAt,
    ...opt("parentToolUseId", activity.parentToolUseId ?? previous?.parentToolUseId),
  };
  switch (activity.kind) {
    case "tool": {
      const prev = previous?.kind === "tool" ? previous : undefined;
      return {
        ...shared,
        kind: "tool",
        toolUseId: activity.toolUseId || (prev?.toolUseId ?? ""),
        toolName: activity.toolName || (prev?.toolName ?? ""),
        input: activity.input !== undefined ? activity.input : prev?.input,
        status: activity.status,
        ...opt("output", activity.output ?? prev?.output),
        ...opt("durationMs", activity.durationMs ?? prev?.durationMs),
      };
    }
    case "approval": {
      const prev = previous?.kind === "approval" ? previous : undefined;
      return {
        ...shared,
        kind: "approval",
        requestId: activity.requestId || (prev?.requestId ?? ""),
        toolName: activity.toolName || (prev?.toolName ?? ""),
        input: activity.input !== undefined ? activity.input : prev?.input,
        status: activity.status,
        ...opt("title", activity.title ?? prev?.title),
        ...opt("description", activity.description ?? prev?.description),
        ...opt("diff", activity.diff ?? prev?.diff),
        ...opt("decision", activity.decision ?? prev?.decision),
      };
    }
    case "user-input": {
      const prev = previous?.kind === "user-input" ? previous : undefined;
      return {
        ...shared,
        kind: "user-input",
        requestId: activity.requestId || (prev?.requestId ?? ""),
        questions: activity.questions.length > 0 ? activity.questions : (prev?.questions ?? []),
        status: activity.status,
        ...opt("answers", activity.answers ?? prev?.answers),
      };
    }
    case "child": {
      const prev = previous?.kind === "child" ? previous : undefined;
      return {
        ...shared,
        kind: "child",
        childKey: activity.childKey || (prev?.childKey ?? ""),
        name: activity.name || (prev?.name ?? ""),
        status: activity.status,
        ...opt("description", activity.description ?? prev?.description),
        ...opt("childThreadId", activity.childThreadId ?? prev?.childThreadId),
        ...opt("summary", activity.summary ?? prev?.summary),
      };
    }
    default:
      return { ...shared, kind: activity.kind, text: activity.text };
  }
}
