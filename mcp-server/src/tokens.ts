import type { LayerNode, LayerTree } from "@adobe-mcp/shared";

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export type ColorSource = "text" | "fill" | "stroke" | "effect";

export interface ColorToken {
  /** Representative colour: the most-used member of the cluster. */
  hex: string;
  /** Distinct raw colours merged into this token. */
  members: string[];
  /** Total occurrences across all members. */
  count: number;
  sources: ColorSource[];
}

export interface TypeToken {
  fontFamily: string;
  fontStyle: string;
  fontPostScriptName: string | null;
  size: number;
  count: number;
}

export interface SkippedImage {
  type: "image";
  extracted: false;
  layerId: number;
  layerName: string;
  kind: string;
}

export interface DesignTokens {
  document: LayerTree["document"];
  colors: ColorToken[];
  typography: TypeToken[];
  /** Raster / smart-object layers that carry no extractable tokens. */
  images: SkippedImage[];
  stats: {
    layersVisited: number;
    hiddenSkipped: number;
    rawColors: number;
    colorDistanceThreshold: number;
  };
}

export interface ExtractOptions {
  /**
   * Max Euclidean RGB distance (0–441) for two colours to share a token.
   * Conservative default; tune against real files.
   */
  colorDistanceThreshold?: number;
  includeHidden?: boolean;
}

// ---------------------------------------------------------------------------
// Walk
// ---------------------------------------------------------------------------

interface Occurrence { hex: string; source: ColorSource }

function* visit(nodes: LayerNode[], includeHidden: boolean, stats: { hidden: number }): Generator<LayerNode> {
  for (const n of nodes) {
    if (!n.visible && !includeHidden) { stats.hidden++; continue; }
    yield n;
    if (n.children) yield* visit(n.children, includeHidden, stats);
  }
}

// Effects come through as Photoshop's raw layerEffects descriptor. Pull out any
// nested { red, grain, blue } colour objects without depending on its layout.
function effectColors(effects: unknown, out: Occurrence[]): void {
  if (!effects || typeof effects !== "object") return;
  for (const v of Object.values(effects as Record<string, unknown>)) {
    if (v && typeof v === "object") {
      const c = v as { red?: unknown; grain?: unknown; blue?: unknown };
      if (typeof c.red === "number" && typeof c.grain === "number" && typeof c.blue === "number") {
        out.push({ hex: rgbToHex(c.red, c.grain, c.blue), source: "effect" });
      } else {
        effectColors(v, out);
      }
    }
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function distance(a: string, b: string): number {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

// ---------------------------------------------------------------------------
// Clustering: greedy, seeded by frequency. Deterministic for a given input.
// ---------------------------------------------------------------------------

export function clusterColors(occurrences: Occurrence[], threshold: number): ColorToken[] {
  const byHex = new Map<string, { count: number; sources: Set<ColorSource> }>();
  for (const { hex, source } of occurrences) {
    const e = byHex.get(hex) ?? { count: 0, sources: new Set<ColorSource>() };
    e.count++;
    e.sources.add(source);
    byHex.set(hex, e);
  }

  // Most-used first; ties broken by hex so the output is stable.
  const ordered = [...byHex.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));

  const clusters: ColorToken[] = [];
  for (const [hex, e] of ordered) {
    const home = clusters.find((c) => distance(c.hex, hex) <= threshold);
    if (home) {
      home.members.push(hex);
      home.count += e.count;
      for (const s of e.sources) if (!home.sources.includes(s)) home.sources.push(s);
    } else {
      clusters.push({ hex, members: [hex], count: e.count, sources: [...e.sources] });
    }
  }
  for (const c of clusters) c.sources.sort();
  return clusters;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function extractDesignTokens(tree: LayerTree, opts: ExtractOptions = {}): DesignTokens {
  const threshold = opts.colorDistanceThreshold ?? 8;
  const includeHidden = opts.includeHidden ?? false;

  const colors: Occurrence[] = [];
  const type = new Map<string, TypeToken>();
  const images: SkippedImage[] = [];
  const stats = { hidden: 0 };
  let visited = 0;

  for (const n of visit(tree.layers, includeHidden, stats)) {
    visited++;

    if (n.text) {
      for (const run of n.text.runs) {
        if (run.color) colors.push({ hex: run.color, source: "text" });
        if (run.fontFamily && run.size != null) {
          const key = `${run.fontFamily}|${run.fontStyle ?? ""}|${run.size}`;
          const t = type.get(key) ?? {
            fontFamily: run.fontFamily,
            fontStyle: run.fontStyle ?? "Regular",
            fontPostScriptName: run.fontPostScriptName ?? null,
            size: run.size,
            count: 0,
          };
          t.count++;
          type.set(key, t);
        }
      }
    }

    if (n.shape) {
      if (n.shape.fill && n.shape.fillEnabled) colors.push({ hex: n.shape.fill, source: "fill" });
      if (n.shape.stroke?.color) colors.push({ hex: n.shape.stroke.color, source: "stroke" });
    }

    if (n.effects) effectColors(n.effects, colors);

    if (n.kind === "pixel" || n.kind === "smartObject") {
      images.push({ type: "image", extracted: false, layerId: n.id, layerName: n.name, kind: n.kind });
    }
  }

  const typography = [...type.values()].sort(
    (a, b) => b.size - a.size || a.fontFamily.localeCompare(b.fontFamily) || a.fontStyle.localeCompare(b.fontStyle),
  );

  return {
    document: tree.document,
    colors: clusterColors(colors, threshold),
    typography,
    images,
    stats: {
      layersVisited: visited,
      hiddenSkipped: stats.hidden,
      rawColors: new Set(colors.map((c) => c.hex)).size,
      colorDistanceThreshold: threshold,
    },
  };
}
