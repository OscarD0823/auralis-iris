import assert from "node:assert/strict";
import { test } from "node:test";
import { makeBackup, readBackup } from "../app/backup.js";
import { fullFrame, packMonochrome } from "../app/scan.js";

const photo = new Blob([Uint8Array.of(255, 216, 255, 1, 2, 3, 255, 217)], { type: "image/jpeg" });
const thumbnail = new Blob([Uint8Array.of(255, 216, 255, 4, 5, 255, 217)], { type: "image/jpeg" });
const pdf = new Blob(["%PDF-1.7\n"], { type: "application/pdf" });

function scan(changes = {}) {
  return {
    id: "original",
    title: "Recibo · Día 1",
    profile: "sharp",
    pdf,
    pages: [
      { id: "first", blob: photo, thumb: thumbnail, width: 1900, height: 2500, turns: 1, quad: fullFrame(), filter: "text" },
      { id: "second", blob: photo, width: 1000, height: 800, turns: 0, quad: fullFrame(), filter: "bw" }
    ],
    ...changes
  };
}

test("a backup restores editable pages and the previous PDF as a separate document", async () => {
  const original = scan({ pdfStale: true });
  const restored = await readBackup(makeBackup(original));
  assert.notEqual(restored.id, original.id);
  assert.equal(restored.title, original.title);
  assert.equal(restored.profile, original.profile);
  assert.equal(restored.pdfStale, true);
  assert.equal(await restored.pdf.text(), await original.pdf.text());
  assert.deepEqual(restored.pages.map((page) => page.filter), ["text", "bw"]);
  assert.equal(restored.pages[0].turns, 1);
  assert.deepEqual(restored.pages[0].quad, fullFrame());
  assert.deepEqual(await restored.pages[0].blob.bytes(), await photo.bytes());
  assert.deepEqual(await restored.pages[0].thumb.bytes(), await thumbnail.bytes());
  assert.equal(restored.pages[1].thumb, undefined);
  assert.notEqual(restored.pages[0].id, original.pages[0].id);
});

test("a PDF received by the first beta can be backed up without source pages", async () => {
  const restored = await readBackup(makeBackup(scan({ pages: [] })));
  assert.equal(restored.pdfStale, false);
  assert.equal(restored.pages.length, 0);
  assert.equal(await restored.pdf.text(), await pdf.text());
});

test("invalid or truncated backups are rejected before saving anything", async () => {
  const valid = makeBackup(scan());
  await assert.rejects(readBackup(valid.slice(0, -1)), /dañado/);
  await assert.rejects(readBackup(new Blob([valid, "extra"])), /dañado/);
  await assert.rejects(readBackup(makeBackup(scan({ profile: "__proto__" }))), /dañado/);
  const [first] = scan().pages;
  const malformed = makeBackup(scan({ pages: [{ ...first, quad: [null, null, null, null] }] }));
  await assert.rejects(readBackup(malformed), /dañado/);
});

test("one-bit rows use independent byte padding and white bits start at the high end", () => {
  const data = new Uint8ClampedArray(9 * 2 * 4);
  for (const index of [0, 7, 8, 10]) data[index * 4] = 255;
  const packed = packMonochrome({ data, width: 9, height: 2 });
  assert.deepEqual([...packed], [0b10000001, 0b10000000, 0b01000000, 0b00000000]);
});
