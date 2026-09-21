# adobe-mcp

MCP server that exposes Photoshop documents to Claude: design tokens (colors, type,
spacing, effects) and exported image assets.

## Architecture

Four processes, one direction of trust. Claude only talks to the MCP server; only the
UXP plugin touches the Photoshop DOM.

```
Claude ──stdio──> mcp-server ──HTTP──> bridge <──WebSocket── uxp-plugin ──> Photoshop
```

- **mcp-server/** — Node + `@modelcontextprotocol/sdk`. Registers the tools Claude
  calls (`extractDesignTokens`, `extractImageAssets`) and forwards them to the bridge.
- **bridge/** — Local relay. Listens on `ws://127.0.0.1:3001` for the plugin, and
  exposes an HTTP API on `http://127.0.0.1:3002` for the MCP server. Correlates
  requests to responses by `requestId` with a timeout, and returns a clear error when
  no plugin is connected.

  | Endpoint | Body | Response |
  | --- | --- | --- |
  | `GET /status` | — | `{ pluginConnected, pending }` |
  | `POST /command` | `{ command, args?, timeoutMs? }` | `200 { result }` · `400` bad request · `502 { error }` plugin-reported error · `503` plugin not connected / disconnected mid-request · `504` timed out (default 5000 ms) |
- **uxp-plugin/** — Runs inside Photoshop (UXP, manifest v5, PS 23.3+). Dials the
  bridge on load, walks `app.activeDocument`, runs exports. Plain JS, no build step,
  no `node_modules` — it is intentionally not an npm workspace.
- **shared/** — TypeScript message-envelope types imported by both `mcp-server` and
  `bridge`. The plugin mirrors these shapes by hand.

The bridge is the WebSocket *server* and the plugin is the *client*: UXP cannot host
a listening socket.

## Setup

Requires Node 22+ and Photoshop 23.3+.

```
npm install
npm run build
```

### Load the plugin in Photoshop

1. Install the [UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/)
   from Creative Cloud.
2. In UDT: **Add Plugin** → select `uxp-plugin/manifest.json`.
3. Click **Load**, then **Debug** to open the console.
4. In Photoshop: **Plugins → Adobe MCP**. The panel should show the Photoshop version.

### Run the bridge

```
npm run dev:bridge
```

### Run the MCP server

```
npm run dev:mcp
```

### Register with Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json` (merge into an existing
`mcpServers` block if there is one), then fully quit and relaunch Claude Desktop:

```json
{
  "mcpServers": {
    "adobe-mcp": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["S:\\Adobe_MCP\\mcp-server\\dist\\index.js"],
      "env": { "ADOBE_MCP_EXPORT_DIR": "S:\\Adobe_MCP\\exports" }
    }
  }
}
```

Use absolute paths: Claude Desktop launches servers with an arbitrary working
directory. `ADOBE_MCP_EXPORT_DIR` is where `extractImageAssets` writes by default;
it falls back to `~/adobe-mcp-exports/` if unset.

### Register with Claude Code

Already declared in [`.mcp.json`](.mcp.json) at the repo root. Any Claude Code session
opened in this folder gets the `adobe-mcp` server.

### Run order

Every session needs all three running, in this order:

1. `npm run dev:bridge` — leave it running
2. Photoshop with the plugin loaded (UXP Developer Tool → Load) and a document open.
   The panel should say `bridge connected`.
3. Claude Desktop / Claude Code — starts the MCP server itself on demand

If the bridge is down the tools return `bridge not reachable`; if Photoshop or the
plugin is down they return `plugin not connected`. Neither hangs.

## Manual test checklist

Run against **2–3 real PSDs** you did not make for this purpose — a landing page, a
brand sheet, a UI mockup. Tick each item per file.

**Setup**

- [ ] Bridge log shows `plugin connected` and the ping/pong exchange
- [ ] Claude lists `extractDesignTokens` and `extractImageAssets` (Claude Desktop:
      the tools icon under the prompt box; Claude Code: `/mcp`)

**`extractDesignTokens`** — ask Claude *"extract the design tokens from the open
Photoshop document"* and compare with the file:

- [ ] Colour token count is close to what you'd say the design actually uses
- [ ] No two visually distinct brand colours merged into one token
      (if they did, lower `colorDistanceThreshold`; if there are noisy near-dupes,
      raise it — it's per call, default 8)
- [ ] Every font in the file appears in `typography`, including fonts not installed
      on this machine
- [ ] Sizes look right (note: stored point size, ignores layer transforms)
- [ ] `images[]` lists every raster / smart-object layer, none silently dropped
- [ ] Hidden layers are absent and `stats.hiddenSkipped` matches how many you hid
- [ ] Layers nested inside groups-inside-groups are counted in `stats.layersVisited`
- [ ] Run it twice with no changes — output is byte-identical

**`extractImageAssets`** — ask Claude *"export the image assets"*:

- [ ] Every raster / smart-object / shape leaf layer has a PNG in the output folder
- [ ] Each PNG opens and shows only that layer, trimmed to its pixels, with its
      layer effects rendered
- [ ] `width` / `height` in the manifest match the PNG
- [ ] Hidden layers were not exported
- [ ] `failed[]` is empty, or each entry has a reason you'd expect
      (e.g. an empty layer → `layer has no visible pixels`)
- [ ] The source document is unchanged afterwards (no stray duplicate left open,
      no visibility changes)

**When something is off**, the two most likely causes are field paths in
`uxp-plugin/walker.js` (`batchPlay` descriptor names) or an API difference in
`uxp-plugin/exporter.js`. Paste the UXP debug console output or the `failed[].error`
text to fix it.

## Manual test — document walker (Phase 1)

1. Start the bridge: `npm run dev:bridge`. It logs `listening on ws://127.0.0.1:3001`.
2. In Photoshop, open a PSD with a mix of text, shape, and image layers, ideally with
   at least one group nested inside another group.
3. In UXP Developer Tool, **Load** the plugin (or **Reload** if already loaded), then
   **Debug** to open the console.
4. Open the panel: **Plugins → Adobe MCP**. Status should read `bridge connected`, and
   the bridge terminal should log `plugin connected` followed by
   `response { requestId: 'ping-1', result: 'pong' }`.
5. Click **Dump layer tree to console**. The debug console prints the JSON tree.
   You can also run `adobeMcp.getLayerTree()` directly in the console.

Check against the file:

- every layer appears, including ones inside nested groups (`children` arrays)
- text layers have `text.runs[]` with `fontFamily`, `fontStyle`, `size`, `color`
- shape layers have `shape.fill` / `shape.stroke`; gradient fills report
  `fillType: "gradient"` with `fill: null`
- hidden layers appear with `visible: false` (they are included, not dropped)
- layers with effects have a raw `effects` descriptor

If the bridge is not running, the panel shows `bridge offline, retrying…` and
reconnects every 2 s. The dump button works without the bridge.

Known gaps for v1: text `size` is the stored point size and ignores any transform
on the layer; only solid-colour fills/strokes are resolved to hex.

## Tools

### `extractDesignTokens`

Input: `{ colorDistanceThreshold?: number = 8, includeHidden?: boolean = false }`

Returns `{ document, colors[], typography[], images[], stats }`.

- **colors** — every text, fill, stroke and layer-effect colour, clustered by RGB
  Euclidean distance (`colorDistanceThreshold`, 0–441). Each token is
  `{ hex, members[], count, sources[] }` where `hex` is the most-used member.
  Default threshold is deliberately tight; tune it against real files.
- **typography** — unique `(fontFamily, fontStyle, size)` triples with usage counts,
  largest first. Fonts are named as stored in the file even if not installed.
- **images** — raster and smart-object layers, flagged `{ type: "image",
  extracted: false }` so nothing is silently dropped.
- Hidden layers (and everything inside hidden groups) are **excluded** and counted in
  `stats.hiddenSkipped`. Pass `includeHidden: true` to include them.
- Output is deterministic and independent of layer order.

### `extractImageAssets`

Input: `{ outputDir?: string, includeHidden?: boolean = false }`

Exports every visible raster, smart-object and shape *leaf* layer as a trimmed PNG.
Groups are not exported as units. Default `outputDir` is `./exports/<document slug>/`
relative to the MCP server's working directory. Returns
`{ outputDir, assets[], failed[] }` with `{ layerName, layerId, type, format, path,
width, height }` per asset. Local paths only — nothing is uploaded.

How export works in UXP (there is no per-layer export API): for each layer the plugin
duplicates the document, shows only that layer and its ancestor groups, trims to
transparent, saves PNG, closes the duplicate. Layer effects render into the export.
SVG export for shape layers is deferred.

## Manual test — tools (Phase 3)

With the bridge running and the plugin loaded (see Phase 1 test), from a second
terminal:

```
npx @modelcontextprotocol/inspector node mcp-server/dist/index.js
```

Call `extractDesignTokens` and check the colours and fonts against the file. Call
`extractImageAssets` and open the PNGs in `exports/`.

## Status

- [x] Phase 0 — scaffold
- [x] Phase 1 — UXP document walker (needs manual verification in Photoshop)
- [x] Phase 2 — bridge request/response correlation
- [x] Phase 3 — `extractDesignTokens`, `extractImageAssets` (export path needs manual verification in Photoshop)
- [x] Phase 4 — Claude Desktop / Claude Code wiring (manual test checklist above)
- [ ] Phase 5 (deferred) — `diffDocuments`
