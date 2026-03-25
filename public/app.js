// Register PWA service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js", { updateViaCache: "none" })
    .catch(() => {});
}

(function () {
  const TOKEN_KEY = "ezmeeting_token";
  const AUTH_TYPE_KEY = "ezmeeting_auth_type"; // "jwt"
  const RECEIVE_LANG_KEY = "ezmeeting_receive_lang";

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
  let currentPage = 1
  let activeDocId = null;

  let sidebarOpen = false;
  let activeSidebarTab = "chat";

  let micMuted = false;
  let camMuted = false;
  let facingMode = "user"; // "user" = front, "environment" = back
  const peerMediaStates = new Map();

  // Voice-to-text state (server-side Whisper)
  let sttMediaRecorder = null;
  let sttActive = false;
  let sttChunkInterval = null;

  // Subtitle settings
  let subtitlesEnabled = false;
  let subtitleSourceLang = "auto"; // "auto" = detect source speech language
  let subtitleLang = ""; // "" = original (no translation)

  // NotebookLM conversation history (client-side only)
  let notebookConversation = [];

  const SimplePeerCtor = window.SimplePeer;
  if (typeof SimplePeerCtor !== "function") {
    console.error("SimplePeer not loaded");
  }

  const $ = (id) => document.getElementById(id);

  const SUBTITLE_LANG_LABELS = {
    auto: "Auto",
    en: "English",
    my: "Myanmar",
    th: "Thai",
    ja: "Japanese",
    zh: "Chinese",
    ko: "Korean",
    fr: "French",
    de: "German",
    es: "Spanish",
    pt: "Portuguese",
    ru: "Russian",
    hi: "Hindi",
    ar: "Arabic",
    vi: "Vietnamese",
    id: "Indonesian",
    tr: "Turkish",
    it: "Italian",
    nl: "Dutch",
    pl: "Polish",
    uk: "Ukrainian",
    sv: "Swedish",
    ta: "Tamil",
    bn: "Bengali",
    ms: "Malay",
    tl: "Filipino",
  };

  // â”€â”€ Token helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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


  // â”€â”€ View management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  function syncMeetingLayoutState() {
    const meetingView = $("view-meeting");
    if (!meetingView) return;
    meetingView.classList.toggle("sidebar-open", !!sidebarOpen);
  }

  // â”€â”€ Sidebar management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function openSidebar(tabName) {
    const sidebar = $("meeting-sidebar");
    if (!sidebar) return;
    sidebarOpen = true;
    sidebar.classList.remove("sidebar-hidden");
    switchSidebarTab(tabName || activeSidebarTab);
    syncMeetingLayoutState();
    updateControlIcons();
  }

  function closeSidebar() {
    const sidebar = $("meeting-sidebar");
    if (!sidebar) return;
    sidebarOpen = false;
    sidebar.classList.add("sidebar-hidden");
    syncMeetingLayoutState();
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
    const signBtn = $("btn-toggle-handsign-bar");
    if (signBtn) signBtn.classList.toggle("active", sidebarOpen && activeSidebarTab === "handsign");
  }

  // â”€â”€ Insight tabs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Mic / Cam toggle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function svgIcon(name) {
    return `<i data-lucide="${name}" style="width:20px;height:20px;stroke:currentColor;stroke-width:2;"></i>`;
  }

  function renderIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  function updateVideoLayout() {
    const grid = $("meeting-grid");
    if (!grid) return;
    const total = 1 + peers.size;
    grid.classList.remove("layout-1", "layout-2", "layout-3-4", "layout-5-plus");
    if (total <= 1) grid.classList.add("layout-1");
    else if (total === 2) grid.classList.add("layout-2");
    else if (total <= 4) grid.classList.add("layout-3-4");
    else grid.classList.add("layout-5-plus");
  }

  function applyTileMediaState(tileEl, state) {
    if (!tileEl) return;
    const micOff = !!(state && state.micMuted);
    const camOff = !!(state && state.camMuted);
    const indicators = tileEl.querySelector(".media-state-indicators");
    if (indicators) {
      indicators.innerHTML = "";
      if (micOff) {
        const micBadge = document.createElement("span");
        micBadge.className = "media-state-badge media-state-badge--mic";
        micBadge.innerHTML = '<i data-lucide="mic-off"></i>';
        indicators.appendChild(micBadge);
      }
      renderIcons();
    }
    tileEl.classList.toggle("cam-off", camOff);
    tileEl.classList.toggle("cam-on", !camOff);
  }

  function applyLocalMediaState() {
    applyTileMediaState($("local-tile"), { micMuted, camMuted });
  }

  function emitMediaState() {
    if (!socket || !socket.connected || !meetingState.code) return;
    socket.emit("media:state", { micMuted: !!micMuted, camMuted: !!camMuted });
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
    applyLocalMediaState();
    emitMediaState();
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
    applyLocalMediaState();
    emitMediaState();
  }

  // â”€â”€ Switch camera (front/back) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function switchCamera() {
    if (!localStream) return;
    facingMode = facingMode === "user" ? "environment" : "user";
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode },
        audio: true,
      });
      // Replace video track in local stream and all peer connections
      const newVideoTrack = newStream.getVideoTracks()[0];
      const oldVideoTrack = localStream.getVideoTracks()[0];
      // Replace track in all peer connections BEFORE stopping old track
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
      // Now stop old track and swap in local stream
      if (oldVideoTrack) oldVideoTrack.stop();
      localStream.removeTrack(oldVideoTrack);
      localStream.addTrack(newVideoTrack);
      // Update local video element
      const v = $("local-video");
      if (v) v.srcObject = localStream;
      // Mirror: front camera mirrored, back camera normal
      if (v) v.style.transform = facingMode === "user" ? "scaleX(-1)" : "scaleX(1)";
      // Stop the new audio track since we keep the old one
      newStream.getAudioTracks().forEach(t => t.stop());
      // Re-apply cam muted state
      if (camMuted) newVideoTrack.enabled = false;
    } catch (e) {
      console.warn("Camera switch failed", e);
      // Revert facing mode
      facingMode = facingMode === "user" ? "environment" : "user";
    }
  }

  // â”€â”€ Lobby user display â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    if (legacyChip) legacyChip.textContent = name + (email ? " Â· " + email : "");
    if (av) av.textContent = name.charAt(0).toUpperCase();
  }

  // â”€â”€ Subtitle helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function setSubtitlesEnabled(enabled) {
    subtitlesEnabled = !!enabled;
    const subtitleToggle = $("toggle-subtitles");
    if (subtitleToggle) subtitleToggle.checked = subtitlesEnabled;

    if (subtitlesEnabled) {
      if (!sttActive) startStt();
      return;
    }

    // Hide all subtitle overlays when disabled
    document.querySelectorAll(".remote-voice-subtitle").forEach((el) => { el.textContent = ""; });
    const localVSub = $("local-voice-subtitle");
    if (localVSub) localVSub.textContent = "";
    hideGlobalSubtitle();
  }

  function subtitleLangLabel(code, fallback) {
    const key = String(code || "").trim().toLowerCase();
    if (SUBTITLE_LANG_LABELS[key]) return SUBTITLE_LANG_LABELS[key];
    return fallback || key.toUpperCase() || "Unknown";
  }

  function hideGlobalSubtitle() {
    const meta = $("qr-subtitle-meta");
    const text = $("qr-subtitle-text");
    if (meta) meta.textContent = "";
    if (text) text.textContent = "";
    clearTimeout(hideGlobalSubtitle._timer);
  }

  function showGlobalSubtitle(displayText, sourceLang, speaker) {
    const meta = $("qr-subtitle-meta");
    const textEl = $("qr-subtitle-text");
    if (!meta || !textEl) return;
    if (!subtitlesEnabled || !displayText) { hideGlobalSubtitle(); return; }

    const sourceLabel = subtitleLangLabel(sourceLang, "Source");
    const targetLabel = subtitleLangLabel(subtitleLang || sourceLang, "Original");
    meta.textContent = sourceLabel + " â†’ " + targetLabel + (speaker ? " Â· " + speaker : "");
    textEl.textContent = displayText;
    clearTimeout(hideGlobalSubtitle._timer);
    hideGlobalSubtitle._timer = setTimeout(() => hideGlobalSubtitle(), 6000);
  }

  function renderLocalSignSubtitle() {
    const el = $("local-sign-subtitle");
    if (el) el.textContent = "";
  }

  function setRemoteSignSubtitle(peerId, data) {
    const wrap = document.getElementById("remote-" + peerId);
    if (!wrap) return;
    const sub = wrap.querySelector(".remote-sign-subtitle");
    if (!sub) return;
    let line = data.text || "";
    if (data.translatedText) line += " Â· " + data.translatedText;
    const kind = data.kind && data.kind !== "gesture" ? " [" + data.kind + "]" : "";
    sub.textContent = line ? line + kind : "";
  }

  // â”€â”€ STT subtitle helpers (real-time translated voice) â”€â”€â”€â”€â”€â”€â”€â”€
  function clearSttSubtitleTimer(key) {
    const t = sttSubtitleTimers.get(key);
    if (t) { clearTimeout(t); sttSubtitleTimers.delete(key); }
  }

  function scheduleSttSubtitleClear(key, el) {
    if (!el) return;
    clearSttSubtitleTimer(key);
    const t = setTimeout(() => { el.textContent = ""; sttSubtitleTimers.delete(key); }, 5000);
    sttSubtitleTimers.set(key, t);
  }

  function sttSubtitleText(data) {
    let line = data && data.text ? String(data.text) : "";
    if (data && data.translatedText) line += " â†’ " + data.translatedText;
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

  // â”€â”€ TTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ PDF helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Document panel helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    // Every member can upload their own private document
    if (row) row.classList.remove("hidden");
  }

  function emitDocLanguage() {
    // Use "To language" subtitle setting as preferred language for server-side translation
    const sel = $("subtitle-lang-select") || $("recv-lang-select") || $("doc-lang-select");
    if (!socket || !socket.connected || !sel) return;
    const lang = normalizeReceiveLang(sel.value || "en");
    socket.emit("doc:setLanguage", { preferredLanguage: lang });
  }

  function applyDocPayload(d) {
    const st = $("doc-status");
    if (st) {
      st.innerHTML = '<span class="notebook-source-item"><i data-lucide="file-check" style="width:12px;height:12px;stroke:var(--green);stroke-width:2;"></i> ' +
        (d.fileName || "Document") + " â€” ready</span>";
      renderIcons();
    }
    activeDocId = d.docId || null;
    hidePdfPreview();
  }

  // â”€â”€ NotebookLM-style conversation rendering â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        // AI response â€” render with basic markdown-like formatting
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

  // â”€â”€ Subtitle translation helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const _translateCache = new Map();
  async function translateForSubtitle(text, sourceLang) {
    if (!subtitleLang || !text.trim()) return text;
    // Use explicit source language when user selected "From language".
    const forcedSrc = subtitleSourceLang && subtitleSourceLang !== "auto" ? subtitleSourceLang : "";
    const detectedSrc = (sourceLang || "auto").split("-")[0] || "auto";
    const src = forcedSrc || detectedSrc;
    if (src === subtitleLang) return text;
    const key = src + ":" + subtitleLang + ":" + text;
    if (_translateCache.has(key)) return _translateCache.get(key);
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, source: src, target: subtitleLang }),
      });
      if (!res.ok) return text;
      const data = await res.json();
      const result = data.translated || text;
      _translateCache.set(key, result);
      // Keep cache small
      if (_translateCache.size > 200) {
        const first = _translateCache.keys().next().value;
        _translateCache.delete(first);
      }
      return result;
    } catch {
      return text;
    }
  }

  // â”€â”€ Voice-to-Text (Server-side Whisper) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const STT_CHUNK_MS = 4000; // send audio every 4 seconds

  function initStt() {
    // Nothing to initialize â€” MediaRecorder is created on start
  }

  function startStt() {
    if (sttActive) return;
    if (!localStream) { meetingStatus("No microphone stream available."); return; }

    // Create a new stream with only audio tracks
    const audioTracks = localStream.getAudioTracks();
    if (!audioTracks.length) { meetingStatus("No audio track found."); return; }
    const audioStream = new MediaStream(audioTracks);

    // Pick best supported format (Safari uses mp4, Chrome uses webm)
    let mimeType = "";
    for (const mt of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
      if (MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; }
    }

    const recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : {});

    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      if (!socket || !socket.connected) return;

      // Use "From language" in settings as Whisper hint, fallback to STT lang select
      const sourceSel = $("subtitle-source-lang-select");
      const langSel = $("stt-lang-select");
      const sourceLangVal = sourceSel ? sourceSel.value : "";
      const sttLangVal = langSel ? langSel.value : "";
      // If user picked a specific "From language" (not auto), use that
      const whisperLang = (sourceLangVal && sourceLangVal !== "auto")
        ? sourceLangVal
        : (sttLangVal.split("-")[0] || "");

      // Determine file extension from mime type for Whisper
      const ext = mimeType.includes("mp4") ? ".mp4" : mimeType.includes("ogg") ? ".ogg" : ".webm";
      e.data.arrayBuffer().then((buf) => {
        socket.emit("audio:chunk", {
          audio: buf,
          language: whisperLang,
          ext,
        });
      });
    };

    recorder.onerror = () => { stopStt(); };

    recorder.start(STT_CHUNK_MS);
    sttMediaRecorder = recorder;
    sttActive = true;

    const bar = $("stt-live-bar");
    if (bar) bar.classList.remove("hidden");
    const btn = $("btn-stt");
    if (btn) btn.classList.add("active");
    const liveText = $("stt-live-text");
    if (liveText) liveText.textContent = "Listening (Whisper)...";
  }

  function stopStt() {
    sttActive = false;
    if (sttMediaRecorder && sttMediaRecorder.state !== "inactive") {
      try { sttMediaRecorder.stop(); } catch (_) {}
    }
    sttMediaRecorder = null;

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

  // â”€â”€ Socket handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    socket.on("media:state", (data) => {
      const peerId = typeof data?.socketId === "string" ? data.socketId : "";
      if (!peerId) return;
      if (socket && peerId === socket.id) return;
      const state = { micMuted: !!data.micMuted, camMuted: !!data.camMuted };
      peerMediaStates.set(peerId, state);
      const wrap = document.getElementById("remote-" + peerId);
      if (wrap) applyTileMediaState(wrap, state);
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
          if (data.translatedText) body += ` â†’ ${data.translatedText}`;
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

    /* â”€â”€ Real-time translated STT subtitles â”€â”€ */
    socket.on("stt:message", (data) => {
      if (!subtitlesEnabled) return;
      const isSelf = socket && data.socketId === socket.id;
      if (isSelf) {
        setLocalSttSubtitle(data);
      } else if (data.socketId) {
        setRemoteSttSubtitle(data.socketId, data);
      }
      // Show in global subtitle bar at bottom of screen
      const displayText = data.translatedText || data.text || "";
      if (displayText) {
        showGlobalSubtitle(displayText, data.lang || "auto", data.from || (isSelf ? "You" : "Participant"));
      }
    });

    /* â”€â”€ Real-time voice captions from other users â”€â”€ */
    socket.on("caption:voice", (data) => {
      const peerId = data.socketId;
      if (!peerId) return;

      // If this is our own transcription, show on local video + chat input
      if (peerId === socket.id) {
        const localSub = $("local-voice-subtitle");
        const sourceForMeta = subtitleSourceLang !== "auto" ? subtitleSourceLang : (data.lang || "auto");
        const speaker = data.from || "You";
        if (localSub && subtitlesEnabled) {
          localSub.textContent = data.text || "";
          clearTimeout(localSub._clearTimer);
          if (data.isFinal && data.text) {
            // Translate local subtitle if language is set
            if (subtitleLang) {
              const srcLang = data.lang || "auto";
              translateForSubtitle(data.text, srcLang).then((translated) => {
                const finalText = translated || data.text;
                if (translated !== data.text) localSub.textContent = translated;
                showGlobalSubtitle(finalText, sourceForMeta, speaker);
                clearTimeout(localSub._clearTimer);
                localSub._clearTimer = setTimeout(() => { localSub.textContent = ""; }, 5000);
              });
            } else {
              showGlobalSubtitle(data.text, sourceForMeta, speaker);
              localSub._clearTimer = setTimeout(() => { localSub.textContent = ""; }, 4000);
            }
          } else if (data.text) {
            showGlobalSubtitle(data.text, sourceForMeta, speaker);
          }
        } else if (localSub && !subtitlesEnabled) {
          localSub.textContent = "";
          hideGlobalSubtitle();
        }
        // (subtitles only â€” no chat input fill)
        return;
      }

      // If subtitles are off, don't show remote captions
      if (!subtitlesEnabled) return;

      const wrap = document.getElementById("remote-" + peerId);
      if (!wrap) return;
      let sub = wrap.querySelector(".remote-voice-subtitle");
      if (!sub) {
        sub = document.createElement("div");
        sub.className = "video-subtitle remote-voice-subtitle";
        sub.setAttribute("aria-live", "polite");
        wrap.appendChild(sub);
      }

      // Show original text immediately
      sub.textContent = data.text || "";
      clearTimeout(sub._clearTimer);
      if (data.text) {
        const sourceForMeta = subtitleSourceLang !== "auto" ? subtitleSourceLang : (data.lang || "auto");
        showGlobalSubtitle(data.text, sourceForMeta, data.from || "Participant");
      }

      // If user selected a different language, translate async
      if (subtitleLang && data.text && data.isFinal) {
        const srcLang = data.lang || "auto";
        translateForSubtitle(data.text, srcLang).then((translated) => {
          if (translated !== data.text) {
            sub.textContent = translated;
          }
          showGlobalSubtitle(translated || data.text, srcLang, data.from || "Participant");
          clearTimeout(sub._clearTimer);
          sub._clearTimer = setTimeout(() => { sub.textContent = ""; }, 5000);
        });
      } else if (data.isFinal && data.text) {
        sub._clearTimer = setTimeout(() => { sub.textContent = ""; }, 4000);
      } else if (!data.text) {
        sub.textContent = "";
      }
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
      if (st) st.textContent = (d.fileName || "") + " Â· source: " + (d.sourceLanguage || "?");
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
        host_left:  "Host left â€” meeting closed.",
        empty:      "Everyone left â€” meeting closed.",
      };
      meetingStatus(labels[reason] || "Meeting ended.");
      await cleanupMeeting();
      showView("lobby");
      refreshLobbyUser();
    });
  }

  // â”€â”€ Peer management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function setupLocalVideo() {
    const v = $("local-video");
    if (v) v.srcObject = localStream;
    applyLocalMediaState();
    updateVideoLayout();
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
        const indicators = document.createElement("div");
        indicators.className = "media-state-indicators";
        indicators.setAttribute("aria-live", "polite");
        const offPlaceholder = document.createElement("div");
        offPlaceholder.className = "video-off-placeholder";
        offPlaceholder.setAttribute("aria-hidden", "true");
        offPlaceholder.innerHTML = '<i data-lucide="camera-off" style="width:72px;height:72px;stroke:rgba(255,255,255,0.92);stroke-width:2.2;"></i>';
        const lab = document.createElement("span");
        lab.className = "label";
        lab.textContent = remoteName || "Guest";
        wrap.appendChild(vid);
        wrap.appendChild(sub);
        wrap.appendChild(sttSub);
        wrap.appendChild(indicators);
        wrap.appendChild(offPlaceholder);
        wrap.appendChild(lab);
        $("remote-videos").appendChild(wrap);
        renderIcons();
      }
      applyTileMediaState(wrap, peerMediaStates.get(peerId) || { micMuted: false, camMuted: false });
      updateVideoLayout();
    });

    peer.on("close", () => removePeer(peerId));
    peer.on("error", (e) => console.warn("peer error", peerId, e));
    peers.set(peerId, peer);
    updateVideoLayout();
  }

  function removePeer(peerId) {
    clearSttSubtitleTimer("remote:" + peerId);
    peerMediaStates.delete(peerId);
    const peer = peers.get(peerId);
    if (peer) { try { peer.destroy(); } catch (_) {} peers.delete(peerId); }
    const wrap = document.getElementById("remote-" + peerId);
    if (wrap) wrap.remove();
    updateVideoLayout();
  }

  // â”€â”€ Meeting lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function updateMeetingMeta(ack) {
    meetingState = { code: ack.code, joinUrl: ack.joinUrl || "", isHost: !!ack.isHost };
    $('meeting-code-label').textContent = ack.code;
    $("qr-img").src = "/api/qr/" + encodeURIComponent(ack.code);
    $("btn-end").classList.toggle("hidden", !ack.isHost);
    meetingStatus("");
    $("chat-log").innerHTML = "";
    peerMediaStates.clear();
    ["sign-log","sign-log-sidebar"].forEach(id => { const el = $(id); if(el) el.innerHTML = ""; });
    const hs = $("hand-sign-enable");
    if (hs) hs.checked = false;
    const sp = $("hand-sign-spell");
    if (sp) sp.checked = false;
    const tts = $("sign-tts-enable");
    if (tts) tts.checked = false;
    lastLocalSignLine = "";
    localSpellDraft = "";
    renderLocalSignSubtitle();
    syncHandSignUiState();
    document.querySelectorAll(".remote-sign-subtitle").forEach(n => { n.textContent = ""; });
    document.querySelectorAll(".remote-voice-subtitle").forEach(n => { n.textContent = ""; });
    document.querySelectorAll(".remote-stt-subtitle").forEach(n => { n.textContent = ""; });
    const localVoiceSub = $("local-voice-subtitle");
    if (localVoiceSub) localVoiceSub.textContent = "";
    const localSttSub = $("local-stt-subtitle");
    if (localSttSub) localSttSub.textContent = "";
    clearSttSubtitleTimer("local");
    resetDocPanel();
    syncDocHostUi();
    const dinput = $("doc-file-input");
    if (dinput) dinput.value = "";
    if (socket && socket.connected) emitDocLanguage();
    setMicMuted(true);
    setCamMuted(true);
    setSubtitlesEnabled(false);
    updateVideoLayout();
  }

  async function stopHandSignCaptions() {
    if (window.HandSignCaptions && window.HandSignCaptions.isRunning()) {
      try { await window.HandSignCaptions.stop(); } catch (_) {}
    }
    const hs = $("hand-sign-enable");
    if (hs) hs.checked = false;
    const sp = $("hand-sign-spell");
    if (sp) sp.checked = false;
    const tts = $("sign-tts-enable");
    if (tts) tts.checked = false;
    localSpellDraft = "";
    renderLocalSignSubtitle();
    syncHandSignUiState();
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
    const locVoiceSub = $("local-voice-subtitle");
    if (locVoiceSub) locVoiceSub.textContent = "";
    hideGlobalSubtitle();
    const locSttSub = $("local-stt-subtitle");
    if (locSttSub) locSttSub.textContent = "";
    sttSubtitleTimers.forEach((t) => clearTimeout(t));
    sttSubtitleTimers.clear();
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
    closeSidebar();
    const sp = $("settings-popup"); if (sp) sp.classList.add("hidden");
    const sb = $("btn-settings"); if (sb) sb.classList.remove("active");
    micMuted = false; camMuted = false;
    applyLocalMediaState();
    updateVideoLayout();
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

  // â”€â”€ Hand-sign captions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function syncHandSignFromCheckbox() {
    const el = $("hand-sign-enable");
    const video = $("local-video");
    if (!el || !video) return;
    syncHandSignUiState();

    const want = el.checked;
    if (want) {
      if (!window.HandSignCaptions) {
        meetingStatus("Hand-sign script not loaded.");
        el.checked = false;
        syncHandSignUiState();
        return;
      }
      if (!window.HandSignAlphabetKit) {
        meetingStatus("Missing vendor/handsigns-alphabet.js - run: npm run build:handsigns");
        el.checked = false;
        syncHandSignUiState();
        return;
      }
      try {
        meetingStatus("Loading hand models...");
        await window.HandSignCaptions.start(
          video,
          (payload) => {
            if (socket && socket.connected) {
              socket.emit("sign:caption", {
                text: payload.text,
                gestureKey: payload.gestureKey,
                kind: payload.kind || "gesture",
                lang: payload.lang,
                translatedText: payload.translatedText,
              });
            }
            if (payload.kind !== "spell" || payload.text) {
              lastLocalSignLine = payload.text || "";
              renderLocalSignSubtitle();
            }
          },
          {
            getSpellMode: () => {
              const e = $("hand-sign-spell");
              return !!(e && e.checked);
            },
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

    syncHandSignUiState();
  }

  function syncHandSignUiState() {
    const hs = $("hand-sign-enable");
    const sp = $("hand-sign-spell");
    const tts = $("sign-tts-enable");
    const enabled = !!(hs && hs.checked);
    const spell = !!(enabled && sp && sp.checked);
    const status = $("hand-sign-status");
    const modeRow = $("hand-sign-mode-row");
    const ttsRow = $("hand-sign-tts-row");
    const actions = $("hand-sign-actions");
    const hint = $("hand-sign-hint");
    const modeGesture = $("btn-hand-mode-gesture");
    const modeSpell = $("btn-hand-mode-spell");

    if (status) {
      status.textContent = !enabled ? "Off" : (spell ? "On • Spell" : "On • Gesture");
      status.classList.toggle("on", enabled);
    }
    if (modeRow) modeRow.classList.toggle("hidden", !enabled);
    if (ttsRow) ttsRow.classList.toggle("hidden", !enabled);
    if (actions) actions.classList.toggle("hidden", !spell);

    if (hint) {
      hint.textContent = !enabled
        ? "Turn on captions to choose mode and audio behavior."
        : (spell
          ? "Finger-spelling: A-Z, open palm = space, hold fist ~1/3s to send."
          : "Gesture mode uses MediaPipe gestures + fingerpose.");
    }

    if (modeGesture) {
      modeGesture.classList.toggle("active", !spell);
      modeGesture.disabled = !enabled;
    }
    if (modeSpell) {
      modeSpell.classList.toggle("active", spell);
      modeSpell.disabled = !enabled;
    }

    if (!enabled) {
      if (sp) sp.checked = false;
      if (tts) tts.checked = false;
    }
  }
  // â”€â”€ Login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        "Network error â€” is the server running? (npm start) " + String(err && err.message ? err.message : err);
      return;
    }
    const raw = await res.text();
    let data = {};
    if (raw) { try { data = JSON.parse(raw); } catch { $("login-error").textContent = `Server returned ${res.status} (not JSON). Run: npm start`; return; } }
    if (!res.ok) {
      $("login-error").textContent =
        data.error || (res.status === 404 || res.status === 405
          ? "API not found â€” run the backend: npm start"
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

  // â”€â”€ Wire up all event listeners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    $("btn-switch-cam").addEventListener("click", () => switchCamera());

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

    $("btn-toggle-sidebar").addEventListener("click", () => {
      toggleSidebar("chat");
      updateControlIcons();
    });

    $("btn-open-doc").addEventListener("click", () => {
      if (sidebarOpen && activeSidebarTab === "doc") { closeSidebar(); }
      else { openSidebar("doc"); }
      updateControlIcons();
    });

    $("btn-toggle-handsign-bar").addEventListener("click", () => {
      toggleSidebar("handsign");
      syncHandSignUiState();
      updateControlIcons();
    });

    // Settings popup
    const settingsBtn = $("btn-settings");
    const settingsPopup = $("settings-popup");
    if (settingsBtn && settingsPopup) {
      // Prevent any touch/click inside popup from closing it
      settingsPopup.addEventListener("click", (e) => e.stopPropagation());
      settingsPopup.addEventListener("touchend", (e) => e.stopPropagation());

      settingsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        settingsPopup.classList.toggle("hidden");
        settingsBtn.classList.toggle("active", !settingsPopup.classList.contains("hidden"));
      });
      // Close popup when clicking/tapping outside
      document.addEventListener("click", (e) => {
        if (!settingsPopup.contains(e.target) && !settingsBtn.contains(e.target)) {
          settingsPopup.classList.add("hidden");
          settingsBtn.classList.remove("active");
        }
      });
    }

    // Subtitle toggle â€” also auto-start/stop STT
    const subtitleToggle = $("toggle-subtitles");
    if (subtitleToggle) {
      subtitleToggle.addEventListener("change", () => setSubtitlesEnabled(subtitleToggle.checked));

      // Mobile Safari/webview resilience: allow tapping the full row text/icon area.
      const subtitleRow = subtitleToggle.closest(".settings-row");
      if (subtitleRow) {
        subtitleRow.addEventListener("click", (ev) => {
          if (ev.target === subtitleToggle) return;
          subtitleToggle.checked = !subtitleToggle.checked;
          setSubtitlesEnabled(subtitleToggle.checked);
        });
      }
    }

    // Subtitle translation: from language (also syncs STT speech language)
    const subtitleSourceSel = $("subtitle-source-lang-select");
    if (subtitleSourceSel) {
      subtitleSourceSel.value = subtitleSourceLang;
      subtitleSourceSel.addEventListener("change", () => {
        subtitleSourceLang = subtitleSourceSel.value || "auto";
        // Sync STT lang select so Whisper uses the right language
        const sttSel = $("stt-lang-select");
        if (sttSel && subtitleSourceLang !== "auto") {
          // Map 2-letter code to locale code used in stt-lang-select (e.g. "my" -> "my-MM")
          const opt = [...sttSel.options].find(o => o.value.startsWith(subtitleSourceLang));
          if (opt) sttSel.value = opt.value;
        }
        // Restart STT if active so Whisper picks up new language
        if (sttActive) { stopStt(); startStt(); }
      });
    }

    // Subtitle translation: to language
    const subtitleLangSel = $("subtitle-lang-select");
    if (subtitleLangSel) {
      subtitleLangSel.value = subtitleLang;
      subtitleLangSel.addEventListener("change", () => {
        subtitleLang = subtitleLangSel.value;
        // Tell server our preferred receive language for stt:message translation
        if (socket && socket.connected) emitDocLanguage();
      });
    }

    // Chat form
    $("form-chat").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const input = $("chat-input");
      const text = input.value.trim();
      if (!text || !socket) return;
      socket.emit("chat:message", { text });
      input.value = "";
    });

    // (STT mic button and lang select removed from chat â€” subtitles controlled via Settings)

    // Hand-sign controls
    const handSignCb = $("hand-sign-enable");
    if (handSignCb) {
      handSignCb.addEventListener("change", () => {
        syncHandSignUiState();
        void syncHandSignFromCheckbox();
      });
    }

    const spellCb = $("hand-sign-spell");
    if (spellCb) {
      spellCb.addEventListener("change", () => {
        syncHandSignUiState();
        if (window.HandSignCaptions && window.HandSignCaptions.isRunning()) {
          if (!spellCb.checked) window.HandSignCaptions.clearSpellBuffer();
        }
      });
    }

    const modeGestureBtn = $("btn-hand-mode-gesture");
    if (modeGestureBtn) {
      modeGestureBtn.addEventListener("click", () => {
        const hs = $("hand-sign-enable");
        const sp = $("hand-sign-spell");
        if (!hs || !sp || !hs.checked) return;
        sp.checked = false;
        sp.dispatchEvent(new Event("change"));
      });
    }

    const modeSpellBtn = $("btn-hand-mode-spell");
    if (modeSpellBtn) {
      modeSpellBtn.addEventListener("click", () => {
        const hs = $("hand-sign-enable");
        const sp = $("hand-sign-spell");
        if (!hs || !sp || !hs.checked) return;
        sp.checked = true;
        sp.dispatchEvent(new Event("change"));
      });
    }

    const signTtsCb = $("sign-tts-enable");
    if (signTtsCb) {
      signTtsCb.addEventListener("change", () => {
        if (!signTtsCb.checked && window.speechSynthesis) {
          try { speechSynthesis.cancel(); } catch (_) {}
        }
      });
    }

    syncHandSignUiState();

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
        if (!before) { meetingStatus("Nothing to send yet â€” hold each letter steady until it appears."); setTimeout(() => meetingStatus(""), 5000); }
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

    // (recv-lang-select removed â€” "To language" in Settings handles this now)

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
          // Add JWT auth header if using legacy login
          if (getAuthType() === "jwt") {
            fetchOpts.headers = { Authorization: "Bearer " + getToken() };
          }
          const res = await fetch(
            "/api/rooms/" + encodeURIComponent(meetingState.code) + "/documents",
            fetchOpts
          );
          const data = await res.json().catch(() => ({}));
          if (res.status === 202) meetingStatus("Document queued â€” AI is processing...");
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
              (res.status === 503 ? "Eazii AI not configured on server" : "") ||
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

  // â”€â”€ Boot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function boot() {
    wireEvents();
    initStt();

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





