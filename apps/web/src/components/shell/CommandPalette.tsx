import { useCallback, useEffect, useMemo } from "react";
import { closePalette, loadRecents, runPaletteItem } from "../../lib/commands.ts";
import { buildPaletteItems, rankPaletteItems, type PaletteItem } from "../../lib/paletteItems.ts";
import { messageHitItems } from "../../lib/paletteMessages.ts";
import { threadRecency } from "../../lib/threadRecency.ts";
import { resetPaletteSearch, setPaletteQuery, usePaletteSearch } from "../../state/paletteSearch.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Dialog } from "../ui/Dialog.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { ListPicker } from "../ui/ListPicker.tsx";
import styles from "./CommandPalette.module.css";

const LIMIT = 60;
const MESSAGE_LIMIT = 20;

function PaletteRow({ item }: { item: PaletteItem }) {
  return (
    <>
      <span className={styles.group}>{item.group}</span>
      <span className={styles.label}>{item.label}</span>
      {item.detail ? <span className={styles.detail}>{item.detail}</span> : null}
      {item.kbd ? <Kbd>{item.kbd}</Kbd> : null}
    </>
  );
}

/** `⌘K`: every shortcut action, every navigation target, the thread's own actions. */
export function CommandPalette() {
  const model = useModel((s) => s.model);
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const recents = useMemo(() => loadRecents(), []);

  const items = useMemo(
    () => buildPaletteItems({ model, selectedThreadId, selectedProjectId }),
    [model, selectedThreadId, selectedProjectId],
  );
  const recency = useMemo(() => threadRecency(), []);
  const hits = usePaletteSearch((s) => s.hits);
  const messageItems = useMemo(() => messageHitItems(model, hits), [model, hits]);
  useEffect(() => resetPaletteSearch, []);
  const rank = useCallback(
    (query: string, all: readonly PaletteItem[]) => {
      const ranked = rankPaletteItems(query, [...all], recents, recency);
      return query.trim() === "" ? ranked : [...ranked.slice(0, LIMIT), ...messageItems];
    },
    [recents, recency, messageItems],
  );

  return (
    <Dialog title="Command palette" variant="palette" onCancel={closePalette}>
      <ListPicker
        items={items}
        itemKey={(item) => item.id}
        rank={rank}
        limit={LIMIT + MESSAGE_LIMIT}
        onQueryChange={setPaletteQuery}
        renderItem={(item) => <PaletteRow item={item} />}
        onPick={runPaletteItem}
        onClose={closePalette}
        label="Commands"
        inputLabel="Command"
        placeholder="Run a command, jump to a thread…"
      />
    </Dialog>
  );
}

/** Mounted once by the app shell; renders only while the palette is open. */
export function CommandPaletteHost() {
  const open = useUi((s) => s.paletteOpen);
  return open ? <CommandPalette /> : null;
}
