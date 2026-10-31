export { COMMAND_DELAY_MS, MAX_COMMAND_LENGTH, PtyManager, REAP_AFTER_MS, SCROLLBACK_BYTES, STOP_GRACE_MS, STOP_POLL_MS, selectPtyBackend, type PtyCreateSpec, type PtyManagerOptions } from "./manager.ts";
export { childPids, descendants, killProcessTree, type KillTreeDeps, type TreeSignal } from "./killTree.ts";
export { createBunBackend, isBunRuntime } from "./bunBackend.ts";
export { createNodePtyBackend } from "./nodePtyBackend.ts";
export type { PtyBackend, PtyExit, PtyHandle, PtyInfo, PtySpawnSpec } from "./types.ts";
