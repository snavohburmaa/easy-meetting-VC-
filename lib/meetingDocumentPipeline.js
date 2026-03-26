import fs from "fs";
import path from "path";
import { extractText } from "./documentExtract.js";
import { detectLanguage, normalizeTargetLang } from "./detectLanguage.js";
import { analyzeDocument } from "./summarize.js";
import { translateInsightBundle } from "./translate.js";
import {
  setActiveDoc,
  getActiveDoc,
  getTranslationCache,
  setUserDoc,
  getUserDoc,
  getUserTranslationCache,
} from "./roomDocuments.js";
import { setDocument as setTranscriptDocument } from "./meetingTranscript.js";

const HF_TOKEN = process.env.HF_API_KEY || "";
const LT_URL = process.env.LIBRETRANSLATE_URL || "https://libretranslate.com";
const LT_KEY = process.env.LIBRETRANSLATE_API_KEY || "";

/**
 * @param {object} doc
 * @param {Map} cache
 * @param {import("socket.io").Socket} socket
 * @param {string} target
 */
/**
 * @returns {Promise<{ insight: object, translationFailed: boolean }>}
 */
async function localizeForSocket(doc, cache, socket, target) {
  const ltSrc = doc.ltSource || "auto";
  const insightSrc = {
    overview: doc.overviewSrc,
    keyPoints: doc.keyPointsSrc,
    deepDive: doc.deepDiveSrc,
    studyQuestions: doc.studyQsSrc,
    objectives: doc.objectivesSrc,
  };

  const skipTranslate = ltSrc !== "auto" && ltSrc === target;

  if (skipTranslate) {
    return { insight: insightSrc, translationFailed: false };
  }

  try {
    const insight = await translateInsightBundle(
      cache,
      insightSrc,
      ltSrc,
      target,
      LT_URL,
      LT_KEY
    );
    return { insight, translationFailed: false };
  } catch {
    if (!socket.data._docTranslateWarned) {
      socket.data._docTranslateWarned = true;
      socket.emit("doc:warn", {
        message:
          "Could not translate insights (LibreTranslate busy or blocked). Showing English analysis — set LIBRETRANSLATE_URL to your own instance for reliable Thai and other languages.",
      });
    }
    return { insight: insightSrc, translationFailed: true };
  }
}

/**
 * @param {import("socket.io").Server} io
 * @param {import("socket.io").Socket} socket
 * @param {string} code
 */
async function emitPayloadForOneSocket(io, socket, code) {
  const doc = getActiveDoc(code);
  if (!doc || !doc.ready) return;
  const cache = getTranslationCache(code);
  const target = normalizeTargetLang(socket.data.preferredLanguage || "en");
  const { insight, translationFailed } = await localizeForSocket(
    doc,
    cache,
    socket,
    target
  );
  socket.emit("doc:payload", {
    docId: doc.docId,
    fileName: doc.fileName,
    mime: doc.mime,
    insight,
    translationFailed,
    language: target,
    sourceLanguage: doc.francCode,
    at: doc.at,
  });
}

/**
 * @param {object} io
 * @param {string} code
 * @param {object} params
 */
async function processUploadedDocument(io, code, params) {
  const { docId, filePath, fileName, mime, maxExtractChars } = params;

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    const message = `Could not read uploaded file: ${err && err.message ? err.message : err}`;
    io.to(code).emit("doc:error", { docId, fileName, message });
    return;
  }

  io.to(code).emit("doc:processing", { docId, fileName });

  try {
    const { text, extractor, warnings, truncated } = await extractText(
      buffer,
      fileName,
      maxExtractChars
    );

    if (!text.trim()) {
      throw new Error(
        "No extractable text (try a text-based PDF or Office file, not a scan)."
      );
    }

    const { francCode, ltSource } = await detectLanguage(text);

    let insight = { overview: "", keyPoints: "", deepDive: "", studyQuestions: "", objectives: "" };
    try {
      const analysisTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error("HF analysis timeout (30s)")), 30000));
      insight = await Promise.race([analyzeDocument(text, HF_TOKEN, francCode), analysisTimeout]);
    } catch (analysisErr) {
      console.error("[doc pipeline] HF analysis skipped (doc still usable for AI chat):", analysisErr.message || analysisErr);
    }

    const storageExt = path.extname(filePath).toLowerCase() || ".bin";

    const doc = {
      docId,
      fileName,
      mime,
      filePath,
      storageExt,
      extractedText: text,
      francCode,
      ltSource,
      overviewSrc: insight.overview,
      keyPointsSrc: insight.keyPoints,
      deepDiveSrc: insight.deepDive,
      studyQsSrc: insight.studyQuestions,
      objectivesSrc: insight.objectives,
      extractor,
      warnings,
      truncated,
      ready: true,
      at: Date.now(),
    };

    setActiveDoc(code, doc);
    // Capture document text in meeting transcript for summary generation
    try { setTranscriptDocument(code, fileName, text); } catch (_) {}
    io.to(code).emit("doc:ready", {
      docId,
      fileName,
      sourceLanguage: francCode,
      extractor,
      warnings,
      truncated,
    });

    await emitLocalizedPayloads(io, code);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    io.to(code).emit("doc:error", { docId, fileName, message });
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
  }
}

/**
 * @param {import("socket.io").Server} io
 * @param {string} code
 */
async function emitLocalizedPayloads(io, code) {
  const doc = getActiveDoc(code);
  if (!doc || !doc.ready) return;

  const socks = await io.in(code).fetchSockets();
  const cache = getTranslationCache(code);

  for (const s of socks) {
    const target = normalizeTargetLang(s.data.preferredLanguage || "en");
    const { insight, translationFailed } = await localizeForSocket(
      doc,
      cache,
      s,
      target
    );
    s.emit("doc:payload", {
      docId: doc.docId,
      fileName: doc.fileName,
      mime: doc.mime,
      insight,
      translationFailed,
      language: target,
      sourceLanguage: doc.francCode,
      at: doc.at,
    });
  }
}

/**
 * Process a document for a single user (private — not shared with room).
 * Events are emitted only to sockets belonging to that user.
 */
async function processUserDocument(io, code, email, params) {
  const { docId, filePath, fileName, mime, maxExtractChars } = params;

  // Find all sockets for this user in the room
  const emitToUser = async (event, data) => {
    const socks = await io.in(code).fetchSockets();
    for (const s of socks) {
      if (s.user && s.user.email === email) s.emit(event, data);
    }
  };

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    const message = `Could not read uploaded file: ${err && err.message ? err.message : err}`;
    await emitToUser("doc:error", { docId, fileName, message });
    return;
  }

  await emitToUser("doc:processing", { docId, fileName });

  try {
    const { text, extractor, warnings, truncated } = await extractText(
      buffer,
      fileName,
      maxExtractChars
    );

    if (!text.trim()) {
      throw new Error(
        "No extractable text (try a text-based PDF or Office file, not a scan)."
      );
    }

    const { francCode, ltSource } = await detectLanguage(text);

    // Analyze doc via HF — if it fails or times out, still store the doc so AI chat works
    let insight = { overview: "", keyPoints: "", deepDive: "", studyQuestions: "", objectives: "" };
    try {
      const analysisTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error("HF analysis timeout (30s)")), 30000));
      insight = await Promise.race([analyzeDocument(text, HF_TOKEN, francCode), analysisTimeout]);
    } catch (analysisErr) {
      console.error("[doc pipeline] HF analysis skipped (doc still usable for AI chat):", analysisErr.message || analysisErr);
    }

    const storageExt = path.extname(filePath).toLowerCase() || ".bin";

    const doc = {
      docId,
      fileName,
      mime,
      filePath,
      storageExt,
      extractedText: text,
      francCode,
      ltSource,
      overviewSrc: insight.overview,
      keyPointsSrc: insight.keyPoints,
      deepDiveSrc: insight.deepDive,
      studyQsSrc: insight.studyQuestions,
      objectivesSrc: insight.objectives,
      extractor,
      warnings,
      truncated,
      ready: true,
      at: Date.now(),
    };

    setUserDoc(code, email, doc);

    await emitToUser("doc:ready", {
      docId,
      fileName,
      sourceLanguage: francCode,
      extractor,
      warnings,
      truncated,
    });

    // Send localized payload to each of this user's sockets
    const socks = await io.in(code).fetchSockets();
    const cache = getUserTranslationCache(code, email);
    for (const s of socks) {
      if (s.user && s.user.email === email) {
        const target = normalizeTargetLang(s.data.preferredLanguage || "en");
        const { insight: localized, translationFailed } = await localizeForSocket(
          doc,
          cache,
          s,
          target
        );
        s.emit("doc:payload", {
          docId: doc.docId,
          fileName: doc.fileName,
          mime: doc.mime,
          insight: localized,
          translationFailed,
          language: target,
          sourceLanguage: doc.francCode,
          at: doc.at,
        });
      }
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await emitToUser("doc:error", { docId, fileName, message });
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
  }
}

/**
 * Re-emit the per-user document payload for a single socket (e.g. on language change).
 */
async function emitUserPayloadForOneSocket(io, socket, code) {
  if (!socket.user || !socket.user.email) return;
  const doc = getUserDoc(code, socket.user.email);
  if (!doc || !doc.ready) return;
  const cache = getUserTranslationCache(code, socket.user.email);
  const target = normalizeTargetLang(socket.data.preferredLanguage || "en");
  const { insight, translationFailed } = await localizeForSocket(
    doc,
    cache,
    socket,
    target
  );
  socket.emit("doc:payload", {
    docId: doc.docId,
    fileName: doc.fileName,
    mime: doc.mime,
    insight,
    translationFailed,
    language: target,
    sourceLanguage: doc.francCode,
    at: doc.at,
  });
}

export {
  processUploadedDocument,
  emitLocalizedPayloads,
  emitPayloadForOneSocket,
  processUserDocument,
  emitUserPayloadForOneSocket,
};
