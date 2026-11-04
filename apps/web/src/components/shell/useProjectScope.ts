import { useUi } from "../../state/ui.ts";

/** The project ids the rail is filtered to, limited to live projects; empty means All. */
export function useProjectScope(liveIds: readonly string[]): string[] {
  const filter = useUi((s) => s.projectFilter);
  const selected = useUi((s) => s.selectedProjectId);
  const live = filter.filter((id) => liveIds.includes(id));
  if (live.length > 0) return live;
  return selected !== null && liveIds.includes(selected) ? [selected] : [];
}
