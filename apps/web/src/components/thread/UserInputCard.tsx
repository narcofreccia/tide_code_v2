import { memo, useState } from "react";
import type { ActivityOf } from "@tide/contracts";
import { declineSecret, provideSecret, respondUserInput } from "../../lib/threadActions.ts";
import { useOfflineReason } from "../../state/threadEnv.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Choice.tsx";
import { RequestFrom, type RequestOrigin } from "./RequestFrom.tsx";
import styles from "./Card.module.css";
import local from "./UserInputCard.module.css";
import { Pill } from "../ui/Pill.tsx";

type Answer = string | string[];
type Question = ActivityOf<"user-input">["questions"][number];

/** Harnesses mark their pick in the label ("(Recommended) Hybrid…"); shown as a tag, sent back verbatim. */
export function splitRecommended(label: string): { text: string; recommended: boolean } {
  const match = /^\s*\(recommended\)\s*[:\-–—]?\s*|\s*\(recommended\)\s*$/i.exec(label);
  if (match === null) return { text: label, recommended: false };
  const text = (label.slice(0, match.index) + label.slice(match.index + match[0].length)).trim();
  return text === "" ? { text: label, recommended: false } : { text, recommended: true };
}

function answered(question: Question, answer: Answer | undefined): boolean {
  if (answer === undefined) return false;
  return Array.isArray(answer) ? answer.length > 0 : answer.trim() !== "";
}

/** A harness question (AskUserQuestion / codex user-input) rendered 1:1; `from`: a child's, answered from its parent (R16). */
export const UserInputCard = memo(function UserInputCard({ activity, from }: { activity: ActivityOf<"user-input">; from?: RequestOrigin }) {
  if (activity.secret === true) return <SecretCard activity={activity} {...(from ? { from } : {})} />;
  return <QuestionCard activity={activity} {...(from ? { from } : {})} />;
});

/**
 * R16: tide_request_secret. The value lives only in this component's local state until
 * Provide sends it over `secret.provide`; it never enters a draft, a store or an event.
 */
function SecretCard({ activity, from }: { activity: ActivityOf<"user-input">; from?: RequestOrigin }) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const question = activity.questions[0];
  const name = question?.id ?? "secret";
  const inputId = `secret-${activity.id}`;
  const offline = useOfflineReason(activity.threadId);

  if (activity.status === "resolved") {
    const decided = activity.answers?.["decided"] === "provided" ? "provided" : "declined";
    return (
      <li className={styles.resolved}>
        <span>Secret</span>
        <span className={styles.target}>
          {name} · {decided}
        </span>
      </li>
    );
  }

  const provide = (): void => {
    if (value === "" || sending || offline !== undefined) return;
    setSending(true);
    void provideSecret(activity.threadId, activity.requestId, value).then((ok) => {
      setSending(false);
      if (ok) setValue("");
    });
  };

  return (
    <li>
      <section className={`${styles.card} ${styles.attention}`} aria-label="Secret request">
        {from ? <RequestFrom what="Secret request" from={from} /> : null}
        <div className={styles.question}>
          {question?.text ? <span className={styles.questionText}>{question.text}</span> : null}
          <label htmlFor={inputId} className={local.name}>
            {name}
          </label>
          <input
            id={inputId}
            className={local.input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") provide();
            }}
          />
        </div>
        <div className={styles.actions}>
          <Button variant="primary" disabled={value === "" || sending || offline !== undefined} title={offline} onClick={provide}>
            Provide
          </Button>
          <Button
            variant="ghost"
            disabled={sending || offline !== undefined}
            title={offline}
            onClick={() => declineSecret(activity.threadId, activity.requestId)}
          >
            Decline
          </Button>
        </div>
      </section>
    </li>
  );
}

function QuestionCard({ activity, from }: { activity: ActivityOf<"user-input">; from?: RequestOrigin }) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const questions = activity.questions;
  const single = questions.length === 1 && questions[0]?.multi !== true && (questions[0]?.options?.length ?? 0) > 0;
  const offline = useOfflineReason(activity.threadId);

  const submit = (payload: Record<string, Answer>): void =>
    respondUserInput(activity.threadId, activity.requestId, payload);

  if (activity.status === "resolved") {
    const given = Object.values(activity.answers ?? {})
      .map((v) => (Array.isArray(v) ? v : [String(v)]).map((l) => splitRecommended(l).text).join(", "))
      .join(" · ");
    return (
      <li className={styles.resolved}>
        <span>Answered</span>
        <span className={styles.target}>{given}</span>
      </li>
    );
  }

  const pick = (question: Question, label: string): void => {
    if (single) {
      submit({ [question.id]: label });
      return;
    }
    setAnswers((prev) => ({ ...prev, [question.id]: label }));
  };

  const toggle = (question: Question, label: string): void => {
    setAnswers((prev) => {
      const current = prev[question.id];
      const list = Array.isArray(current) ? current : [];
      return {
        ...prev,
        [question.id]: list.includes(label) ? list.filter((l) => l !== label) : [...list, label],
      };
    });
  };

  const complete = questions.every((q) => answered(q, answers[q.id]));

  const done = questions.filter((q) => answered(q, answers[q.id])).length;
  const many = questions.length > 1;

  return (
    <li>
      <section className={`${styles.card} ${styles.attention} ${local.card}`} aria-label="Question">
        {from ? <RequestFrom what="Question" from={from} /> : null}
        {questions.map((question, index) => (
          <fieldset key={question.id} className={local.question}>
            <legend className={local.questionText}>
              {many ? <span className={local.index}>{index + 1}.</span> : null}
              <span>{question.text}</span>
            </legend>
            {question.options && question.options.length > 0 ? (
              <div className={local.options}>
                {question.options.map((option) => {
                  const { text, recommended } = splitRecommended(option.label);
                  const body = (
                    <>
                      <span className={local.optionLabel}>
                        {text}
                        {recommended ? (
                          <Pill tone="accent" size="sm" className={local.recommended}>
                            Recommended
                          </Pill>
                        ) : null}
                      </span>
                      {option.description ? <span className={local.optionHint}>{option.description}</span> : null}
                    </>
                  );
                  if (question.multi) {
                    const checked = (answers[question.id] as string[] | undefined)?.includes(option.label) ?? false;
                    return (
                      <Checkbox
                        key={option.label}
                        className={`${local.option} ${checked ? local.selected : ""}`}
                        aria-label={option.label}
                        checked={checked}
                        onChange={() => toggle(question, option.label)}
                      >
                        <span className={local.optionBody}>{body}</span>
                      </Checkbox>
                    );
                  }
                  const selected = answers[question.id] === option.label;
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={`${local.option} ${selected ? local.selected : ""}`}
                      aria-pressed={single ? undefined : selected}
                      // a single choice answers on click
                      disabled={single && offline !== undefined}
                      title={single ? offline : undefined}
                      onClick={() => pick(question, option.label)}
                    >
                      <span className={local.radio} aria-hidden="true" />
                      <span className={local.optionBody}>{body}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <textarea
                className={styles.textarea}
                aria-label={question.text}
                value={typeof answers[question.id] === "string" ? (answers[question.id] as string) : ""}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))}
              />
            )}
          </fieldset>
        ))}
        {single ? null : (
          <div className={local.footer}>
            {many ? (
              <span className={local.progress}>
                {done} of {questions.length} answered
              </span>
            ) : null}
            <Button variant="primary" disabled={!complete || offline !== undefined} title={offline} onClick={() => submit(answers)}>
              Send answer
            </Button>
          </div>
        )}
      </section>
    </li>
  );
}
