import { networkInterfaces as osNetworkInterfaces, type NetworkInterfaceInfo } from "node:os";

export type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface RemoteInfo {
  host: string;
  port: number;
  lanUrls: string[];
  /** embeds the bearer token — only ever handed to a client socket, never to an agent one */
  pairingUrl?: string;
}

const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"]);

/** True when binding to this host means "this machine only". */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

/** Routable IPv4 addresses of this host, in interface order. */
export function lanIps(interfaces: Interfaces = osNetworkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.internal) continue;
      // node ≥18 reports family as "IPv4"; older bindings use 4
      if (info.family !== "IPv4" && (info.family as unknown as number) !== 4) continue;
      if (!out.includes(info.address)) out.push(info.address);
    }
  }
  return out;
}

export interface RemoteInfoOptions {
  host: string;
  port: number;
  token: string;
  /** false for agent sockets: they must never see the pairing token */
  includePairing: boolean;
  interfaces?: Interfaces;
}

/**
 * How clients reach this server. A loopback bind advertises no LAN URLs at all — nothing
 * off-box can connect — while `--host 0.0.0.0` lists every routable IPv4 address.
 */
export function buildRemoteInfo(options: RemoteInfoOptions): RemoteInfo {
  const { host, port, token, includePairing } = options;
  const ips = isLoopbackHost(host) ? [] : lanIps(options.interfaces ?? osNetworkInterfaces());
  const lanUrls = ips.map((ip) => `ws://${ip}:${port}/ws`);
  const pairHost = ips[0] ?? "127.0.0.1";
  return {
    host,
    port,
    lanUrls,
    ...(includePairing ? { pairingUrl: `http://${pairHost}:${port}/pair#token=${token}` } : {}),
  };
}

/**
 * The `/pair` page. The hosted web app is not deployed yet, so this is a static explainer:
 * it prints the WebSocket URL and reads the token out of the URL fragment in the browser —
 * a fragment is never sent to the server, so the token stays off the wire and out of logs.
 */
export function pairPage(remote: { lanUrls: string[]; port: number }): string {
  const wsUrl = remote.lanUrls[0] ?? `ws://127.0.0.1:${remote.port}/ws`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair with Tide</title>
<style>
:root{color-scheme:dark;--bg:#0d0f12;--fg:#e6e8eb;--dim:#8b939e;--line:#232830;--accent:#7aa2f7}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;padding:40px 20px}
main{max-width:640px;margin:0 auto}h1{font-size:18px;margin:0 0 4px}p{color:var(--dim);margin:0 0 20px}
section{border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:0 0 12px}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:0 0 8px}
code{display:block;word-break:break-all;color:var(--accent)}
ol{margin:0;padding-left:18px;color:var(--dim)}li{margin:4px 0}
</style></head><body><main>
<h1>Pair with this Tide server</h1>
<p>The hosted web client is not deployed yet — connect a local client with the values below.</p>
<section><h2>WebSocket URL</h2><code>${wsUrl}</code></section>
<section><h2>Token</h2><code id="tok">not in this link</code></section>
<section><h2>How to connect</h2><ol>
<li>Open the Tide web client and paste the WebSocket URL above.</li>
<li>Paste the token when asked; it is stored only in that browser.</li>
<li>The token also lives in <code>&lt;TIDE_HOME&gt;/server.json</code> on the server host.</li>
<li>The token is in this page's URL fragment, so it never reached the server. Treat this link as a secret and re-open it if you need the value again.</li>
</ol></section>
</main><script>
var t=new URLSearchParams(location.hash.slice(1)).get("token");
if(t)document.getElementById("tok").textContent=t;
</script></body></html>`;
}
