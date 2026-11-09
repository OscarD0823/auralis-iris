import assert from "node:assert/strict";
import { test } from "node:test";
import { makeImages } from "../app/images.js";
import { fullFrame, packMonochrome } from "../app/scan.js";
import { unzipSync } from "../app/vendor/fflate.js";

function page(sample) {
  const bytes = Uint8Array.of(255, 216, 255, sample, 255, 217);
  const blob = new Blob([bytes], { type: "image/jpeg" });
  return { blob, width: 800, height: 600, turns: 0, filter: "color", quad: fullFrame() };
}

test("one unedited page downloads as the original JPEG", async () => {
  const source = page(1);
  const progress = [];
  const image = await makeImages([source], (index) => progress.push(index));
  assert.equal(image.type, "image/jpeg");
  assert.equal(image, source.blob);
  assert.deepEqual(progress, [1]);
});

test("multiple pages form a standard ZIP of numbered JPEGs in document order", async () => {
  const pages = [page(2), page(1)];
  const progress = [];
  const archive = await makeImages(pages, (index) => progress.push(index));
  assert.equal(archive.type, "application/zip");
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual(Object.keys(files), ["pagina-01.jpg", "pagina-02.jpg"]);
  assert.deepEqual(files["pagina-01.jpg"], new Uint8Array(await pages[0].blob.arrayBuffer()));
  assert.deepEqual(files["pagina-02.jpg"], new Uint8Array(await pages[1].blob.arrayBuffer()));
  assert.deepEqual(progress, [1, 2]);
});

test("one-bit PDF images retain independent padding on each row", () => {
  const data = new Uint8ClampedArray(9 * 2 * 4);
  for (const index of [0, 7, 8, 10]) data[index * 4] = 255;
  const packed = packMonochrome({ data, width: 9, height: 2 });
  assert.deepEqual([...packed], [0b10000001, 0b10000000, 0b01000000, 0b00000000]);
});
