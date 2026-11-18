import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { bridgeSocket, clientMessageSchema, type BridgeSocket } from "./socket.js";
import type { PtyListener } from "./pty.js";

function fakeSocket() {
  const ee = new EventEmitter();
  const sent: unknown[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
    close: () => {},
    on: (ev: string, fn: (...a: unknown[]) => void) => ee.on(ev, fn),
  } as unknown as BridgeSocket;
  return { socket, sent, emit: (ev: string, ...a: unknown[]) => ee.emit(ev, ...a) };
}

function fakeSession() {
  let listener: PtyListener | undefined;
  const writes: string[] = [];
  const sizes: [number, number][] = [];
  let detached = false;
  return {
    session: {
      attach(l: PtyListener) {
        listener = l;
        return { replay: "old", write: (s: string) => writes.push(s), resize: (c: number, r: number) => sizes.push([c, r]), detach: () => (detached = true) };
      },
    },
    listener: () => listener!,
    writes,
    sizes,
    detached: () => detached,
  };
}

describe("bridgeSocket", () => {
  it("replays first, forwards input, resize and ping, and detaches on close", () => {
    const s = fakeSocket();
    const p = fakeSession();
    bridgeSocket(s.socket, p.session);
    expect(s.sent).toEqual([{ type: "replay", data: "old" }]);
    s.emit("message", Buffer.from(JSON.stringify({ type: "input", data: "ls\r" })));
    s.emit("message", JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    s.emit("message", JSON.stringify({ type: "ping", t: 12.5 }));
    s.emit("message", "not json");
    s.emit("message", JSON.stringify({ type: "nope" }));
    expect(p.writes).toEqual(["ls\r"]);
    expect(p.sizes).toEqual([[100, 30]]);
    expect(s.sent[1]).toEqual({ type: "pong", t: 12.5 });
    s.emit("close");
    expect(p.detached()).toBe(true);
  });

  it("flushes pending output before exit and restart", () => {
    const s = fakeSocket();
    const p = fakeSession();
    bridgeSocket(s.socket, p.session);
    p.listener().data("a");
    p.listener().data("b");
    p.listener().exit(3);
    p.listener().restart?.();
    expect(s.sent.slice(1)).toEqual([{ type: "data", data: "a" }, { type: "data", data: "b" }, { type: "exit", code: 3 }, { type: "restart" }]);
  });

  it("sends nothing once the socket is no longer open", () => {
    const s = fakeSocket();
    (s.socket as { readyState: number }).readyState = 3;
    bridgeSocket(s.socket, fakeSession().session);
    expect(s.sent).toEqual([]);
  });

  it("parses the client messages", () => {
    expect(clientMessageSchema.safeParse({ type: "input", data: "x" }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "resize", cols: "1", rows: 2 }).success).toBe(false);
  });
});
