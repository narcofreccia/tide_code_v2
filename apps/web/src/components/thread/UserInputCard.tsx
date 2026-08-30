import { useState } from "react";
import type { ActivityOf } from "@tide/contracts";
import { respondUserInput } from "../../lib/threadActions.ts";
import { Button } from "../ui/Button.tsx";
import styles from "./Card.module.css";

type Answer = string | string[];
type Question = ActivityOf<"user-input">["questions"][number];

function answered(question: Question, answer: Answer | undefined): boolean {
  if (answer === undefined) return false;
  return Array.isArray(answer) ? answer.length > 0 : answer.trim() !== "";
}

/** A harness question (AskUserQuestion / codex user-input) rendered 1:1. */
export function UserInputCard({ activity }: { activity: ActivityOf<"user-input"> }) {
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
        {questions.map((question) => (
          <div key={question.id} className={styles.question}>
            <span className={styles.questionText}>{question.text}</span>
            {question.options && question.options.length > 0 ? (
              <div className={styles.options}>
                {question.options.map((option) =>
                  question.multi ? (
                    <label key={option.label} className={styles.check}>
                      <input
                        type="checkbox"
                        aria-label={option.label}
                        checked={(answers[question.id] as string[] | undefined)?.includes(option.label) ?? false}
                        onChange={() => toggle(question, option.label)}
                      />
                      {option.label}
                      {option.description ? (
                        <span className={styles.optionHint}>{option.description}</span>
                      ) : null}
                    </label>
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
