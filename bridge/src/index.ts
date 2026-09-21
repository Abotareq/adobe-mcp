import { randomUUID } from "node:crypto";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import {
  BRIDGE_HTTP_PORT,
  BRIDGE_PORT,
  type BridgeCommand,
  type BridgeHttpCommand,
  type BridgeRequest,
  type BridgeResponse,
} from "@adobe-mcp/shared";

const DEFAULT_TIMEOUT_MS = 5000;

class BridgeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// Plugin side: one WebSocket connection, requests correlated by requestId.
// ---------------------------------------------------------------------------

let plugin: WebSocket | null = null;
const pending = new Map<string, Pending>();

function pluginConnected(): boolean {
  return plugin !== null && plugin.readyState === WebSocket.OPEN;
}

function rejectAll(reason: string): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new BridgeError(reason, 503));
    pending.delete(id);
  }
}

function call(command: BridgeCommand, args: unknown = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  if (!pluginConnected()) {
    return Promise.reject(new BridgeError("plugin not connected", 503));
  }
  const requestId = randomUUID();
  const request: BridgeRequest = { requestId, command, args };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new BridgeError(`${command} timed out after ${timeoutMs}ms`, 504));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });

    plugin!.send(JSON.stringify(request), (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(new BridgeError(`send failed: ${err.message}`, 503));
      }
    });
  });
}

const wss = new WebSocketServer({ port: BRIDGE_PORT, host: "127.0.0.1" });

wss.on("listening", () => {
  console.log(`[bridge] plugin socket on ws://127.0.0.1:${BRIDGE_PORT}`);
});

wss.on("connection", (socket) => {
  if (plugin) {
    console.log("[bridge] new plugin connection replaces the previous one");
    plugin.close();
  }
  plugin = socket;
  console.log("[bridge] plugin connected");

  socket.on("message", (data) => {
    let response: BridgeResponse;
    try {
      response = JSON.parse(data.toString());
    } catch {
      return;
    }
    const p = pending.get(response.requestId);
    if (!p) return; // late reply after timeout, or not a response
    pending.delete(response.requestId);
    clearTimeout(p.timer);
    if (response.error !== undefined) p.reject(new BridgeError(response.error, 502));
    else p.resolve(response.result);
  });

  socket.on("close", () => {
    console.log("[bridge] plugin disconnected");
    if (plugin === socket) {
      plugin = null;
      rejectAll("plugin disconnected");
    }
  });
});

// ---------------------------------------------------------------------------
// MCP-server side: small HTTP API.
// ---------------------------------------------------------------------------

const api = express();
api.use(express.json());

api.get("/status", (_req, res) => {
  res.json({ pluginConnected: pluginConnected(), pending: pending.size });
});

api.post("/command", async (req, res) => {
  const body = (req.body ?? {}) as Partial<BridgeHttpCommand>;
  if (typeof body.command !== "string") {
    res.status(400).json({ error: "command is required" });
    return;
  }
  try {
    const result = await call(body.command, body.args, body.timeoutMs);
    res.json({ result });
  } catch (err) {
    const e = err as Partial<BridgeError>;
    res.status(e.status ?? 500).json({ error: e.message ?? String(err) });
  }
});

api.listen(BRIDGE_HTTP_PORT, "127.0.0.1", () => {
  console.log(`[bridge] http api on http://127.0.0.1:${BRIDGE_HTTP_PORT}`);
});
