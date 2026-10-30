import type { Project } from "@tide/contracts";
import styles from "./ProjectIcon.module.css";

/** First user-perceived character of `text` (an emoji with joiners counts as one). */
export function firstGrapheme(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Segmenter) {
    for (const part of new Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)) return part.segment;
  }
  return Array.from(trimmed)[0] ?? "";
}

/** 16px project mark: the favicon (`data`), an emoji, or the first letter on a tinted square. */
export function ProjectIcon({ project }: { project: Pick<Project, "title" | "icon"> }) {
  const icon = project.icon;
  if (icon?.kind === "data") {
    return <img className={styles.icon} src={icon.value} alt="" data-icon="data" draggable={false} />;
  }
  if (icon?.kind === "emoji") {
    return (
      <span className={`${styles.icon} ${styles.emoji}`} data-icon="emoji" aria-hidden="true">
        {firstGrapheme(icon.value)}
      </span>
    );
  }
  return (
    <span className={`${styles.icon} ${styles.letter}`} data-icon="letter" aria-hidden="true">
      {firstGrapheme(project.title).toUpperCase() || "?"}
    </span>
  );
}
