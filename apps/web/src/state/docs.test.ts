import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { mockRpc, resetUi } from "../testHarness.ts";
import { docKey, ensureDoc, useDocs } from "./docs.ts";

afterEach(() => resetUi());

async function load(path: string, handlers: Parameters<typeof mockRpc>[0]) {
  const rpc = mockRpc(handlers);
  ensureDoc("t1", path);
  await waitFor(() => expect(useDocs.getState().docs[docKey("t1", path)]?.loading).toBe(false));
  return { rpc, doc: useDocs.getState().docs[docKey("t1", path)]! };
}

describe("docs: binary files", () => {
  it("reads an image via fs.readBinary into a data URL", async () => {
    const { rpc, doc } = await load("a.png", {
      "fs.read": () => ({ binary: true, size: 3, mtime: 1 }),
      "fs.readBinary": () => ({ data: "AAEC", mediaType: "image/png", size: 3, mtime: 1 }),
    });
    expect(rpc).toHaveBeenCalledWith("fs.readBinary", { threadId: "t1", path: "a.png" });
    expect(doc.imageSrc).toBe("data:image/png;base64,AAEC");
    expect(doc.size).toBe(3);
  });

  it("does not call readBinary for non-image binaries", async () => {
    const { rpc, doc } = await load("a.pdf", { "fs.read": () => ({ binary: true, size: 3, mtime: 1 }) });
    expect(rpc).not.toHaveBeenCalledWith("fs.readBinary", expect.anything());
    expect(doc.binary).toBe(true);
    expect(doc.imageSrc).toBeUndefined();
  });

  it("falls back to the notice when readBinary fails", async () => {
    const { doc } = await load("a.png", {
      "fs.read": () => ({ binary: true, size: 3, mtime: 1 }),
      "fs.readBinary": () => {
        throw new Error("too big");
      },
    });
    expect(doc.binary).toBe(true);
    expect(doc.imageSrc).toBeUndefined();
  });
});
