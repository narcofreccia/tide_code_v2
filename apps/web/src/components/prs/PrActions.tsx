import { useState } from "react";
import type { MergeStrategy, PrComment } from "@tide/contracts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { showToast } from "../../state/toast.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Choice.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { Select } from "../ui/Select.tsx";
import { askThreadToAddress, commentOnPr, mergePr, reviewComments, reviewPr, type PrTarget, type ReviewEvent } from "./prActions.ts";
import { mergeBlock } from "./prFilters.ts";
import { loadPrs, type PrEntry } from "./prData.ts";
import styles from "./PrDetail.module.css";

const METHODS: { value: MergeStrategy; label: string }[] = [
  { value: "squash", label: "Squash and merge" },
  { value: "merge", label: "Merge commit" },
  { value: "rebase", label: "Rebase and merge" },
];

const REVIEW_LABEL: Record<ReviewEvent, string> = {
  approve: "Approving",
  request_changes: "Requesting changes",
  comment: "Submitting the review",
};

function target(entry: PrEntry): PrTarget {
  return { projectId: entry.projectId, number: entry.pr.number, ...(entry.envId === undefined ? {} : { envId: entry.envId }) };
}

/** Comment box + review verdicts. One textarea feeds both. */
export function ReviewBox({ entry, onDone }: { entry: PrEntry; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const text = body.trim();

  const run = (label: string, action: () => Promise<void>): void => {
    setBusy(true);
    action()
      .then(() => {
        setBody("");
        onDone();
      })
      .catch((error: unknown) => showToast(`${label} failed: ${errorText(error)}`))
      .finally(() => setBusy(false));
  };
  const review = (event: ReviewEvent): void => run(REVIEW_LABEL[event], () => reviewPr(target(entry), event, text || undefined));

  return (
    <div className={styles.box}>
      <textarea
        className={styles.textarea}
        aria-label="Comment"
        placeholder="Leave a comment (markdown)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
      />
      <div className={styles.row}>
        <Button disabled={busy || text === ""} onClick={() => run("Commenting", () => commentOnPr(target(entry), text))}>
          Comment
        </Button>
        <span className={styles.spacer} />
        <Button variant="quiet" disabled={busy || text === ""} onClick={() => review("comment")} title="Submit as a review comment">
          Review comment
        </Button>
        <Button
          variant="quiet"
          disabled={busy || text === ""}
          onClick={() => review("request_changes")}
          title={text === "" ? "Say what needs to change" : "Request changes"}
        >
          Request changes
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => review("approve")}>
          Approve
        </Button>
      </div>
    </div>
  );
}

/** Method + delete-branch + confirm; off with the reason while blocked, unless "Merge anyway". */
export function MergeBox({ entry, onDone }: { entry: PrEntry; onDone: () => void }) {
  const [method, setMethod] = useState<MergeStrategy>("squash");
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [anyway, setAnyway] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const { pr } = entry;
  const block = mergeBlock(pr, anyway);
  const soft = mergeBlock(pr, true) === undefined && mergeBlock(pr, false) !== undefined;
  if (pr.state !== "open") return null;

  const merge = (): void => {
    setConfirming(false);
    setBusy(true);
    mergePr(target(entry), method, deleteBranch)
      .then((out) => {
        if (out.merged) showToast(`Merged #${pr.number}`);
        else showToast(`Merging #${pr.number} failed: ${out.error ?? "the forge refused"}`);
        onDone();
        void loadPrs();
      })
      .catch((error: unknown) => showToast(`Merging #${pr.number} failed: ${errorText(error)}`))
      .finally(() => setBusy(false));
  };

  return (
    <div className={styles.box}>
      <div className={styles.row}>
        <Select label="Merge method" value={method} options={METHODS} onSelect={setMethod} />
        <Checkbox checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)}>
          Delete branch
        </Checkbox>
        {soft ? (
          <Checkbox checked={anyway} onChange={(e) => setAnyway(e.target.checked)}>
            Merge anyway
          </Checkbox>
        ) : null}
        <span className={styles.spacer} />
        <Button variant="primary" disabled={block !== undefined || busy} title={block} onClick={() => setConfirming(true)}>
          {busy ? "Merging…" : "Merge…"}
        </Button>
      </div>
      {block ? <p className={styles.blocked}>Can't merge: {block}</p> : null}
      {confirming ? (
        <ConfirmDialog
          title={`Merge #${pr.number}`}
          body={
            <>
              {METHODS.find((m) => m.value === method)?.label} <strong>{pr.head ?? `#${pr.number}`}</strong> into{" "}
              <strong>{pr.base ?? "its base"}</strong>
              {deleteBranch ? " and delete the branch" : ""}?
            </>
          }
          confirmLabel="Merge"
          onCancel={() => setConfirming(false)}
          onConfirm={merge}
        />
      ) : null}
    </div>
  );
}

/** "Ask the thread to address comments": only for a thread-linked PR with something to address. */
export function AddressButton({ entry, comments }: { entry: PrEntry; comments: readonly PrComment[] }) {
  const [busy, setBusy] = useState(false);
  if (!entry.threadId || entry.pr.state !== "open" || reviewComments(comments).length === 0) return null;
  const threadId = entry.threadId;
  return (
    <Button
      disabled={busy}
      onClick={() => {
        setBusy(true);
        askThreadToAddress(threadId, entry.pr.number, comments)
          .catch((error: unknown) => showToast(`Asking the thread failed: ${errorText(error)}`))
          .finally(() => setBusy(false));
      }}
    >
      Ask the thread to address comments
    </Button>
  );
}
