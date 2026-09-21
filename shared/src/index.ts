/**
 * Message envelope shared by the bridge and the MCP server.
 *
 * Direction of travel:
 *   MCP server -> bridge -> UXP plugin : BridgeRequest
 *   UXP plugin -> bridge -> MCP server : BridgeResponse
 *
 * The UXP plugin is plain JS and does not import this file; it must
 * produce/consume the same shapes by hand (see uxp-plugin/walker.js).
 */

/** Commands the UXP plugin knows how to execute. Grows per phase. */
export type BridgeCommand = "ping" | "getLayerTree" | "exportLayers";

export interface BridgeRequest<TArgs = unknown> {
  requestId: string;
  command: BridgeCommand;
  args: TArgs;
}

export interface BridgeResponse<TResult = unknown> {
  requestId: string;
  result?: TResult;
  error?: string;
}

/** Fixed local port the bridge listens on and the plugin dials. */
export const BRIDGE_PORT = 3001;
/** Local port of the bridge's HTTP API, called by the MCP server. */
export const BRIDGE_HTTP_PORT = 3002;

/** Body of `POST /command` on the bridge HTTP API. */
export interface BridgeHttpCommand<TArgs = unknown> {
  command: BridgeCommand;
  args?: TArgs;
  /** Overrides the bridge's default (5000 ms). */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Layer tree — result of the "getLayerTree" command.
// ---------------------------------------------------------------------------

/** Normalised layer kind. `psKind` on the node keeps Photoshop's raw value. */
export type LayerKind =
  | "pixel"
  | "text"
  | "smartObject"
  | "group"
  | "shape"
  | "adjustment"
  | "other";

export interface LayerBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** One contiguous run of characters sharing a style. */
export interface TextRun {
  from: number;
  to: number;
  fontPostScriptName?: string;
  fontFamily?: string;
  fontStyle?: string;
  /** Point size as stored in the document; not scaled by any layer transform. */
  size?: number;
  /** #rrggbb */
  color?: string | null;
}

export interface TextDetails {
  contents: string;
  runs: TextRun[];
}

export interface ShapeDetails {
  fillType: "solid" | "gradient" | "pattern" | "none";
  /** #rrggbb — only for fillType "solid". */
  fill: string | null;
  fillEnabled: boolean;
  stroke: { color: string | null; width: number | null } | null;
}

export interface LayerNode {
  id: number;
  name: string;
  kind: LayerKind;
  psKind: string;
  bounds: LayerBounds;
  visible: boolean;
  /** 0–100 */
  opacity: number;
  blendMode: string;
  text?: TextDetails;
  shape?: ShapeDetails;
  /** Raw Photoshop `layerEffects` descriptor, if the layer has any. */
  effects?: unknown;
  children?: LayerNode[];
}

export interface LayerTree {
  document: {
    id: number;
    name: string;
    path: string | null;
    width: number;
    height: number;
    resolution: number;
  };
  layers: LayerNode[];
}

// ---------------------------------------------------------------------------
// Layer export — args/result of the "exportLayers" command.
// ---------------------------------------------------------------------------

export interface ExportLayersArgs {
  /** Absolute folder path. Must already exist; the MCP server creates it. */
  outputDir: string;
  /** Layers to export, with the filename to use for each (no extension). */
  layers: { id: number; fileName: string }[];
}

export interface ExportedLayer {
  layerId: number;
  format: "png";
  path: string;
  width: number;
  height: number;
}

export interface ExportLayersResult {
  exported: ExportedLayer[];
  /** Layers that failed to export, with the reason. */
  failed: { layerId: number; error: string }[];
}
