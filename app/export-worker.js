import { runExportJob } from "./export.js";

self.addEventListener("message", async ({ data }) => {
  try {
    const canvas = typeof OffscreenCanvas === "function" && new OffscreenCanvas(1, 1);
    if (!canvas?.getContext("2d") || !canvas.convertToBlob || !self.createImageBitmap) {
      self.postMessage({ type: "unavailable" });
      return;
    }
    const progress = (page) => self.postMessage({ type: "progress", page });
    const blob = await runExportJob(data, progress);
    self.postMessage({ type: "complete", blob });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message });
  }
}, { once: true });
