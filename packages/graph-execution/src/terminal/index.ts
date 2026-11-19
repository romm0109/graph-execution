// The server side of the shared terminal: `graph-execution/terminal` (also re-exported from `graph-execution/api`).
// Nothing here loads node-pty at import time. The browser side is `graph-execution/terminal/client`.
export { SCROLLBACK_MAX, createPtySession, createPtySessionSync, clamp, type PtyAttachment, type PtyListener, type PtyModule, type PtySession, type PtySessionOptions } from "./pty.js";
export { bridgeSocket, clientMessageSchema, type BridgeSocket, type BridgeTarget, type ClientMessage } from "./socket.js";
export { batchOutput, OUTPUT_BATCH_MS, type OutputBatcher } from "./batch.js";
export { fixSpawnHelper, nodePtyDir } from "./pty-helper.js";
