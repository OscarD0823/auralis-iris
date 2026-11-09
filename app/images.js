import { isFullFrame, jpeg, renderScan, SOURCE_EDGE } from "./scan.js";

async function makeJpg(page) {
  if (page.turns === 0 && page.filter === "color" && isFullFrame(page.quad) && page.blob.type === "image/jpeg") {
    return page.blob;
  }
  const canvas = await renderScan(page, SOURCE_EDGE);
  try {
    return await jpeg(canvas, .92);
  } finally {
    canvas.width = canvas.height = 1;
  }
}

export async function makeImages(pages, onProgress, signal) {
  signal?.throwIfAborted();
  if (pages.length === 1) {
    onProgress(1);
    return makeJpg(pages[0]);
  }
  const { Zip, ZipPassThrough } = await import("./vendor/fflate.js");
  const chunks = [];
  const zip = new Zip((error, data) => {
    if (error) throw error;
    chunks.push(data);
  });
  for (const [index, page] of pages.entries()) {
    signal?.throwIfAborted();
    onProgress(index + 1);
    const image = await makeJpg(page);
    const bytes = new Uint8Array(await image.arrayBuffer());
    signal?.throwIfAborted();
    const file = new ZipPassThrough("pagina-" + String(index + 1).padStart(2, "0") + ".jpg");
    zip.add(file);
    file.push(bytes, true);
  }
  zip.end();
  return new Blob(chunks, { type: "application/zip" });
}
