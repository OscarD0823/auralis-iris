import "./vendor/pdf-lib.js";
import { jpeg, packMonochrome, profiles, renderScan } from "./scan.js";

const { PDFDocument, drawObject, pushGraphicsState, popGraphicsState, translate, scale } = globalThis.PDFLib;

function drawMonochrome(pdf, page, canvas, box) {
  const { width, height } = canvas;
  const pixels = canvas.getContext("2d").getImageData(0, 0, width, height);
  const stream = pdf.context.flateStream(packMonochrome(pixels), {
    Type: "XObject",
    Subtype: "Image",
    Width: width,
    Height: height,
    ColorSpace: "DeviceGray",
    BitsPerComponent: 1
  });
  const key = page.node.newXObject("Image", pdf.context.register(stream));
  page.pushOperators(pushGraphicsState(), translate(box.x, box.y), scale(box.width, box.height), drawObject(key), popGraphicsState());
}

export async function makePdf(scan, onProgress, signal) {
  const { maxEdge, quality } = profiles[scan.profile] ?? profiles.balanced;
  const pdf = await PDFDocument.create();
  pdf.setTitle(scan.title);
  pdf.setCreator("Auralis Iris");
  for (const [index, source] of scan.pages.entries()) {
    signal?.throwIfAborted();
    onProgress(index + 1);
    const canvas = await renderScan(source, maxEdge);
    try {
      signal?.throwIfAborted();
      const [width, height] = canvas.width > canvas.height ? [841.89, 595.28] : [595.28, 841.89];
      const page = pdf.addPage([width, height]);
      const ratio = Math.min((width - 24) / canvas.width, (height - 24) / canvas.height);
      const drawWidth = canvas.width * ratio;
      const drawHeight = canvas.height * ratio;
      const box = { x: (width - drawWidth) / 2, y: (height - drawHeight) / 2, width: drawWidth, height: drawHeight };
      if (source.filter === "bw") drawMonochrome(pdf, page, canvas, box);
      else {
        const optimized = await jpeg(canvas, quality);
        const image = await pdf.embedJpg(await optimized.arrayBuffer());
        page.drawImage(image, box);
      }
    } finally {
      canvas.width = canvas.height = 1;
    }
  }
  signal?.throwIfAborted();
  return new Blob([await pdf.save()], { type: "application/pdf" });
}
