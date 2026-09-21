// Per-layer PNG export. Mirrors ExportLayersArgs / ExportLayersResult in
// shared/src/index.ts.
//
// UXP has no per-layer export API, so for each target layer we duplicate the
// document, show only that layer (and its ancestor groups), trim to the visible
// pixels, save as PNG, and close the duplicate. Everything runs inside one
// executeAsModal scope.
const { app, core, constants } = require("photoshop");
const { storage } = require("uxp");

function toFileUrl(absPath) {
  return "file:///" + absPath.split("\\").join("/").replace(/^\/+/, "");
}

// Set visibility on the whole tree so that only `targetId` and the groups that
// contain it are visible. Returns true if this subtree contains the target.
function showOnly(layers, targetId) {
  let found = false;
  for (const layer of layers) {
    let contains = layer.id === targetId;
    if (!contains && layer.kind === "group") contains = showOnly(layer.layers, targetId);
    layer.visible = contains;
    if (contains) found = true;
  }
  return found;
}

async function exportOne(source, folder, { id, fileName }) {
  const dup = await source.duplicate();
  try {
    if (!showOnly(dup.layers, id)) throw new Error(`layer ${id} not found`);
    await dup.trim(constants.TrimType.TRANSPARENT);
    if (dup.width === 0 || dup.height === 0) throw new Error("layer has no visible pixels");

    const file = await folder.createFile(`${fileName}.png`, { overwrite: true });
    await dup.saveAs.png(file, {}, true);
    return { layerId: id, format: "png", path: file.nativePath, width: dup.width, height: dup.height };
  } finally {
    await dup.closeWithoutSaving();
  }
}

async function exportLayers({ outputDir, layers }) {
  const source = app.activeDocument;
  if (!source) throw new Error("No active document");

  const folder = await storage.localFileSystem.getEntryWithUrl(toFileUrl(outputDir));
  if (!folder.isFolder) throw new Error(`Not a folder: ${outputDir}`);

  const result = { exported: [], failed: [] };
  await core.executeAsModal(
    async () => {
      for (const target of layers) {
        try {
          result.exported.push(await exportOne(source, folder, target));
        } catch (err) {
          result.failed.push({ layerId: target.id, error: String((err && err.message) || err) });
        }
      }
    },
    { commandName: "Adobe MCP: export layers" },
  );
  return result;
}

module.exports = { exportLayers };
