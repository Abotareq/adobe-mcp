const { app } = require("photoshop");
const { getLayerTree } = require("./walker.js");
const { exportLayers } = require("./exporter.js");

const BRIDGE_URL = "ws://127.0.0.1:3001";

// Commands the bridge may send. Envelope: { requestId, command, args } in,
// { requestId, result } | { requestId, error } out (see shared/src/index.ts).
const commands = {
  ping: async () => "pong",
  getLayerTree: () => getLayerTree(),
  exportLayers: (args) => exportLayers(args),
};

const status = document.getElementById("status");
const setStatus = (text) => { status.textContent = text; };

let socket = null;

function connect() {
  socket = new WebSocket(BRIDGE_URL);

  socket.onopen = () => setStatus(`Photoshop ${app.version} — bridge connected`);

  socket.onmessage = async (event) => {
    let req;
    try { req = JSON.parse(event.data); } catch { return; }
    const { requestId, command, args } = req;
    const handler = commands[command];
    try {
      if (!handler) throw new Error(`Unknown command: ${command}`);
      socket.send(JSON.stringify({ requestId, result: await handler(args) }));
    } catch (err) {
      socket.send(JSON.stringify({ requestId, error: String(err && err.message || err) }));
    }
  };

  socket.onclose = () => {
    setStatus(`Photoshop ${app.version} — bridge offline, retrying…`);
    setTimeout(connect, 2000);
  };
  socket.onerror = () => { /* onclose follows and schedules the retry */ };
}

// Manual test: dump the active document's layer tree to the UXP debug console.
document.getElementById("dump").addEventListener("click", async () => {
  try {
    const tree = await getLayerTree();
    console.log(JSON.stringify(tree, null, 2));
    setStatus(`Dumped ${tree.layers.length} top-level layers to console`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  }
});

// Also reachable from the debug console as `adobeMcp.getLayerTree()`.
window.adobeMcp = { getLayerTree };

setStatus(`Photoshop ${app.version} — connecting to bridge…`);
connect();
