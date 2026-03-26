import fs from "fs";
import path from "path";
import { extractText } from "./documentExtract.js";
import { analyzeDocument } from "./summarize.js";
import {
  setActiveDoc,
  getActiveDoc,
  setUserDoc,
  getUserDoc,
} from "./roomDocuments.js";
import { setDocument as setTranscriptDocument } from "./meetingTranscript.js";

/**
 * Emit document payload to a single socket.
 */
async function emitPayloadForOneSocket(io, socket, code) {
  const doc = getActiveDoc(code);
  if (!doc || !doc.ready) return;
  socket.emit("doc:payload", {
    docId: doc.docId,
    fileName: doc.fileName,
    mime: doc.mime,
    insight: {
      overview: doc.overviewSrc,
      keyPoints: doc.keyPointsSrc,
      deepDive: doc.deepDiveSrc,
      studyQuestions: doc.studyQsSrc,
      objectives: doc.objectivesSrc,
    },
    language: "en",
    sourceLanguage: "en",
    at: doc.at,
  });
}

/**
 * Process an uploaded document (shared with room).
 */
async function processUploadedDocument(io, code, params) {
  const { docId, filePath, fileName, mime, maxExtractChars } = params;

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    io.to(code).emit("doc:error", { docId, fileName, message: "Could not read uploaded file: " + (err.message || err) });
    return;
  }

  io.to(code).emit("doc:processing", { docId, fileName });

  try {
    const { text, extractor, warnings, truncated } = await extractText(buffer, fileName, maxExtractChars);
    if (!text.trim()) throw new Error("No extractable text (try a text-based PDF or Office file, not a scan).");

    let insight = { overview: "", keyPoints: "", deepDive: "", studyQuestions: "", objectives: "" };
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("Analysis timeout")), 30000));
      insight = await Promise.race([analyzeDocument(text, null, "eng"), timeout]);
    } catch (e) {
      console.error("[doc pipeline] analysis skipped:", e.message);
    }

    const doc = {
      docId, fileName, mime, filePath,
      storageExt: path.extname(filePath).toLowerCase() || ".bin",
      extractedText: text,
      overviewSrc: insight.overview,
      keyPointsSrc: insight.keyPoints,
      deepDiveSrc: insight.deepDive,
      studyQsSrc: insight.studyQuestions,
      objectivesSrc: insight.objectives,
      extractor, warnings, truncated,
      ready: true, at: Date.now(),
    };

    setActiveDoc(code, doc);
    try { setTranscriptDocument(code, fileName, text); } catch (_) {}

    io.to(code).emit("doc:ready", { docId, fileName, sourceLanguage: "en", extractor, warnings, truncated });
    await emitLocalizedPayloads(io, code);
  } catch (err) {
    io.to(code).emit("doc:error", { docId, fileName, message: err.message || String(err) });
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
}

/**
 * Emit document payloads to all sockets in a room.
 */
async function emitLocalizedPayloads(io, code) {
  const doc = getActiveDoc(code);
  if (!doc || !doc.ready) return;
  const socks = await io.in(code).fetchSockets();
  const insight = {
    overview: doc.overviewSrc,
    keyPoints: doc.keyPointsSrc,
    deepDive: doc.deepDiveSrc,
    studyQuestions: doc.studyQsSrc,
    objectives: doc.objectivesSrc,
  };
  for (const s of socks) {
    s.emit("doc:payload", {
      docId: doc.docId, fileName: doc.fileName, mime: doc.mime,
      insight, language: "en", sourceLanguage: "en", at: doc.at,
    });
  }
}

/**
 * Process a document for a single user (private).
 */
async function processUserDocument(io, code, email, params) {
  const { docId, filePath, fileName, mime, maxExtractChars } = params;

  const emitToUser = async (event, data) => {
    const socks = await io.in(code).fetchSockets();
    for (const s of socks) { if (s.user && s.user.email === email) s.emit(event, data); }
  };

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    await emitToUser("doc:error", { docId, fileName, message: "Could not read file: " + (err.message || err) });
    return;
  }

  await emitToUser("doc:processing", { docId, fileName });

  try {
    const { text, extractor, warnings, truncated } = await extractText(buffer, fileName, maxExtractChars);
    if (!text.trim()) throw new Error("No extractable text.");

    let insight = { overview: "", keyPoints: "", deepDive: "", studyQuestions: "", objectives: "" };
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("Analysis timeout")), 30000));
      insight = await Promise.race([analyzeDocument(text, null, "eng"), timeout]);
    } catch (e) {
      console.error("[doc pipeline] analysis skipped:", e.message);
    }

    const doc = {
      docId, fileName, mime, filePath,
      storageExt: path.extname(filePath).toLowerCase() || ".bin",
      extractedText: text,
      overviewSrc: insight.overview,
      keyPointsSrc: insight.keyPoints,
      deepDiveSrc: insight.deepDive,
      studyQsSrc: insight.studyQuestions,
      objectivesSrc: insight.objectives,
      extractor, warnings, truncated,
      ready: true, at: Date.now(),
    };

    setUserDoc(code, email, doc);
    await emitToUser("doc:ready", { docId, fileName, sourceLanguage: "en", extractor, warnings, truncated });

    const socks = await io.in(code).fetchSockets();
    const payload = {
      docId: doc.docId, fileName: doc.fileName, mime: doc.mime,
      insight: { overview: doc.overviewSrc, keyPoints: doc.keyPointsSrc, deepDive: doc.deepDiveSrc, studyQuestions: doc.studyQsSrc, objectives: doc.objectivesSrc },
      language: "en", sourceLanguage: "en", at: doc.at,
    };
    for (const s of socks) { if (s.user && s.user.email === email) s.emit("doc:payload", payload); }
  } catch (err) {
    await emitToUser("doc:error", { docId, fileName, message: err.message || String(err) });
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
}

/**
 * Re-emit document payload for a single socket.
 */
async function emitUserPayloadForOneSocket(io, socket, code) {
  if (!socket.user || !socket.user.email) return;
  const doc = getUserDoc(code, socket.user.email);
  if (!doc || !doc.ready) return;
  socket.emit("doc:payload", {
    docId: doc.docId, fileName: doc.fileName, mime: doc.mime,
    insight: { overview: doc.overviewSrc, keyPoints: doc.keyPointsSrc, deepDive: doc.deepDiveSrc, studyQuestions: doc.studyQsSrc, objectives: doc.objectivesSrc },
    language: "en", sourceLanguage: "en", at: doc.at,
  });
}

export {
  processUploadedDocument,
  emitLocalizedPayloads,
  emitPayloadForOneSocket,
  processUserDocument,
  emitUserPayloadForOneSocket,
};
