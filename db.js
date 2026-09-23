const DB_NAME = "wisenotes";
const DB_VERSION = 1;
const STORE = "sessions";

let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "sessionId" });
          store.createIndex("createdAt", "createdAt");
          store.createIndex("videoId", "videoId");
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }
  return dbPromise;
}

export async function putSession(session) {
  const db = await openDb();
  await requestPromise(db.transaction(STORE, "readwrite").objectStore(STORE).put(session));
  return session;
}

export async function getSession(sessionId) {
  const db = await openDb();
  return requestPromise(db.transaction(STORE).objectStore(STORE).get(sessionId));
}

export async function patchSession(sessionId, patch) {
  const db = await openDb();
  const transaction = db.transaction(STORE, "readwrite");
  const store = transaction.objectStore(STORE);
  const current = await requestPromise(store.get(sessionId));
  if (!current) throw new Error(`Unknown WiseNotes session: ${sessionId}`);
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await requestPromise(store.put(next));
  await transactionPromise(transaction);
  return next;
}

export async function getLatestSession() {
  const db = await openDb();
  const sessions = await requestPromise(db.transaction(STORE).objectStore(STORE).getAll());
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

export async function clearSessions() {
  const db = await openDb();
  await requestPromise(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}
