import fs from "fs";
import path from "path";

/** @type {Map<string, object>} */
const byCode = new Map();

function getState(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!byCode.has(c)) {
    byCode.set(c, {
      activeDoc: null,
      translationCache: new Map(),
      uploadTimestamps: new Map(),
      /** Per-user private documents: Map<email, doc> */
      userDocs: new Map(),
      /** Per-user translation caches: Map<email, Map> */
      userTranslationCaches: new Map(),
    });
  }
  return byCode.get(c);
}

function clearRoom(code) {
  const c = String(code || "").trim().toUpperCase();
  const st = byCode.get(c);
  if (!st) return;
  if (st.activeDoc && st.activeDoc.filePath) {
    try {
      fs.unlinkSync(st.activeDoc.filePath);
    } catch (_) {}
  }
  // Clean up per-user docs
  for (const doc of st.userDocs.values()) {
    if (doc && doc.filePath) {
      try { fs.unlinkSync(doc.filePath); } catch (_) {}
    }
  }
  byCode.delete(c);
}

function unlinkDocFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (_) {}
}

/**
 * @param {string} code
 * @param {object} doc
 */
function setActiveDoc(code, doc) {
  const st = getState(code);
  const nextPath = doc && doc.filePath;
  if (st.activeDoc && st.activeDoc.filePath && st.activeDoc.filePath !== nextPath) {
    unlinkDocFile(st.activeDoc.filePath);
  }
  st.translationCache = new Map();
  st.activeDoc = doc || null;
}

function getActiveDoc(code) {
  const st = byCode.get(String(code || "").trim().toUpperCase());
  return st ? st.activeDoc : null;
}

function getTranslationCache(code) {
  return getState(code).translationCache;
}

/* ── Per-user private document helpers ── */

function setUserDoc(code, email, doc) {
  const st = getState(code);
  const key = String(email || "").toLowerCase();
  const prev = st.userDocs.get(key);
  if (prev && prev.filePath && (!doc || prev.filePath !== doc.filePath)) {
    unlinkDocFile(prev.filePath);
  }
  st.userTranslationCaches.set(key, new Map());
  st.userDocs.set(key, doc || null);
}

function getUserDoc(code, email) {
  const st = byCode.get(String(code || "").trim().toUpperCase());
  if (!st) return null;
  return st.userDocs.get(String(email || "").toLowerCase()) || null;
}

function getUserTranslationCache(code, email) {
  const st = getState(code);
  const key = String(email || "").toLowerCase();
  if (!st.userTranslationCaches.has(key)) {
    st.userTranslationCaches.set(key, new Map());
  }
  return st.userTranslationCaches.get(key);
}

function canUpload(code, email, minMs) {
  const st = getState(code);
  const key = String(email || "").toLowerCase();
  const now = Date.now();
  const last = st.uploadTimestamps.get(key) || 0;
  if (now - last < minMs) return false;
  st.uploadTimestamps.set(key, now);
  return true;
}

function ensureUploadDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeJoinUploadDir(uploadDir, docId, ext) {
  const safeExt = /^\.[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : "";
  const id = /^[0-9a-f-]{36}$/i.test(docId) ? docId : null;
  if (!id || !safeExt) throw new Error("invalid_doc_path");
  const full = path.join(uploadDir, `${id}${safeExt}`);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(uploadDir))) throw new Error("path_traversal");
  return resolved;
}

export {
  getState,
  clearRoom,
  setActiveDoc,
  getActiveDoc,
  getTranslationCache,
  setUserDoc,
  getUserDoc,
  getUserTranslationCache,
  canUpload,
  ensureUploadDir,
  safeJoinUploadDir,
  unlinkDocFile,
};
