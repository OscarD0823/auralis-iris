export const MAX_PAGES = 60;
export const MAX_FILE = 40 * 1024 * 1024;
export const SOURCE_EDGE = 2800;
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
  if (typeof document === "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function fit(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export async function jpeg(canvas, quality) {
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: "image/jpeg", quality })
    : await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (blob?.type !== "image/jpeg") throw new Error("No se pudo preparar la imagen.");
  return blob;
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
    const [width, height] = fit(image.width, image.height, SOURCE_EDGE);
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

export async function orientedPage(page, maxEdge = SOURCE_EDGE) {
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

function pixelCorners(quad, width, height) {
  return quad.map(([x, y]) => [x * (width - 1), y * (height - 1)]);
}

function cropResolution(page, maxEdge) {
  const [width, height] = page.turns % 2 ? [page.height, page.width] : [page.width, page.height];
  const corners = pixelCorners(page.quad, width, height);
  const [top, right, bottom, left] = corners.map(([x, y], index) => {
    const [nextX, nextY] = corners[(index + 1) % 4];
    return Math.hypot(nextX - x, nextY - y);
  });
  const [outWidth, outHeight] = fit(Math.max(top, bottom), Math.max(left, right), maxEdge);
  // Read enough pixels for the edge that stretches most during correction.
  const scale = Math.min(1, 1.12 * Math.max(outWidth / Math.min(top, bottom), outHeight / Math.min(left, right)));
  return { edge: Math.ceil(Math.max(width, height) * scale), outWidth, outHeight };
}

function deskew(source, quad, width, height) {
  const { width: sourceWidth, height: sourceHeight } = source;
  const points = pixelCorners(quad, sourceWidth, sourceHeight);
  const canvas = canvasAt(width, height);
  const ctx = canvas.getContext("2d", { alpha: false });
  const pixels = source.getContext("2d").getImageData(0, 0, sourceWidth, sourceHeight).data;
  const image = ctx.createImageData(width, height);
  const output = image.data;
  const [a, b, c, d, e, f, g, h] = projection(points);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    const v = (y + .5) / height;
    const rowX = b * v + c;
    const rowY = e * v + f;
    const rowWeight = 1 + h * v;
    for (let x = 0; x < width; x++) {
      const u = (x + .5) / width;
      const inverseWeight = 1 / (rowWeight + g * u);
      const sx = Math.max(0, Math.min(sourceWidth - 1, (a * u + rowX) * inverseWeight));
      const sy = Math.max(0, Math.min(sourceHeight - 1, (d * u + rowY) * inverseWeight));
      const left = Math.floor(sx);
      const top = Math.floor(sy);
      const rightStep = left < sourceWidth - 1 ? 4 : 0;
      const first = (top * sourceWidth + left) * 4;
      const second = top < sourceHeight - 1 ? first + sourceWidth * 4 : first;
      const ix = sx - left;
      const iy = sy - top;
      for (let channel = 0; channel < 3; channel++) {
        const tl = pixels[first + channel];
        const bl = pixels[second + channel];
        const topValue = tl + (pixels[first + rightStep + channel] - tl) * ix;
        const bottomValue = bl + (pixels[second + rightStep + channel] - bl) * ix;
        output[offset++] = topValue + (bottomValue - topValue) * iy;
      }
      output[offset++] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function luma(data, offset) {
  return (data[offset] * 54 + data[offset + 1] * 183 + data[offset + 2] * 19) / 256;
}

function monochrome({ data, width, height }) {
  const shades = new Uint8Array(width * height);
  for (let pixel = 0; pixel < shades.length; pixel++) shades[pixel] = luma(data, pixel * 4);
  const radius = Math.max(3, Math.round(Math.min(width, height) / 36));
  const columns = new Uint32Array(width);
  function addRow(row, factor) {
    const offset = row * width;
    for (let x = 0; x < width; x++) columns[x] += shades[offset + x] * factor;
  }
  let top = 0;
  let bottom = Math.min(radius, height - 1);
  for (let row = top; row <= bottom; row++) addRow(row, 1);
  for (let y = 0; y < height; y++) {
    let left = 0;
    let right = Math.min(radius, width - 1);
    let sum = 0;
    for (let x = left; x <= right; x++) sum += columns[x];
    const rows = bottom - top + 1;
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const threshold = Math.max(48, .86 * sum / (rows * (right - left + 1)));
      const value = shades[pixel] < threshold ? 0 : 255;
      const offset = pixel * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = value;
      if (x >= radius) sum -= columns[left++];
      if (right < width - 1) sum += columns[++right];
    }
    if (y >= radius) addRow(top++, -1);
    if (bottom < height - 1) addRow(++bottom, 1);
  }
}

export function packMonochrome({ data, width, height }) {
  const stride = Math.ceil(width / 8);
  const packed = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4] > 0) packed[y * stride + (x >> 3)] |= 128 >> (x & 7);
    }
  }
  return packed;
}

export async function renderScan(page, maxEdge) {
  const original = fullFrame();
  const cropped = page.width > 1 && page.height > 1 &&
    page.quad.some(([x, y], index) => x !== original[index][0] || y !== original[index][1]);
  const resolution = cropped ? cropResolution(page, maxEdge) : null;
  const source = await orientedPage(page, resolution?.edge ?? maxEdge);
  let result = source;
  if (resolution) {
    try {
      result = deskew(source, page.quad, resolution.outWidth, resolution.outHeight);
    } finally {
      source.width = source.height = 1;
    }
  }
  if (page.filter !== "color") {
    const ctx = result.getContext("2d");
    const image = ctx.getImageData(0, 0, result.width, result.height);
    if (page.filter === "bw") monochrome(image);
    else {
      for (let index = 0; index < image.data.length; index += 4) {
        const light = luma(image.data, index);
        const level = page.filter === "text" ? (light - 37) * 1.42 : light;
        image.data[index] = image.data[index + 1] = image.data[index + 2] = level;
      }
    }
    ctx.putImageData(image, 0, 0);
  }
  return result;
}
