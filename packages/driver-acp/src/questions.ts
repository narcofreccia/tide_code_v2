import type { DriverActivity } from "@tide/contracts";
import type { AcpPermissionOption } from "./types.ts";

export type UserInputQuestion = Extract<DriverActivity, { kind: "user-input" }>["questions"][number];

/**
 * Option sets that are questions, not approvals. ACP v1 agents ask everything through
 * `session/request_permission`; a set with a non-standard `kind`, or two options of one kind,
 * is a choice between named answers (T3 Code keeps those as native form questions). Such a set
 * becomes a `user-input` activity; the answer maps back to the option whose `name` matches.
 * `session/request_user_input` (a questions array) is not in ACP v1; it is accepted in the
 * shape below so an agent that ships it early still reaches the user.
 */

const PERMISSION_KINDS: ReadonlySet<string> = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);

export function isQuestionOptions(options: AcpPermissionOption[]): boolean {
  const seen = new Set<string>();
  for (const option of options) {
    if (!PERMISSION_KINDS.has(option.kind) || seen.has(option.kind)) return true;
    seen.add(option.kind);
  }
  return false;
}

export function permissionQuestion(id: string, text: string, options: AcpPermissionOption[]): UserInputQuestion {
  return { id, text, options: options.map((option) => ({ label: option.name })) };
}

/** The first string answer for `questionId` (Tide answers are option labels, or arrays of them). */
function answerText(answers: Record<string, unknown> | undefined, questionId: string): string | undefined {
  const raw = answers?.[questionId];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.find((value): value is string => typeof value === "string");
  return undefined;
}

/**
 * Tide's answer → the agent's option id; undefined = answer `cancelled`. An answer matching no
 * option falls back to the only option when there is exactly one.
 */
export function answerOption(options: AcpPermissionOption[], questionId: string, answers: Record<string, unknown> | undefined): string | undefined {
  if (answers === undefined) return undefined;
  const text = answerText(answers, questionId);
  const match = text === undefined ? undefined : (options.find((option) => option.name === text) ?? options.find((option) => option.optionId === text));
  if (match) return match.optionId;
  return options.length === 1 ? options[0]!.optionId : undefined;
}

// ---- session/request_user_input (not in ACP v1) ----

export interface AcpUserInputRequest {
  sessionId?: string;
  questions?: {
    id?: string;
    question?: string;
    text?: string;
    header?: string;
    options?: { label?: string; name?: string; description?: string }[];
    multiSelect?: boolean;
    multi?: boolean;
  }[];
}

export function userInputQuestions(request: AcpUserInputRequest | null | undefined): UserInputQuestion[] {
  if (!Array.isArray(request?.questions)) return [];
  return request.questions.flatMap((entry, index) => {
    const text = entry?.question ?? entry?.text ?? entry?.header;
    if (typeof text !== "string" || text === "") return [];
    const options = (Array.isArray(entry.options) ? entry.options : []).flatMap((option) => {
      const label = option?.label ?? option?.name;
      return typeof label === "string" && label !== ""
        ? [{ label, ...(typeof option.description === "string" && option.description !== "" ? { description: option.description } : {}) }]
        : [];
    });
    return [
      {
        id: typeof entry.id === "string" && entry.id !== "" ? entry.id : `q${index}`,
        text,
        ...(options.length > 0 ? { options } : {}),
        ...(entry.multiSelect === true || entry.multi === true ? { multi: true } : {}),
      },
    ];
  });
}

/** `{outcome: {outcome: "answered", answers}}`, keyed by question id; no usable answer = cancelled. */
export function userInputResult(questions: UserInputQuestion[], answers: Record<string, unknown> | undefined): unknown {
  const collected: Record<string, string | string[]> = {};
  for (const question of questions) {
    const raw = answers?.[question.id];
    if (typeof raw === "string") collected[question.id] = raw;
    else if (Array.isArray(raw)) collected[question.id] = raw.filter((value): value is string => typeof value === "string");
  }
  return Object.keys(collected).length === 0 ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "answered", answers: collected } };
}
