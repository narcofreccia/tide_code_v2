import { useEffect } from "react";
import { useViewHeading } from "../state/hooks.ts";

/** `<thread title> · Tide`, `Mission Control · Tide`, `Settings · Tide`: the window follows the view. */
export function useDocumentTitle(): void {
  const heading = useViewHeading();
  const text = heading.kind === "thread" ? heading.thread.title : heading.label;
  useEffect(() => {
    document.title = `${text} · Tide`;
  }, [text]);
}
