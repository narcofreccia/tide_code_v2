import { describe, expect, it } from "vitest";
import { normalizeRemoteUrl, repoDisplayName } from "./repoIdentity.ts";

describe("normalizeRemoteUrl", () => {
  const key = "github.com/narcofreccia/tide_code_v2";
  it.each([
    ["https://github.com/narcofreccia/tide_code_v2.git", key],
    ["https://github.com/narcofreccia/tide_code_v2", key],
    ["https://github.com/narcofreccia/tide_code_v2/", key],
    ["https://GitHub.com/narcofreccia/tide_code_v2.git", key],
    ["https://user:token@github.com/narcofreccia/tide_code_v2.git", key],
    ["git@github.com:narcofreccia/tide_code_v2.git", key],
    ["ssh://git@github.com:2222/narcofreccia/tide_code_v2.git", key],
    ["git://github.com/narcofreccia/tide_code_v2.git", key],
    ["https://gitlab.com/group/sub/repo.git", "gitlab.com/group/sub/repo"],
    ["git@gitlab.com:group/sub/repo.git", "gitlab.com/group/sub/repo"],
    ["/tmp/lanb/origin.git", "local/tmp/lanb/origin"],
    ["file:///tmp/lanb/origin.git/", "local/tmp/lanb/origin"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeRemoteUrl(input)).toBe(expected);
  });

  it("is the same key for the https and ssh forms of one repo", () => {
    expect(normalizeRemoteUrl("https://github.com/o/r.git")).toBe(normalizeRemoteUrl("git@github.com:o/r.git"));
  });

  it.each(["", "   ", "github.com", "https://github.com/", "https://github.com/onlyowner", "not a url", "http://[bad"])("rejects %j", (input) => {
    expect(normalizeRemoteUrl(input)).toBeUndefined();
  });
});

describe("repoDisplayName", () => {
  it("keeps owner/name", () => {
    expect(repoDisplayName("github.com/narcofreccia/tide_code_v2")).toBe("narcofreccia/tide_code_v2");
    expect(repoDisplayName("gitlab.com/group/sub/repo")).toBe("sub/repo");
    expect(repoDisplayName("local/tmp/lanb/origin")).toBe("lanb/origin");
  });
});
