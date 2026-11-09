import { isDesktop } from "../lib/bootstrap.ts";

/** Names this device in a server's paired-device list: "Tide desktop", else "<browser> on <os>". */
export function deviceNameFor(userAgent: string, desktop: boolean): string {
  if (desktop) return "Tide desktop";
  const ua = userAgent;
  // order matters: Edge and Opera carry "Chrome", Chrome carries "Safari"
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS/.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS/.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : undefined;
  return os === undefined ? browser : `${browser} on ${os}`;
}

export function thisDeviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return deviceNameFor(ua, typeof window !== "undefined" && isDesktop());
}
