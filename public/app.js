(function () {
  const TOKEN_KEY = "ezmeeting_token";
  const AUTH_TYPE_KEY = "ezmeeting_auth_type"; // "jwt"
  const RECEIVE_LANG_KEY = "ezmeeting_receive_lang";

const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  
  let recognition = null;
  let running = false;


  let langEl = '';
  recognition = new RecognitionCtor();
    recognition.lang = langEl.value || "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    running = true;

    recognition.onstart = () => {
      setStatus(`Listening (${recognition.lang})...`);
      // console.log("[STT] started", { lang: recognition.lang });
    };

    function setStatus(msg) {
  meetingStatus(msg);
}

    recognition.onresult = (event) => {
      const finals = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = String(result[0]?.transcript || "").trim();
        if (!transcript) continue;
        if (result.isFinal) {
          finals.push(transcript);
        }
      }
      if (!finals.length) return;
      const sentence = finals.join(" ").replace(/\s+/g, " ").trim();
      if (!sentence || sentence === lastFinalSentence) return;
      lastFinalSentence = sentence;
      console.log("[STT FINAL]", sentence);

// send to others
if (socket && socket.connected) {
  socket.emit("stt:message", {
    text: sentence,
    lang: recognition.lang || "en-US",
    at: Date.now()
  });
  console.log("[STT] emitted",socket.id , sentence);
}
    };

    recognition.onerror = (event) => {
      const msg = event?.error || "recognition_error";
      setStatus(`Error: ${msg}`);
      console.warn("[STT ERROR]", msg);
    };

    recognition.onend = () => {
      if (!running) return;
      try {
        recognition.start();
      } catch (_) {
        setStatus("Reconnecting...");
      }
    };

    try{
      recognition.start();
    }catch(e){
      setStatus("Could not start recognition: " + (e.message || e));
    }


  let socket = null;
  let localStream = null;
  const peers = new Map();
  let meetingState = { joinUrl: "", code: "", isHost: false };
  let busy = false;

  let lastLocalSignLine = "";
  let localSpellDraft = "";
  const ttsPending = [];
  const MAX_TTS_QUEUED = 3;
  const sttSubtitleTimers = new Map();

  let docPdfBlobUrl = null;
  let pdfDoc = null;
  let currentPage = 1;
  let activeDocId = null;

  let sidebarOpen = false;
  let activeSidebarTab = "chat";

  let micMuted = false;
  let camMuted = false;

  // Voice-to-text state
  let sttRecognition = null;
  let sttActive = false;
  let lastFinalSentence = "";

  // NotebookLM conversation history (client-side only)
  let notebookConversation = [];

  const SimplePeerCtor = window.SimplePeer;
  if (typeof SimplePeerCtor !== "function") {
    console.error("SimplePeer not loaded");
  }

  const $ = (id) => document.getElementById(id);

  // ── Token helpers ────────────────────────────────────────────
  function getToken()    { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t)   { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken()  { localStorage.removeItem(TOKEN_KEY); }
  function getAuthType() { return localStorage.getItem(AUTH_TYPE_KEY) || "jwt"; }
  function setAuthType(t) { localStorage.setItem(AUTH_TYPE_KEY, t); }
  function normalizeReceiveLang(code) {
    const c = typeof code === "string" ? code.trim().toLowerCase() : "";
    return /^[a-z]{2}$/.test(c) ? c : "en";
  }
  function getReceiveLang() {
    return normalizeReceiveLang(localStorage.getItem(RECEIVE_LANG_KEY) || "en");
  }
  function setReceiveLang(code) {
    localStorage.setItem(RECEIVE_LANG_KEY, normalizeReceiveLang(code));
  }


  // ── View management ──────────────────────────────────────────
  function showView(name) {
    ["view-login", "view-lobby", "view-meeting"].forEach((id) => {
      const el = $(id);
      el.classList.add("hidden");
      el.style.display = "";
    });
    const target = $("view-" + name);
    if (target) {
      target.classList.remove("hidden");
    }
  }

  function meetingStatus(msg) {
    const el = $("meeting-status");
    if (el) el.textContent = msg || "";
  }

  // ── Sidebar management ───────────────────────────────────────
  function openSidebar(tabName) {
    const sidebar = $("meeting-sidebar");
    if (!sidebar) return;
    sidebarOpen = true;
    sidebar.classList.remove("sidebar-hidden");
    switchSidebarTab(tabName || activeSidebarTab);
    updateControlIcons();
  }

  function closeSidebar() {
    const sidebar = $("meeting-sidebar");
    if (!sidebar) return;
    sidebarOpen = false;
    sidebar.classList.add("sidebar-hidden");
    updateControlIcons();
  }

  function toggleSidebar(tabName) {
    if (sidebarOpen && activeSidebarTab === (tabName || activeSidebarTab)) {
      closeSidebar();
    } else {
      openSidebar(tabName);
    }
  }

  function switchSidebarTab(tabName) {
    activeSidebarTab = tabName;
    document.querySelectorAll(".sidebar-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    document.querySelectorAll(".sidebar-panel").forEach((p) => {
      p.classList.remove("active");
    });
    const panelId = "panel-" + tabName;
    const panel = $(panelId);
    if (panel) panel.classList.add("active");
  }

  function updateControlIcons() {
    const btn = $("btn-toggle-sidebar");
    if (btn) btn.classList.toggle("active", sidebarOpen && activeSidebarTab === "chat");
    const docBtn = $("btn-open-doc");
    if (docBtn) docBtn.classList.toggle("active", sidebarOpen && activeSidebarTab === "doc");
    const langBtn = $("btn-open-language");
    if (langBtn) langBtn.classList.toggle("active", sidebarOpen && activeSidebarTab === "chat");
  }

  // ── Insight tabs ─────────────────────────────────────────────
  function initInsightTabs() {
    if (!document.querySelector(".insight-tab")) return;
    document.querySelectorAll(".insight-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const key = tab.dataset.insight;
        document.querySelectorAll(".insight-tab").forEach(t => t.classList.remove("active"));
        document.querySelectorAll(".insight-panel").forEach(p => p.classList.remove("active"));
        tab.classList.add("active");
        const panel = $("insight-panel-" + key);
        if (panel) panel.classList.add("active");
      });
    });
  }

  function initSidebarTabs() {
    document.querySelectorAll(".sidebar-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!sidebarOpen) {
          openSidebar(btn.dataset.tab);
        } else {
          switchSidebarTab(btn.dataset.tab);
        }
        updateControlIcons();
      });
    });
  }

  // ── Mic / Cam toggle ─────────────────────────────────────────
  function svgIcon(name) {
    return `<i data-lucide="${name}" style="width:20px;height:20px;stroke:currentColor;stroke-width:2;"></i>`;
  }

  function renderIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  function setMicMuted(muted) {
    micMuted = muted;
    if (localStream) {
      localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
    }
    const btn = $("btn-toggle-mic");
    if (btn) {
      btn.innerHTML = svgIcon(muted ? "mic-off" : "mic");
      btn.classList.toggle("muted-state", muted);
      btn.title = muted ? "Unmute microphone" : "Mute microphone";
      renderIcons();
    }
  }

  function setCamMuted(muted) {
    camMuted = muted;
    if (localStream) {
      localStream.getVideoTracks().forEach(t => { t.enabled = !muted; });
    }
    const btn = $("btn-toggle-cam");
    if (btn) {
      btn.innerHTML = svgIcon(muted ? "camera-off" : "camera");
      btn.classList.toggle("muted-state", muted);
      btn.title = muted ? "Turn on camera" : "Turn off camera";
      renderIcons();
    }
  }

  // ── Lobby user display ───────────────────────────────────────
  function decodeJwtPayload(token) {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      return JSON.parse(atob(b64));
    } catch { return null; }
  }

  async function refreshLobbyUser() {
    const legacyChip = $("lobby-user");
    const av = $("lobby-user-avatar");

    const t = getToken();
    if (!t) { if (legacyChip) legacyChip.textContent = ""; return; }
    const payload = decodeJwtPayload(t);
    const name  = (payload && (payload.name  || payload.email)) || "Signed in";
    const email = (payload && payload.email) || "";
    if (legacyChip) legacyChip.textContent = name + (email ? " · " + email : "");
    if (av) av.textContent = name.charAt(0).toUpperCase();
  }

  // ── Subtitle helpers ─────────────────────────────────────────
  function renderLocalSignSubtitle() {
    const el = $("local-sign-subtitle");
    if (!el) return;
    if (!lastLocalSignLine && !localSpellDraft) { el.textContent = ""; return; }
    el.textContent = "";
    if (lastLocalSignLine) el.appendChild(document.createTextNode(lastLocalSignLine));
    if (localSpellDraft) {
      const span = document.createElement("span");
      span.className = "sign-draft";
      span.textContent = "Spelling: " + localSpellDraft;
      el.appendChild(span);
    }
  }

  function setRemoteSignSubtitle(peerId, data) {
    const wrap = document.getElementById("remote-" + peerId);
    if (!wrap) return;
    const sub = wrap.querySelector(".remote-sign-subtitle");
    if (!sub) return;
    let line = data.text || "";
    if (data.translatedText) line += " · " + data.translatedText;
    const kind = data.kind && data.kind !== "gesture" ? " [" + data.kind + "]" : "";
    sub.textContent = line ? line + kind : "";
  }

  function clearSttSubtitleTimer(key) {
    const t = sttSubtitleTimers.get(key);
    if (t) {
      clearTimeout(t);
      sttSubtitleTimers.delete(key);
    }
  }

  function scheduleSttSubtitleClear(key, el) {
    if (!el) return;
    clearSttSubtitleTimer(key);
    const t = setTimeout(() => {
      el.textContent = "";
      sttSubtitleTimers.delete(key);
    }, 5000);
    sttSubtitleTimers.set(key, t);
  }

  function sttSubtitleText(data) {
    let line = data && data.text ? String(data.text) : "";
    if (data && data.translatedText) line += ` → ${data.translatedText}`;
    return line;
  }

  function setLocalSttSubtitle(data) {
    const el = $("local-stt-subtitle");
    if (!el) return;
    el.textContent = sttSubtitleText(data);
    scheduleSttSubtitleClear("local", el);
  }

  function setRemoteSttSubtitle(peerId, data) {
    const wrap = document.getElementById("remote-" + peerId);
    if (!wrap) return;
    const sub = wrap.querySelector(".remote-stt-subtitle");
    if (!sub) return;
    sub.textContent = sttSubtitleText(data);
    scheduleSttSubtitleClear("remote:" + peerId, sub);
  }

  // ── TTS ──────────────────────────────────────────────────────
  function flushTtsQueue() {
    if (!window.speechSynthesis) return;
    const chk = $("sign-tts-enable");
    if (!chk || !chk.checked) {
      try { speechSynthesis.cancel(); } catch (_) {}
      ttsPending.length = 0;
      return;
    }
    if (document.hidden) return;
    if (speechSynthesis.speaking || speechSynthesis.pending) return;
    const next = ttsPending.shift();
    if (!next) return;
    const u = new SpeechSynthesisUtterance(next.text);
    u.lang = next.lang || "en-US";
    u.onend = () => flushTtsQueue();
    u.onerror = () => flushTtsQueue();
    speechSynthesis.speak(u);
  }

  function enqueueSignTts(text, lang) {
    const chk = $("sign-tts-enable");
    if (!chk || !chk.checked || !text) return;
    if (ttsPending.length >= MAX_TTS_QUEUED) ttsPending.shift();
    ttsPending.push({ text, lang: lang || "en-US" });
    flushTtsQueue();
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) flushTtsQueue();
  });

  // ── PDF helpers ──────────────────────────────────────────────
  function hidePdfPreview() {
    const wrap = $("doc-pdf-wrap");
    const noPrev = $("doc-no-preview");
    const navWrap = $("slide-nav-wrap");
    if (wrap) wrap.classList.add("hidden");
    if (noPrev) noPrev.classList.remove("hidden");
    if (navWrap) navWrap.classList.add("hidden");
  }

  function showPdfPreview() {
    const wrap = $("doc-pdf-wrap");
    const noPrev = $("doc-no-preview");
    const navWrap = $("slide-nav-wrap");
    if (wrap) wrap.classList.remove("hidden");
    if (noPrev) noPrev.classList.add("hidden");
    if (navWrap) navWrap.classList.remove("hidden");
  }

  function updateSlideCounter() {
    const el = $("slide-counter");
    if (!el) return;
    const total = pdfDoc ? pdfDoc.numPages : 1;
    el.textContent = "Page " + currentPage + " / " + total;
  }

  async function renderPdfPage(pageNum) {
    if (!pdfDoc) return;
    pageNum = Math.max(1, Math.min(pageNum, pdfDoc.numPages));
    currentPage = pageNum;
    updateSlideCounter();
    const canvas = $("doc-pdf-canvas");
    if (!canvas) return;
    try {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.1 });
      const ctx = canvas.getContext("2d");
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (e) {
      console.warn("PDF page render", e);
    }
  }

  async function tryRenderPdfFirstPage(docId) {
    const canvas = $("doc-pdf-canvas");
    const code = meetingState.code;
    if (!canvas || !code || !docId) return;
    try {
      const res = await fetch(
        "/api/rooms/" + encodeURIComponent(code) +
        "/documents/" + encodeURIComponent(docId) + "/file",
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("file_fetch");
      const blob = await res.blob();
      if (docPdfBlobUrl) { try { URL.revokeObjectURL(docPdfBlobUrl); } catch (_) {} }
      docPdfBlobUrl = URL.createObjectURL(blob);
      const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc =
        "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.mjs";
      const data = await blob.arrayBuffer();
      pdfDoc = await pdfjs.getDocument({ data }).promise;
      currentPage = 1;
      updateSlideCounter();
      showPdfPreview();
      await renderPdfPage(1);
    } catch (e) {
      console.warn("PDF preview", e);
      hidePdfPreview();
    }
  }

  // ── Document panel helpers ───────────────────────────────────
  function resetDocPanel() {
    if (docPdfBlobUrl) { try { URL.revokeObjectURL(docPdfBlobUrl); } catch (_) {} docPdfBlobUrl = null; }
    pdfDoc = null;
    currentPage = 1;
    const st = $("doc-status");
    if (st) st.textContent = "";
    activeDocId = null;
    const chatIn = $("doc-chat-input");
    if (chatIn) chatIn.value = "";
    notebookConversation = [];
    renderNotebookConversation();
    hidePdfPreview();
  }

  function syncDocHostUi() {
    const row = $("doc-upload-row");
    if (row) row.classList.toggle("hidden", !meetingState.isHost);
  }

  function emitDocLanguage() {
    const sel = $("recv-lang-select") || $("doc-lang-select");
    if (!socket || !socket.connected || !sel) return;
    const lang = normalizeReceiveLang(sel.value);
    socket.emit("doc:setLanguage", { preferredLanguage: lang });
  }

  function applyDocPayload(d) {
    const st = $("doc-status");
    if (st) {
      st.innerHTML = '<span class="notebook-source-item"><i data-lucide="file-check" style="width:12px;height:12px;stroke:var(--green);stroke-width:2;"></i> ' +
        (d.fileName || "Document") + " — ready</span>";
      renderIcons();
    }
    activeDocId = d.docId || null;
    hidePdfPreview();
  }

  // ── NotebookLM-style conversation rendering ──────────────────
  function renderNotebookConversation() {
    const container = $("notebook-conversation");
    if (!container) return;
    container.innerHTML = "";

    if (notebookConversation.length === 0) {
      const empty = document.createElement("div");
      empty.className = "notebook-empty";
      empty.innerHTML = '<i data-lucide="sparkles" style="width:24px;height:24px;stroke:var(--text-3);stroke-width:1.5;"></i>' +
        '<p>Ask anything about the uploaded document. Gemini will analyze and answer in your language.</p>';
      container.appendChild(empty);
      renderIcons();
      return;
    }

    for (const msg of notebookConversation) {
      const bubble = document.createElement("div");
      bubble.className = "notebook-msg notebook-msg--" + msg.role;
      if (msg.role === "user") {
        bubble.textContent = msg.text;
      } else {
        // AI response — render with basic markdown-like formatting
        bubble.innerHTML = formatAiResponse(msg.text);
      }
      container.appendChild(bubble);
    }
    container.scrollTop = container.scrollHeight;
  }

  function formatAiResponse(text) {
    // Basic markdown: bold, bullet points, headers
    let html = escapeHtml(text);
    // Bold **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Headers ## text
    html = html.replace(/^### (.+)$/gm, '<div class="notebook-h3">$1</div>');
    html = html.replace(/^## (.+)$/gm, '<div class="notebook-h2">$1</div>');
    // Bullet points
    html = html.replace(/^[-*] (.+)$/gm, '<div class="notebook-bullet">$1</div>');
    // Numbered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<div class="notebook-bullet notebook-numbered">$1</div>');
    // Line breaks
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // ── Voice-to-Text (Web Speech API) ──────────────────────────
  function initStt() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      const btn = $("btn-stt");
      if (btn) btn.style.display = "none";
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }

      // Show interim in live bar
      const liveText = $("stt-live-text");
      if (liveText) liveText.textContent = interim || "Listening...";

      // When we get a final result, add to chat input
      const sentence = final.replace(/\s+/g, " ").trim();
      if (sentence && sentence !== lastFinalSentence) {
        lastFinalSentence = sentence;
        console.log("[STT FINAL]", sentence);
        const input = $("chat-input");
        if (input) {
          input.value += (input.value ? " " : "") + sentence;
        }
        if (liveText) liveText.textContent = "Listening...";
      }
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed") {
        meetingStatus("Microphone access denied for speech recognition.");
      }
      stopStt();
    };

    recognition.onend = () => {
      if (sttActive) {
        // Restart if still active (continuous mode can stop unexpectedly)
        try {
          const langSel = $("stt-lang-select");
          recognition.lang = langSel ? langSel.value : "en-US";
          recognition.start();
        } catch (_) {
          stopStt();
        }
      }
    };

    sttRecognition = recognition;
  }

  function startStt() {
    if (!sttRecognition) return;
    const langSel = $("stt-lang-select");
    sttRecognition.lang = langSel ? langSel.value : "en-US";
    sttActive = true;
    try { sttRecognition.start(); } catch (_) {}

    const bar = $("stt-live-bar");
    if (bar) bar.classList.remove("hidden");
    const btn = $("btn-stt");
    if (btn) btn.classList.add("active");
    const liveText = $("stt-live-text");
    if (liveText) liveText.textContent = "Listening...";
  }

  function stopStt() {
    sttActive = false;
    if (sttRecognition) {
      try { sttRecognition.stop(); } catch (_) {}
    }
    const bar = $("stt-live-bar");
    if (bar) bar.classList.add("hidden");
    const btn = $("btn-stt");
    if (btn) btn.classList.remove("active");
  }

  function toggleStt() {
    if (sttActive) {
      stopStt();
    } else {
      startStt();
    }
  }

  // ── Socket handlers ──────────────────────────────────────────
  function clearLobbyError()  { const el = $("lobby-error");  if (el) el.textContent = ""; }
  function clearLoginError()  { const el = $("login-error");  if (el) el.textContent = ""; }

  async function onConnectError(err) {
    console.error(err);
    await cleanupMeeting();
    const msg = String(err && err.message ? err.message : err);
    if (/invalid|auth|token/i.test(msg)) {
      clearToken();
      showView("login");
      $("login-error").textContent = "Session expired. Please sign in again.";
    } else {
      meetingStatus("Connection error: " + msg);
    }
  }

  function registerSocketHandlers() {
    if (!socket) return;

    socket.on("signal", ({ fromId, signal }) => {
      const peer = peers.get(fromId);
      if (peer && signal !== undefined) {
        try { peer.signal(signal); } catch (e) { console.warn("signal", e); }
      }
    });

    socket.on("peer:joined", ({ peerId, name }) => { addPeer(peerId, name || "Guest"); });
    socket.on("peer:left",   ({ peerId })        => { removePeer(peerId); });

    socket.on("chat:message", (data) => {
      const log = $("chat-log");
      const line = document.createElement("div");
      const t = new Date(data.at).toLocaleTimeString();
      line.textContent = `[${t}] ${data.from}: ${data.text}`;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    });

    socket.on("sign:caption", (data) => {
      const isSelf = socket && data.socketId === socket.id;
      if (isSelf) {
        lastLocalSignLine = data.text || "";
        renderLocalSignSubtitle();
      } else if (data.socketId) {
        setRemoteSignSubtitle(data.socketId, data);
      }

      ["sign-log", "sign-log-sidebar"].forEach((logId) => {
        const signLog = $(logId);
        if (signLog) {
          const line = document.createElement("div");
          line.className = "sign-line";
          const t = new Date(data.at).toLocaleTimeString();
          let body = `${data.from}: ${data.text}`;
          if (data.translatedText) body += ` → ${data.translatedText}`;
          if (data.kind && data.kind !== "gesture") body += ` (${data.kind})`;
          line.textContent = `[${t}] ${body}`;
          signLog.appendChild(line);
          signLog.scrollTop = signLog.scrollHeight;
        }
      });

      const chat = $("chat-log");
      if (chat) {
        const c = document.createElement("div");
        c.className = "sign-chat-echo";
        const t = new Date(data.at).toLocaleTimeString();
        c.textContent = `[Sign] [${t}] ${data.from}: ${data.text}`;
        chat.appendChild(c);
        chat.scrollTop = chat.scrollHeight;
      }

      if (!isSelf) enqueueSignTts(data.text, data.lang);
      flushTtsQueue();
    });

    socket.on("doc:processing", (d) => {
      activeDocId = null;
      notebookConversation = [];
      renderNotebookConversation();
      const st = $("doc-status");
      if (st) st.textContent = 'Processing "' + (d.fileName || "") + '"...';
    });

    socket.on("stt:message", (data) => {
      const isSelf = socket && data.socketId === socket.id;
      if (isSelf) {
        setLocalSttSubtitle(data);
      } else if (data.socketId) {
        setRemoteSttSubtitle(data.socketId, data);
      }
    });

    socket.on("doc:ready", (d) => {
      const st = $("doc-status");
      if (st) st.textContent = (d.fileName || "") + " · source: " + (d.sourceLanguage || "?");
    });

    socket.on("doc:payload", (d) => { applyDocPayload(d); });

    socket.on("doc:error", (d) => {
      activeDocId = null;
      const msg = d && d.message ? d.message : "Document error";
      meetingStatus("Document: " + msg);
      const st = $("doc-status");
      if (st) st.textContent = msg;
    });

    socket.on("doc:warn",   (d) => { if (d && d.message) meetingStatus(d.message); });

    socket.on("room:ended", async ({ reason }) => {
      const labels = {
        host_ended: "Meeting ended by host.",
        host_left:  "Host left — meeting closed.",
        empty:      "Everyone left — meeting closed.",
      };
      meetingStatus(labels[reason] || "Meeting ended.");
      await cleanupMeeting();
      showView("lobby");
      refreshLobbyUser();
    });
  }

  // ── Peer management ──────────────────────────────────────────
  function setupLocalVideo() {
    const v = $("local-video");
    if (v) v.srcObject = localStream;
  }

  function addPeer(peerId, remoteName) {
    if (!socket || !localStream || peers.has(peerId)) return;
    if (typeof SimplePeerCtor !== "function") return;
    const initiator = socket.id < peerId;
    const peer = new SimplePeerCtor({ initiator, stream: localStream, trickle: true, config: SimplePeerCtor.config });

    peer.on("signal", (signal) => {
      if (socket && socket.connected) socket.emit("signal", { targetId: peerId, signal });
    });

    peer.on("stream", (remoteStream) => {
      let wrap = document.getElementById("remote-" + peerId);
      if (!wrap) {
        wrap = document.createElement("div");
        wrap.className = "remote-wrap";
        wrap.id = "remote-" + peerId;
        const vid = document.createElement("video");
        vid.playsInline = true;
        vid.autoplay = true;
        vid.srcObject = remoteStream;
        const sub = document.createElement("div");
        sub.className = "video-subtitle remote-sign-subtitle";
        sub.setAttribute("aria-live", "polite");
        const sttSub = document.createElement("div");
        sttSub.className = "video-subtitle stt-subtitle remote-stt-subtitle";
        sttSub.setAttribute("aria-live", "polite");
        const lab = document.createElement("span");
        lab.className = "label";
        lab.textContent = remoteName || "Guest";
        wrap.appendChild(vid);
        wrap.appendChild(sub);
        wrap.appendChild(sttSub);
        wrap.appendChild(lab);
        $("remote-videos").appendChild(wrap);
      }
    });

    peer.on("close", () => removePeer(peerId));
    peer.on("error", (e) => console.warn("peer error", peerId, e));
    peers.set(peerId, peer);
  }

  function removePeer(peerId) {
    clearSttSubtitleTimer("remote:" + peerId);
    const peer = peers.get(peerId);
    if (peer) { try { peer.destroy(); } catch (_) {} peers.delete(peerId); }
    const wrap = document.getElementById("remote-" + peerId);
    if (wrap) wrap.remove();
  }

  // ── Meeting lifecycle ────────────────────────────────────────
  function updateMeetingMeta(ack) {
    meetingState = { code: ack.code, joinUrl: ack.joinUrl || "", isHost: !!ack.isHost };
    $('meeting-code-label').textContent = ack.code;
    $("qr-img").src = "/api/qr/" + encodeURIComponent(ack.code);
    $("btn-end").classList.toggle("hidden", !ack.isHost);
    meetingStatus("");
    $("chat-log").innerHTML = "";
    ["sign-log","sign-log-sidebar"].forEach(id => { const el = $(id); if(el) el.innerHTML = ""; });
    const hs = $("hand-sign-enable");
    if (hs) hs.checked = false;
    const sp = $("hand-sign-spell");
    if (sp) sp.checked = false;
    lastLocalSignLine = "";
    localSpellDraft = "";
    renderLocalSignSubtitle();
    document.querySelectorAll(".remote-sign-subtitle").forEach(n => { n.textContent = ""; });
    const localStt = $("local-stt-subtitle");
    if (localStt) localStt.textContent = "";
    document.querySelectorAll(".remote-stt-subtitle").forEach(n => { n.textContent = ""; });
    clearSttSubtitleTimer("local");
    resetDocPanel();
    syncDocHostUi();
    const dinput = $("doc-file-input");
    if (dinput) dinput.value = "";
    if (socket && socket.connected) emitDocLanguage();
    setMicMuted(false);
    setCamMuted(false);
  }

  async function stopHandSignCaptions() {
    if (window.HandSignCaptions && window.HandSignCaptions.isRunning()) {
      try { await window.HandSignCaptions.stop(); } catch (_) {}
    }
    const hs = $("hand-sign-enable");
    if (hs) hs.checked = false;
    localSpellDraft = "";
    renderLocalSignSubtitle();
  }

  async function cleanupMeeting() {
    stopStt();
    await stopHandSignCaptions();
    resetDocPanel();
    ttsPending.length = 0;
    if (window.speechSynthesis) { try { speechSynthesis.cancel(); } catch (_) {} }
    lastLocalSignLine = "";
    localSpellDraft = "";
    const locSub = $("local-sign-subtitle");
    if (locSub) locSub.textContent = "";
    const localStt = $("local-stt-subtitle");
    if (localStt) localStt.textContent = "";
    sttSubtitleTimers.forEach((t) => clearTimeout(t));
    sttSubtitleTimers.clear();
    peers.forEach(p => { try { p.destroy(); } catch (_) {} });
    peers.clear();
    $("remote-videos").innerHTML = "";
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    const lv = $("local-video");
    if (lv) lv.srcObject = null;
    if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
    busy = false;
    meetingStatus("");
    const qr = $("qr-img"); if (qr) qr.removeAttribute("src");
    closeSidebar();
    const hsBar = $("hand-sign-bar"); if(hsBar) hsBar.style.display = "none";
    micMuted = false; camMuted = false;
  }

  function buildSocketOpts() {
    const token = getToken();
    return { auth: { token } };
  }

  async function startHost() {
    if (busy) return;
    clearLobbyError();
    busy = true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      busy = false;
      $("lobby-error").textContent = "Camera/microphone access is required.";
      return;
    }
    // Check auth
    const token = getToken();
    if (!token) { busy = false; showView("login"); return; }

    showView("meeting");
    setupLocalVideo();
    socket = window.io(buildSocketOpts());
    socket.on("connect_error", onConnectError);
    registerSocketHandlers();
    const runCreate = () => {
      socket.emit("room:create", async (ack) => {
        if (!ack || ack.error) {
          meetingStatus("Could not create room: " + (ack && ack.error ? ack.error : "unknown"));
          await cleanupMeeting(); showView("lobby"); return;
        }
        updateMeetingMeta(ack);
        (ack.peers || []).forEach(p => addPeer(p.id, p.name));
        busy = false;
      });
    };
    if (socket.connected) runCreate(); else socket.once("connect", runCreate);
  }

  async function startJoin(rawCode) {
    if (busy) return;
    const code = String(rawCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4) { $("lobby-error").textContent = "Enter a valid meeting code."; return; }
    clearLobbyError();
    busy = true;
    // try {
    //   localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    // } catch (e) {
    //   busy = false;
    //   console.warn("Media access error", e);
    //   $("lobby-error").textContent = "Camera/microphone access is required.";
    //   return;
    // }
    const token = getToken();
    if (!token) { busy = false; showView("login"); return; }

    showView("meeting");
    setupLocalVideo();
    socket = window.io(buildSocketOpts());
    socket.on("connect_error", onConnectError);
    registerSocketHandlers();
    const runJoin = () => {
      socket.emit("room:join", { code }, async (ack) => {
        if (!ack || ack.error) {
          meetingStatus(ack && ack.error === "not_found"
            ? "Meeting not found or already ended."
            : "Could not join: " + (ack && ack.error ? ack.error : "unknown"));
          await cleanupMeeting(); showView("lobby"); return;
        }
        updateMeetingMeta(ack);
        (ack.peers || []).forEach(p => addPeer(p.id, p.name));
        busy = false;
        try { const u = new URL(window.location.href); u.searchParams.delete("join"); window.history.replaceState({}, "", u.toString()); } catch (_) {}
      });
    };
    if (socket.connected) runJoin(); else socket.once("connect", runJoin);
  }

  async function leaveMeeting() {
    if (socket && socket.connected) socket.emit("room:leave");
    await cleanupMeeting();
    showView("lobby");
    refreshLobbyUser();
  }

  function endMeetingForAll() {
    if (socket && socket.connected) socket.emit("room:end");
  }

  // ── Hand-sign captions ───────────────────────────────────────
  async function syncHandSignFromCheckbox() {
    const el = $("hand-sign-enable");
    const video = $("local-video");
    if (!el || !video) return;
    const want = el.checked;
    if (want) {
      if (!window.HandSignCaptions) { meetingStatus("Hand-sign script not loaded."); el.checked = false; return; }
      if (!window.HandSignAlphabetKit) { meetingStatus("Missing vendor/handsigns-alphabet.js — run: npm run build:handsigns"); el.checked = false; return; }
      try {
        meetingStatus("Loading hand models...");
        await window.HandSignCaptions.start(
          video,
          (payload) => {
            if (socket && socket.connected) {
              socket.emit("sign:caption", {
                text: payload.text, gestureKey: payload.gestureKey,
                kind: payload.kind || "gesture", lang: payload.lang, translatedText: payload.translatedText,
              });
            }
            if (payload.kind !== "spell" || payload.text) {
              lastLocalSignLine = payload.text || "";
              renderLocalSignSubtitle();
            }
          },
          {
            getSpellMode: () => { const e = $("hand-sign-spell"); return !!(e && e.checked); },
            onSpellPreview: (state) => {
              localSpellDraft = state && state.buffer ? state.buffer : "";
              renderLocalSignSubtitle();
            },
          }
        );
        meetingStatus("");
      } catch (e) {
        console.error(e);
        meetingStatus("Hand recognition failed: " + (e && e.message ? e.message : e));
        el.checked = false;
      }
    } else if (window.HandSignCaptions) {
      try { await window.HandSignCaptions.stop(); } catch (_) {}
    }
  }

  // ── Login ────────────────────────────────────────────────────
  async function submitLogin(ev) {
    ev.preventDefault();
    clearLoginError();
    const email = $("login-email").value.trim();
    const name  = $("login-name").value.trim();
    let res;
    try {
      res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name }),
      });
    } catch (err) {
      $("login-error").textContent =
        "Network error — is the server running? (npm start) " + String(err && err.message ? err.message : err);
      return;
    }
    const raw = await res.text();
    let data = {};
    if (raw) { try { data = JSON.parse(raw); } catch { $("login-error").textContent = `Server returned ${res.status} (not JSON). Run: npm start`; return; } }
    if (!res.ok) {
      $("login-error").textContent =
        data.error || (res.status === 404 || res.status === 405
          ? "API not found — run the backend: npm start"
          : `Request failed (${res.status}).`);
      return;
    }
    if (!data.token || typeof data.token !== "string") { $("login-error").textContent = "Invalid response: missing token."; return; }
    setToken(data.token);
    setAuthType("jwt");
    refreshLobbyUser();
    showView("lobby");
    applyJoinFromQuery();
  }

  function applyJoinFromQuery() {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("join");
      if (code) $("join-code").value = code.trim().toUpperCase();
    } catch (_) {}
  }

  async function logout() {
    clearToken();
    localStorage.removeItem(AUTH_TYPE_KEY);
    await cleanupMeeting();
    showView("login");
  }

  // ── Wire up all event listeners ──────────────────────────────
  function wireEvents() {
    // Login
    $("form-login").addEventListener("submit", submitLogin);

    // Lobby
    $("btn-host").addEventListener("click", () => startHost());
    $("form-join").addEventListener("submit", (ev) => { ev.preventDefault(); startJoin($("join-code").value); });
    $("btn-logout").addEventListener("click", logout);

    // Meeting controls
    $("btn-copy-link").addEventListener("click", async () => {
      const url = meetingState.joinUrl;
      if (!url) return;
      try { await navigator.clipboard.writeText(url); meetingStatus("Invite link copied!"); setTimeout(() => meetingStatus(""), 2500); }
      catch { meetingStatus("Copy manually: " + url); }
    });

    $("btn-leave").addEventListener("click", leaveMeeting);
    $("btn-end").addEventListener("click", endMeetingForAll);

    $("btn-toggle-mic").addEventListener("click", () => setMicMuted(!micMuted));
    $("btn-toggle-cam").addEventListener("click", () => setCamMuted(!camMuted));

    $("btn-toggle-sidebar").addEventListener("click", () => {
      toggleSidebar("chat");
      updateControlIcons();
    });

    $("btn-open-doc").addEventListener("click", () => {
      if (sidebarOpen && activeSidebarTab === "doc") { closeSidebar(); }
      else { openSidebar("doc"); }
      updateControlIcons();
    });

    const langBtn = $("btn-open-language");
    if (langBtn) {
      langBtn.addEventListener("click", () => {
        openSidebar("chat");
        const sel = $("recv-lang-select");
        if (sel) sel.focus();
        meetingStatus("Set your receive language for incoming voice translations.");
        setTimeout(() => meetingStatus(""), 3000);
        updateControlIcons();
      });
    }

    $("btn-toggle-handsign-bar").addEventListener("click", () => {
      const bar = $("hand-sign-bar");
      if (!bar) return;
      const isHidden = bar.style.display === "none" || bar.style.display === "";
      bar.style.display = isHidden ? "flex" : "none";
      const btn = $("btn-toggle-handsign-bar");
      if (btn) btn.classList.toggle("active", isHidden);
    });

    // Chat form
    $("form-chat").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const input = $("chat-input");
      const text = input.value.trim();
      if (!text || !socket) return;
      socket.emit("chat:message", { text });
      input.value = "";
    });

    // Voice-to-text button
    const sttBtn = $("btn-stt");
    if (sttBtn) sttBtn.addEventListener("click", toggleStt);

    // STT language change
    const sttLang = $("stt-lang-select");
    if (sttLang) sttLang.addEventListener("change", () => {
      if (sttActive) {
        stopStt();
        startStt();
      }
    });

    // Hand-sign checkboxes
    const handSignCb = $("hand-sign-enable");
    if (handSignCb) handSignCb.addEventListener("change", () => void syncHandSignFromCheckbox());

    const spellCb = $("hand-sign-spell");
    if (spellCb) spellCb.addEventListener("change", () => {
      if (window.HandSignCaptions && window.HandSignCaptions.isRunning()) {
        if (!spellCb.checked) window.HandSignCaptions.clearSpellBuffer();
      }
    });

    // Spell buttons
    function spellNeedHandSign() {
      meetingStatus('Turn on "Hand-sign captions" first, then enable Finger-spelling.');
      setTimeout(() => meetingStatus(""), 5000);
    }

    const btnSpellCommit = $("btn-spell-commit");
    if (btnSpellCommit) {
      btnSpellCommit.addEventListener("click", () => {
        if (!window.HandSignCaptions || !window.HandSignCaptions.isRunning()) { spellNeedHandSign(); return; }
        const before = window.HandSignCaptions.getSpellBuffer
          ? String(window.HandSignCaptions.getSpellBuffer() || "").trim() : "";
        window.HandSignCaptions.commitSpell();
        if (!before) { meetingStatus("Nothing to send yet — hold each letter steady until it appears."); setTimeout(() => meetingStatus(""), 5000); }
        else meetingStatus("");
      });
    }

    const btnSpellClear = $("btn-spell-clear");
    if (btnSpellClear) {
      btnSpellClear.addEventListener("click", () => {
        if (!window.HandSignCaptions || !window.HandSignCaptions.isRunning()) { spellNeedHandSign(); return; }
        window.HandSignCaptions.clearSpellBuffer();
        localSpellDraft = ""; renderLocalSignSubtitle();
        meetingStatus("Spelling buffer cleared."); setTimeout(() => meetingStatus(""), 2000);
      });
    }

    // Doc language
    const docLang = $("doc-lang-select");
    if (docLang) docLang.addEventListener("change", () => emitDocLanguage());
    const recvLang = $("recv-lang-select");
    if (recvLang) {
      recvLang.value = getReceiveLang();
      recvLang.addEventListener("change", () => {
        recvLang.value = normalizeReceiveLang(recvLang.value);
        setReceiveLang(recvLang.value);
        emitDocLanguage();
      });
    }

    // Doc file upload
    const docFile = $("doc-file-input");
    if (docFile) {
      docFile.addEventListener("change", async (ev) => {
        const input = ev.target;
        const f = input.files && input.files[0];
        input.value = "";
        if (!f || !meetingState.isHost || !meetingState.code) return;
        try {
          meetingStatus("Uploading document...");
          const fd = new FormData();
          fd.append("file", f);
          const fetchOpts = {
            method: "POST",
            credentials: "include",
            body: fd,
          };
          // Add JWT auth header if using legacy login
          if (getAuthType() === "jwt") {
            fetchOpts.headers = { Authorization: "Bearer " + getToken() };
          }
          const res = await fetch(
            "/api/rooms/" + encodeURIComponent(meetingState.code) + "/documents",
            fetchOpts
          );
          const data = await res.json().catch(() => ({}));
          if (res.status === 202) meetingStatus("Document queued — AI is processing...");
          else if (!res.ok) meetingStatus("Upload failed: " + (data.error || data.message || res.statusText));
        } catch (err) {
          meetingStatus("Upload failed: " + String(err && err.message ? err.message : err));
        }
      });
    }

    // PDF slide nav
    const btnPrev = $("btn-slide-prev");
    if (btnPrev) btnPrev.addEventListener("click", async () => { if (pdfDoc) await renderPdfPage(currentPage - 1); });
    const btnNext = $("btn-slide-next");
    if (btnNext) btnNext.addEventListener("click", async () => { if (pdfDoc) await renderPdfPage(currentPage + 1); });

    // NotebookLM-style Gemini Q&A
    const chatForm = $("doc-chat-form");
    if (chatForm) {
      chatForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const input = $("doc-chat-input");
        const btn = $("doc-chat-send");
        const q = input && input.value ? input.value.trim() : "";
        if (!meetingState.code) return;
        if (!activeDocId) {
          meetingStatus("Wait until the shared document has finished processing.");
          setTimeout(() => meetingStatus(""), 4000);
          return;
        }
        if (!q) return;

        // Add user message to conversation
        notebookConversation.push({ role: "user", text: q });
        notebookConversation.push({ role: "ai", text: "Thinking..." });
        renderNotebookConversation();
        input.value = "";
        if (btn) btn.disabled = true;

        try {
          const fetchOpts = {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: q, language: navigator.language || "en" }),
          };
          if (getAuthType() === "jwt") {
            fetchOpts.headers.Authorization = "Bearer " + getToken();
          }
          const res = await fetch(
            "/api/rooms/" + encodeURIComponent(meetingState.code) + "/documents/chat",
            fetchOpts
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const err =
              data.message ||
              data.error ||
              (res.status === 503 ? "Gemini not configured on server" : "") ||
              res.statusText;
            throw new Error(err);
          }
          // Update the "Thinking..." message with actual answer
          notebookConversation[notebookConversation.length - 1].text = data.answer || "No answer received.";
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          notebookConversation[notebookConversation.length - 1].text = "Error: " + msg;
        } finally {
          renderNotebookConversation();
          if (btn) btn.disabled = false;
        }
      });
    }

    // Auto-resize textarea
    const docInput = $("doc-chat-input");
    if (docInput) {
      docInput.addEventListener("input", () => {
        docInput.style.height = "auto";
        docInput.style.height = Math.min(docInput.scrollHeight, 120) + "px";
      });
    }

    initInsightTabs();
    initSidebarTabs();
  }

  // ── Boot ─────────────────────────────────────────────────────
  async function boot() {
    wireEvents();
    initStt();
    const recvLang = $("recv-lang-select");
    if (recvLang) recvLang.value = getReceiveLang();

    // Check for existing session
    const token = getToken();

    if (token) {
      setAuthType("jwt");
      await refreshLobbyUser();
      showView("lobby");
      applyJoinFromQuery();
    } else {
      showView("login");
    }
  }

  boot();
})();
