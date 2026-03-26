// Register PWA service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

(function () {
  const TOKEN_KEY = "ezmeeting_token";
  const AUTH_TYPE_KEY = "ezmeeting_auth_type"; // "jwt"

  let socket = null;
  let localStream = null;
  const peers = new Map();
  let meetingState = { joinUrl: "", code: "", isHost: false };
  let busy = false;

  let lastLocalSignLine = "";
  let localSpellDraft = "";
  const ttsPending = [];
  const MAX_TTS_QUEUED = 3;

  let docPdfBlobUrl = null;
  let pdfDoc = null;
  let currentPage = 1
  let activeDocId = null;

  let sidebarOpen = false;
  let activeSidebarTab = "chat";

  let micMuted = false;
  let camMuted = false;
  let facingMode = "user"; // "user" = front, "environment" = back
  let screenStream = null;
  let screenSharing = false;

  // Voice-to-text state (browser SpeechRecognition)
  let sttRecognition = null;
  let sttActive = false;

  // Subtitle settings
  let subtitlesEnabled = false;

  // Language preferences
  const LANGUAGES = {
    en: { name: "English",    speechCode: "en-US" },
    my: { name: "Myanmar",    speechCode: "my-MM" },
    th: { name: "Thai",       speechCode: "th-TH" },
    ja: { name: "Japanese",   speechCode: "ja-JP" },
    zh: { name: "Chinese",    speechCode: "zh-CN" },
    ko: { name: "Korean",     speechCode: "ko-KR" },
    fr: { name: "French",     speechCode: "fr-FR" },
    de: { name: "German",     speechCode: "de-DE" },
    es: { name: "Spanish",    speechCode: "es-ES" },
    pt: { name: "Portuguese", speechCode: "pt-BR" },
    ru: { name: "Russian",    speechCode: "ru-RU" },
    hi: { name: "Hindi",      speechCode: "hi-IN" },
    ar: { name: "Arabic",     speechCode: "ar-SA" },
    vi: { name: "Vietnamese", speechCode: "vi-VN" },
    id: { name: "Indonesian", speechCode: "id-ID" },
    tr: { name: "Turkish",    speechCode: "tr-TR" },
    it: { name: "Italian",    speechCode: "it-IT" },
    nl: { name: "Dutch",      speechCode: "nl-NL" },
    pl: { name: "Polish",     speechCode: "pl-PL" },
    uk: { name: "Ukrainian",  speechCode: "uk-UA" },
    sv: { name: "Swedish",    speechCode: "sv-SE" },
    ta: { name: "Tamil",      speechCode: "ta-IN" },
    bn: { name: "Bengali",    speechCode: "bn-IN" },
    ms: { name: "Malay",      speechCode: "ms-MY" },
    tl: { name: "Filipino",   speechCode: "fil-PH" },
  };
  let speakLang = "en";
  let subtitleLang = "en";

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


  // ── View management ──────────────────────────────────────────
  let summaryRoomCode = null;
  let summaryChatHistory = [];
  let summaryMeetingName = "";

  function showView(name) {
    ["view-login", "view-lobby", "view-meeting", "view-summary"].forEach((id) => {
      const el = $(id);
      if (el) { el.classList.add("hidden"); el.style.display = ""; }
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
        // On mobile, tapping the already-active tab acts as "back to meeting".
        const isSameTab = activeSidebarTab === btn.dataset.tab;
        const isMobile = window.matchMedia && window.matchMedia("(max-width: 640px)").matches;
        if (sidebarOpen && isSameTab && isMobile) {
          closeSidebar();
          updateControlIcons();
          return;
        }
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

  // ── Switch camera (front/back) ───────────────────────────────
  async function switchCamera() {
    if (!localStream) return;
    facingMode = facingMode === "user" ? "environment" : "user";
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode },
        audio: true,
      });
      const newVideoTrack = newStream.getVideoTracks()[0];
      const oldVideoTrack = localStream.getVideoTracks()[0];
      peers.forEach((peer) => {
        try {
          if (typeof peer.replaceTrack === "function") {
            peer.replaceTrack(oldVideoTrack, newVideoTrack, localStream);
          } else {
            const pc = peer._pc;
            if (pc) {
              const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
              if (sender) sender.replaceTrack(newVideoTrack);
            }
          }
        } catch (_) {}
      });
      if (oldVideoTrack) oldVideoTrack.stop();
      localStream.removeTrack(oldVideoTrack);
      localStream.addTrack(newVideoTrack);
      const v = $("local-video");
      if (v) v.srcObject = localStream;
      if (v) v.style.transform = facingMode === "user" ? "scaleX(-1)" : "scaleX(1)";
      newStream.getAudioTracks().forEach(t => t.stop());
      if (camMuted) newVideoTrack.enabled = false;
    } catch (e) {
      console.warn("Camera switch failed", e);
      facingMode = facingMode === "user" ? "environment" : "user";
    }
  }

  // ── Screen sharing ────────────────────────────────────────────
  async function startScreenShare() {
    if (screenSharing) return;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (e) {
      // User cancelled or denied
      return;
    }
    screenSharing = true;
    const screenTrack = screenStream.getVideoTracks()[0];
    const camTrack = localStream.getVideoTracks()[0];

    // Replace camera track with screen track in all peer connections
    peers.forEach((peer) => {
      try {
        if (typeof peer.replaceTrack === "function") {
          peer.replaceTrack(camTrack, screenTrack, localStream);
        } else {
          const pc = peer._pc;
          if (pc) {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
            if (sender) sender.replaceTrack(screenTrack);
          }
        }
      } catch (_) {}
    });

    // Show screen share in local video (no mirror)
    const v = $("local-video");
    if (v) {
      v.srcObject = new MediaStream([screenTrack, ...localStream.getAudioTracks()]);
      v.style.transform = "none";
    }

    // Update button state
    const btn = $("btn-share-screen");
    if (btn) btn.classList.add("active");

    // When user stops sharing via browser UI
    screenTrack.onended = () => stopScreenShare();
  }

  function stopScreenShare() {
    if (!screenSharing) return;
    screenSharing = false;

    const camTrack = localStream.getVideoTracks()[0];

    if (screenStream) {
      const screenTrack = screenStream.getVideoTracks()[0];
      // Replace screen track back with camera track
      peers.forEach((peer) => {
        try {
          if (typeof peer.replaceTrack === "function") {
            peer.replaceTrack(screenTrack, camTrack, localStream);
          } else {
            const pc = peer._pc;
            if (pc) {
              const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
              if (sender) sender.replaceTrack(camTrack);
            }
          }
        } catch (_) {}
      });
      screenStream.getTracks().forEach(t => t.stop());
      screenStream = null;
    }

    // Restore local video to camera
    const v = $("local-video");
    if (v) {
      v.srcObject = localStream;
      v.style.transform = facingMode === "user" ? "scaleX(-1)" : "scaleX(1)";
    }

    // Re-apply cam muted state
    if (camMuted && camTrack) camTrack.enabled = false;

    const btn = $("btn-share-screen");
    if (btn) btn.classList.remove("active");
  }

  function showScreenShareRequest(fromId, fromName) {
    // Remove any existing request popup
    const existing = $("screen-request-popup");
    if (existing) existing.remove();

    const popup = document.createElement("div");
    popup.id = "screen-request-popup";
    popup.className = "screen-request-popup";
    popup.innerHTML =
      '<div class="screen-request-content">' +
        '<p><strong>' + escapeHtml(fromName) + '</strong> wants to share their screen.</p>' +
        '<div class="screen-request-actions">' +
          '<button type="button" class="small" id="btn-screen-accept">Allow</button>' +
          '<button type="button" class="small secondary" id="btn-screen-deny">Deny</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(popup);
    renderIcons();

    $("btn-screen-accept").addEventListener("click", () => {
      if (socket && socket.connected) socket.emit("screen:respond", { targetId: fromId, approved: true });
      popup.remove();
    });
    $("btn-screen-deny").addEventListener("click", () => {
      if (socket && socket.connected) socket.emit("screen:respond", { targetId: fromId, approved: false });
      popup.remove();
    });

    // Auto-deny after 30 seconds
    setTimeout(() => {
      if (popup.parentNode) {
        if (socket && socket.connected) socket.emit("screen:respond", { targetId: fromId, approved: false });
        popup.remove();
      }
    }, 30000);
  }

  function requestScreenShare() {
    if (screenSharing) {
      stopScreenShare();
      return;
    }
    if (!socket || !socket.connected) return;
    // Host shares directly; non-host must ask permission
    if (meetingState.isHost) {
      startScreenShare();
    } else {
      meetingStatus("Requesting screen share permission...");
      socket.emit("screen:request");
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
  function setSubtitlesEnabled(enabled) {
    subtitlesEnabled = !!enabled;
    const subtitleToggle = $("toggle-subtitles");
    if (subtitleToggle) subtitleToggle.checked = subtitlesEnabled;

    const box = $("subtitle-box");
    if (!subtitlesEnabled && box) box.innerHTML = "";
  }

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
    if (row) row.classList.remove("hidden");
  }

  function emitDocLanguage() {
    if (!socket || !socket.connected) return;
    socket.emit("doc:setLanguage", { preferredLanguage: "en" });
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
      empty.innerHTML = '<i data-lucide="message-circle-question" style="width:24px;height:24px;stroke:var(--text-3);stroke-width:1.5;"></i>' +
        '<p>Ask anything about the uploaded document. Eazii will analyze and answer in your language.</p>';
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
        bubble.innerHTML = formatAiResponse(msg.text);
      }
      container.appendChild(bubble);
    }
    container.scrollTop = container.scrollHeight;
  }

  function formatAiResponse(text) {
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/^### (.+)$/gm, '<div class="notebook-h3">$1</div>');
    html = html.replace(/^## (.+)$/gm, '<div class="notebook-h2">$1</div>');
    html = html.replace(/^[-*] (.+)$/gm, '<div class="notebook-bullet">$1</div>');
    html = html.replace(/^\d+\. (.+)$/gm, '<div class="notebook-bullet notebook-numbered">$1</div>');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // ── Voice-to-Text (Browser SpeechRecognition) ───────────────
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  function initStt() {}

  function startStt() {
    if (sttActive) return;
    if (!SpeechRecognitionCtor) {
      meetingStatus("Speech recognition not supported in this browser.");
      return;
    }

    sttActive = true;
    const recognition = new SpeechRecognitionCtor();
    sttRecognition = recognition;

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = (LANGUAGES[speakLang] && LANGUAGES[speakLang].speechCode) || "en-US";
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      if (!socket || !socket.connected) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        const isFinal = result.isFinal;
        socket.emit("caption:voice", { text, isFinal, lang: recognition.lang });

        // Show own captions locally
        if (isFinal && text.trim()) {
          const box = $("subtitle-box");
          if (box && subtitlesEnabled) {
            const line = document.createElement("div");
            line.textContent = "You: " + text.trim();
            box.appendChild(line);
            box.scrollTop = box.scrollHeight;
            while (box.children.length > 20) box.removeChild(box.firstChild);
          }
        }
      }
    };

    recognition.onerror = (e) => {
      // "no-speech" and "aborted" are normal — just restart
      if (e.error === "no-speech" || e.error === "aborted") return;
      console.warn("[stt] error:", e.error);
      if (e.error === "not-allowed") {
        meetingStatus("Microphone access denied for speech recognition.");
        stopStt();
      }
    };

    recognition.onend = () => {
      // Auto-restart if still active (browser stops after silence)
      if (sttActive) {
        try { recognition.start(); } catch (_) {}
      }
    };

    try {
      recognition.start();
    } catch (err) {
      meetingStatus("Could not start speech recognition.");
      sttActive = false;
      sttRecognition = null;
    }
  }

  function stopStt() {
    sttActive = false;
    if (sttRecognition) {
      try { sttRecognition.stop(); } catch (_) {}
    }
    sttRecognition = null;
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

    // Screen share permission — host receives requests
    socket.on("screen:request", ({ fromId, fromName }) => {
      showScreenShareRequest(fromId, fromName);
    });
    // Non-host receives approval/denial
    socket.on("screen:approved", () => {
      meetingStatus("");
      startScreenShare();
    });
    socket.on("screen:denied", () => {
      meetingStatus("Screen share request denied by host.");
      setTimeout(() => meetingStatus(""), 4000);
    });

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
          if (data.translatedText) body += ` \u2192 ${data.translatedText}`;
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

    /* ── Real-time voice captions — show translated text from others ── */
    socket.on("caption:voice", (data) => {
      if (!data.socketId || !subtitlesEnabled) return;
      if (data.socketId === socket.id) return;

      const box = $("subtitle-box");
      if (!box || !data.isFinal) return;
      const displayText = data.translatedText || data.text || "";
      if (!displayText.trim()) return;

      const name = data.from || "Someone";
      const line = document.createElement("div");
      line.textContent = name + ": " + displayText.trim();
      box.appendChild(line);
      box.scrollTop = box.scrollHeight;
      while (box.children.length > 20) box.removeChild(box.firstChild);
    });

    socket.on("doc:processing", (d) => {
      activeDocId = null;
      notebookConversation = [];
      renderNotebookConversation();
      const st = $("doc-status");
      if (st) st.textContent = 'Processing "' + (d.fileName || "") + '"...';
    });

    socket.on("doc:ready", (d) => {
      const st = $("doc-status");
      if (st) st.textContent = (d.fileName || "") + " \u00b7 source: " + (d.sourceLanguage || "?");
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

    socket.on("room:ended", async ({ reason, summaryCode }) => {
      const labels = {
        host_ended: "Meeting ended by host.",
        host_left:  "Host left \u2014 meeting closed.",
        empty:      "Everyone left \u2014 meeting closed.",
      };
      meetingStatus(labels[reason] || "Meeting ended.");
      await cleanupMeeting();
      if (summaryCode) {
        promptMeetingName(summaryCode);
      } else {
        showView("lobby");
        refreshLobbyUser();
      }
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
        const lab = document.createElement("span");
        lab.className = "label";
        lab.textContent = remoteName || "Guest";
        wrap.appendChild(vid);
        wrap.appendChild(sub);
        wrap.appendChild(lab);
        $("remote-videos").appendChild(wrap);
      }
    });

    peer.on("close", () => removePeer(peerId));
    peer.on("error", (e) => console.warn("peer error", peerId, e));
    peers.set(peerId, peer);
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (peer) { try { peer.destroy(); } catch (_) {} peers.delete(peerId); }
    const wrap = document.getElementById("remote-" + peerId);
    if (wrap) wrap.remove();
  }

  // ── Meeting lifecycle ────────────────────────────────────────
  function updateMeetingMeta(ack) {
    meetingState = { code: ack.code, joinUrl: ack.joinUrl || "", isHost: !!ack.isHost };
    $('meeting-code-label').textContent = ack.code;
    const shareCode = $("share-code-display");
    if (shareCode) shareCode.textContent = ack.code;
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
    const subBox = $("subtitle-box");
    if (subBox) subBox.innerHTML = "";
    resetDocPanel();
    syncDocHostUi();
    const dinput = $("doc-file-input");
    if (dinput) dinput.value = "";
    if (socket && socket.connected) emitDocLanguage();
    setMicMuted(true);
    setCamMuted(true);
    setSubtitlesEnabled(false);
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
    stopScreenShare();
    stopStt();
    await stopHandSignCaptions();
    resetDocPanel();
    ttsPending.length = 0;
    if (window.speechSynthesis) { try { speechSynthesis.cancel(); } catch (_) {} }
    lastLocalSignLine = "";
    localSpellDraft = "";
    const locSub = $("local-sign-subtitle");
    if (locSub) locSub.textContent = "";
    const subBox2 = $("subtitle-box");
    if (subBox2) subBox2.innerHTML = "";
    peers.forEach(p => { try { p.destroy(); } catch (_) {} });
    peers.clear();
    $("remote-videos").innerHTML = "";
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    facingMode = "user";
    const lv = $("local-video");
    if (lv) { lv.srcObject = null; lv.style.transform = ""; }
    if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
    busy = false;
    meetingStatus("");
    const qr = $("qr-img"); if (qr) qr.removeAttribute("src");
    const shareM = $("share-modal"); if (shareM) shareM.classList.add("hidden");
    const scrReq = $("screen-request-popup"); if (scrReq) scrReq.remove();
    closeSidebar();
    const hsBar = $("hand-sign-bar"); if(hsBar) hsBar.style.display = "none";
    const sp = $("settings-popup"); if (sp) sp.classList.add("hidden");
    const sb = $("btn-settings"); if (sb) sb.classList.remove("active");
    micMuted = false; camMuted = false;
  }

  function buildSocketOpts() {
    const token = getToken();
    return { auth: { token } };
  }

  async function startHost() {
    if (busy) return;
    readLangSelects("host");
    clearLobbyError();
    busy = true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      busy = false;
      $("lobby-error").textContent = "Camera/microphone access is required.";
      return;
    }
    const token = getToken();
    if (!token) { busy = false; showView("login"); return; }

    showView("meeting");
    setupLocalVideo();
    socket = window.io(buildSocketOpts());
    socket.on("connect_error", onConnectError);
    registerSocketHandlers();
    const runCreate = () => {
      socket.emit("room:create", { speakLang, subtitleLang }, async (ack) => {
        if (!ack || ack.error) {
          meetingStatus("Could not create room: " + (ack && ack.error ? ack.error : "unknown"));
          await cleanupMeeting(); showView("lobby"); return;
        }
        updateMeetingMeta(ack);
        (ack.peers || []).forEach(p => addPeer(p.id, p.name));
        busy = false;
        startStt();
      });
    };
    if (socket.connected) runCreate(); else socket.once("connect", runCreate);
  }

  async function startJoin(rawCode) {
    if (busy) return;
    readLangSelects("join");
    const code = String(rawCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4) { $("lobby-error").textContent = "Enter a valid meeting code."; return; }
    clearLobbyError();
    busy = true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      busy = false;
      $("lobby-error").textContent = "Camera/microphone access is required.";
      return;
    }
    const token = getToken();
    if (!token) { busy = false; showView("login"); return; }

    showView("meeting");
    setupLocalVideo();
    socket = window.io(buildSocketOpts());
    socket.on("connect_error", onConnectError);
    registerSocketHandlers();
    const runJoin = () => {
      socket.emit("room:join", { code, speakLang, subtitleLang }, async (ack) => {
        if (!ack || ack.error) {
          meetingStatus(ack && ack.error === "not_found"
            ? "Meeting not found or already ended."
            : "Could not join: " + (ack && ack.error ? ack.error : "unknown"));
          await cleanupMeeting(); showView("lobby"); return;
        }
        updateMeetingMeta(ack);
        (ack.peers || []).forEach(p => addPeer(p.id, p.name));
        busy = false;
        startStt();
        try { const u = new URL(window.location.href); u.searchParams.delete("join"); window.history.replaceState({}, "", u.toString()); } catch (_) {}
      });
    };
    if (socket.connected) runJoin(); else socket.once("connect", runJoin);
  }

  async function leaveMeeting() {
    const code = meetingState.code;
    if (socket && socket.connected) {
      socket.emit("room:leave", async (ack) => {
        await cleanupMeeting();
        if (ack && ack.summaryCode) {
          promptMeetingName(ack.summaryCode);
        } else {
          showView("lobby");
          refreshLobbyUser();
        }
      });
    } else {
      await cleanupMeeting();
      showView("lobby");
      refreshLobbyUser();
    }
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
      if (!window.HandSignAlphabetKit) { meetingStatus("Missing vendor/handsigns-alphabet.js \u2014 run: npm run build:handsigns"); el.checked = false; return; }
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
        "Network error \u2014 is the server running? (npm start) " + String(err && err.message ? err.message : err);
      return;
    }
    const raw = await res.text();
    let data = {};
    if (raw) { try { data = JSON.parse(raw); } catch { $("login-error").textContent = `Server returned ${res.status} (not JSON). Run: npm start`; return; } }
    if (!res.ok) {
      $("login-error").textContent =
        data.error || (res.status === 404 || res.status === 405
          ? "API not found \u2014 run the backend: npm start"
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

  // ── Meeting Name Prompt ─────────────────────────────────────
  function promptMeetingName(summaryCode) {
    const modal = $("meeting-name-modal");
    const input = $("meeting-name-input");
    if (!modal) { showMeetingSummary(summaryCode); return; }
    if (input) input.value = "";
    modal.classList.remove("hidden");
    renderIcons();
    if (input) input.focus();

    function finish(name) {
      modal.classList.add("hidden");
      summaryMeetingName = (name || "").trim();
      // Save name to server if provided
      if (summaryMeetingName) {
        fetch("/api/meeting-summary/" + encodeURIComponent(summaryCode) + "/name", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: summaryMeetingName }),
        }).catch(() => {});
      }
      showMeetingSummary(summaryCode);
    }

    const form = $("form-meeting-name");
    const skipBtn = $("btn-skip-name");

    function onSubmit(ev) {
      ev.preventDefault();
      cleanup();
      finish(input ? input.value : "");
    }
    function onSkip() {
      cleanup();
      finish("");
    }
    function cleanup() {
      if (form) form.removeEventListener("submit", onSubmit);
      if (skipBtn) skipBtn.removeEventListener("click", onSkip);
    }

    if (form) form.addEventListener("submit", onSubmit);
    if (skipBtn) skipBtn.addEventListener("click", onSkip);
  }

  // ── Meeting Summary ──────────────────────────────────────────
  async function showMeetingSummary(code) {
    summaryRoomCode = code;
    summaryChatHistory = [];
    showView("summary");
    renderIcons();

    const loading = $("summary-loading");
    const cards = $("summary-cards");
    if (loading) loading.classList.remove("hidden");
    if (cards) cards.classList.add("hidden");

    // Reset chat log
    const chatLog = $("summary-chat-log");
    if (chatLog) {
      chatLog.innerHTML = '<div class="notebook-empty">' +
        '<i data-lucide="message-circle-question" style="width:24px;height:24px;stroke:var(--text-3);stroke-width:1.5;"></i>' +
        '<p>Ask any question about this meeting. The AI will use the full transcript to answer.</p></div>';
    }

    // Poll for summary (generation may still be in progress)
    let data = null;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch("/api/meeting-summary/" + encodeURIComponent(code));
        if (res.ok) {
          data = await res.json();
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (loading) loading.classList.add("hidden");

    if (!data) {
      if (cards) {
        cards.classList.remove("hidden");
        const txt = $("summary-text");
        if (txt) txt.textContent = "Could not generate meeting summary. The meeting may have been too short.";
      }
      renderIcons();
      return;
    }

    // Populate summary cards
    if (cards) cards.classList.remove("hidden");

    // Show meeting name in title if provided
    const titleEl = $("summary-title");
    const displayName = summaryMeetingName || (data.meetingName || "");
    if (titleEl) titleEl.textContent = displayName || "Meeting Summary";

    const meta = $("summary-meta");
    if (meta) meta.textContent = new Date(data.createdAt).toLocaleString() + " \u00b7 Room: " + code;

    const txt = $("summary-text");
    if (txt) txt.textContent = data.summary || "No summary available.";

    const dur = $("summary-duration");
    if (dur) dur.textContent = (data.durationMinutes || 0) + " min";

    const att = $("summary-attendees");
    if (att) {
      const count = (data.attendees || []).length;
      att.textContent = count + " participant" + (count !== 1 ? "s" : "");
    }

    // Store attendee details for popup
    populateAttendeePopup(data.attendeeDetails || [], data.attendees || []);

    // Topics
    const topicsEl = $("summary-topics");
    const topicsCard = $("summary-topics-card");
    if (topicsEl && data.topics && data.topics.length > 0) {
      topicsEl.innerHTML = "";
      data.topics.forEach((t) => {
        const div = document.createElement("div");
        div.className = "summary-topic-item";
        div.innerHTML = "<strong>" + escapeHtml(t.title) + "</strong><p>" + escapeHtml(t.details) + "</p>";
        topicsEl.appendChild(div);
      });
      if (topicsCard) topicsCard.classList.remove("hidden");
    } else if (topicsCard) {
      topicsCard.classList.add("hidden");
    }

    // Assignments
    const assignEl = $("summary-assignments");
    const assignCard = $("summary-assignments-card");
    if (assignEl && data.assignments && data.assignments.length > 0) {
      assignEl.innerHTML = "";
      data.assignments.forEach((a) => {
        const div = document.createElement("div");
        div.className = "summary-assignment-item";
        div.innerHTML = '<span class="assignment-badge">' + escapeHtml(a.assignee) + "</span> " + escapeHtml(a.task);
        assignEl.appendChild(div);
      });
      if (assignCard) assignCard.classList.remove("hidden");
    } else if (assignCard) {
      assignCard.classList.add("hidden");
    }

    // Key Decisions
    const decEl = $("summary-decisions");
    const decCard = $("summary-decisions-card");
    if (decEl && data.keyDecisions && data.keyDecisions.length > 0) {
      decEl.innerHTML = "";
      data.keyDecisions.forEach((d) => {
        const div = document.createElement("div");
        div.className = "summary-decision-item";
        div.textContent = d;
        decEl.appendChild(div);
      });
      if (decCard) decCard.classList.remove("hidden");
    } else if (decCard) {
      decCard.classList.add("hidden");
    }

    renderIcons();
  }

  async function askSummaryQuestion(question) {
    if (!summaryRoomCode || !question.trim()) return;

    const chatLog = $("summary-chat-log");
    if (!chatLog) return;

    // Clear empty state
    const empty = chatLog.querySelector(".notebook-empty");
    if (empty) empty.remove();

    // Add user message
    const userBubble = document.createElement("div");
    userBubble.className = "notebook-msg notebook-msg--user";
    userBubble.textContent = question;
    chatLog.appendChild(userBubble);

    // Add thinking bubble
    const aiBubble = document.createElement("div");
    aiBubble.className = "notebook-msg notebook-msg--ai";
    aiBubble.textContent = "Thinking...";
    chatLog.appendChild(aiBubble);
    chatLog.scrollTop = chatLog.scrollHeight;

    try {
      const res = await fetch("/api/meeting-summary/" + encodeURIComponent(summaryRoomCode) + "/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Request failed");
      aiBubble.innerHTML = formatAiResponse(data.answer || "No answer.");
    } catch (err) {
      aiBubble.textContent = "Error: " + (err.message || err);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // ── Attendee popup ─────────────────────────────────────────
  function populateAttendeePopup(details, names) {
    const list = $("attendee-list");
    if (!list) return;
    list.innerHTML = "";

    const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
    const fmtDur = (join, leave) => {
      if (!join) return "";
      const ms = (leave || Date.now()) - join;
      const mins = Math.round(ms / 60000);
      return mins < 1 ? "<1 min" : mins + " min";
    };

    if (details && details.length > 0) {
      details.forEach((a) => {
        const row = document.createElement("div");
        row.className = "attendee-row";
        row.innerHTML =
          '<div class="attendee-avatar">' + escapeHtml(a.name.charAt(0).toUpperCase()) + '</div>' +
          '<div class="attendee-info">' +
            '<div class="attendee-name">' + escapeHtml(a.name) + '</div>' +
            '<div class="attendee-times">' +
              '<span><span class="attendee-time-label">Joined </span>' + fmtTime(a.joinedAt) + '</span>' +
              '<span><span class="attendee-time-label">Left </span>' + fmtTime(a.leftAt) + '</span>' +
              '<span><span class="attendee-time-label">Duration </span>' + fmtDur(a.joinedAt, a.leftAt) + '</span>' +
            '</div>' +
          '</div>';
        list.appendChild(row);
      });
    } else {
      // Fallback: just show names without times
      names.forEach((name) => {
        const row = document.createElement("div");
        row.className = "attendee-row";
        row.innerHTML =
          '<div class="attendee-avatar">' + escapeHtml(name.charAt(0).toUpperCase()) + '</div>' +
          '<div class="attendee-info"><div class="attendee-name">' + escapeHtml(name) + '</div></div>';
        list.appendChild(row);
      });
    }
  }

  // ── Language selector helpers ────────────────────────────────
  function populateLangSelects() {
    const ids = ["host-speak-lang", "host-subtitle-lang", "join-speak-lang", "join-subtitle-lang"];
    ids.forEach((id) => {
      const sel = $(id);
      if (!sel || sel.children.length) return;
      Object.entries(LANGUAGES).forEach(([code, { name }]) => {
        const opt = document.createElement("option");
        opt.value = code;
        opt.textContent = name;
        sel.appendChild(opt);
      });
      sel.value = "en";
    });
  }

  function readLangSelects(prefix) {
    const sp = $(prefix + "-speak-lang");
    const sb = $(prefix + "-subtitle-lang");
    if (sp) speakLang = sp.value || "en";
    if (sb) subtitleLang = sb.value || "en";
  }

  // ── Wire up all event listeners ──────────────────────────────
  function wireEvents() {
    const on = (id, event, handler) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener(event, handler);
    };

    // Login
    on("form-login", "submit", submitLogin);

    // Lobby
    on("btn-host", "click", () => startHost());
    on("form-join", "submit", (ev) => { ev.preventDefault(); startJoin($("join-code").value); });
    on("btn-logout", "click", logout);

    // Meeting controls
    on("btn-copy-link", "click", async () => {
      const url = meetingState.joinUrl;
      if (!url) return;
      try { await navigator.clipboard.writeText(url); meetingStatus("Invite link copied!"); setTimeout(() => meetingStatus(""), 2500); }
      catch { meetingStatus("Copy manually: " + url); }
    });

    on("btn-leave", "click", leaveMeeting);
    on("btn-end", "click", endMeetingForAll);

    // Share modal
    on("btn-share-meeting", "click", () => {
      const modal = $("share-modal");
      if (modal) modal.classList.remove("hidden");
    });
    on("btn-share-close", "click", () => {
      const modal = $("share-modal");
      if (modal) modal.classList.add("hidden");
    });
    const shareModal = $("share-modal");
    if (shareModal) {
      shareModal.addEventListener("click", (e) => {
        if (e.target === shareModal) shareModal.classList.add("hidden");
      });
    }

    on("btn-toggle-mic", "click", () => setMicMuted(!micMuted));
    on("btn-toggle-cam", "click", () => setCamMuted(!camMuted));
    on("btn-switch-cam", "click", () => switchCamera());
    on("btn-share-screen", "click", () => requestScreenShare());

    // Mobile sidebar close & leave buttons
    const sidebarCloseBtn = $("btn-sidebar-close");
    if (sidebarCloseBtn) {
      const onSidebarClose = (ev) => {
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        closeSidebar();
      };
      sidebarCloseBtn.addEventListener("click", onSidebarClose);
      sidebarCloseBtn.addEventListener("touchend", onSidebarClose, { passive: false });
    }
    const sidebarLeaveBtn = $("btn-sidebar-leave");
    if (sidebarLeaveBtn) {
      const onSidebarLeave = (ev) => {
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        closeSidebar();
        leaveMeeting();
      };
      sidebarLeaveBtn.addEventListener("click", onSidebarLeave);
      sidebarLeaveBtn.addEventListener("touchend", onSidebarLeave, { passive: false });
    }

    on("btn-toggle-sidebar", "click", () => {
      toggleSidebar("chat");
      updateControlIcons();
    });


    on("btn-toggle-handsign-bar", "click", () => {
      const bar = $("hand-sign-bar");
      if (!bar) return;
      const isHidden = bar.style.display === "none" || bar.style.display === "";
      bar.style.display = isHidden ? "flex" : "none";
      const btn = $("btn-toggle-handsign-bar");
      if (btn) btn.classList.toggle("active", isHidden);
    });

    // Settings popup
    const settingsBtn = $("btn-settings");
    const settingsPopup = $("settings-popup");
    if (settingsBtn && settingsPopup) {
      settingsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        settingsPopup.classList.toggle("hidden");
        settingsBtn.classList.toggle("active", !settingsPopup.classList.contains("hidden"));
      });
      document.addEventListener("click", (e) => {
        if (!settingsPopup.contains(e.target) && e.target !== settingsBtn) {
          settingsPopup.classList.add("hidden");
          settingsBtn.classList.remove("active");
        }
      });
    }

    // Subtitle toggle
    const subtitleToggle = $("toggle-subtitles");
    if (subtitleToggle) {
      subtitleToggle.addEventListener("change", () => setSubtitlesEnabled(subtitleToggle.checked));

      const subtitleRow = subtitleToggle.closest(".settings-row");
      if (subtitleRow) {
        subtitleRow.addEventListener("click", (ev) => {
          const toggleSwitch = subtitleToggle.closest("label.toggle-switch");
          if (ev.target === subtitleToggle || (toggleSwitch && toggleSwitch.contains(ev.target))) return;
          subtitleToggle.checked = !subtitleToggle.checked;
          setSubtitlesEnabled(subtitleToggle.checked);
        });
      }
    }


    // Chat form
    on("form-chat", "submit", (ev) => {
      ev.preventDefault();
      const input = $("chat-input");
      const text = input.value.trim();
      if (!text || !socket) return;
      socket.emit("chat:message", { text });
      input.value = "";
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
        if (!before) { meetingStatus("Nothing to send yet \u2014 hold each letter steady until it appears."); setTimeout(() => meetingStatus(""), 5000); }
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


    // Doc file upload
    const docFile = $("doc-file-input");
    if (docFile) {
      docFile.addEventListener("change", async (ev) => {
        const input = ev.target;
        const f = input.files && input.files[0];
        input.value = "";
        if (!f || !meetingState.code) return;
        try {
          meetingStatus("Uploading document...");
          const fd = new FormData();
          fd.append("file", f);
          const fetchOpts = {
            method: "POST",
            credentials: "include",
            body: fd,
          };
          if (getAuthType() === "jwt") {
            fetchOpts.headers = { Authorization: "Bearer " + getToken() };
          }
          const res = await fetch(
            "/api/rooms/" + encodeURIComponent(meetingState.code) + "/documents",
            fetchOpts
          );
          const data = await res.json().catch(() => ({}));
          if (res.status === 202) meetingStatus("Document queued \u2014 AI is processing...");
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

    // NotebookLM-style Eazii Q&A
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
              (res.status === 503 ? "Eazii AI not configured on server" : "") ||
              res.statusText;
            throw new Error(err);
          }
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

    // Summary view events
    on("btn-back-lobby", "click", () => {
      summaryRoomCode = null;
      summaryMeetingName = "";
      showView("lobby");
      refreshLobbyUser();
    });

    on("btn-export-summary", "click", () => {
      if (!summaryRoomCode) return;
      window.open("/api/meeting-summary/" + encodeURIComponent(summaryRoomCode) + "/export", "_blank");
    });

    // Attendee popup
    on("btn-show-attendees", "click", () => {
      const popup = $("attendee-popup");
      if (popup) { popup.classList.remove("hidden"); renderIcons(); }
    });
    on("btn-attendee-close", "click", () => {
      const popup = $("attendee-popup");
      if (popup) popup.classList.add("hidden");
    });
    const attPopup = $("attendee-popup");
    if (attPopup) {
      attPopup.addEventListener("click", (e) => {
        if (e.target === attPopup) attPopup.classList.add("hidden");
      });
    }

    const summaryForm = $("form-summary-chat");
    if (summaryForm) {
      summaryForm.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const input = $("summary-chat-input");
        const q = input && input.value ? input.value.trim() : "";
        if (!q) return;
        input.value = "";
        askSummaryQuestion(q);
      });
    }

    const summaryInput = $("summary-chat-input");
    if (summaryInput) {
      summaryInput.addEventListener("input", () => {
        summaryInput.style.height = "auto";
        summaryInput.style.height = Math.min(summaryInput.scrollHeight, 120) + "px";
      });
    }

    initInsightTabs();
    initSidebarTabs();
  }

  // ── Boot ─────────────────────────────────────────────────────
  async function boot() {
    wireEvents();
    initStt();
    populateLangSelects();

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
