import { MAX_FILE, newId, validQuad } from "./scan.js";
import { android, stageAndroidFile } from "./android.js";

const $ = (selector) => document.querySelector(selector);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const types = new Set(["image/jpeg", "application/pdf"]);
const idPattern = /^[a-f0-9]{32}$/;
const linkPattern = /^[a-f0-9]{48}$/;
const vendorScripts = new Map();
const webHome = "https://oscard0823.github.io/auralis-iris/";

async function loadVendor(file) {
  if (!vendorScripts.has(file)) {
    const loaded = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("./vendor/" + file, import.meta.url);
      script.onload = resolve;
      script.onerror = () => {
        script.remove();
        reject(new Error("No se pudo cargar el lector de códigos de Iris."));
      };
      document.head.append(script);
    });
    vendorScripts.set(file, loaded);
  }
  try {
    await vendorScripts.get(file);
  } catch (error) {
    vendorScripts.delete(file);
    throw error;
  }
}

function makePacket(blob, name, id = newId(), quad) {
  if (!types.has(blob.type) || !blob.size || blob.size > MAX_FILE || !idPattern.test(id)) {
    throw new Error("Solo puedes enviar fotos y PDF de hasta 40 MB.");
  }
  const packet = { id, name: name.slice(0, 120).toWellFormed(), type: blob.type, size: blob.size };
  if (blob.type === "image/jpeg" && validQuad(quad)) packet.quad = quad;
  return packet;
}

function readQuad(header) {
  if (!header || header.length > 256) return undefined;
  try {
    return JSON.parse(header);
  } catch {
    return undefined;
  }
}

async function validFile(blob) {
  const prefix = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  if (blob.type === "image/jpeg") return prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255;
  return new TextDecoder().decode(prefix) === "%PDF-";
}

async function api(path, options = {}, address) {
  const { key, ...init } = options;
  const headers = new Headers(init.headers);
  if (key) headers.set("Authorization", "Bearer " + key);
  let upload;
  try {
    const route = address ? "./__iris_lan/" + encodeURIComponent(address) + "/" : "./api/";
    if (address) {
      headers.set("X-Iris-Method", init.method || "GET");
      if (init.body) {
        upload = await stageAndroidFile(init.body, init.body.type === "image/jpeg" ? "Envio.jpg" : "Envio.pdf");
        headers.set("X-Iris-Upload", upload);
      }
    }
    const response = await fetch(route + path, { ...(address ? {} : init), headers, cache: "no-store", signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      const error = new Error((await response.text()).trim() || "No se pudo comunicar con el otro dispositivo.");
      error.code = response.status;
      throw error;
    }
    return response;
  } finally {
    if (upload) android.discardFile(upload);
  }
}

async function localEdition() {
  if (!["127.0.0.1", "localhost"].includes(location.hostname)) return false;
  try {
    const response = await fetch("./api/info", { cache: "no-store", signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).app === "auralis-iris";
  } catch {
    return false;
  }
}

function lanLink(key, isGuest, receive, state, address) {
  let closed = false;
  let online = false;
  let timer;

  async function poll() {
    if (closed) return;
    try {
      const response = await api("inbox", { key }, address);
      if (closed) return;
      const connected = response.headers.get("X-Iris-Online") === "true";
      if (connected !== online) {
        online = connected;
        state(online);
      }
      if (response.status === 200) {
        const id = response.headers.get("X-Iris-ID");
        const blob = await response.blob();
        if (await validFile(blob)) {
          const name = decodeURIComponent(response.headers.get("X-Iris-Name") || "Archivo");
          await receive(blob, name, id, readQuad(response.headers.get("X-Iris-Quad")));
        }
        await api("inbox", { method: "DELETE", key, headers: { "X-Iris-ID": id } }, address);
      }
    } catch (error) {
      if (closed) return;
      if (error.code === 410) {
        closed = true;
        state(false, "La conexión local terminó. Puedes vincular los dispositivos de nuevo.");
        return;
      }
      state(false, "Esperando la red local o espacio para guardar. Iris volverá a intentar la recepción.");
      online = false;
    }
    if (!closed) timer = setTimeout(poll, 600);
  }

  return {
    isGuest,
    start: poll,
    async send(blob, name, id, quad) {
      const packet = makePacket(blob, name, id, quad);
      const headers = { "Content-Type": packet.type, "X-Iris-ID": packet.id, "X-Iris-Name": encodeURIComponent(packet.name) };
      if (packet.quad) headers["X-Iris-Quad"] = JSON.stringify(packet.quad);
      await api("inbox", {
        method: "POST", key, body: blob, headers
      }, address);
      const until = Date.now() + 35000;
      while (!closed && Date.now() < until) {
        const status = await api("outbox", { key }, address);
        if (status.headers.get("X-Iris-Pending") !== packet.id) return;
        await delay(500);
      }
      throw new Error("El otro dispositivo aún no confirmó la recepción. Tu archivo sigue guardado aquí.");
    },
    close() {
      closed = true;
      clearTimeout(timer);
      api("pair", { method: "DELETE", key }, address).catch(() => {});
    }
  };
}

function rtcLink(isGuest, receive, state) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  let channel;
  let incoming;
  let saving = false;
  let sending = false;
  const receipts = new Map();
  const sendJSON = (message) => channel.send(JSON.stringify(message));

  function attach(opened) {
    channel = opened;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => state(true));
    channel.addEventListener("close", () => state(false, "El otro dispositivo se desconectó."));
    channel.addEventListener("message", async ({ data }) => {
      if (typeof data === "string") {
        let message;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        if (!message || !idPattern.test(message.id)) return;
        if (message.ack !== undefined) {
          receipts.get(message.id)?.(message.ack === true);
          return;
        }
        if (incoming || saving || !types.has(message.type) || !Number.isInteger(message.size) ||
            message.size <= 0 || message.size > MAX_FILE || typeof message.name !== "string" || message.name.length > 120) {
          sendJSON({ id: message.id, ack: false });
          return;
        }
        incoming = { ...message, chunks: [], received: 0 };
        return;
      }
      if (!incoming || !(data instanceof ArrayBuffer)) return;
      incoming.received += data.byteLength;
      if (!data.byteLength || data.byteLength > 16384 || incoming.received > incoming.size) {
        const id = incoming.id;
        incoming = null;
        sendJSON({ id, ack: false });
        return;
      }
      incoming.chunks.push(data);
      if (incoming.received !== incoming.size) return;
      const { id, name, type, chunks, quad } = incoming;
      incoming = null;
      saving = true;
      let ack = false;
      try {
        const blob = new Blob(chunks, { type });
        if (await validFile(blob)) {
          await receive(blob, name, id, quad);
          ack = true;
        }
      } catch {
        // The sending device keeps a copy if the receiver cannot store it.
      } finally {
        saving = false;
        if (channel.readyState === "open") sendJSON({ id, ack });
      }
    });
  }

  if (isGuest) pc.addEventListener("datachannel", (event) => {
    if (channel || event.channel.label !== "auralis-iris") event.channel.close();
    else attach(event.channel);
  });
  else attach(pc.createDataChannel("auralis-iris"));

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") {
      state(false, "No se pudo abrir el enlace directo. Revisa que ambos dispositivos estén en la misma red.");
    }
  });

  return {
    pc,
    isGuest,
    async send(blob, name, id, quad) {
      if (channel?.readyState !== "open" || sending) throw new Error("Espera a que el otro dispositivo esté listo.");
      const packet = makePacket(blob, name, id, quad);
      sending = true;
      let timer;
      try {
        const confirmation = new Promise((resolve) => {
          receipts.set(packet.id, resolve);
          timer = setTimeout(() => resolve(false), 45000);
        });
        sendJSON(packet);
        const until = Date.now() + 35000;
        for (let offset = 0; offset < blob.size; offset += 16384) {
          while (channel.bufferedAmount > 256 * 1024 && channel.readyState === "open" && Date.now() < until) await delay(15);
          if (channel.readyState !== "open" || Date.now() >= until) throw new Error("Se interrumpió el envío por la red.");
          channel.send(await blob.slice(offset, offset + 16384).arrayBuffer());
        }
        if (!(await confirmation)) throw new Error("El otro dispositivo no confirmó el guardado. Tu archivo sigue aquí.");
      } finally {
        sending = false;
        clearTimeout(timer);
        receipts.delete(packet.id);
      }
    },
    close() {
      receipts.forEach((resolve) => resolve(false));
      pc.close();
    }
  };
}

async function gather(pc) {
  if (pc.iceGatheringState !== "complete") {
    await new Promise((resolve) => {
      const finish = () => {
        pc.removeEventListener("icegatheringstatechange", check);
        clearTimeout(timeout);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === "complete") finish();
      };
      const timeout = setTimeout(finish, 2800);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }
  if (!pc.localDescription?.sdp.includes("a=candidate:")) {
    throw new Error("El navegador no anunció una dirección para el enlace directo. Prueba en la edición de Windows.");
  }
}

async function encodeCode(description) {
  const stream = new Blob([description.sdp]).stream().pipeThrough(new CompressionStream("deflate"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const base = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return "IRIS1." + (description.type === "offer" ? "O." : "A.") + base;
}

async function decodeCode(value, type) {
  const prefix = type === "offer" ? "IRIS1.O." : "IRIS1.A.";
  const code = value.trim();
  if (!code.startsWith(prefix) || code.length > 3500 || !/^[a-zA-Z0-9_-]+$/.test(code.slice(prefix.length))) {
    throw new Error("Copia el código completo de Iris.");
  }
  let sdp;
  try {
    const bytes = Uint8Array.from(atob(code.slice(prefix.length).replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    sdp = await new Response(stream).text();
    if (sdp.length > 12000 || !sdp.startsWith("v=0") || (sdp.match(/^m=/gm) || []).length !== 1 ||
        !/^m=application /m.test(sdp) || !/^a=candidate:/m.test(sdp)) throw new Error();
  } catch {
    throw new Error("El código de conexión no es válido. Genera uno nuevo.");
  }
  return { type, sdp };
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(label, action, className = "outline") {
  const element = node("button", label, className);
  element.type = "button";
  element.addEventListener("click", action);
  return element;
}

function qrFor(value) {
  const qr = globalThis.qrcode(0, "M");
  qr.addData(value);
  qr.make();
  const canvas = node("canvas", "", "pair-qr");
  const count = qr.getModuleCount();
  canvas.width = canvas.height = (count + 8) * 5;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Código QR de vinculación");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#102f2a";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) ctx.fillRect((col + 4) * 5, (row + 4) * 5, 5, 5);
    }
  }
  return canvas;
}

function copyable(value, name, status) {
  const field = node("label", "", "field");
  field.append(node("span", name));
  const input = node("input");
  input.value = value;
  input.readOnly = true;
  field.append(input);
  const copy = button("Copiar", async () => {
    input.select();
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(value);
      else if (!document.execCommand("copy")) throw new Error();
      status.textContent = "Copiado.";
    } catch {
      status.textContent = "Selecciona el texto y cópialo desde el navegador.";
    }
  }, "outline small");
  return [field, copy];
}

function androidInvitation(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return;
  }
  if (url.username || url.password || url.search) return;
  const params = new URLSearchParams(url.hash.slice(1));
  if (params.get("rtc")?.startsWith("IRIS1.O.") && !params.has("lan") && ["http:", "https:"].includes(url.protocol)) {
    return { params };
  }
  const parts = url.hostname.split(".").map(Number);
  const [first, second] = parts;
  const local = first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
  if (url.protocol === "http:" && url.pathname === "/" && parts.length === 4 && local &&
      Number(url.port) >= 1024 && linkPattern.test(params.get("lan")) && !params.has("rtc")) {
    return { params, address: url.host };
  }
}

export function setupPair({ receive, onChange }) {
  const dialog = $("#pair-dialog");
  const content = $("#pair-content");
  const status = $("#pair-status");
  let link;
  let active = false;
  let stopQR = () => {};
  let invitation = new URLSearchParams(location.hash.slice(1));
  let address;
  const bridge = localEdition();

  function show() {
    if (!dialog.open) dialog.showModal();
  }

  function report(online, error) {
    const changed = online !== active;
    active = online;
    onChange(online, link?.isGuest ?? false);
    if (error) status.textContent = error;
    if (online && changed) {
      status.textContent = "Vinculación lista.";
      if (dialog.open) dialog.close();
    }
  }

  function end() {
    const old = link;
    link = null;
    old?.close();
    report(false);
    menu();
  }

  function steps(...children) {
    const group = node("div", "", "pair-steps");
    group.append(...children);
    content.replaceChildren(group);
    return group;
  }

  function showInvitation(url, help) {
    const group = steps(node("p", help), qrFor(url), ...copyable(url, "Enlace de vinculación", status));
    group.append(button("Cancelar vinculación", end, "text-button"));
    return group;
  }

  async function hostLan() {
    await loadVendor("qrcode.js");
    const { key, urls } = await (await api("pair", { method: "POST" })).json();
    link = lanLink(key, false, receive, report);
    const explain = "Escanea el QR con la cámara del celular conectado a la misma red. Usa una red de confianza: la edición portable envía los archivos por HTTP local.";
    const group = showInvitation(urls[0], explain);
    if (urls.length > 1) {
      const other = node("details");
      other.append(node("summary", "Otras direcciones de este PC"));
      for (const url of urls.slice(1)) {
        other.append(qrFor(url), ...copyable(url, "Enlace alternativo", status));
      }
      group.append(other);
    }
    status.textContent = "Esperando el celular…";
    link.start();
  }

  async function readQR(group, accepts) {
    stopQR();
    const video = node("video", "", "qr-camera");
    video.autoplay = video.muted = video.playsInline = true;
    group.append(video);
    let cancelled = false;
    let stream;
    const stop = () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      video.remove();
    };
    stopQR = stop;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" } } });
      if (cancelled) return;
      video.srcObject = stream;
      await loadVendor("jsqr.js");
      const canvas = node("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      while (!cancelled) {
        if (video.videoWidth) {
          canvas.width = Math.min(640, video.videoWidth);
          canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = globalThis.jsQR(pixels.data, pixels.width, pixels.height)?.data;
          if (code && accepts(code)) return code;
        }
        await delay(160);
      }
    } finally {
      stop();
    }
  }

  async function hostRtc() {
    await loadVendor("qrcode.js");
    link = rtcLink(false, receive, report);
    const { pc } = link;
    await pc.setLocalDescription(await pc.createOffer());
    await gather(pc);
    const url = android ? new URL(webHome) : new URL(location.pathname, location.origin);
    url.hash = "rtc=" + await encodeCode(pc.localDescription);
    const group = showInvitation(url.href, "1. Abre el enlace en el celular con el QR. Mantén ambos dispositivos en la misma red.");
    const field = node("label", "", "field");
    field.append(node("span", "2. Código de respuesta que muestra el celular"));
    const input = node("textarea");
    input.rows = 2;
    input.spellcheck = false;
    field.append(input);
    const actions = node("div", "", "actions");
    actions.append(button("Vincular", guarded(async () => {
      const answer = await decodeCode(input.value, "answer");
      await pc.setRemoteDescription(answer);
      status.textContent = "Conectando con el celular…";
    }), "primary"));
    if (navigator.mediaDevices?.getUserMedia) {
      actions.append(button("Leer respuesta con cámara", guarded(async () => {
        const reply = await readQR(group, (code) => code.startsWith("IRIS1.A."));
        if (reply) {
          input.value = reply;
          input.focus();
        }
      })));
    }
    group.insertBefore(field, group.lastChild);
    group.insertBefore(actions, group.lastChild);
    status.textContent = "";
  }

  async function join() {
    const key = invitation.get("lan");
    const offer = invitation.get("rtc");
    if (linkPattern.test(key)) {
      const guestKey = (await (await api("join", { method: "POST", key }, address)).json()).key;
      link = lanLink(guestKey, true, receive, report, address);
      link.start();
    } else if (offer) {
      const remote = await decodeCode(offer, "offer");
      await loadVendor("qrcode.js");
      link = rtcLink(true, receive, report);
      const { pc } = link;
      await pc.setRemoteDescription(remote);
      await pc.setLocalDescription(await pc.createAnswer());
      await gather(pc);
      const reply = await encodeCode(pc.localDescription);
      steps(node("p", "Muestra este QR a la cámara del PC o pega la respuesta en el dispositivo que abrió la vinculación."),
        qrFor(reply), ...copyable(reply, "Código de respuesta", status), button("Cancelar vinculación", end, "text-button"));
      status.textContent = "Esperando la confirmación del otro dispositivo…";
    } else {
      throw new Error("Abre un enlace de vinculación nuevo.");
    }
    clearInvitation();
  }

  function clearInvitation() {
    invitation = new URLSearchParams();
    address = undefined;
    history.replaceState(null, "", location.pathname + location.search);
  }

  function guarded(action, resetOnError = false) {
    return async (event) => {
      const target = event.currentTarget;
      target.disabled = true;
      try {
        await action();
      } catch (error) {
        if (resetOnError) end();
        status.textContent = error.message || "No se pudo vincular el dispositivo.";
      } finally {
        target.disabled = false;
      }
    };
  }

  async function menu() {
    status.textContent = "";
    if (invitation.has("lan") || invitation.has("rtc")) {
      steps(node("p", "Al aceptar, puedes usar este dispositivo como cámara y enviar fotos al que inició la vinculación."),
        button("Aceptar y vincular", guarded(join, true), "primary"),
        button("Seguir sin vincular", () => {
          clearInvitation();
          dialog.close();
        }, "text-button"));
      return;
    }
    const local = await bridge;
    const group = steps(node("p", "Conecta ambos dispositivos a la misma red. El otro equipo recibirá las fotos en el documento que tenga abierto."));
    if (local) group.append(button("Mostrar QR de la red local", guarded(hostLan, true), "primary"));
    if (android) {
      const useInvitation = (value) => {
        const parsed = androidInvitation(value);
        if (!parsed) throw new Error("Pega un enlace de vinculación de Iris válido.");
        stopQR();
        invitation = parsed.params;
        address = parsed.address;
        return menu();
      };
      if (navigator.mediaDevices?.getUserMedia) {
        group.append(button("Leer QR de vinculación", guarded(async () => {
          const value = await readQR(group, androidInvitation);
          if (value) await useInvitation(value);
        }), "primary"));
      }
      const field = node("label", "", "field");
      field.append(node("span", "O pega el enlace de vinculación del PC"));
      const input = node("textarea");
      input.rows = 2;
      input.spellcheck = false;
      field.append(input);
      group.append(field, button("Abrir enlace", guarded(() => useInvitation(input.value))));
    }
    if (globalThis.RTCPeerConnection && globalThis.CompressionStream && globalThis.DecompressionStream) {
      group.append(button(local ? "Vincular con códigos web" : "Crear enlace web", guarded(hostRtc, true), local ? "outline" : "primary"));
    }
    group.append(node("p", "Para usar Bluetooth, exporta el PDF y compártelo desde el sistema si tu dispositivo ofrece esa opción.", "muted small-text"));
  }

  $("#pair").addEventListener("click", () => {
    if (active) {
      steps(node("p", "Puedes enviar páginas o el PDF al dispositivo vinculado."),
        button("Desconectar", end, "outline"));
    } else if (!link) menu();
    else if (status.textContent && !status.textContent.startsWith("Esperando") && !status.textContent.startsWith("Conectando")) {
      content.append(button("Crear otra vinculación", end));
    }
    show();
  });
  dialog.addEventListener("close", () => stopQR());
  if (invitation.has("lan") || invitation.has("rtc")) {
    menu();
    show();
  }
  return {
    send(blob, name, id, quad) {
      if (!link || !active) throw new Error("Conecta el otro dispositivo para enviar el archivo.");
      return link.send(blob, name, id, quad);
    }
  };
}
