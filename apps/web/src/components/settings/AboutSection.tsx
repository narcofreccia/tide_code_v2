import { useServerInfo } from "../../lib/useServerInfo.ts";
import type { SectionMeta } from "./search.ts";
import { SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { SettingRow } from "./ui/SettingRow.tsx";
import styles from "./ui/settings.module.css";

const LINKS = [
  { href: "https://github.com/narcofreccia/tide_code_v2", label: "Repository" },
  { href: "https://claude.com/claude-code", label: "Claude Code" },
  { href: "https://developers.openai.com/codex/cli", label: "Codex CLI" },
  { href: "https://opencode.ai", label: "OpenCode" },
];

export const META: SectionMeta = {
  title: "About",
  blurb: "Tide is an orchestrator for the coding harnesses you already pay for. It never stores provider credentials.",
  keywords: ["Server version", "Started", "version", ...LINKS.map((l) => l.label)],
};

export function AboutSection() {
  const info = useServerInfo();
  return (
    <SettingsPage title={META.title} blurb={META.blurb}>
      <SettingsGroup title="Server">
        <SettingRow label="Server version" control={<span className={styles.value}>{info?.version ?? "—"}</span>} />
        <SettingRow
          label="Started"
          control={<span className={styles.value}>{info ? new Date(info.startedAt).toLocaleString() : "—"}</span>}
        />
      </SettingsGroup>
      <SettingsGroup title="Links">
        {LINKS.map((link) => (
          <SettingRow
            key={link.href}
            label={link.label}
            control={
              <a href={link.href} target="_blank" rel="noreferrer" className={styles.value}>
                {link.href}
              </a>
            }
          />
        ))}
      </SettingsGroup>
    </SettingsPage>
  );
}
