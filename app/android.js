export const android = globalThis.IrisAndroid;

const chunkSize = 192 * 1024;

function encode(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",", 2)[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function stageAndroidFile(blob, name) {
  const error = () => new Error("Android no pudo preparar el archivo. Revisa el espacio disponible.");
  const id = android.startFile(name);
  if (!id) throw error();
  try {
    for (let start = 0; start < blob.size; start += chunkSize) {
      const chunk = await encode(blob.slice(start, start + chunkSize));
      if (!android.appendFile(id, chunk)) throw error();
    }
    return id;
  } catch {
    android.discardFile(id);
    throw error();
  }
}

export async function exportAndroidFile(blob, name, share = false) {
  const id = await stageAndroidFile(blob, name);
  const result = await new Promise((resolve) => {
    function complete({ detail }) {
      if (detail[0] !== id) return;
      removeEventListener("iris-android-export", complete);
      resolve(detail[1]);
    }
    addEventListener("iris-android-export", complete);
    android.exportFile(id, share);
  });
  if (result === "error") throw new Error("Android no pudo " + (share ? "compartir" : "guardar") + " el archivo.");
  return result !== "cancelled";
}
