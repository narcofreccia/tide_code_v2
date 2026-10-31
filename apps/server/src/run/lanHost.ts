import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export type InterfaceMap = Record<string, NetworkInterfaceInfo[] | undefined>;

const PREFERRED = ["en0", "eth0"];

/**
 * This machine's LAN IPv4, substituted for `${host}` in run-stack connects (a phone app reaching the
 * dev backend). Prefers en0/eth0, else the first non-internal IPv4, else "localhost".
 */
export function lanHost(interfaces: InterfaceMap = networkInterfaces()): string {
  const v4 = (name: string): string | undefined =>
    interfaces[name]?.find((a) => (a.family === "IPv4" || (a.family as unknown) === 4) && !a.internal)?.address;
  for (const name of PREFERRED) {
    const hit = v4(name);
    if (hit !== undefined) return hit;
  }
  for (const name of Object.keys(interfaces)) {
    const hit = v4(name);
    if (hit !== undefined) return hit;
  }
  return "localhost";
}
