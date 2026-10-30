import { useEffect, useState } from "react";
import type { EnvRoute } from "@tide/contracts";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { Icon } from "../ui/Icon.tsx";
import { guessRouteKind, ROUTE_KINDS, ROUTE_LABELS, toWsUrl } from "./envView.ts";
import styles from "./Environments.module.css";

const KIND_OPTIONS = ROUTE_KINDS.map((kind) => ({ value: kind, label: ROUTE_LABELS[kind] }));

/** Order is priority: the first route is tried first. */
function renumber(routes: EnvRoute[]): EnvRoute[] {
  return routes.map((route, index) => ({ ...route, priority: index }));
}

function UrlField({ value, label, onSave }: { value: string; label: string; onSave: (url: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    const url = toWsUrl(draft);
    if (url !== undefined && url !== value) onSave(url);
    else setDraft(value);
  };
  return (
    <input
      className={styles.input}
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

/**
 * The ways this client can reach one machine, best first. The connection manager tries them in
 * order and stays on the first that answers.
 */
export function RoutesEditor({ routes, onChange }: { routes: EnvRoute[]; onChange: (routes: EnvRoute[]) => void }) {
  const ordered = [...routes].sort((a, b) => a.priority - b.priority);
  const [adding, setAdding] = useState("");
  const set = (next: EnvRoute[]): void => onChange(renumber(next));
  const move = (from: number, to: number): void => {
    const next = [...ordered];
    const [item] = next.splice(from, 1);
    if (item === undefined) return;
    next.splice(to, 0, item);
    set(next);
  };
  const add = (): void => {
    const url = toWsUrl(adding);
    if (url === undefined) return;
    set([...ordered, { kind: guessRouteKind(url), url, priority: ordered.length }]);
    setAdding("");
  };

  return (
    <div className={styles.routes} aria-label="Routes">
      <ol className={styles.routeList}>
        {ordered.map((route, index) => (
          <li key={`${index}:${route.url}`} className={styles.route}>
            <Select
              label={`Route ${index + 1} kind`}
              value={route.kind}
              options={KIND_OPTIONS}
              onSelect={(kind) => set(ordered.map((r, i) => (i === index ? { ...r, kind } : r)))}
              variant="field"
            />
            <UrlField
              label={`Route ${index + 1} URL`}
              value={route.url}
              onSave={(url) => set(ordered.map((r, i) => (i === index ? { ...r, url } : r)))}
            />
            <Button variant="quiet" aria-label={`Move route ${index + 1} up`} disabled={index === 0} onClick={() => move(index, index - 1)}>
              <Icon name="arrowUp" size={14} />
            </Button>
            <Button
              variant="quiet"
              aria-label={`Move route ${index + 1} down`}
              disabled={index === ordered.length - 1}
              onClick={() => move(index, index + 1)}
            >
              <Icon name="arrowUp" size={14} className={styles.down} />
            </Button>
            <Button
              variant="quietDanger"
              aria-label={`Remove route ${index + 1}`}
              disabled={ordered.length === 1}
              title={ordered.length === 1 ? "A machine needs at least one route" : undefined}
              onClick={() => set(ordered.filter((_, i) => i !== index))}
            >
              <Icon name="close" size={14} />
            </Button>
          </li>
        ))}
      </ol>
      <form
        className={styles.route}
        aria-label="Add a route"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          className={styles.input}
          aria-label="New route URL"
          placeholder="http://100.101.102.103:3777 or wss://relay.example/…"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
        />
        <Button type="submit" disabled={toWsUrl(adding) === undefined}>
          Add route
        </Button>
      </form>
    </div>
  );
}
