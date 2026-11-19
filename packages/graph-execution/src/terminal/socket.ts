// The WebSocket protocol between a browser terminal (client.ts) and a PTY session (pty.ts).
//   client → server: {type:"input",data} | {type:"resize",cols,rows} | {type:"ping",t}; anything else is ignored.
//   server → client: {type:"replay",data} first, then {type:"data",data} (batched), {type:"exit",code},
//                    {type:"restart"} and {type:"pong",t}.
import { z } from "zod";
import { batchOutput } from "./batch.js";
import type { PtyAttachment, PtyListener } from "./pty.js";

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({ type: z.literal("resize"), cols: z.number(), rows: z.number() }),
  // The client measures its round trip to the server (shown under the terminal); `t` comes back as sent.
  z.object({ type: z.literal("ping"), t: z.number() }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** The part of a `ws` WebSocket (as @fastify/websocket hands it over) the bridge uses. */
export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", fn: (raw: Buffer | ArrayBuffer | Buffer[] | string) => void): unknown;
  on(event: "close", fn: () => void): unknown;
  readonly readyState: number;
  readonly OPEN: number;
}

/** What the bridge attaches to: a PtySession, or anything with the same `attach`. */
export interface BridgeTarget {
  attach(listener: PtyListener): PtyAttachment;
}

/** Connects `socket` to `session` until the socket closes. */
export function bridgeSocket(socket: BridgeSocket, session: BridgeTarget): void {
  const send = (msg: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  // One frame per PTY chunk floods the socket during a TUI redraw; batch them (see batchOutput).
  const output = batchOutput((data) => send({ type: "data", data }));
  const att = session.attach({
    data: (data) => output.push(data),
    exit: (code) => {
      output.flush();
      send({ type: "exit", code });
    },
    restart: () => {
      output.flush();
      send({ type: "restart" });
    },
  });
  send({ type: "replay", data: att.replay });
  socket.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText(raw));
    } catch {
      return;
    }
    const msg = clientMessageSchema.safeParse(parsed);
    if (!msg.success) return;
    if (msg.data.type === "input") att.write(msg.data.data);
    else if (msg.data.type === "ping") send({ type: "pong", t: msg.data.t });
    else att.resize(msg.data.cols, msg.data.rows);
  });
  socket.on("close", () => {
    output.dispose();
    att.detach();
  });
}

function rawText(raw: Buffer | ArrayBuffer | Buffer[] | string): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw).toString();
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString();
  return raw.toString();
}
