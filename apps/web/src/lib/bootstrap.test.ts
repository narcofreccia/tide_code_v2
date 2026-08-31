import { afterEach, describe, expect, it } from "vitest";
import { applyDesktopFlag, httpOriginFor, isDesktop, platformOf } from "./bootstrap.ts";

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
