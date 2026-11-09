function runWorker(job, onProgress, signal) {
  let worker;
  try {
    worker = new Worker(new URL("./export-worker.js", import.meta.url), { type: "module" });
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
      if (started) finish(reject, new Error("Se interrumpió la exportación."));
      else finish(resolve, null);
    });
    worker.addEventListener("messageerror", () => finish(reject, new Error("No se pudo recibir el archivo.")));
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
          finish(reject, new Error(data.message || "No se pudo preparar el archivo."));
          break;
      }
    });
    try {
      worker.postMessage(job);
    } catch (error) {
      finish(reject, error);
    }
  });
}

export async function runExportJob(job, onProgress, signal) {
  if (job.kind === "images") {
    const { makeImages } = await import("./images.js");
    return makeImages(job.pages, onProgress, signal);
  }
  const { makePdf } = await import("./pdf.js");
  return makePdf(job, onProgress, signal);
}

async function exportFile(job, onProgress, signal) {
  signal.throwIfAborted();
  const input = { ...job, pages: job.pages.map(({ thumb, ...page }) => page) };
  if (typeof Worker === "function" && typeof OffscreenCanvas === "function") {
    const result = await runWorker(input, onProgress, signal);
    if (result) return result;
  }
  signal.throwIfAborted();
  return runExportJob(input, onProgress, signal);
}

export function exportPdf({ title, profile, pages }, onProgress, signal) {
  return exportFile({ kind: "pdf", title, profile, pages }, onProgress, signal);
}

export function exportImages(pages, onProgress, signal) {
  return exportFile({ kind: "images", pages }, onProgress, signal);
}
