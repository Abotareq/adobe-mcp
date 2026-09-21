#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ExportLayersArgs, ExportLayersResult, LayerNode, LayerTree } from "@adobe-mcp/shared";
import { callBridge } from "./bridge.js";
import { extractDesignTokens } from "./tokens.js";

// Walking a large document is one batchPlay call per text/shape layer.
const LAYER_TREE_TIMEOUT_MS = 30_000;
const EXPORT_TIMEOUT_MS = 120_000;

// Claude Desktop starts MCP servers with an arbitrary cwd, so never default to it.
const EXPORT_ROOT = process.env.ADOBE_MCP_EXPORT_DIR ?? path.join(homedir(), "adobe-mcp-exports");

const server = new McpServer({ name: "adobe-mcp", version: "0.1.0" });

// ---------------------------------------------------------------------------
// extractDesignTokens
// ---------------------------------------------------------------------------

const ColorToken = z.object({
  hex: z.string(),
  members: z.array(z.string()),
  count: z.number(),
  sources: z.array(z.enum(["text", "fill", "stroke", "effect"])),
});
const TypeToken = z.object({
  fontFamily: z.string(),
  fontStyle: z.string(),
  fontPostScriptName: z.string().nullable(),
  size: z.number(),
  count: z.number(),
});
const SkippedImage = z.object({
  type: z.literal("image"),
  extracted: z.literal(false),
  layerId: z.number(),
  layerName: z.string(),
  kind: z.string(),
});
const DocumentInfo = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string().nullable(),
  width: z.number(),
  height: z.number(),
  resolution: z.number(),
});

server.registerTool(
  "extractDesignTokens",
  {
    title: "Extract design tokens",
    description:
      "Walk the active Photoshop document and return its colours (clustered, near-duplicates merged), " +
      "type scale (font family / style / size), and a list of raster layers that were skipped. " +
      "Hidden layers are excluded unless includeHidden is set.",
    inputSchema: z.object({
      colorDistanceThreshold: z
        .number()
        .min(0)
        .max(441)
        .default(8)
        .describe("Max RGB Euclidean distance for two colours to merge into one token. 0 = exact match only."),
      includeHidden: z.boolean().default(false),
    }),
    outputSchema: z.object({
      document: DocumentInfo,
      colors: z.array(ColorToken),
      typography: z.array(TypeToken),
      images: z.array(SkippedImage),
      stats: z.object({
        layersVisited: z.number(),
        hiddenSkipped: z.number(),
        rawColors: z.number(),
        colorDistanceThreshold: z.number(),
      }),
    }),
  },
  async ({ colorDistanceThreshold, includeHidden }) => {
    const tree = await callBridge<LayerTree>("getLayerTree", {}, LAYER_TREE_TIMEOUT_MS);
    const tokens = extractDesignTokens(tree, { colorDistanceThreshold, includeHidden });
    return {
      content: [{ type: "text", text: JSON.stringify(tokens, null, 2) }],
      structuredContent: { ...tokens },
    };
  },
);

// ---------------------------------------------------------------------------
// extractImageAssets
// ---------------------------------------------------------------------------

const EXPORTABLE = new Set<LayerNode["kind"]>(["pixel", "smartObject", "shape"]);

function* leaves(nodes: LayerNode[], includeHidden: boolean): Generator<LayerNode> {
  for (const n of nodes) {
    if (!n.visible && !includeHidden) continue;
    if (n.children) yield* leaves(n.children, includeHidden);
    else if (EXPORTABLE.has(n.kind)) yield n;
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "layer";
}

server.registerTool(
  "extractImageAssets",
  {
    title: "Extract image assets",
    description:
      "Export every raster, smart-object and shape layer of the active Photoshop document as a trimmed PNG " +
      "into a local folder, and return a manifest of paths and dimensions. Local paths only; nothing is uploaded.",
    inputSchema: z.object({
      outputDir: z
        .string()
        .optional()
        .describe("Absolute folder to write into. Defaults to <ADOBE_MCP_EXPORT_DIR or ~/adobe-mcp-exports>/<document name>/."),
      includeHidden: z.boolean().default(false),
    }),
    outputSchema: z.object({
      outputDir: z.string(),
      assets: z.array(
        z.object({
          layerName: z.string(),
          layerId: z.number(),
          type: z.string(),
          format: z.literal("png"),
          path: z.string(),
          width: z.number(),
          height: z.number(),
        }),
      ),
      failed: z.array(z.object({ layerName: z.string(), layerId: z.number(), error: z.string() })),
    }),
  },
  async ({ outputDir, includeHidden }) => {
    const tree = await callBridge<LayerTree>("getLayerTree", {}, LAYER_TREE_TIMEOUT_MS);

    const docSlug = slug(tree.document.name.replace(/\.[^.]+$/, ""));
    const dir = path.resolve(outputDir ?? path.join(EXPORT_ROOT, docSlug));
    mkdirSync(dir, { recursive: true });

    const targets = [...leaves(tree.layers, includeHidden)];
    const byId = new Map(targets.map((n) => [n.id, n]));
    const args: ExportLayersArgs = {
      outputDir: dir,
      layers: targets.map((n) => ({ id: n.id, fileName: `${slug(n.name)}-${n.id}` })),
    };

    const result =
      targets.length === 0
        ? { exported: [], failed: [] }
        : await callBridge<ExportLayersResult>("exportLayers", args, EXPORT_TIMEOUT_MS);

    const out = {
      outputDir: dir,
      assets: result.exported.map((e) => ({
        layerName: byId.get(e.layerId)?.name ?? "",
        layerId: e.layerId,
        type: byId.get(e.layerId)?.kind ?? "unknown",
        format: e.format,
        path: e.path,
        width: e.width,
        height: e.height,
      })),
      failed: result.failed.map((f) => ({ layerName: byId.get(f.layerId)?.name ?? "", ...f })),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      structuredContent: out,
    };
  },
);

await server.connect(new StdioServerTransport());
// stdout is the MCP transport; only ever log to stderr from this process.
console.error("[mcp-server] ready on stdio");
