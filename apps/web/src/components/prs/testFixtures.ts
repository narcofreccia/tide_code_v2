import { vi } from "vitest";
import type { PrComment, PrDetail, PrListItem, PullRequest, UnaryMethodName } from "@tide/contracts";
import { setRpcCaller, type RpcCaller } from "../../state/model.ts";
import { useEnvironments } from "../../state/envStore.ts";

export function makePr(number: number, patch: Partial<PullRequest> = {}): PullRequest {
  return {
    url: `https://github.com/acme/app/pull/${number}`,
    number,
    state: "open",
    updatedAt: 1_000,
    title: `PR ${number}`,
    author: "alice",
    base: "main",
    head: `feat-${number}`,
    repo: "acme/app",
    ...patch,
  };
}

export function item(number: number, patch: Partial<PullRequest> = {}, extra: Partial<PrListItem> = {}): PrListItem {
  return { projectId: "p1", pr: makePr(number, patch), ...extra };
}

export function comment(id: string, patch: Partial<PrComment> = {}): PrComment {
  return { id, author: "bob", body: `comment ${id}`, createdAt: 10, kind: "comment", ...patch };
}

export function detail(pr: PullRequest, patch: Partial<PrDetail> = {}): PrDetail {
  return { pr, body: "## Why\nBecause.", files: [], comments: [], ...patch };
}

type Handler = (params: never, opts?: { envId?: string }) => unknown;

/** Like `mockRpc`, but handlers also see the routing options (multi-environment tests). */
export function mockRoutedRpc(handlers: Partial<Record<UnaryMethodName, Handler>>) {
  const caller = vi.fn(async (method: string, params: unknown, opts?: { envId?: string }) => {
    const handler = handlers[method as UnaryMethodName] as ((p: unknown, o?: { envId?: string }) => unknown) | undefined;
    if (!handler) throw new Error(`unmocked rpc: ${method}`);
    return handler(params, opts);
  });
  setRpcCaller(caller as unknown as RpcCaller);
  return caller;
}

/** Two connected machines, `e1` primary. */
export function twoEnvironments(): void {
  useEnvironments.setState({
    environments: [
      { id: "e1", name: "Laptop", routes: [], addedAt: 1 },
      { id: "e2", name: "Build box", routes: [], addedAt: 2 },
    ],
    statuses: { e1: { connection: "connected" }, e2: { connection: "connected" } },
    primaryId: "e1",
  });
}

export function resetEnvironments(): void {
  useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
}
