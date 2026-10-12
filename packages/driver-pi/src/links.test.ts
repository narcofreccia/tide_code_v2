import { describe, expect, it } from "vitest";
import type { LinkedDir, OpenSessionOptions } from "@tide/contracts";
import { ENV_CWD, ENV_LINKED_DIRS, ENV_SYSTEM_PROMPT_APPEND, parseLinkedDirs } from "@tide/pi-extensions/protocol";
import { buildSpawn } from "./spawn.ts";

const links: LinkedDir[] = [
  { path: "/repos/frontend", label: "frontend", access: "write" },
  { path: "/repos/infra", label: "infra", access: "read", note: "Terraform for staging" },
];

const options = (patch: Partial<OpenSessionOptions> = {}): OpenSessionOptions => ({
  threadId: "t1",
  cwd: "/work/repo",
  mode: "auto",
  interaction: "default",
  mcpServers: [],
  ...patch,
});

describe("pi spawn carries linked repos into the bridge", () => {
  it("passes cwd, links and the preamble as env the extension reads at load time", () => {
    const { env } = buildSpawn(options({ linkedDirs: links, systemPromptAppend: "## Linked repositories" }), {}, undefined);
    expect(env[ENV_CWD]).toBe("/work/repo");
    expect(parseLinkedDirs(env[ENV_LINKED_DIRS])).toEqual(links);
    expect(env[ENV_SYSTEM_PROMPT_APPEND]).toBe("## Linked repositories");
  });

  it("omits the link env entirely when the thread has no links", () => {
    const { env } = buildSpawn(options(), {}, undefined);
    expect(env[ENV_LINKED_DIRS]).toBeUndefined();
    expect(env[ENV_SYSTEM_PROMPT_APPEND]).toBeUndefined();
    expect(env[ENV_CWD]).toBe("/work/repo");
  });
});
