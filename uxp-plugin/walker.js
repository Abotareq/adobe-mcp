// Document walker. Mirrors the LayerTree / LayerNode shapes in shared/src/index.ts.
//
// Structure (id, name, kind, bounds, visibility, children) comes from the UXP DOM.
// Details the DOM does not expose (shape fill/stroke, every text style run, layer
// effects) come from one batchPlay `get` per text/shape layer.
const { app, action } = require("photoshop");

// Photoshop layer kinds -> normalised kinds. Shapes are fill layers with a vector
// mask; Photoshop has no distinct "shape" kind.
const KIND = {
  pixel: "pixel",
  text: "text",
  smartObject: "smartObject",
  group: "group",
  solidColor: "shape",
  gradientFill: "shape",
  patternFill: "shape",
};
const ADJUSTMENT_KINDS = new Set([
  "blackAndWhite", "brightnessContrast", "channelMixer", "colorBalance", "colorLookup",
  "curves", "exposure", "gradientMap", "hueSaturation", "invert", "levels",
  "photoFilter", "posterize", "selectiveColor", "threshold", "vibrance",
]);

function normaliseKind(psKind) {
  if (KIND[psKind]) return KIND[psKind];
  if (ADJUSTMENT_KINDS.has(psKind)) return "adjustment";
  return "other";
}

// batchPlay colours are { red, grain, blue } (grain = green), 0-255 floats.
function rgbToHex(c) {
  if (!c || typeof c.red !== "number") return null;
  const h = (v) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(c.red)}${h(c.grain)}${h(c.blue)}`;
}

// Unit values arrive as { _value, _unit }; plain numbers pass through.
function unit(v) {
  return v && typeof v === "object" && "_value" in v ? v._value : v ?? null;
}

async function getDescriptor(docId, layerId) {
  const [d] = await action.batchPlay(
    [{
      _obj: "get",
      _target: [{ _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }],
      _options: { dialogOptions: "dontDisplay" },
    }],
    {},
  );
  return d;
}

function textDetails(d) {
  const tk = d.textKey;
  if (!tk) return undefined;
  return {
    contents: tk.textKey ?? "",
    runs: (tk.textStyleRange || []).map((r) => {
      const s = r.textStyle || {};
      return {
        from: r.from,
        to: r.to,
        fontPostScriptName: s.fontPostScriptName,
        fontFamily: s.fontName,
        fontStyle: s.fontStyleName,
        size: unit(s.size),
        color: rgbToHex(s.color),
      };
    }),
  };
}

function shapeDetails(d) {
  const adj = Array.isArray(d.adjustment) ? d.adjustment[0] : null;
  const fillType =
    !adj ? "none"
    : adj._obj === "solidColorLayer" ? "solid"
    : adj._obj === "gradientLayer" ? "gradient"
    : adj._obj === "patternLayer" ? "pattern"
    : "none";
  const s = d.AGMStrokeStyleInfo || {};
  return {
    fillType,
    fill: fillType === "solid" ? rgbToHex(adj.color) : null,
    fillEnabled: s.fillEnabled !== false,
    stroke: s.strokeEnabled
      ? {
          color: rgbToHex(s.strokeStyleContent && s.strokeStyleContent.color),
          width: unit(s.strokeStyleLineWidth),
        }
      : null,
  };
}

async function walkLayer(layer, docId) {
  const psKind = String(layer.kind);
  const kind = normaliseKind(psKind);
  const b = layer.bounds;
  const node = {
    id: layer.id,
    name: layer.name,
    kind,
    psKind,
    bounds: { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height },
    visible: layer.visible,
    opacity: layer.opacity,
    blendMode: String(layer.blendMode),
  };

  if (kind === "text" || kind === "shape") {
    const d = await getDescriptor(docId, layer.id);
    if (kind === "text") node.text = textDetails(d);
    if (kind === "shape") node.shape = shapeDetails(d);
    if (d.layerEffects) node.effects = d.layerEffects;
  }

  if (kind === "group") {
    node.children = [];
    for (const child of layer.layers) node.children.push(await walkLayer(child, docId));
  }
  return node;
}

async function getLayerTree() {
  const doc = app.activeDocument;
  if (!doc) throw new Error("No active document");

  let path = null;
  try { path = doc.path || null; } catch { /* unsaved document */ }

  const layers = [];
  for (const layer of doc.layers) layers.push(await walkLayer(layer, doc.id));

  return {
    document: {
      id: doc.id,
      name: doc.name,
      path,
      width: doc.width,
      height: doc.height,
      resolution: doc.resolution,
    },
    layers,
  };
}

module.exports = { getLayerTree };
