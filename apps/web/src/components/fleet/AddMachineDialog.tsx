import { useState } from "react";
import { addEnvironment, pairWithCode } from "../../state/environments.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { showToast } from "../../state/toast.ts";
import { Dialog } from "../ui/Dialog.tsx";
import { DialogFrame, FrameField } from "../ui/DialogFrame.tsx";
import section from "../settings/Section.module.css";
import { guessRouteKind, httpOriginOf, toWsUrl } from "./envView.ts";
import { closeAddMachine, useFleetUi } from "./fleetUi.ts";
import styles from "./Environments.module.css";

type Tab = "code" | "token";

const CODE = /^\d{6}$/;

function TabSwitch({ value, onChange }: { value: Tab; onChange: (tab: Tab) => void }) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label="How to pair">
      {(["code", "token"] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          role="radio"
          aria-checked={value === tab}
          className={`${styles.segment} ${value === tab ? styles.segmentOn : ""}`}
          onClick={() => onChange(tab)}
        >
          {tab === "code" ? "Pairing code" : "Token"}
        </button>
      ))}
    </div>
  );
}

/** Where the other machine is reachable from outside its LAN; carried over from the old Remote section. */
function ReachHints() {
  return (
    <div className={styles.hints}>
      <p className={section.note}>
        <strong>Tailscale</strong>: on the other machine run <span className={section.code}>tailscale serve 3777</span> and use
        the printed <span className={section.code}>*.ts.net</span> URL. Nothing is exposed beyond your tailnet.
      </p>
      <p className={section.note}>
        <strong>SSH tunnel</strong>: <span className={section.code}>ssh -L 3778:127.0.0.1:3777 host</span>, then use{" "}
        <span className={section.code}>http://127.0.0.1:3778</span> here.
      </p>
    </div>
  );
}

function blockedReason(tab: Tab, url: string, secret: string, busy: boolean): string | undefined {
  if (busy) return "Connecting…";
  if (toWsUrl(url) === undefined) return "Enter the machine's URL";
  if (tab === "code" && !CODE.test(secret.trim())) return "The code has 6 digits";
  if (tab === "token" && secret.trim() === "") return "Paste the token";
  return undefined;
}

function AddMachineForm({ initialUrl }: { initialUrl: string }) {
  const [tab, setTab] = useState<Tab>("code");
  const [url, setUrl] = useState(initialUrl);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = blockedReason(tab, url, secret, busy);

  const submit = (): void => {
    const ws = toWsUrl(url);
    if (blocked !== undefined || ws === undefined) return;
    setBusy(true);
    setError(null);
    const done =
      tab === "code"
        ? pairWithCode(httpOriginOf(ws) ?? url.trim(), secret.trim())
        : addEnvironment({ routes: [{ kind: guessRouteKind(ws), url: ws, priority: 0 }], token: secret.trim() });
    done
      .then(() => {
        showToast("Machine added");
        closeAddMachine();
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  return (
    <DialogFrame
      heading="Add a machine running Tide"
      context="Its projects and threads join this window; they keep running over there."
      toolbar={<TabSwitch value={tab} onChange={(next) => { setTab(next); setSecret(""); setError(null); }} />}
      outcome={tab === "code" ? "Exchanges the one-time code for that machine's token and connects." : "Connects with the token printed by tide-server."}
      primaryLabel={tab === "code" ? "Pair" : "Add machine"}
      onPrimary={submit}
      blockedReason={blocked}
      onCancel={closeAddMachine}
    >
      <div className={styles.sheetRows}>
        <FrameField label="URL" caption="The address the other machine shows under Pair another device">
          <input
            className={section.input}
            aria-label="Machine URL"
            placeholder="http://192.168.1.20:3777"
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </FrameField>
        {tab === "code" ? (
          <FrameField label="Code" caption="6 digits, valid for 5 minutes, works once">
            <input
              className={`${section.input} ${styles.codeInput}`}
              aria-label="Pairing code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={secret}
              onChange={(e) => setSecret(e.target.value.replace(/\D/g, ""))}
            />
          </FrameField>
        ) : (
          <FrameField label="Token" caption="Printed by tide-server at start; kept only in this browser">
            <input
              className={section.input}
              type="password"
              autoComplete="off"
              aria-label="Machine token"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </FrameField>
        )}
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <ReachHints />
    </DialogFrame>
  );
}

/** Mounted once by Settings › Environments; the palette opens it through `openAddMachine`. */
export function AddMachineDialog() {
  const request = useFleetUi((s) => s.addMachine);
  if (request === null) return null;
  return (
    <Dialog title="Add machine" onCancel={closeAddMachine} variant="sheet">
      <AddMachineForm initialUrl={request.url ?? ""} />
    </Dialog>
  );
}
