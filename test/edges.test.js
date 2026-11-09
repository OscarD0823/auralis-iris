import assert from "node:assert/strict";
import { test } from "node:test";
import { findDocumentQuad } from "../app/edges.js";

function photo(sheets, background, { light = () => 0, noise = 3, width = 360, height = 480 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 27;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x / (width - 1);
      const py = y / (height - 1);
      const sheet = sheets.find(({ corners }) => corners.every(([a, b], i) => {
        const [c, d] = corners[(i + 1) % 4];
        return (c - a) * (py - b) - (d - b) * (px - a) >= 0;
      }));
      const color = sheet?.color ?? background;
      const ink = sheet && px > .28 && px < .68 && py > .28 && py < .68 &&
        y % 13 < 3 && x % 17 < 12 ? 75 : 0;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const shade = light(px, py) + noise * ((seed >>> 24) / 127.5 - 1) - ink;
      const offset = 4 * (y * width + x);
      for (let channel = 0; channel < 3; channel++) data[offset + channel] = color[channel] + shade;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}

function expectCorners(image, corners) {
  const result = findDocumentQuad(image);
  assert(result, "expected a four-sided page");
  for (const [index, [x, y]] of result.entries()) {
    const [expectedX, expectedY] = corners[index];
    assert(Math.hypot(x - expectedX, y - expectedY) < .017, JSON.stringify({ result, corners }));
  }
}

test("finds all four sides of a tilted page before correcting perspective", () => {
  const corners = [[.21, .16], [.81, .11], [.87, .84], [.14, .91]];
  expectCorners(photo([{ corners, color: [240, 241, 238] }], [67, 83, 94]), corners);
});

test("finds white paper on a light table under a soft shadow", () => {
  const corners = [[.17, .16], [.84, .19], [.78, .85], [.2, .89]];
  const light = (x, y) => -43 * Math.max(0, Math.min(1, (x + .4 * y - .44) * 3.5));
  expectCorners(photo([{ corners, color: [248, 246, 240] }], [229, 230, 226], { light }), corners);
});

test("uses color contrast for a background of similar brightness", () => {
  const corners = [[.11, .32], [.79, .15], [.9, .72], [.24, .86]];
  expectCorners(photo([{ corners, color: [225, 225, 225] }], [245, 215, 240]), corners);
});

test("keeps the whole photo when a page is cut off or its borders disappear", () => {
  const partial = [[-.14, .18], [.84, .14], [.88, .86], [-.09, .94]];
  assert.equal(findDocumentQuad(photo([{ corners: partial, color: [245, 245, 242] }], [50, 66, 70])), null);
  assert.equal(findDocumentQuad(photo([], [233, 233, 233], { noise: 3 })), null);
});

test("does not crop a dark illustration inside an already trimmed page", () => {
  const image = [[.17, .24], [.82, .24], [.82, .76], [.17, .76]];
  assert.equal(findDocumentQuad(photo([{ corners: image, color: [56, 66, 78] }], [240, 242, 238])), null);
});

test("keeps the whole photo when two similar sheets are visible", () => {
  const left = [[.07, .15], [.44, .15], [.44, .85], [.07, .85]];
  const right = [[.56, .15], [.93, .15], [.93, .85], [.56, .85]];
  const sheets = [left, right].map((corners) => ({ corners, color: [243, 243, 240] }));
  assert.equal(findDocumentQuad(photo(sheets, [70, 74, 78], { width: 480, height: 340 })), null);
});
