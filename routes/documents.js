import path from "path";
import crypto from "crypto";
import fs from "fs";
import express from "express";
import multer from "multer";
import { auth, verifyToken } from "../lib/auth.js";
import { fromNodeHeaders } from "better-auth/node";
import * as rooms from "../lib/rooms.js";
import * as roomDocuments from "../lib/roomDocuments.js";
import { extFromName, sanitizeOriginalName } from "../lib/documentExtract.js";
import { processUploadedDocument, processUserDocument } from "../lib/meetingDocumentPipeline.js";
import { askAboutDocument } from "../lib/geminiDocChat.js";

const MAX_BYTES = Number(process.env.MAX_DOCUMENT_BYTES) || 20 * 1024 * 1024;
const MAX_EXTRACT = Number(process.env.MAX_EXTRACT_CHARS) || 80000;
const UPLOAD_MS_GAP = Number(process.env.DOC_UPLOAD_COOLDOWN_MS) || 8000;
const GEMINI_KEY = (process.env.GEMINI_API_KEY || "").trim();
const MAX_GEMINI_CONTEXT = Number(process.env.MAX_GEMINI_CONTEXT_CHARS) || 120000;
const DOC_CHAT_COOLDOWN_MS = Number(process.env.DOC_CHAT_COOLDOWN_MS) || 5000;

/** @type {Map<string, number>} */
const docChatLastByUser = new Map();

async function authUser(req) {
  // Try better-auth session (cookie-based)
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (session && session.user) {
      return { email: session.user.email, name: session.user.name };
    }
  } catch (_) { /* fall through */ }
  // Fallback to JWT Authorization header
  try {
    const hdr = req.headers.authorization || "";
    if (hdr.startsWith("Bearer ")) {
      const payload = verifyToken(hdr.slice(7));
      if (payload && payload.email) return { email: payload.email, name: payload.name };
    }
  } catch (_) { /* fall through */ }
  return null;
}

/**
 * @param {import("socket.io").Server} io
 */
export function createDocumentsRouter(io) {
  const router = express.Router();
  const uploadDir = path.resolve(
    process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads")
  );
  roomDocuments.ensureUploadDir(uploadDir);

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      let ext = extFromName(file.originalname);
      if (!ext) ext = ".bin";
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: MAX_BYTES },
  });

  async function assertHostInRoom(code, user) {
    const room = rooms.getRoom(code);
    if (!room) return { error: "room_not_found" };
    const socks = await io.in(code).fetchSockets();
    const mine = socks.find((s) => s.user && s.user.email === user.email);
    if (!mine) return { error: "not_in_room" };
    if (room.hostId !== mine.id) return { error: "host_only" };
    return { ok: true, socketId: mine.id };
  }

  async function assertInRoom(code, user) {
    const room = rooms.getRoom(code);
    if (!room) return { error: "room_not_found" };
    const socks = await io.in(code).fetchSockets();
    const mine = socks.find((s) => s.user && s.user.email === user.email);
    if (!mine) return { error: "not_in_room" };
    return { ok: true };
  }

  router.post(
    "/rooms/:code/documents",
    upload.single("file"),
    async (req, res) => {
      const code = (req.params.code || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{4,12}$/.test(code)) {
        return res.status(400).json({ error: "invalid_code" });
      }
      const user = await authUser(req);
      if (!user) return res.status(401).json({ error: "auth_required" });

      // Any room member can upload their own private document
      const gate = await assertInRoom(code, user);
      if (!gate.ok) {
        const status = gate.error === "not_in_room" ? 403 : 404;
        return res.status(status).json({ error: gate.error });
      }

      if (!req.file) {
        return res.status(400).json({ error: "file_required" });
      }

      let ext = extFromName(req.file.originalname);
      if (!ext) ext = ".bin";

      if (!roomDocuments.canUpload(code, user.email, UPLOAD_MS_GAP)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(429).json({ error: "upload_rate_limited" });
      }

      const docId = path.basename(req.file.filename, ext);
      const fileName = sanitizeOriginalName(req.file.originalname);
      const mime = req.file.mimetype || "application/octet-stream";

      res.status(202).json({
        docId,
        fileName,
        status: "processing",
      });

      // Process as a private per-user document
      const uploaderEmail = user.email;
      setImmediate(() => {
        processUserDocument(io, code, uploaderEmail, {
          docId,
          filePath: req.file.path,
          fileName,
          mime,
          maxExtractChars: MAX_EXTRACT,
        }).catch(async (err) => {
          console.error("[doc pipeline]", err);
          // Emit error only to this user's sockets
          const socks = await io.in(code).fetchSockets();
          for (const s of socks) {
            if (s.user && s.user.email === uploaderEmail) {
              s.emit("doc:error", { docId, fileName, message: String(err && err.message ? err.message : err) });
            }
          }
        });
      });
    }
  );

  router.get("/rooms/:code/documents/:docId/file", async (req, res) => {
    const code = (req.params.code || "").trim().toUpperCase();
    const docId = (req.params.docId || "").trim();
    if (!/^[A-Z0-9]{4,12}$/.test(code) || !/^[0-9a-f-]{36}$/i.test(docId)) {
      return res.status(400).json({ error: "invalid_params" });
    }
    const user = await authUser(req);
    if (!user) return res.status(401).json({ error: "auth_required" });

    const gate = await assertInRoom(code, user);
    if (!gate.ok) return res.status(403).json({ error: gate.error });

    // Check user's private doc first, fall back to shared room doc
    let doc = roomDocuments.getUserDoc(code, user.email);
    if (!doc || doc.docId !== docId) {
      doc = roomDocuments.getActiveDoc(code);
    }
    if (!doc || doc.docId !== docId) {
      return res.status(404).json({ error: "document_not_found" });
    }

    const ext =
      doc.storageExt && String(doc.storageExt).startsWith(".")
        ? String(doc.storageExt).toLowerCase()
        : extFromName(doc.fileName) || ".bin";
    let filePath;
    try {
      filePath = roomDocuments.safeJoinUploadDir(uploadDir, docId, ext);
    } catch {
      return res.status(400).json({ error: "invalid_document" });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "file_missing" });
    }

    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(doc.fileName)}"`
    );
    res.type(doc.mime || "application/octet-stream");
    fs.createReadStream(filePath).pipe(res);
  });

  /**
   * Ask Eazii AI about the user's private document. Body: { question: string, language?: string }
   */
  router.post(
    "/rooms/:code/documents/chat",
    express.json({ limit: "48kb" }),
    async (req, res) => {
      const code = (req.params.code || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{4,12}$/.test(code)) {
        return res.status(400).json({ error: "invalid_code" });
      }
      const user = await authUser(req);
      if (!user) return res.status(401).json({ error: "auth_required" });

      const gate = await assertInRoom(code, user);
      if (!gate.ok) return res.status(403).json({ error: gate.error });

      if (!GEMINI_KEY) {
        return res.status(503).json({
          error: "gemini_not_configured",
          message: "Server has no GEMINI_API_KEY. Add it to .env and restart.",
        });
      }

      // Use the user's own private document
      const doc = roomDocuments.getUserDoc(code, user.email);
      if (!doc || !doc.ready || !(doc.extractedText && String(doc.extractedText).trim())) {
        return res.status(400).json({
          error: "no_document",
          message: "Upload a document first, then ask questions about it.",
        });
      }

      const question =
        typeof req.body?.question === "string"
          ? req.body.question.trim().slice(0, 4000)
          : "";
      if (!question) {
        return res.status(400).json({ error: "question_required" });
      }

      // Accept optional language hint from client
      const language =
        typeof req.body?.language === "string"
          ? req.body.language.trim().slice(0, 20)
          : "";

      const ck = `${code}:${String(user.email || "").toLowerCase()}`;
      const now = Date.now();
      const last = docChatLastByUser.get(ck) || 0;
      if (now - last < DOC_CHAT_COOLDOWN_MS) {
        return res.status(429).json({ error: "rate_limited" });
      }
      docChatLastByUser.set(ck, now);

      const contextText = String(doc.extractedText).slice(0, MAX_GEMINI_CONTEXT);

      try {
        const answer = await askAboutDocument({
          contextText,
          question,
          apiKey: GEMINI_KEY,
          language,
        });
        return res.json({ answer });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error("[doc chat]", msg);
        return res.status(502).json({
          error: "gemini_error",
          message: msg.slice(0, 600),
        });
      }
    }
  );

  return router;
}
