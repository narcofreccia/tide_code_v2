import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import styles from "./BootScreen.module.css";

/** The page URL with credentials stripped: a report must be safe to paste anywhere. */
export function safeUrl(href: string): string {
  try {
    const url = new URL(href);
    for (const key of ["token", "wsTicket"]) url.searchParams.delete(key);
    return url.toString();
  } catch {
    return "(unreadable url)";
  }
}

/** A client-side bug report: no network, nothing leaves the machine until the user pastes it. */
export function buildReport(title: string, detail: string, extra: readonly string[] = []): string {
  const version = (import.meta.env as Record<string, string | undefined>).VITE_TIDE_VERSION;
  return [
    `Tide report: ${title}`,
    `Version: ${version ?? "dev"}`,
    `URL: ${safeUrl(window.location.href)}`,
    `User agent: ${navigator.userAgent}`,
    ...extra,
    "",
    detail,
  ].join("\n");
}

/** Reload + Copy report buttons shared by both boot screens. */
export function BootActions({ retryLabel, report }: { retryLabel: string; report: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.actions}>
      <Button variant="primary" onClick={() => window.location.reload()}>
        {retryLabel}
      </Button>
      <Button
        onClick={() => {
          void navigator.clipboard?.writeText(report()).then(() => setCopied(true), () => undefined);
        }}
      >
        {copied ? "Copied" : "Copy report"}
      </Button>
    </div>
  );
}

interface State {
  error: Error | undefined;
}

/** Catches a render error anywhere below and shows a recoverable screen instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Tide render error", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === undefined) return this.props.children;
    return (
      <div className={styles.screen} role="alert">
        <Card header="Tide hit an error">
          <p className={styles.message}>{error.message}</p>
          <p className={styles.hint}>Your threads are safe: they live on the server. Reload to pick up where you left off.</p>
          <BootActions retryLabel="Reload" report={() => buildReport("render error", error.stack ?? error.message)} />
        </Card>
      </div>
    );
  }
}
