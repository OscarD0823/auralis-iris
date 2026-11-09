export const MAX_PAGES = 60;
export const MAX_FILE = 40 * 1024 * 1024;
export const profiles = {
  small: { maxEdge: 1200, quality: .61 },
  balanced: { maxEdge: 1750, quality: .77 },
  sharp: { maxEdge: 2480, quality: .87 }
};

export function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fullFrame() {
  return [[0, 0], [1, 0], [1, 1], [0, 1]];
}

function canvasAt(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function fit(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export function jpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob?.type === "image/jpeg") resolve(blob);
      else reject(new Error("No se pudo preparar la imagen."));
    }, "image/jpeg", quality);
  });
}

export async function makePage(file, id = newId()) {
  if (!file.size || file.size > MAX_FILE || file.type === "image/svg+xml") {
    throw new Error("Elige una foto válida de hasta 40 MB.");
  }
  let image;
  try {
    image = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("El navegador no pudo abrir esta foto. Prueba con JPEG, PNG o WebP.");
  }
  try {
    const [width, height] = fit(image.width, image.height, 2800);
    const canvas = canvasAt(width, height);
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await jpeg(canvas, .92);
    return { id, blob, width, height, turns: 0, quad: fullFrame(), filter: "color" };
  } finally {
    image.close();
  }
}

export function rotatePage(page) {
  const quad = page.quad.map(([x, y]) => [1 - y, x]);
  return { ...page, turns: (page.turns + 1) % 4, quad: [quad[3], quad[0], quad[1], quad[2]] };
}

export function validQuad(quad) {
  return quad.every(([x, y], index) => {
    const [nextX, nextY] = quad[(index + 1) % 4];
    const [lastX, lastY] = quad[(index + 2) % 4];
    const cross = (nextX - x) * (lastY - nextY) - (nextY - y) * (lastX - nextX);
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 && cross > .003;
  });
}

export async function orientedPage(page, maxEdge = 2800) {
  const [width, height] = fit(page.width, page.height, maxEdge);
  const sideways = page.turns % 2;
  const canvas = canvasAt(sideways ? height : width, sideways ? width : height);
  const ctx = canvas.getContext("2d", { alpha: false });
  const image = await createImageBitmap(page.blob);
  try {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(page.turns * Math.PI / 2);
    ctx.drawImage(image, -width / 2, -height / 2, width, height);
    ctx.resetTransform();
  } finally {
    image.close();
  }
  return canvas;
}

export async function detectEdges(page) {
  const canvas = await orientedPage(page, 220);
  const { width, height } = canvas;
  if (width < 20 || height < 20) return null;
  const { data } = canvas.getContext("2d").getImageData(0, 0, width, height);
  const light = (x, y) => {
    const offset = (y * width + x) * 4;
    return (data[offset] * 54 + data[offset + 1] * 183 + data[offset + 2] * 19) / 256;
  };
  const border = [];
  for (let x = 0; x < width; x += 3) border.push(light(x, 0), light(x, height - 1));
  for (let y = 0; y < height; y += 3) border.push(light(0, y), light(width - 1, y));
  border.sort((a, b) => a - b);
  const threshold = Math.max(145, border[Math.floor(border.length * .75)] + 36);
  if (threshold > 238) return null;
  const best = [-Infinity, -Infinity, -Infinity, -Infinity];
  const corners = fullFrame();
  let count = 0;
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      if (light(x, y) < threshold || light(x - 2, y) < threshold || light(x + 2, y) < threshold ||
          light(x, y - 2) < threshold || light(x, y + 2) < threshold) continue;
      count++;
      const scores = [-x - y, x - y, x + y, y - x];
      for (let corner = 0; corner < 4; corner++) {
        if (scores[corner] > best[corner]) {
          best[corner] = scores[corner];
          corners[corner] = [x / (width - 1), y / (height - 1)];
        }
      }
    }
  }
  return count > width * height * .16 && validQuad(corners) ? corners : null;
}

function projection([[x0, y0], [x1, y1], [x2, y2], [x3, y3]]) {
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

function deskew(source, quad, maxEdge) {
  const points = quad.map(([x, y]) => [x * (source.width - 1), y * (source.height - 1)]);
  const distance = (from, to) => Math.hypot(points[from][0] - points[to][0], points[from][1] - points[to][1]);
  const [width, height] = fit(Math.max(distance(0, 1), distance(3, 2)), Math.max(distance(0, 3), distance(1, 2)), maxEdge);
  const canvas = canvasAt(width, height);
  const ctx = canvas.getContext("2d", { alpha: false });
  const pixels = source.getContext("2d").getImageData(0, 0, source.width, source.height).data;
  const image = ctx.createImageData(width, height);
  const [a, b, c, d, e, f, g, h] = projection(points);
  for (let y = 0; y < height; y++) {
    const v = (y + .5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + .5) / width;
      const weight = 1 + g * u + h * v;
      const sx = Math.max(0, Math.min(source.width - 1, (a * u + b * v + c) / weight));
      const sy = Math.max(0, Math.min(source.height - 1, (d * u + e * v + f) / weight));
      const left = Math.floor(sx);
      const top = Math.floor(sy);
      const right = Math.min(left + 1, source.width - 1);
      const bottom = Math.min(top + 1, source.height - 1);
      const ix = sx - left;
      const iy = sy - top;
      const output = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const topValue = pixels[(top * source.width + left) * 4 + channel] * (1 - ix) +
          pixels[(top * source.width + right) * 4 + channel] * ix;
        const bottomValue = pixels[(bottom * source.width + left) * 4 + channel] * (1 - ix) +
          pixels[(bottom * source.width + right) * 4 + channel] * ix;
        image.data[output + channel] = topValue * (1 - iy) + bottomValue * iy;
      }
      image.data[output + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export async function renderScan(page, maxEdge) {
  const original = fullFrame();
  const cropped = page.width > 1 && page.height > 1 &&
    page.quad.some(([x, y], index) => x !== original[index][0] || y !== original[index][1]);
  const source = await orientedPage(page, cropped ? Math.min(2800, maxEdge * 2) : maxEdge);
  const result = cropped ? deskew(source, page.quad, maxEdge) : source;
  if (page.filter !== "color") {
    const ctx = result.getContext("2d");
    const image = ctx.getImageData(0, 0, result.width, result.height);
    for (let index = 0; index < image.data.length; index += 4) {
      const luma = (image.data[index] * 54 + image.data[index + 1] * 183 + image.data[index + 2] * 19) / 256;
      const level = page.filter === "text" ? (luma - 37) * 1.42 : luma;
      image.data[index] = image.data[index + 1] = image.data[index + 2] = level;
    }
    ctx.putImageData(image, 0, 0);
  }
  return result;
}

export async function makePdf(scan, onProgress) {
  const { maxEdge, quality } = profiles[scan.profile] ?? profiles.balanced;
  const pdf = await globalThis.PDFLib.PDFDocument.create();
  pdf.setTitle(scan.title);
  pdf.setCreator("Auralis Iris");
  for (const [index, source] of scan.pages.entries()) {
    onProgress(index + 1);
    const canvas = await renderScan(source, maxEdge);
    const optimized = await jpeg(canvas, quality);
    const image = await pdf.embedJpg(await optimized.arrayBuffer());
    const [width, height] = image.width > image.height ? [841.89, 595.28] : [595.28, 841.89];
    const page = pdf.addPage([width, height]);
    const scale = Math.min((width - 24) / image.width, (height - 24) / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    page.drawImage(image, { x: (width - drawWidth) / 2, y: (height - drawHeight) / 2, width: drawWidth, height: drawHeight });
  }
  return new Blob([await pdf.save()], { type: "application/pdf" });
}
