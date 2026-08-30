import { useServerInfo } from "../../lib/useServerInfo.ts";
import section from "./Section.module.css";

const LINKS = [
  { href: "https://github.com/narcofreccia/tide_code_v2", label: "Repository" },
  { href: "https://claude.com/claude-code", label: "Claude Code" },
  { href: "https://developers.openai.com/codex/cli", label: "Codex CLI" },
  { href: "https://opencode.ai", label: "OpenCode" },
];

export function AboutSection() {
  const info = useServerInfo();
  return (
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>About</h3>
      </div>
      <ul className={section.rows}>
        <li className={section.row}>
          <span className={section.label}>Server version</span>
          <span className={section.value}>{info?.version ?? "—"}</span>
        </li>
        <li className={section.row}>
          <span className={section.label}>Started</span>
          <span className={section.value}>
            {info ? new Date(info.startedAt).toLocaleString() : "—"}
          </span>
        </li>
      </ul>
      <ul className={section.rows}>
        {LINKS.map((link) => (
          <li key={link.href} className={section.row}>
            <span className={section.label}>{link.label}</span>
            <a href={link.href} target="_blank" rel="noreferrer" className={section.value}>
              {link.href}
            </a>
          </li>
        ))}
      </ul>
      <p className={section.note}>
        Tide is an orchestrator for the coding harnesses you already pay for. It never stores
        provider credentials.
      </p>
    </div>
  );
}
