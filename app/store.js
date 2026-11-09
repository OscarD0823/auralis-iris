const namespace = "auralis-iris";

export async function openLibrary() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(namespace, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("scans", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Cierra las otras pestañas de Iris para abrir la biblioteca."));
  });
}

function requestIn(db, mode, run) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("scans", mode);
    const request = run(transaction.objectStore("scans"));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? new Error("No se pudo guardar el documento."));
  });
}

export function readScans(db) {
  return requestIn(db, "readonly", (scans) => scans.getAll());
}

function changeScan(db, id, revision, write) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("scans", "readwrite");
    const scans = transaction.objectStore("scans");
    const request = scans.get(id);
    let conflict;
    request.onsuccess = () => {
      if (request.result?.revision !== revision) {
        conflict = new Error("Otra ventana cambió este documento. La biblioteca se actualizó. Repite el ajuste.");
        conflict.name = "LibraryConflict";
        transaction.abort();
        return;
      }
      write(scans);
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(conflict ?? transaction.error ?? new Error("No se pudo guardar el documento."));
  });
}

export function saveScan(db, scan, revision) {
  return changeScan(db, scan.id, revision, (scans) => scans.put(scan));
}

export function deleteScan(db, scan) {
  return changeScan(db, scan.id, scan.revision, (scans) => scans.delete(scan.id));
}
