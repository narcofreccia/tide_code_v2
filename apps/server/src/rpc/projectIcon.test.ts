import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectIcon, MAX_ICON_BYTES } from "./projectIcon.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "tide-icon-"));
  dirs.push(d);
  return d;
};

describe("detectIcon", () => {
  it("returns {} when nothing fits", async () => {
    expect(await detectIcon(await tmp())).toEqual({});
  });

  it("picks the first candidate in order and encodes a data URL", async () => {
    const d = await tmp();
    await mkdir(join(d, "public"));
    await writeFile(join(d, "public", "favicon.svg"), "<svg/>");
    await writeFile(join(d, "favicon.ico"), "ico");
    expect(await detectIcon(d)).toEqual({ icon: { kind: "data", value: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}` }, source: "public/favicon.svg" });
  });

  it("skips files over 32 KB and falls through", async () => {
    const d = await tmp();
    await mkdir(join(d, "public"));
    await writeFile(join(d, "public", "favicon.png"), Buffer.alloc(MAX_ICON_BYTES + 1));
    await writeFile(join(d, "apple-touch-icon.png"), "png");
    expect((await detectIcon(d)).source).toBe("apple-touch-icon.png");
  });
});
