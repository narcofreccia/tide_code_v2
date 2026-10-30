import { describe, expect, it } from "vitest";
import { PortLister, parseLsof, parsePs, parseSs, type PortProbe } from "./ports.ts";

const LSOF = "p100\ncnode\nn*:3000\nn[::1]:3000\np200\ncpython\nn127.0.0.1:8000\np300\ncpostgres\nn*:5432\n";
const PS = "  1     0 launchd\n 50     1 zsh\n100    50 node\n200    60 python\n 60     1 zsh\n300     1 postgres\n";

describe("ports", () => {
  it("parses lsof, ss and ps output", () => {
    expect(parseLsof(LSOF)).toEqual([{ port: 3000, pid: 100, command: "node" }, { port: 3000, pid: 100, command: "node" }, { port: 8000, pid: 200, command: "python" }, { port: 5432, pid: 300, command: "postgres" }]);
    expect(parseSs('State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\nLISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=77,fd=19))\n')).toEqual([{ port: 5173, pid: 77, command: "node" }]);
    expect(parsePs(PS).get(100)).toBe(50);
  });

  it("keeps only listeners under the given root pids, dedupes ports, and caches for 3 s", async () => {
    let calls = 0;
    let t = 0;
    const probe: PortProbe = { listeners: async () => (calls++, { kind: "lsof", text: LSOF }), processes: async () => PS };
    const lister = new PortLister({ probe, now: () => t });
    expect(await lister.list([50])).toEqual([{ port: 3000, pid: 100, command: "node", url: "http://127.0.0.1:3000" }]);
    expect((await lister.list([60])).map((p) => p.port)).toEqual([8000]);
    expect(await lister.list([])).toEqual([]);
    expect(calls).toBe(1);
    t = 3001;
    await lister.list([50]);
    expect(calls).toBe(2);
  });

  it("degrades to no ports when the commands are unavailable", async () => {
    const lister = new PortLister({ probe: { listeners: async () => undefined, processes: async () => undefined } });
    expect(await lister.list([1])).toEqual([]);
  });
});
