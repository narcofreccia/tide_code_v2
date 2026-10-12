import { afterEach, describe, expect, it } from "vitest";
import {
  applyDesktopFlag,
  defaultServerUrl,
  httpOriginFor,
  isDesktop,
  pairingPageUrl,
  platformOf,
  resolveServerUrl,
  wsUrlFor,
} from "./bootstrap.ts";

describe("httpOriginFor", () => {
  it("derives the http origin of a ws url", () => {
    expect(httpOriginFor("ws://127.0.0.1:3777/ws")).toBe("http://127.0.0.1:3777");
  });

  it("keeps tls when the socket is secure", () => {
    expect(httpOriginFor("wss://tide.example.com/ws")).toBe("https://tide.example.com");
  });

  it("keeps a non-default port", () => {
    expect(httpOriginFor("wss://host.local:8443/ws")).toBe("https://host.local:8443");
  });
});

describe("desktop detection", () => {
  const html = document.documentElement;

  afterEach(() => {
    delete html.dataset.desktop;
    window.localStorage.clear();
  });

  it("buckets the platform from the user agent", () => {
    expect(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac");
    expect(platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("win");
    expect(platformOf("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });

  it("does nothing in a plain browser tab", () => {
    expect(isDesktop()).toBe(false);
    expect(applyDesktopFlag()).toBeNull();
    expect(html.dataset.desktop).toBeUndefined();
  });

  it("stamps and persists the flag once the shell has handed off with ?server=", () => {
    window.history.replaceState(null, "", "/?server=ws%3A%2F%2F127.0.0.1%3A3777%2Fws");
    expect(isDesktop()).toBe(true);
    expect(applyDesktopFlag()).toBe(platformOf(window.navigator.userAgent));
    expect(html.dataset.desktop).toBe(platformOf(window.navigator.userAgent));
    expect(window.localStorage.getItem("tide.desktop")).toBe("1");

    // the shell strips the query on later navigations; the flag survives
    window.history.replaceState(null, "", "/");
    expect(isDesktop()).toBe(true);
  });
});

describe("server url", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("turns a page url into its socket url", () => {
    expect(wsUrlFor("http://192.168.1.20:3777")).toBe("ws://192.168.1.20:3777/ws");
    expect(wsUrlFor("https://tide.example.ts.net/some/page")).toBe("wss://tide.example.ts.net/ws");
  });

  it("builds the LAN page url with ?server=", () => {
    expect(pairingPageUrl("http://192.168.1.20:3777")).toBe(
      "http://192.168.1.20:3777/?server=ws%3A%2F%2F192.168.1.20%3A3777%2Fws&paired=1",
    );
  });

  it("does not take a pairing link for the desktop shell", () => {
    window.history.replaceState(null, "", "/?server=ws%3A%2F%2F10.0.0.5%3A3777%2Fws&paired=1");
    expect(isDesktop()).toBe(false);
  });

  it("derives the default from the page origin outside vite dev", () => {
    const page = { protocol: "http:", href: "http://10.0.0.5:3777/#/mission" };
    expect(defaultServerUrl(page, { DEV: false })).toBe("ws://10.0.0.5:3777/ws");
    expect(defaultServerUrl({ protocol: "https:", href: "https://t.ts.net/" }, { DEV: false })).toBe("wss://t.ts.net/ws");
    // vite dev serves the page on another port than the server
    expect(defaultServerUrl(page, { DEV: true })).toBe("ws://127.0.0.1:3777/ws");
    expect(defaultServerUrl({ protocol: "tauri:", href: "tauri://localhost/" }, { DEV: false })).toBe(
      "ws://127.0.0.1:3777/ws",
    );
    expect(defaultServerUrl(page, { DEV: false, VITE_TIDE_URL: "ws://env:1/ws" })).toBe("ws://env:1/ws");
  });

  it("prefers ?server= over storage, and storage over the default", () => {
    window.localStorage.setItem("tide.serverUrl", "ws://stored:1/ws");
    expect(resolveServerUrl()).toBe("ws://stored:1/ws");
    window.history.replaceState(null, "", "/?server=ws%3A%2F%2Fquery%3A2%2Fws");
    expect(resolveServerUrl()).toBe("ws://query:2/ws");
    expect(window.localStorage.getItem("tide.serverUrl")).toBe("ws://query:2/ws");
  });
});
