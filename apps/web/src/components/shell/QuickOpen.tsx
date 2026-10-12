import { useFileIndex } from "../../state/files.ts";
import { openFileTab, setQuickOpen } from "../../state/workbench.ts";
import { Dialog } from "../ui/Dialog.tsx";
import { ListPicker, PickerNote } from "../ui/ListPicker.tsx";
import { PathRow } from "../ui/PathRow.tsx";

const LIMIT = 40;
const NO_PATHS: string[] = [];
const close = (): void => setQuickOpen(false);
const identity = (path: string): string => path;

/** `⌘P`: fuzzy file picker over the thread's cached recursive listing. */
export function QuickOpen({ threadId }: { threadId: string }) {
  const index = useFileIndex(threadId);
  const paths = index.data?.paths ?? NO_PATHS;
  const indexing = index.loading && paths.length === 0;

  return (
    <Dialog title="Quick open" variant="palette" onCancel={close}>
      <ListPicker
        items={paths}
        itemKey={identity}
        limit={LIMIT}
        renderItem={(path) => <PathRow path={path} />}
        onPick={(path) => {
          close();
          openFileTab(threadId, path);
        }}
        onClose={close}
        label="Files"
        inputLabel="Open file"
        placeholder="Open file…"
        before={indexing ? <PickerNote>Indexing files…</PickerNote> : null}
        empty={index.loading ? null : "No matching file."}
        after={index.data?.truncated ? <PickerNote>Index truncated at 20 000 files.</PickerNote> : null}
      />
    </Dialog>
  );
}
