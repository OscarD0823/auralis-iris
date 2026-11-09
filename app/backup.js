import { MAX_FILE, MAX_PAGES, SOURCE_EDGE, newId, profiles, validQuad } from "./scan.js";

const signature = "AURALIS-IRIS/1\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const prefix = encoder.encode(signature);
const headerLimit = 128 * 1024;
const backupLimit = 1024 ** 3;
const finishes = new Set(["color", "gray", "text", "bw"]);

export function makeBackup(scan) {
  const pages = scan.pages.map(({ width, height, turns, quad, filter, blob, thumb }) =>
    ({ width, height, turns, quad, filter, size: blob.size, thumbSize: thumb?.size ?? 0 }));
  const metadata = encoder.encode(JSON.stringify({
    title: scan.title,
    profile: scan.profile,
    pdfSize: scan.pdf?.size ?? 0,
    pdfStale: Boolean(scan.pdfStale),
    pages
  }));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, metadata.byteLength);
  const parts = [prefix, size, metadata];
  for (const page of scan.pages) {
    parts.push(page.blob);
    if (page.thumb) parts.push(page.thumb);
  }
  if (scan.pdf) parts.push(scan.pdf);
  const backup = new Blob(parts, { type: "application/x-auralis-iris" });
  if (backup.size > backupLimit) throw new Error("Este documento supera el límite de 1 GB por respaldo.");
  return backup;
}

function validPage(page) {
  const { width, height, turns, quad, filter } = page;
  return [width, height].every((value) => Number.isInteger(value) && value >= 1 && value <= SOURCE_EDGE) &&
    Number.isInteger(turns) && turns >= 0 && turns <= 3 && finishes.has(filter) &&
    Array.isArray(quad) && quad.length === 4 &&
    quad.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) &&
    validQuad(quad);
}

export async function readBackup(file) {
  const invalid = new Error("El respaldo de Iris está dañado o usa un formato incompatible.");
  const metadataStart = prefix.length + 4;
  if (file.size < metadataStart || file.size > backupLimit) throw invalid;
  const header = await file.slice(0, metadataStart).arrayBuffer();
  const bytes = new Uint8Array(header);
  if (!prefix.every((byte, index) => byte === bytes[index])) throw invalid;
  const metadataSize = new DataView(header).getUint32(prefix.length);
  let offset = metadataStart + metadataSize;
  if (!metadataSize || metadataSize > headerLimit || offset > file.size) throw invalid;
  let data;
  try {
    data = JSON.parse(decoder.decode(await file.slice(metadataStart, offset).arrayBuffer()));
  } catch {
    throw invalid;
  }
  if (!data || typeof data.title !== "string" || !data.title.trim() || data.title.length > 120 ||
      !Object.hasOwn(profiles, data.profile) || typeof data.pdfStale !== "boolean" ||
      !Array.isArray(data.pages) || data.pages.length > MAX_PAGES ||
      !Number.isInteger(data.pdfSize) || data.pdfSize < 0 || (data.pdfStale && !data.pdfSize)) throw invalid;

  async function readPart(size, limit, type, magic) {
    if (!Number.isInteger(size) || size < magic.length || size > limit || offset + size > file.size) throw invalid;
    const part = file.slice(offset, offset + size, type);
    const bytes = new Uint8Array(await part.slice(0, magic.length).arrayBuffer());
    if (!magic.every((byte, index) => byte === bytes[index])) throw invalid;
    offset += size;
    return part;
  }

  const jpgMagic = [255, 216, 255];
  const pages = [];
  for (const page of data.pages) {
    if (!page || !validPage(page)) throw invalid;
    const { size, thumbSize, width, height, turns, quad, filter } = page;
    const blob = await readPart(size, MAX_FILE, "image/jpeg", jpgMagic);
    const thumb = thumbSize === 0 ? undefined : await readPart(thumbSize, MAX_FILE, "image/jpeg", jpgMagic);
    pages.push({ id: newId(), width, height, turns, quad, filter, blob, thumb });
  }
  const pdf = data.pdfSize ? await readPart(data.pdfSize, backupLimit, "application/pdf", encoder.encode("%PDF-")) : null;
  if (offset !== file.size || (!pages.length && !pdf)) throw invalid;
  return { id: newId(), title: data.title, profile: data.profile, pdfStale: data.pdfStale, pages, pdf };
}
