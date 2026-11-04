import { memo, useState } from "react";
import type { ActivityOf } from "@tide/contracts";
import { declineSecret, provideSecret, respondUserInput } from "../../lib/threadActions.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Choice.tsx";
import { RequestFrom, type RequestOrigin } from "./RequestFrom.tsx";
import styles from "./Card.module.css";
import secretStyles from "./UserInputCard.module.css";

type Answer = string | string[];
type Question = ActivityOf<"user-input">["questions"][number];

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
    if (value === "" || sending) return;
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
          <label htmlFor={inputId} className={secretStyles.name}>
            {name}
          </label>
          <input
            id={inputId}
            className={secretStyles.input}
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
          <Button variant="primary" disabled={value === "" || sending} onClick={provide}>
            Provide
          </Button>
          <Button variant="ghost" disabled={sending} onClick={() => declineSecret(activity.threadId, activity.requestId)}>
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

  const submit = (payload: Record<string, Answer>): void =>
    respondUserInput(activity.threadId, activity.requestId, payload);

  if (activity.status === "resolved") {
    const given = Object.values(activity.answers ?? {})
      .map((v) => (Array.isArray(v) ? v.join(", ") : String(v)))
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

  return (
    <li>
      <section className={`${styles.card} ${styles.attention}`} aria-label="Question">
        {from ? <RequestFrom what="Question" from={from} /> : null}
        {questions.map((question) => (
          <div key={question.id} className={styles.question}>
            <span className={styles.questionText}>{question.text}</span>
            {question.options && question.options.length > 0 ? (
              <div className={styles.options}>
                {question.options.map((option) =>
                  question.multi ? (
                    <Checkbox
                      key={option.label}
                      className={styles.check}
                      aria-label={option.label}
                      checked={(answers[question.id] as string[] | undefined)?.includes(option.label) ?? false}
                      onChange={() => toggle(question, option.label)}
                    >
                      {option.label}
                      {option.description ? (
                        <span className={styles.optionHint}>{option.description}</span>
                      ) : null}
                    </Checkbox>
                  ) : (
                    <Button
                      key={option.label}
                      variant={answers[question.id] === option.label ? "primary" : "ghost"}
                      onClick={() => pick(question, option.label)}
                    >
                      {option.label}
                    </Button>
                  ),
                )}
              </div>
            ) : (
              <textarea
                className={styles.textarea}
                aria-label={question.text}
                value={typeof answers[question.id] === "string" ? (answers[question.id] as string) : ""}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))}
              />
            )}
          </div>
        ))}
        {single ? null : (
          <div className={styles.actions}>
            <Button variant="primary" disabled={!complete} onClick={() => submit(answers)}>
              Send answer
            </Button>
          </div>
        )}
      </section>
    </li>
  );
}
