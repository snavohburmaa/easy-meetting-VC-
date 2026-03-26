import fs from "fs";
import path from "path";

/** @type {Map<string, object>} */
const byCode = new Map();

function getState(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!byCode.has(c)) {
    byCode.set(c, {
      activeDoc: null,
      uploadTimestamps: new Map(),
      userDocs: new Map(),
    });
  }
  return byCode.get(c);
}

function clearRoom(code) {
  const c = String(code || "").trim().toUpperCase();
  const st = byCode.get(c);
  if (!st) return;
  if (st.activeDoc && st.activeDoc.filePath) {
    try { fs.unlinkSync(st.activeDoc.filePath); } catch (_) {}
  }
  for (const doc of st.userDocs.values()) {
    if (doc && doc.filePath) { try { fs.unlinkSync(doc.filePath); } catch (_) {} }
  }
  byCode.delete(c);
}

function unlinkDocFile(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (_) {}
}

function setActiveDoc(code, doc) {
  const st = getState(code);
  const nextPath = doc && doc.filePath;
  if (st.activeDoc && st.activeDoc.filePath && st.activeDoc.filePath !== nextPath) {
    unlinkDocFile(st.activeDoc.filePath);
  }
  st.activeDoc = doc || null;
}

function getActiveDoc(code) {
  const st = byCode.get(String(code || "").trim().toUpperCase());
  return st ? st.activeDoc : null;
}

function setUserDoc(code, email, doc) {
  const st = getState(code);
  const key = String(email || "").toLowerCase();
  const prev = st.userDocs.get(key);
  if (prev && prev.filePath && (!doc || prev.filePath !== doc.filePath)) {
    unlinkDocFile(prev.filePath);
  }
  st.userDocs.set(key, doc || null);
}

function getUserDoc(code, email) {
  const st = byCode.get(String(code || "").trim().toUpperCase());
  if (!st) return null;
  return st.userDocs.get(String(email || "").toLowerCase()) || null;
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
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
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
  getState, clearRoom, setActiveDoc, getActiveDoc,
  setUserDoc, getUserDoc,
  canUpload, ensureUploadDir, safeJoinUploadDir, unlinkDocFile,
};
