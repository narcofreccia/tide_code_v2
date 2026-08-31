import { useState } from "react";
import { selectProjectLinks } from "@tide/client";
import type { LinkAccess, ProjectLink } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { Checkbox } from "../ui/Choice.tsx";
import styles from "./ThreadLinkPicker.module.css";

const NO_LINKS: ProjectLink[] = [];

/** One project link as the new-thread picker holds it. */
export interface LinkChoice {
  linkId: string;
  enabled: boolean;
  access: LinkAccess;
}

/** Everything on, each at the project's default access — what the server does when `links` is omitted. */
export function defaultChoices(links: ProjectLink[]): LinkChoice[] {
  return links.map((link) => ({ linkId: link.id, enabled: true, access: link.access }));
}

/** True while the user has not touched the defaults, so `links` can be omitted. */
export function isDefaultChoices(choices: LinkChoice[], links: ProjectLink[]): boolean {
  if (choices.length !== links.length) return false;
  return links.every((link) => {
    const choice = choices.find((c) => c.linkId === link.id);
    return choice !== undefined && choice.enabled && choice.access === link.access;
  });
}

/** The `thread.create.links` payload for the current choices. */
export function choicesPayload(choices: LinkChoice[]): { linkId: string; access: LinkAccess }[] {
  return choices.filter((c) => c.enabled).map((c) => ({ linkId: c.linkId, access: c.access }));
}

/** Choices for a project's links, reset whenever the project's link set changes. */
export function useLinkChoices(projectId: string | undefined): {
  links: ProjectLink[];
  choices: LinkChoice[];
  setChoices: (next: LinkChoice[]) => void;
  /** `undefined` while untouched — the caller then omits `links` entirely */
  payload: { linkId: string; access: LinkAccess }[] | undefined;
} {
  const model = useModel((s) => s.model);
  const links = projectId ? selectProjectLinks(model, projectId) : NO_LINKS;
  const signature = links.map((l) => `${l.id}:${l.access}`).join("|");
  const [state, setState] = useState<{ signature: string; choices: LinkChoice[] }>(() => ({
    signature,
    choices: defaultChoices(links),
  }));
  const choices = state.signature === signature ? state.choices : defaultChoices(links);
  return {
    links,
    choices,
    setChoices: (next) => setState({ signature, choices: next }),
    payload: isDefaultChoices(choices, links) ? undefined : choicesPayload(choices),
  };
}

/**
 * Which linked repositories the new thread may reach. Everything is on by
 * default; a link the project shares read-only cannot be widened here.
 */
export function ThreadLinkPicker({
  links,
  choices,
  onChange,
}: {
  links: ProjectLink[];
  choices: LinkChoice[];
  onChange: (next: LinkChoice[]) => void;
}) {
  if (links.length === 0) return null;
  const patch = (linkId: string, part: Partial<LinkChoice>): void =>
    onChange(choices.map((c) => (c.linkId === linkId ? { ...c, ...part } : c)));

  return (
    <div className={styles.picker} aria-label="Linked repositories">
      <span className={styles.label}>linked repos</span>
      <ul className={styles.list}>
        {links.map((link) => {
          const choice = choices.find((c) => c.linkId === link.id);
          const enabled = choice?.enabled ?? false;
          const access = choice?.access ?? link.access;
          const canWrite = link.access === "write";
          return (
            <li key={link.id} className={styles.chip} title={link.note ? `${link.path} — ${link.note}` : link.path}>
              <Checkbox checked={enabled} onChange={(e) => patch(link.id, { enabled: e.target.checked })}>
                {link.label}
              </Checkbox>
              <button
                type="button"
                className={styles.access}
                disabled={!enabled || !canWrite}
                aria-label={`${link.label} access`}
                title={canWrite ? "Toggle read / read+write" : "Shared read-only by the project"}
                onClick={() => patch(link.id, { access: access === "write" ? "read" : "write" })}
              >
                {access === "write" ? "rw" : "ro"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
