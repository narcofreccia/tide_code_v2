import { useMemo, useState } from "react";
import type { SlashCommandInfo, Thread } from "@tide/contracts";
import { applySlash, commandName, filterCommands, findSlashQuery, SOURCE_LABELS, TIDE_COMMANDS, unknownCommand, type SlashQuery } from "../../lib/slash.ts";
import { providerIdOf } from "../../lib/vocab.ts";
import { useSlashCommands } from "../../state/slashCommands.ts";
import { ListPickerList, PickerNote } from "../ui/ListPicker.tsx";
import { Pill } from "../ui/Pill.tsx";
import picker from "./MentionPicker.module.css";
import styles from "./SlashPicker.module.css";

export interface SlashState {
  /** the open `/` token, if the caret sits in one */
  query: (SlashQuery & { caret: number }) | undefined;
  matches: SlashCommandInfo[];
  loading: boolean;
  /** the text opens with a command this harness does not list (only when it lists commands) */
  unknown: string | undefined;
  /** re-reads the token after an edit or caret move */
  sync: (text: string, caret: number) => void;
  close: () => void;
  /** the text after picking `command`, with its caret */
  apply: (text: string, command: SlashCommandInfo) => { text: string; caret: number } | undefined;
}

/**
 * The composer's `/` picker state for a thread. `listsCommands` is the harness's
 * `caps.commands`: without it nothing is fetched and nothing is flagged — the
 * text goes through as typed. Tide's own commands (`/side`, `/btw`) lead the list
 * unless `tideCommands` is off (a side chat's composer: side chats do not nest).
 */
export function useSlash(thread: Thread, text: string, listsCommands: boolean, tideCommands = true): SlashState {
  const [query, setQuery] = useState<SlashState["query"]>(undefined);
  const active = text.startsWith("/") || query !== undefined;
  const harness = useSlashCommands(thread.id, providerIdOf(thread), listsCommands, active);
  const { loaded, loading } = harness;
  const commands = useMemo(() => (tideCommands ? [...TIDE_COMMANDS, ...harness.commands] : harness.commands), [tideCommands, harness.commands]);
  const matches = query === undefined ? [] : filterCommands(commands, query.query);
  return {
    query,
    matches,
    loading: listsCommands && loading,
    unknown: listsCommands && loaded ? unknownCommand(text, commands) : undefined,
    sync: (value, caret) => {
      const found = findSlashQuery(value, caret);
      setQuery(found ? { ...found, caret } : undefined);
    },
    close: () => setQuery(undefined),
    apply: (value, command) => {
      if (query === undefined) return undefined;
      setQuery(undefined);
      return applySlash(value, query, query.caret, commandName(command));
    },
  };
}

function CommandRow({ command }: { command: SlashCommandInfo }) {
  return (
    <>
      <span className={styles.name}>/{commandName(command)}</span>
      {command.argumentHint ? <span className={styles.args}>{command.argumentHint}</span> : null}
      <span className={styles.description}>{command.description ?? ""}</span>
      <span className={styles.source}>
        <Pill tone={command.source === "builtin" ? "muted" : "accent"}>{SOURCE_LABELS[command.source]}</Pill>
      </span>
    </>
  );
}

/** The `/` command picker floating above the composer; the composer owns the caret and cursor. */
export function SlashPicker({
  slash,
  cursor,
  onPick,
}: {
  slash: SlashState;
  cursor: number;
  onPick: (command: SlashCommandInfo) => void;
}) {
  if (slash.matches.length === 0) {
    if (!slash.loading) return null;
    return (
      <div className={picker.picker}>
        <PickerNote>Loading commands…</PickerNote>
      </div>
    );
  }
  return (
    <div className={picker.picker}>
      <ListPickerList
        items={slash.matches}
        itemKey={(c) => `${c.source}:${c.name}`}
        renderItem={(c) => <CommandRow command={c} />}
        active={cursor}
        onPick={onPick}
        label="Slash commands"
        pickOn="mousedown"
        dense
      />
    </div>
  );
}
