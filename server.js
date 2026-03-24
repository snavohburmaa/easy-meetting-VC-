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
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getKey, markLimited, isRateLimitError } from "./lib/geminiKeys.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const WHISPER_URL = process.env.WHISPER_URL || "http://127.0.0.1:5555";

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
  socket.data.preferredLanguage = "en";

  socket.on("room:create", (ack) => {
    if (socket.data.roomCode) {
      if (typeof ack === "function") ack({ error: "already_in_room" });
      return;
    }
    const code = rooms.createRoom(socket.id);
    socket.join(code);
    socket.data.roomCode = code;
    rooms.setParticipantMeta(code, socket.id, socket.user);
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
    socket.join(codeRaw);
    socket.data.roomCode = codeRaw;
    rooms.setParticipantMeta(codeRaw, socket.id, socket.user);
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
    io.to(code).emit("chat:message", {
      text,
      at: Date.now(),
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

    io.to(code).emit("sign:caption", {
      text: text.trim(),
      gestureKey,
      kind,
      lang: lang || undefined,
      translatedText: translatedText || undefined,
      at: Date.now(),
      from: socket.user.name,
      socketId: socket.id,
    });
  });

  /* ── Real-time voice-to-text captions ── */
  socket.on("caption:voice", (payload) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const now = Date.now();
    if (!socket.data.voiceCaptionLog) socket.data.voiceCaptionLog = [];
    socket.data.voiceCaptionLog = socket.data.voiceCaptionLog.filter((t) => now - t < 1000);
    if (socket.data.voiceCaptionLog.length >= 20) return;
    socket.data.voiceCaptionLog.push(now);

    const text = typeof payload?.text === "string" ? payload.text.slice(0, 1000) : "";
    const isFinal = !!payload?.isFinal;
    const lang = typeof payload?.lang === "string" ? payload.lang.slice(0, 16) : "";
    socket.to(code).emit("caption:voice", {
      text,
      isFinal,
      lang,
      at: Date.now(),
      from: socket.user.name,
      socketId: socket.id,
    });
  });

  /* ── Server-side Whisper transcription ── */
  socket.on("audio:chunk", async (payload) => {
    const code = socket.data.roomCode;
    if (!code) return;

    // Socket.io delivers binary fields as Buffer in Node.js
    const audioBuffer = payload?.audio;
    if (!audioBuffer || !Buffer.isBuffer(audioBuffer)) return;
    // Skip tiny payloads that are just silence headers
    if (audioBuffer.length < 500) return;

    const lang = typeof payload?.language === "string" ? payload.language.slice(0, 12) : "";
    const ext = typeof payload?.ext === "string" ? payload.ext.slice(0, 5) : ".webm";
    const filename = "chunk" + (ext.startsWith(".") ? ext : "." + ext);

    try {
      const blob = new Blob([audioBuffer], { type: ext === ".mp4" ? "audio/mp4" : ext === ".ogg" ? "audio/ogg" : "audio/webm" });
      const form = new FormData();
      form.append("audio", blob, filename);
      if (lang) form.append("language", lang);

      const resp = await fetch(`${WHISPER_URL}/transcribe`, {
        method: "POST",
        body: form,
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.error("[whisper] HTTP", resp.status, errText);
        return;
      }
      const result = await resp.json();
      const text = result.text || "";
      if (!text.trim()) return;

      // Emit transcription to the entire room (including sender)
      io.to(code).emit("caption:voice", {
        text: text.trim(),
        isFinal: true,
        lang: result.language || lang || "",
        at: Date.now(),
        from: socket.user.name,
        socketId: socket.id,
      });
    } catch (err) {
      console.error("[whisper]", err.message || err);
    }
  });

  socket.on("room:end", async () => {
    const code = socket.data.roomCode;
    if (!code) return;
    if (!rooms.endRoomByHost(code, socket.id)) return;
    roomDocuments.clearRoom(code);
    io.to(code).emit("room:ended", { reason: "host_ended" });
    await clearRoomSockets(code);
  });

  socket.on("room:leave", async () => {
    await leaveSocketRoom(socket);
  });

  socket.on("disconnecting", async () => {
    await leaveSocketRoom(socket);
  });
});

async function leaveSocketRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const result = rooms.removeParticipant(socket.id);
  socket.data.roomCode = null;
  if (!result) {
    await socket.leave(code);
    return;
  }
  if (result.ended) {
    roomDocuments.clearRoom(result.code);
    io.to(result.code).emit("room:ended", {
      reason: result.reason === "host_left" ? "host_left" : "empty",
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

server.listen(PORT, () => {
  console.log(`Ez meeting: http://localhost:${PORT}`);
});
