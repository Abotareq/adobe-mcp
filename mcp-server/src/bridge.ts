import { BRIDGE_HTTP_PORT, type BridgeCommand, type BridgeHttpCommand } from "@adobe-mcp/shared";

const BASE = process.env.ADOBE_MCP_BRIDGE_URL ?? `http://127.0.0.1:${BRIDGE_HTTP_PORT}`;

/** Call a plugin command through the bridge. Throws with the bridge's error text. */
export async function callBridge<T>(command: BridgeCommand, args?: unknown, timeoutMs?: number): Promise<T> {
  const body: BridgeHttpCommand = { command, args, timeoutMs };
  let res: Response;
  try {
    res = await fetch(`${BASE}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`bridge not reachable at ${BASE} — start it with \`npm run dev:bridge\` (${(err as Error).message})`);
  }
  const json = (await res.json()) as { result?: T; error?: string };
  if (!res.ok) throw new Error(json.error ?? `bridge returned HTTP ${res.status}`);
  return json.result as T;
}
