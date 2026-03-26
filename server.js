import "dotenv/config";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";

/* Prevent unhandled rejections from crashing the process */
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});
import QRCode from "qrcode";
import { Server } from "socket.io";
import { toNodeHandler } from "better-auth/node";
import { auth, signToken, verifyToken } from "./lib/auth.js";
import * as rooms from "./lib/rooms.js";
import * as roomDocuments from "./lib/roomDocuments.js";
import { createDocumentsRouter } from "./routes/documents.js";
import * as meetingDoc from "./lib/meetingDocumentPipeline.js";
import * as meetingTranscript from "./lib/meetingTranscript.js";
import { generateSummary, askAboutMeeting, getSummary } from "./lib/meetingSummary.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getKey, markLimited, isRateLimitError } from "./lib/geminiKeys.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const LT_URL = process.env.LIBRETRANSLATE_URL || "https://libretranslate.com";
const LT_KEY = process.env.LIBRETRANSLATE_API_KEY || "";

/* Ensure uploads directory exists at startup */
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads"));
fs.mkdirSync(uploadDir, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 5e6, // 5 MB — enough for 4-second audio chunks
});

/** CORS for API calls — must be before all API routes */
app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ── better-auth handler — MUST be before express.json() ── */
app.all("/api/auth/*", toNodeHandler(auth));

app.use("/api", createDocumentsRouter(io));

app.use(express.json({ limit: "32kb" }));

app.use("/vendor", express.static(path.join(__dirname, "node_modules/simple-peer")));
app.get("/vendor/fingerpose.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "node_modules/fingerpose/dist/fingerpose.js"));
});

function joinUrlFromSocket(socket, code) {
  const host = socket.handshake.headers?.host || `localhost:${PORT}`;
  const proto = socket.handshake.headers["x-forwarded-proto"] || "http";
  return `${proto}://${host}/?join=${encodeURIComponent(code)}`;
}


/** GET /api/health */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/** POST /api/login { email, name } -> { token } (legacy JWT login) */
app.post("/api/login", (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().slice(0, 320) : "";
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Valid email required" });
  }
  if (!name) {
    return res.status(400).json({ error: "Name required" });
  }
  try {
    const token = signToken({ email, name });
    return res.json({ token });
  } catch {
    return res.status(500).json({ error: "Could not issue token" });
  }
});

/** PNG QR for join URL */
app.get("/api/qr/:code", async (req, res) => {
  const code = (req.params.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) {
    return res.status(400).send("Invalid code");
  }
  try {
    const host = req.get("host") || `localhost:${PORT}`;
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const url = `${proto}://${host}/?join=${encodeURIComponent(code)}`;
    const png = await QRCode.toBuffer(url, { type: "png", width: 256, margin: 2 });
    res.type("png");
    res.send(png);
  } catch {
    res.status(500).send("QR failed");
  }
});

/** Language code to name map for Gemini prompt */
const LANG_NAMES = {
  en:"English",my:"Myanmar",th:"Thai",ja:"Japanese",zh:"Chinese",ko:"Korean",
  fr:"French",de:"German",es:"Spanish",pt:"Portuguese",ru:"Russian",hi:"Hindi",
  ar:"Arabic",vi:"Vietnamese",id:"Indonesian",tr:"Turkish",it:"Italian",
  nl:"Dutch",pl:"Polish",uk:"Ukrainian",sv:"Swedish",ta:"Tamil",bn:"Bengali",
  ms:"Malay",tl:"Filipino",
};

/**
 * Batch-translate text into multiple target languages in a single Gemini call.
 * @param {string} text - Source text
 * @param {string} sourceLang - Source language code (e.g. "en")
 * @param {string[]} targetLangs - Array of target language codes (e.g. ["th", "ja"])
 * @returns {Promise<Object<string, string>>} Map of langCode -> translatedText
 */
async function batchTranslate(text, sourceLang, targetLangs) {
  // Filter out source language and deduplicate
  const unique = [...new Set(targetLangs.filter(l => l !== sourceLang))];
  if (!unique.length) return {};

  // If only one target, use a simple prompt
  const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const targets = unique.map(l => `"${l}": "${LANG_NAMES[l] || l}"`).join(", ");
  const sourceName = LANG_NAMES[sourceLang] || sourceLang;

  const prompt = unique.length === 1
    ? `Translate this ${sourceName} text to ${LANG_NAMES[unique[0]] || unique[0]}. Return ONLY the translated text, nothing else.\n\n${text}`
    : `Translate this ${sourceName} text into the following languages. Return ONLY a JSON object mapping language code to translated text, no markdown fences.\nTarget languages: {${targets}}\n\nText: ${text}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = getKey();
    if (!apiKey) return {};
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const raw = result.response.text().trim();

      if (unique.length === 1) {
        return { [unique[0]]: raw };
      }
      // Parse JSON
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      return JSON.parse(cleaned);
    } catch (err) {
      if (isRateLimitError(err)) { markLimited(apiKey, 60000); continue; }
      console.error("[translate] Gemini error:", err.message || err);
      return {};
    }
  }
  return {};
}

/** POST /api/translate { text, source, target } -> { translated } */
app.post("/api/translate", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 1000) : "";
  const source = typeof req.body?.source === "string" ? req.body.source.trim().slice(0, 10) : "auto";
  const target = typeof req.body?.target === "string" ? req.body.target.trim().slice(0, 10) : "";
  if (!text || !target) return res.status(400).json({ error: "text and target required" });
  if (source === target) return res.json({ translated: text });

  const targetName = LANG_NAMES[target] || target;
  const prompt = `Translate the following text to ${targetName}. Return ONLY the translated text, nothing else.\n\n${text}`;
  const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  // Try up to 3 different API keys from the pool
  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = getKey();
    if (!apiKey) return res.status(503).json({ error: "No GEMINI_API_KEY configured" });
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const translated = result.response.text().trim();
      return res.json({ translated });
    } catch (err) {
      if (isRateLimitError(err)) {
        markLimited(apiKey, 60000);
        continue; // try next key
      }
      return res.status(502).json({ error: "Translation failed", message: (err.message || "").slice(0, 200) });
    }
  }
  return res.status(429).json({ error: "All API keys rate limited. Try again shortly." });
});

/** GET /api/meeting-summary/:code — retrieve generated summary */
app.get("/api/meeting-summary/:code", (req, res) => {
  const code = (req.params.code || "").trim().toUpperCase();
  const data = getSummary(code);
  if (!data) return res.status(404).json({ error: "Summary not found or expired" });
  const { rawTranscript, ...safe } = data;
  res.json(safe);
});

/** POST /api/meeting-summary/:code/ask — ask AI about the meeting */
app.post("/api/meeting-summary/:code/ask", async (req, res) => {
  const code = (req.params.code || "").trim().toUpperCase();
  const question = typeof req.body?.question === "string" ? req.body.question.trim().slice(0, 2000) : "";
  if (!question) return res.status(400).json({ error: "question required" });
  const data = getSummary(code);
  if (!data) return res.status(404).json({ error: "Summary not found or expired" });
  try {
    const answer = await askAboutMeeting(code, question);
    res.json({ answer });
  } catch (err) {
    res.status(502).json({ error: "AI failed", message: (err.message || "").slice(0, 200) });
  }
});

/** PATCH /api/meeting-summary/:code/name — set meeting name */
app.patch("/api/meeting-summary/:code/name", (req, res) => {
  const code = (req.params.code || "").trim().toUpperCase();
  const data = getSummary(code);
  if (!data) return res.status(404).json({ error: "Summary not found or expired" });
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
  data.meetingName = name;
  res.json({ ok: true });
});

/** GET /api/meeting-summary/:code/export — export summary as downloadable text */
app.get("/api/meeting-summary/:code/export", (req, res) => {
  const code = (req.params.code || "").trim().toUpperCase();
  const data = getSummary(code);
  if (!data) return res.status(404).json({ error: "Summary not found or expired" });

  const W = 58; // content width
  const meetingTitle = data.meetingName || "Meeting Summary";
  const dateStr = new Date(data.createdAt).toLocaleString();
  const duration = `${data.durationMinutes} minute(s)`;
  const attendees = data.attendees.join(", ") || "N/A";

  // ── helpers ──
  const hr      = (ch = "\u2500") => ch.repeat(W);
  const dblHr   = () => "\u2550".repeat(W);
  const center  = (s) => { const pad = Math.max(0, Math.floor((W - s.length) / 2)); return " ".repeat(pad) + s; };
  const wrap    = (text, indent = 0, width = W - indent) => {
    const words = text.split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      if (line && (line.length + 1 + w.length) > width) { lines.push(" ".repeat(indent) + line); line = w; }
      else { line = line ? line + " " + w : w; }
    }
    if (line) lines.push(" ".repeat(indent) + line);
    return lines.join("\n");
  };

  let c = "";

  // ── Header ──
  c += `\u250C${"\u2500".repeat(W + 2)}\u2510\n`;
  c += `\u2502 ${center(meetingTitle).padEnd(W)} \u2502\n`;
  c += `\u2514${"\u2500".repeat(W + 2)}\u2518\n`;
  c += "\n";

  // ── Meeting info ──
  c += `  \u25CF  Date       :  ${dateStr}\n`;
  c += `  \u25CF  Duration   :  ${duration}\n`;
  c += `  \u25CF  Room       :  ${code}\n`;
  c += `  \u25CF  Attendees  :  ${attendees}\n`;
  c += "\n";

  // ── Attendee details ──
  if (data.attendeeDetails && data.attendeeDetails.length) {
    c += `  \u25B8 ATTENDEES\n`;
    c += `  ${hr()}\n`;
    const fmtT = (ts) => ts ? new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "\u2014";
    const fmtD = (j, l) => { const m = Math.round(((l || Date.now()) - j) / 60000); return m < 1 ? "<1 min" : m + " min"; };
    data.attendeeDetails.forEach((a) => {
      c += `    \u25CF  ${a.name.padEnd(18)}  Joined: ${fmtT(a.joinedAt)}   Left: ${fmtT(a.leftAt)}   Duration: ${fmtD(a.joinedAt, a.leftAt)}\n`;
    });
    c += "\n";
  }

  c += dblHr() + "\n";

  // ── Overview ──
  c += "\n";
  c += `  \u25B8 OVERVIEW\n`;
  c += `  ${hr()}\n`;
  c += wrap(data.summary || "No summary available.", 4) + "\n";
  c += "\n";

  // ── Topics ──
  if (data.topics.length) {
    c += `  \u25B8 TOPICS DISCUSSED\n`;
    c += `  ${hr()}\n`;
    data.topics.forEach((t, i) => {
      c += `\n    ${i + 1}.  ${t.title}\n`;
      c += wrap(t.details, 8) + "\n";
    });
    c += "\n";
  }

  // ── Assignments ──
  if (data.assignments.length) {
    c += `  \u25B8 ACTION ITEMS\n`;
    c += `  ${hr()}\n`;
    data.assignments.forEach((a, i) => {
      c += `    ${i + 1}.  [ ${a.assignee} ]  ${a.task}\n`;
    });
    c += "\n";
  }

  // ── Key Decisions ──
  if (data.keyDecisions && data.keyDecisions.length) {
    c += `  \u25B8 KEY DECISIONS\n`;
    c += `  ${hr()}\n`;
    data.keyDecisions.forEach((d, i) => {
      c += `    ${i + 1}.  ${d}\n`;
    });
    c += "\n";
  }

  // ── Transcript ──
  if (data.rawTranscript) {
    c += dblHr() + "\n";
    c += "\n";
    c += `  \u25B8 FULL TRANSCRIPT\n`;
    c += `  ${hr()}\n\n`;
    // Parse and reformat the raw transcript lines
    const lines = data.rawTranscript.split("\n");
    let inTranscript = false;
    for (const line of lines) {
      if (line.startsWith("=== Meeting Transcript ===")) { inTranscript = true; continue; }
      if (!inTranscript) continue;
      if (!line.trim()) continue;
      // Lines look like: "10:30 AM [Voice] Alice: hello"
      const m = line.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*\[(\w+)]\s*(.+?):\s*(.*)$/i);
      if (m) {
        const [, time, type, speaker, text] = m;
        const tag = type.toLowerCase() === "voice" ? "\u{1F399}" : type.toLowerCase() === "sign" ? "\u{1F91F}" : "\u{1F4AC}";
        c += `    ${time.padEnd(9)} ${tag}  ${speaker.padEnd(14)}  ${text}\n`;
      } else {
        c += `    ${line}\n`;
      }
    }
    c += "\n";
  }

  // ── Footer ──
  c += dblHr() + "\n";
  c += center("Generated by Ez Meeting") + "\n";
  c += center(dateStr) + "\n";

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  const safeName = (data.meetingName || "").replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "-");
  const fileName = safeName ? `${safeName}.txt` : `meeting-summary-${code}.txt`;
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(c);
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ── Socket.io auth middleware ── */
io.use(async (socket, next) => {
  // Try better-auth cookie session first
  const cookies = socket.handshake.headers.cookie || "";
  if (cookies) {
    try {
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: cookies }),
      });
      if (session && session.user) {
        socket.user = { email: session.user.email, name: session.user.name };
        return next();
      }
    } catch (_) { /* fall through to JWT */ }
  }

  // Fallback: JWT token (for legacy email+name login)
  const raw = socket.handshake.auth?.token || socket.handshake.query?.token;
  const token = typeof raw === "string" ? raw : "";
  if (!token) {
    return next(new Error("auth_required"));
  }
  try {
    socket.user = verifyToken(token);
    return next();
  } catch {
    return next(new Error("invalid_token"));
  }
});

async function clearRoomSockets(code) {
  const socks = await io.in(code).fetchSockets();
  for (const s of socks) {
    s.data.roomCode = null;
    s.leave(code);
  }
}

io.on("connection", (socket) => {
  socket.data.roomCode = null;
  socket.data.speakLang = "en";
  socket.data.subtitleLang = "en";

  socket.on("room:create", (payload, ack) => {
    // Support both (ack) and (payload, ack) signatures
    if (typeof payload === "function") { ack = payload; payload = {}; }
    if (socket.data.roomCode) {
      if (typeof ack === "function") ack({ error: "already_in_room" });
      return;
    }
    socket.data.speakLang = typeof payload?.speakLang === "string" ? payload.speakLang.slice(0, 10) : "en";
    socket.data.subtitleLang = typeof payload?.subtitleLang === "string" ? payload.subtitleLang.slice(0, 10) : "en";
    const code = rooms.createRoom(socket.id);
    socket.join(code);
    socket.data.roomCode = code;
    rooms.setParticipantMeta(code, socket.id, socket.user);
    meetingTranscript.initRoom(code);
    meetingTranscript.addAttendee(code, socket.user.name);
    const peers = rooms.listPeers(code, socket.id);
    if (typeof ack === "function") {
      ack({
        code,
        joinUrl: joinUrlFromSocket(socket, code),
        peers,
        isHost: true,
      });
    }
  });

  socket.on("room:join", (payload, ack) => {
    const codeRaw = typeof payload?.code === "string" ? payload.code.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{4,12}$/.test(codeRaw)) {
      if (typeof ack === "function") ack({ error: "invalid_code" });
      return;
    }
    if (socket.data.roomCode) {
      if (typeof ack === "function") ack({ error: "already_in_room" });
      return;
    }
    const r = rooms.joinRoom(codeRaw, socket.id);
    if (!r.ok) {
      if (typeof ack === "function") ack({ error: "not_found" });
      return;
    }
    socket.data.speakLang = typeof payload?.speakLang === "string" ? payload.speakLang.slice(0, 10) : "en";
    socket.data.subtitleLang = typeof payload?.subtitleLang === "string" ? payload.subtitleLang.slice(0, 10) : "en";
    socket.join(codeRaw);
    socket.data.roomCode = codeRaw;
    rooms.setParticipantMeta(codeRaw, socket.id, socket.user);
    meetingTranscript.initRoom(codeRaw);
    meetingTranscript.addAttendee(codeRaw, socket.user.name);
    const peerList = rooms.listPeers(codeRaw, socket.id);
    const host = rooms.isHost(codeRaw, socket.id);
    if (typeof ack === "function") {
      ack({
        code: codeRaw,
        joinUrl: joinUrlFromSocket(socket, codeRaw),
        peers: peerList,
        isHost: host,
      });
    }
    socket.to(codeRaw).emit("peer:joined", {
      peerId: socket.id,
      name: socket.user.name,
    });

    // Emit user's private doc if they have one, otherwise shared room doc
    meetingDoc.emitUserPayloadForOneSocket(io, socket, codeRaw).catch(() => {});
    meetingDoc.emitPayloadForOneSocket(io, socket, codeRaw).catch((err) => console.error("[doc emit]", err));
  });

  socket.on("signal", (payload) => {
    const targetId = typeof payload?.targetId === "string" ? payload.targetId : "";
    const signal = payload?.signal;
    if (!targetId || signal === undefined) return;
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.getRoom(code);
    if (!room || !room.participants.has(targetId) || !room.participants.has(socket.id)) return;
    io.to(targetId).emit("signal", { fromId: socket.id, signal });
  });

  socket.on("chat:message", (payload) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const text = typeof payload?.text === "string" ? payload.text.slice(0, 2000) : "";
    if (!text.trim()) return;
    const chatAt = Date.now();
    meetingTranscript.addEntry(code, { at: chatAt, from: socket.user.name, text, type: "chat" });
    io.to(code).emit("chat:message", {
      text,
      at: chatAt,
      from: socket.user.name,
      socketId: socket.id,
    });
  });

  const SIGN_KINDS = new Set(["gesture", "spell", "model"]);

  socket.on("doc:setLanguage", (payload) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const raw =
      typeof payload?.preferredLanguage === "string"
        ? payload.preferredLanguage.trim().slice(0, 12)
        : "";
    socket.data.preferredLanguage = raw || "en";
    meetingDoc.emitUserPayloadForOneSocket(io, socket, code).catch(() => {});
    meetingDoc.emitPayloadForOneSocket(io, socket, code).catch((err) => console.error("[doc emit]", err));
  });

  socket.on("sign:caption", (payload) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const now = Date.now();
    if (!socket.data.signCaptionLog) socket.data.signCaptionLog = [];
    socket.data.signCaptionLog = socket.data.signCaptionLog.filter((t) => now - t < 1000);
    if (socket.data.signCaptionLog.length >= 12) return;
    socket.data.signCaptionLog.push(now);

    const text = typeof payload?.text === "string" ? payload.text.slice(0, 500) : "";
    if (!text.trim()) return;
    const gestureKey =
      typeof payload?.gestureKey === "string" ? payload.gestureKey.slice(0, 64) : "";
    let kind = typeof payload?.kind === "string" ? payload.kind.trim().toLowerCase() : "gesture";
    if (!SIGN_KINDS.has(kind)) kind = "gesture";
    const lang =
      typeof payload?.lang === "string" ? payload.lang.trim().slice(0, 16) : "";
    const translatedText =
      typeof payload?.translatedText === "string"
        ? payload.translatedText.trim().slice(0, 500)
        : "";

    const signAt = Date.now();
    meetingTranscript.addEntry(code, { at: signAt, from: socket.user.name, text: text.trim(), type: "sign" });
    io.to(code).emit("sign:caption", {
      text: text.trim(),
      gestureKey,
      kind,
      lang: lang || undefined,
      translatedText: translatedText || undefined,
      at: signAt,
      from: socket.user.name,
      socketId: socket.id,
    });
  });

  /* ── Real-time voice-to-text captions with translation ── */
  socket.on("caption:voice", async (payload) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const now = Date.now();
    if (!socket.data.voiceCaptionLog) socket.data.voiceCaptionLog = [];
    socket.data.voiceCaptionLog = socket.data.voiceCaptionLog.filter((t) => now - t < 1000);
    if (socket.data.voiceCaptionLog.length >= 20) return;
    socket.data.voiceCaptionLog.push(now);

    const text = typeof payload?.text === "string" ? payload.text.slice(0, 1000) : "";
    const isFinal = !!payload?.isFinal;
    const senderLang = socket.data.speakLang || "en";

    // For interim results, relay immediately without translation
    if (!isFinal || !text.trim()) {
      socket.to(code).emit("caption:voice", {
        text, isFinal, lang: senderLang, at: now,
        from: socket.user.name, socketId: socket.id,
      });
      return;
    }

    // Final result — collect target languages from all participants in the room
    const roomSockets = await io.in(code).fetchSockets();
    const targetLangs = new Set();
    for (const s of roomSockets) {
      if (s.id !== socket.id) targetLangs.add(s.data.subtitleLang || "en");
    }
    // Always include English for the meeting summary/transcript
    targetLangs.add("en");

    // Translate via Gemini (skip if sender speaks the only needed language)
    let translations = {};
    const needsTranslation = [...targetLangs].some(l => l !== senderLang);
    if (needsTranslation) {
      translations = await batchTranslate(text.trim(), senderLang, [...targetLangs]);
    }

    // Store English version in transcript for summary
    const englishText = senderLang === "en" ? text.trim() : (translations["en"] || text.trim());
    meetingTranscript.addEntry(code, {
      at: now, from: socket.user.name, text: englishText, type: "voice",
    });

    // Emit personalized translated captions to each participant
    for (const s of roomSockets) {
      if (s.id === socket.id) continue;
      const theirLang = s.data.subtitleLang || "en";
      const translatedText = (theirLang === senderLang)
        ? text.trim()
        : (translations[theirLang] || text.trim());
      s.emit("caption:voice", {
        text: text.trim(),
        translatedText,
        isFinal: true,
        lang: senderLang,
        at: now,
        from: socket.user.name,
        socketId: socket.id,
      });
    }
  });

  // ── Screen share permission flow ──
  socket.on("screen:request", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.getRoom(code);
    if (!room) return;
    // Host can share directly — no permission needed
    if (room.hostId === socket.id) {
      socket.emit("screen:approved");
      return;
    }
    // Send request to host
    const name = socket.user?.name || "Someone";
    io.to(room.hostId).emit("screen:request", { fromId: socket.id, fromName: name });
  });

  socket.on("screen:respond", (payload) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.getRoom(code);
    if (!room || room.hostId !== socket.id) return; // only host can respond
    const targetId = typeof payload?.targetId === "string" ? payload.targetId : "";
    const approved = !!payload?.approved;
    if (!targetId) return;
    io.to(targetId).emit(approved ? "screen:approved" : "screen:denied");
  });

  socket.on("room:end", async () => {
    const code = socket.data.roomCode;
    if (!code) return;
    if (!rooms.endRoomByHost(code, socket.id)) return;
    roomDocuments.clearRoom(code);
    // Generate summary before notifying clients
    let summaryCode = null;
    const transcript = meetingTranscript.getTranscript(code);
    if (transcript && transcript.entries.length > 0) {
      summaryCode = code;
      generateSummary(code).then(() => {
        meetingTranscript.deleteTranscript(code);
      }).catch((err) => {
        console.error("[meeting-summary] generation failed:", err);
        meetingTranscript.deleteTranscript(code);
      });
    } else {
      meetingTranscript.deleteTranscript(code);
    }
    io.to(code).emit("room:ended", { reason: "host_ended", summaryCode });
    await clearRoomSockets(code);
  });

  socket.on("room:leave", async (ack) => {
    const code = socket.data.roomCode;
    let summaryCode = null;
    if (code) {
      const transcript = meetingTranscript.getTranscript(code);
      if (transcript && transcript.entries.length > 0) {
        summaryCode = code;
        try { await generateSummary(code); } catch (_) {}
      }
    }
    await leaveSocketRoom(socket);
    if (typeof ack === "function") ack({ summaryCode });
  });

  socket.on("disconnecting", async () => {
    await leaveSocketRoom(socket);
  });
});

async function leaveSocketRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  meetingTranscript.markAttendeeLeft(code, socket.user.name);
  const result = rooms.removeParticipant(socket.id);
  socket.data.roomCode = null;
  if (!result) {
    await socket.leave(code);
    return;
  }
  if (result.ended) {
    roomDocuments.clearRoom(result.code);
    let summaryCode = null;
    const transcript = meetingTranscript.getTranscript(result.code);
    if (transcript && transcript.entries.length > 0) {
      summaryCode = result.code;
      generateSummary(result.code).then(() => {
        meetingTranscript.deleteTranscript(result.code);
      }).catch(() => {
        meetingTranscript.deleteTranscript(result.code);
      });
    } else {
      meetingTranscript.deleteTranscript(result.code);
    }
    io.to(result.code).emit("room:ended", {
      reason: result.reason === "host_left" ? "host_left" : "empty",
      summaryCode,
    });
    await clearRoomSockets(result.code);
  } else {
    socket.to(result.code).emit("peer:left", { peerId: socket.id });
    await socket.leave(code);
  }
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use (another process is listening).\n` +
        `Stop it, e.g. find the PID:  lsof -i :${PORT}\n` +
        `Then:  kill <PID>\n` +
        `Or use another port:  PORT=3001 npm start`
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Ez meeting: http://localhost:${PORT}`);
  console.log(`Listening on ${HOST}:${PORT} (LAN ready)`);
});
