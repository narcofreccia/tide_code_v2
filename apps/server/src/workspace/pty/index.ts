export { PtyManager, REAP_AFTER_MS, SCROLLBACK_BYTES, selectPtyBackend, type PtyManagerOptions } from "./manager.ts";
export { createBunBackend, isBunRuntime } from "./bunBackend.ts";
export { createNodePtyBackend } from "./nodePtyBackend.ts";
export type { PtyBackend, PtyExit, PtyHandle, PtyInfo, PtySpawnSpec } from "./types.ts";
