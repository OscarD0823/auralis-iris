function runWorker(scan, onProgress, signal) {
  let worker;
  try {
    worker = new Worker(new URL("./pdf-worker.js", import.meta.url), { type: "module" });
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    let started = false;
    const abort = () => finish(reject, signal.reason);
    function finish(settle, value) {
      signal.removeEventListener("abort", abort);
      worker.terminate();
      settle(value);
    }
    signal.addEventListener("abort", abort, { once: true });
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      if (started) finish(reject, new Error("Se interrumpió la exportación del PDF."));
      else finish(resolve, null);
    });
    worker.addEventListener("messageerror", () => finish(reject, new Error("No se pudo recibir el PDF.")));
    worker.addEventListener("message", ({ data }) => {
      switch (data.type) {
        case "progress":
          started = true;
          onProgress(data.page);
          break;
        case "complete":
          finish(resolve, data.blob);
          break;
        case "unavailable":
          finish(resolve, null);
          break;
        case "error":
          finish(reject, new Error(data.message || "No se pudo preparar el PDF."));
          break;
      }
    });
    try {
      worker.postMessage(scan);
    } catch (error) {
      finish(reject, error);
    }
  });
}

export async function exportPdf(scan, onProgress, signal) {
  signal.throwIfAborted();
  const job = { title: scan.title, profile: scan.profile, pages: scan.pages.map(({ thumb, ...page }) => page) };
  if (typeof Worker === "function" && typeof OffscreenCanvas === "function") {
    const pdf = await runWorker(job, onProgress, signal);
    if (pdf) return pdf;
  }
  signal.throwIfAborted();
  const { makePdf } = await import("./pdf.js");
  return makePdf(job, onProgress, signal);
}
