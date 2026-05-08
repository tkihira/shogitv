/* eslint-disable */
// Classic Web Worker that hosts the YaneuraOu.wasm engine. Loaded via
// `new Worker('/engine/worker-host.js')` from the main thread.
//
// Protocol:
//   main → worker: { kind: 'init' }
//   main → worker: { kind: 'usi', line: 'usi' | 'isready' | 'position ...' | 'go ...' | 'stop' | ... }
//   worker → main: { kind: 'ready' }                — engine factory resolved
//   worker → main: { kind: 'usi', line: '<usi line>' }
//   worker → main: { kind: 'error', message: string }

self.YaneuraOu_HalfKP = undefined;

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.kind === "init") {
    try {
      // Resolve all engine assets relative to this worker's own URL so the same code works
      // under both the dev server (/) and the GH Pages subpath (/shogitv/).
      self.importScripts("yaneuraou.k-p.js");
      const factory = self.YaneuraOu_K_P;
      if (typeof factory !== "function") {
        throw new Error("YaneuraOu_K_P factory not found after importScripts");
      }
      const engineUrl = new URL("yaneuraou.k-p.js", self.location.href).href;
      const engine = await factory({
        locateFile: (name) => new URL(name, self.location.href).href,
        mainScriptUrlOrBlob: engineUrl,
        print: () => {},
        printErr: (line) => console.warn("[engine]", line),
      });
      engine.addMessageListener((line) => {
        self.postMessage({ kind: "usi", line });
      });
      self._engine = engine;
      self.postMessage({ kind: "ready" });
    } catch (err) {
      self.postMessage({ kind: "error", message: String(err && err.message ? err.message : err) });
    }
    return;
  }

  if (msg.kind === "usi") {
    if (!self._engine) {
      self.postMessage({ kind: "error", message: "engine not initialized" });
      return;
    }
    self._engine.postMessage(msg.line);
    return;
  }
};
