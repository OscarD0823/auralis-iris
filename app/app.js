import { MAX_PAGES, makePage, rotatePage, validQuad, fullFrame, detectEdges, orientedPage, renderScan, jpeg, makePdf, newId } from "./scan.js";
import { openLibrary, readScans, saveScan, deleteScan } from "./store.js";
import { setupPair } from "./pair.js";

const $ = (selector) => document.querySelector(selector);
const pageDialog = $("#page-dialog");
const cameraDialog = $("#camera-dialog");
const video = $("#camera-video");
const nameInput = $("#doc-name");
const pagesList = $("#pages");
const dateFormat = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short" });
const sizeFormat = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 1 });
const thumbURLs = new Map();

function emptyScan() {
  return { id: newId(), title: "Escaneo sin título", pages: [], pdf: null, profile: "balanced", updated: 0 };
}

let scans = [];
let current = emptyScan();
let editing;
let camera;
let cameraRequest = 0;
let previewURL;
let connected = false;
let guest = false;
let busy = false;
let queue = Promise.resolve();
let installPrompt;

const library = openLibrary();
const pairing = setupPair({ receive: receiveFile, onChange: connectionChanged });

function notice(message, error = false) {
  const status = $("#status");
  status.hidden = !message;
  status.textContent = message;
  status.classList.toggle("error", error);
}

function serialized(work) {
  const operation = queue.then(work);
  queue = operation.catch(() => {});
  return operation;
}

function foreground(work) {
  return async () => {
    if (busy) return;
    busy = true;
    setControls();
    try {
      await work();
    } catch (error) {
      notice(error.name === "QuotaExceededError" ? "El navegador se quedó sin espacio. Descarga tus PDF y libera espacio en la biblioteca." : error.message || "Ocurrió un error.", true);
    } finally {
      busy = false;
      setControls();
    }
  };
}

function pageText(count) {
  return count + (count === 1 ? " página" : " páginas");
}

function sizeText(bytes) {
  return bytes < 1048576 ? sizeFormat.format(bytes / 1024) + " KB" : sizeFormat.format(bytes / 1048576) + " MB";
}

function displayTitle(title) {
  return title.trim().slice(0, 120) || "Escaneo sin título";
}

function fileName(title) {
  return (displayTitle(title).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/g, "") || "Escaneo") + ".pdf";
}

function create(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value) element.textContent = value;
  return element;
}

function control(label, symbol, action) {
  const button = create("button", "icon-button", symbol);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", action);
  return button;
}

function selectScan(scan) {
  const changed = current.id !== scan.id;
  current = scan;
  try {
    localStorage.setItem("iris-active", scan.id);
  } catch {
    // The library still works if the browser blocks this preference.
  }
  render(changed);
}

async function reloadLibrary() {
  scans = (await readScans(await library)).sort((a, b) => b.updated - a.updated);
}

async function libraryWrite(work) {
  try {
    await work();
  } catch (error) {
    if (error.name === "LibraryConflict") {
      await reloadLibrary();
      selectScan(scans.find((scan) => scan.id === current.id) ?? scans[0] ?? emptyScan());
    }
    throw error;
  }
}

async function commit(scan, select = true) {
  const stored = { ...scan, updated: Date.now(), revision: newId() };
  await libraryWrite(async () => saveScan(await library, stored, scan.revision));
  scans = [stored, ...scans.filter((item) => item.id !== stored.id)];
  if (select) selectScan(stored);
  else renderLibrary();
  return stored;
}

function renderLibrary() {
  const list = $("#library");
  list.replaceChildren();
  $("#library-empty").hidden = scans.length > 0;
  for (const scan of scans) {
    const item = create("li");
    const entry = create("button", "library-entry");
    entry.type = "button";
    entry.disabled = busy;
    if (scan.id === current.id) entry.setAttribute("aria-current", "true");
    const info = scan.pages.length ? pageText(scan.pages.length) : (scan.pdf ? "PDF recibido" : "Sin páginas");
    entry.append(create("strong", "", scan.title), create("span", "", info + " · " + dateFormat.format(scan.updated)));
    entry.addEventListener("click", foreground(() => serialized(() => selectScan(scans.find((item) => item.id === scan.id) ?? scan))));
    item.append(entry);
    list.append(item);
  }
}

function renderPages() {
  const liveIDs = new Set(current.pages.map((page) => page.id));
  for (const [id, saved] of thumbURLs) {
    if (!liveIDs.has(id)) {
      URL.revokeObjectURL(saved.url);
      thumbURLs.delete(id);
    }
  }
  pagesList.replaceChildren();
  current.pages.forEach((page, index) => {
    const item = create("li", "page-card");
    const adjust = create("button", "page-thumb");
    adjust.type = "button";
    adjust.setAttribute("aria-label", "Ajustar página " + (index + 1));
    const image = create("img");
    image.alt = "";
    image.loading = "lazy";
    const blob = page.thumb ?? page.blob;
    let saved = thumbURLs.get(page.id);
    if (saved?.blob !== blob) {
      if (saved) URL.revokeObjectURL(saved.url);
      saved = { blob, url: URL.createObjectURL(blob) };
      thumbURLs.set(page.id, saved);
    }
    image.src = saved.url;
    adjust.append(image, create("span", "", "Página " + (index + 1)));
    adjust.addEventListener("click", () => openPage(page.id).catch((error) => notice(error.message, true)));
    const actions = create("div", "page-actions");
    const before = control("Mover página " + (index + 1) + " hacia el inicio", "↑", changePage(page.id, -1));
    const after = control("Mover página " + (index + 1) + " hacia el final", "↓", changePage(page.id, 1));
    before.dataset.boundary = String(index === 0);
    after.dataset.boundary = String(index === current.pages.length - 1);
    actions.append(before, after, control("Quitar página " + (index + 1), "×", changePage(page.id, 0)));
    item.append(adjust, actions);
    pagesList.append(item);
  });
}

function setControls() {
  const pdfOnly = Boolean(current.pdf && !current.pages.length);
  const count = current.pages.length;
  $("#take-photo").disabled = busy || count >= MAX_PAGES;
  $("#import").disabled = busy || count >= MAX_PAGES;
  $("#generate").disabled = busy || count === 0;
  $("#new-doc").disabled = busy;
  $("#delete-doc").disabled = busy;
  $("#download").disabled = busy;
  $("#share").disabled = busy;
  $("#send-pdf").disabled = busy;
  $("#send-pdf").hidden = !connected;
  $("#send-page").disabled = busy;
  $("#send-page").hidden = !connected;
  nameInput.disabled = busy;
  $("#profile").disabled = busy || pdfOnly;
  document.querySelectorAll(".library-entry, .pages button").forEach((button) => {
    button.disabled = busy || button.dataset.boundary === "true";
  });
}

function render(updateTitle = false) {
  const pdfOnly = Boolean(current.pdf && !current.pages.length);
  if (updateTitle || document.activeElement !== nameInput) nameInput.value = current.updated ? current.title : "";
  $("#page-count").textContent = pdfOnly ? "PDF recibido" : pageText(current.pages.length);
  $("#profile").value = current.profile;
  $("#capture-actions").hidden = pdfOnly;
  $("#pdf-controls").hidden = pdfOnly;
  $("#empty-pages").hidden = pdfOnly || current.pages.length > 0;
  $("#pdf-result").hidden = !current.pdf;
  if (current.pdf) $("#pdf-size").textContent = sizeText(current.pdf.size);
  $("#delete-doc").hidden = !current.updated;
  renderLibrary();
  renderPages();
  setControls();
}

function changePage(id, offset) {
  return foreground(() => serialized(async () => {
    const pages = [...current.pages];
    const index = pages.findIndex((page) => page.id === id);
    if (index < 0 || index + offset < 0 || index + offset >= pages.length) return;
    if (offset === 0 && !confirm("¿Quitar esta página del documento?")) return;
    const [page] = pages.splice(index, 1);
    if (offset !== 0) pages.splice(index + offset, 0, page);
    await commit({ ...current, pages, pdf: null });
  }));
}

function writableScan() {
  return current.pdf && !current.pages.length ? emptyScan() : current;
}

async function addFiles(files) {
  const added = [];
  let warning = "";
  for (const file of files) {
    try {
      const page = await makePage(file);
      const saved = await serialized(async () => {
        const scan = writableScan();
        if (scan.pages.length >= MAX_PAGES) return false;
        await commit({ ...scan, pages: [...scan.pages, page], pdf: null });
        return true;
      });
      if (!saved) {
        warning = "Este documento admite hasta 60 páginas. Crea otro para seguir escaneando.";
        break;
      }
      added.push(page);
    } catch (error) {
      warning = error.name === "QuotaExceededError" ? "El navegador se quedó sin espacio." : error.message;
    }
  }
  if (added.length) navigator.storage?.persist?.().catch(() => {});
  if (guest && connected && added.length) {
    for (const [index, page] of added.entries()) {
      notice("Enviando " + (index + 1) + " de " + added.length + "…");
      try {
        await pairing.send(page.blob, current.title, page.id);
      } catch (error) {
        notice("Las páginas están en la biblioteca de este dispositivo. " + error.message, true);
        return;
      }
    }
    const sent = added.length === 1 ? "Página guardada y enviada." : pageText(added.length) + " guardadas y enviadas.";
    notice(sent + (warning ? " " + warning : ""), Boolean(warning));
  } else {
    const saved = added.length === 1 ? "Página guardada." : pageText(added.length) + " guardadas.";
    notice([added.length ? saved : "", warning].filter(Boolean).join(" "), Boolean(warning));
  }
}

async function receiveFile(blob, title, id) {
  return serialized(async () => {
    if (scans.some((scan) => scan.id === id || scan.pages.some((page) => page.id === id))) return;
    if (blob.type === "application/pdf") {
      const scan = { ...emptyScan(), id, title: displayTitle(title), pdf: blob };
      await commit(scan, false);
      notice("PDF recibido. Ábrelo desde la biblioteca.");
      return;
    }
    const page = await makePage(blob, id);
    let scan = writableScan();
    if (scan.pages.length >= MAX_PAGES) scan = { ...emptyScan(), title: displayTitle(title) };
    if (!scan.updated) scan = { ...scan, title: displayTitle(title) };
    await commit({ ...scan, pages: [...scan.pages, page], pdf: null });
    notice("Página recibida y guardada.");
  });
}

function connectionChanged(online, isGuest) {
  connected = online;
  guest = isGuest;
  $("#pair span").textContent = online ? "Dispositivo vinculado" : "Conectar celular";
  $("#take-photo span").textContent = online && isGuest ? "Tomar foto y enviar" : "Tomar foto";
  const banner = $("#connection-banner");
  banner.hidden = !online;
  banner.textContent = isGuest
    ? "Cámara vinculada. Cada foto se guarda aquí y se envía al otro dispositivo."
    : "Dispositivo vinculado. Las páginas recibidas se guardan en el documento abierto.";
  setControls();
}

function drawCorners() {
  $("#crop-outline").setAttribute("points", editing.page.quad.map(([x, y]) => (100 * x) + "," + (100 * y)).join(" "));
  pageDialog.querySelectorAll(".corner").forEach((corner, index) => {
    const [x, y] = editing.page.quad[index];
    corner.style.left = (100 * x) + "%";
    corner.style.top = (100 * y) + "%";
  });
}

async function drawPreview() {
  const requested = editing.page;
  const blob = await jpeg(await orientedPage(requested, 900), .9);
  if (editing?.page.turns !== requested.turns || editing.page.id !== requested.id) return;
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = URL.createObjectURL(blob);
  $("#crop-preview").src = previewURL;
  drawCorners();
}

async function openPage(id) {
  if (busy || pageDialog.open) return;
  const page = current.pages.find((item) => item.id === id);
  if (!page) return;
  editing = { scanId: current.id, page };
  $("#filter").value = page.filter;
  $("#crop-hint").hidden = true;
  pageDialog.showModal();
  await drawPreview();
}

function moveCorner(index, x, y) {
  const quad = [...editing.page.quad];
  quad[index] = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  if (validQuad(quad)) {
    editing.page = { ...editing.page, quad };
    drawCorners();
  }
}

pageDialog.querySelectorAll(".corner").forEach((corner, index) => {
  corner.addEventListener("pointerdown", (event) => corner.setPointerCapture(event.pointerId));
  corner.addEventListener("pointermove", (event) => {
    if (!corner.hasPointerCapture(event.pointerId)) return;
    const bounds = $("#crop-surface").getBoundingClientRect();
    moveCorner(index, (event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
  });
  corner.addEventListener("keydown", (event) => {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const [x, y] = editing.page.quad[index];
    const step = event.shiftKey ? .05 : .01;
    moveCorner(index, x + direction[0] * step, y + direction[1] * step);
  });
});

$("#rotate").addEventListener("click", () => {
  editing.page = rotatePage(editing.page);
  drawPreview().catch((error) => notice(error.message, true));
});
$("#reset-crop").addEventListener("click", () => {
  editing.page = { ...editing.page, quad: fullFrame() };
  $("#crop-hint").hidden = true;
  drawCorners();
});
$("#auto-crop").addEventListener("click", async () => {
  const requested = editing.page;
  const message = $("#crop-hint");
  try {
    const quad = await detectEdges(requested);
    if (editing?.page !== requested) return;
    if (quad) {
      editing.page = { ...requested, quad };
      drawCorners();
    }
    message.textContent = quad ? "Revisa las esquinas sugeridas antes de guardar." : "No se distinguieron los bordes. Puedes ajustarlos a mano.";
  } catch {
    message.textContent = "No se pudo analizar la imagen. Puedes ajustar las esquinas a mano.";
  }
  message.hidden = false;
});

$("#apply-page").addEventListener("click", foreground(async () => {
  const { scanId, page } = editing;
  const adjusted = { ...page, filter: $("#filter").value };
  pageDialog.close();
  adjusted.thumb = await jpeg(await renderScan(adjusted, 360), .78);
  await serialized(async () => {
    const scan = scans.find((item) => item.id === scanId);
    if (!scan) return;
    await commit({ ...scan, pdf: null, pages: scan.pages.map((item) => item.id === adjusted.id ? adjusted : item) }, current.id === scanId);
  });
  notice("Ajustes de la página guardados.");
}));

$("#send-page").addEventListener("click", foreground(async () => {
  const page = { ...editing.page, filter: $("#filter").value };
  const title = current.title;
  pageDialog.close();
  const blob = await jpeg(await renderScan(page, 2480), .88);
  await pairing.send(blob, title);
  notice("Página enviada y guardada en el otro dispositivo.");
}));

pageDialog.addEventListener("close", () => {
  editing = undefined;
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = undefined;
  $("#crop-preview").removeAttribute("src");
});

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia || matchMedia("(pointer: coarse)").matches || guest) {
    $("#camera-file").click();
    return;
  }
  const request = ++cameraRequest;
  cameraDialog.showModal();
  $("#capture").disabled = true;
  $("#camera-hint").textContent = "Esperando acceso a la cámara…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    if (!cameraDialog.open || request !== cameraRequest) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    camera = stream;
    video.srcObject = stream;
    await video.play();
    $("#capture").disabled = false;
    $("#camera-hint").textContent = "Centra el documento en el encuadre.";
  } catch {
    $("#camera-hint").textContent = "No se pudo abrir la cámara. Revisa el permiso o cierra esta ventana e importa una foto.";
  }
}

$("#capture").addEventListener("click", foreground(async () => {
  if (!video.videoWidth) return;
  const canvas = create("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  cameraDialog.close();
  await addFiles([await jpeg(canvas, .94)]);
}));
cameraDialog.addEventListener("close", () => {
  cameraRequest++;
  camera?.getTracks().forEach((track) => track.stop());
  camera = undefined;
  video.srcObject = null;
});

$("#take-photo").addEventListener("click", openCamera);
$("#import").addEventListener("click", () => $("#image-files").click());
for (const id of ["#camera-file", "#image-files"]) {
  const input = $(id);
  input.addEventListener("change", foreground(async () => {
    const files = Array.from(input.files);
    input.value = "";
    await addFiles(files);
  }));
}

$("#new-doc").addEventListener("click", foreground(() => serialized(() => {
  selectScan(emptyScan());
  notice("");
})));

$("#delete-doc").addEventListener("click", foreground(() => serialized(async () => {
  if (!current.updated || !confirm("¿Eliminar este documento de la biblioteca de este dispositivo?")) return;
  await libraryWrite(async () => deleteScan(await library, current));
  scans = scans.filter((item) => item.id !== current.id);
  selectScan(scans[0] ?? emptyScan());
  notice("Documento eliminado.");
})));

nameInput.addEventListener("change", () => {
  const title = displayTitle(nameInput.value);
  serialized(async () => {
    if (current.title !== title) await commit({ ...current, title });
  }).catch((error) => notice(error.message, true));
});

$("#profile").addEventListener("change", (event) => {
  const profile = event.target.value;
  serialized(async () => {
    if (current.profile !== profile) await commit({ ...current, profile, pdf: null });
  }).catch((error) => notice(error.message, true));
});

$("#generate").addEventListener("click", foreground(() => serialized(async () => {
  const pdf = await makePdf(current, (page) => notice("Optimizando página " + page + " de " + current.pages.length + "…"));
  await commit({ ...current, pdf });
  notice("PDF optimizado y guardado · " + sizeText(pdf.size));
})));

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = create("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

$("#download").addEventListener("click", () => download(current.pdf, fileName(current.title)));
$("#share").addEventListener("click", async () => {
  const file = new File([current.pdf], fileName(current.title), { type: "application/pdf" });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    download(file, file.name);
    notice("PDF descargado. Puedes enviarlo desde el menú Compartir o el asistente Bluetooth del sistema.");
  } catch (error) {
    if (error.name !== "AbortError") notice("El sistema no pudo compartir el PDF. Descárgalo para enviarlo.", true);
  }
});

$("#send-pdf").addEventListener("click", foreground(async () => {
  await pairing.send(current.pdf, current.title);
  notice("PDF enviado y guardado en el otro dispositivo.");
}));

document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
});

$("#install").addEventListener("click", async () => {
  if (installPrompt) {
    const prompt = installPrompt;
    installPrompt = undefined;
    await prompt.prompt();
  } else $("#install-dialog").showModal();
});
if (matchMedia("(display-mode: standalone)").matches || navigator.standalone) $("#install").hidden = true;
if (isSecureContext && "serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

serialized(async () => {
  await reloadLibrary();
  let saved;
  try {
    saved = localStorage.getItem("iris-active");
  } catch {
    // Fall back to the most recent scan.
  }
  selectScan(scans.find((scan) => scan.id === saved) ?? scans[0] ?? current);
}).catch(() => notice("El navegador bloqueó la biblioteca local. Habilita el almacenamiento para poder escanear.", true));
