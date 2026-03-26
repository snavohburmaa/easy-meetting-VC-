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

  // Participants & featured/spotlight state
  const peerNames = new Map(); // peerId -> display name
  let pinnedPeerId = null;     // currently spotlighted peer (null = auto/none)
  let activeSpeakerId = null;  // peer currently talking (detected via audio level)
  let featuredId = null;       // peerId in center tile ("__local__" for self, or peerId)

  // Attention detection state
  let pendingAttentionData = null; // stored from room:ended for host summary
  const liveAttention = new Map(); // peerId -> "Active"|"Distracted"|"Eyes Closed" (host tracks all peers)
  const peerAttentionCounts = new Map(); // peerId -> { scoreSum, total } (participants only)
  let hostSelfAttention = null; // { scoreSum, total } — host's own data, excluded from overall meter

  // English-only speech recognition
  const SPEECH_LANG = "en-US";

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
  let summaryWasHost = false;
  let summaryChatHistory = [];
  let summaryMeetingName = "";
  let historyMeetingId = null; // set when viewing a past meeting from Supabase

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
    // Pause/resume STT when mic is muted/unmuted to prevent
    // picking up other people's audio through speakers
    // STT always runs for transcript capture (not just when subtitles are on)
    if (muted) {
      stopStt();
    } else {
      startStt();
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

    // Show screen share in the featured center tile
    showFeatured(
      new MediaStream([screenTrack, ...localStream.getAudioTracks()]),
      getLocalName() + " (Screen)",
      true
    );

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

    // Hide featured center tile
    hideFeatured();

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

  // ── Recent Meetings ────────────────────────────────────────────
  async function loadRecentMeetings() {
    const list = $("recent-meetings-list");
    const empty = $("recent-meetings-empty");
    if (!list) return;
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch("/api/recent-meetings", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!res.ok) return;
      const { meetings } = await res.json();
      if (!meetings || meetings.length === 0) {
        if (empty) empty.style.display = "";
        return;
      }
      if (empty) empty.style.display = "none";
      // Remove existing cards (keep the empty placeholder)
      list.querySelectorAll(".recent-meeting-card").forEach((el) => el.remove());
      meetings.forEach((m) => {
        const card = document.createElement("div");
        card.className = "recent-meeting-card";
        card.dataset.meetingId = m.id;

        const iconClass = m.isHost ? "recent-meeting-icon--host" : "recent-meeting-icon--guest";
        const iconStroke = m.isHost ? "var(--accent-2)" : "var(--cyan)";
        const badgeClass = m.isHost ? "recent-meeting-badge--host" : "recent-meeting-badge--guest";
        const badgeText = m.isHost ? "Host" : "Guest";
        const displayName = m.meetingName || "Unnamed Meeting";
        const dateStr = formatRecentDate(m.createdAt);
        const dur = (m.durationMinutes || 0) + " min";
        const attCount = (m.attendees || []).length;
        const summarySnippet = (m.summary || "").slice(0, 80);

        card.innerHTML =
          '<div class="recent-meeting-icon ' + iconClass + '">' +
            '<i data-lucide="' + (m.isHost ? "crown" : "user") + '" style="width:18px;height:18px;stroke:' + iconStroke + ';stroke-width:2;"></i>' +
          '</div>' +
          '<div class="recent-meeting-info">' +
            '<div class="recent-meeting-name">' + escapeHtml(displayName) + '</div>' +
            '<div class="recent-meeting-meta">' +
              '<span><i data-lucide="calendar" style="width:11px;height:11px;stroke:currentColor;stroke-width:2;"></i> ' + dateStr + '</span>' +
              '<span><i data-lucide="clock" style="width:11px;height:11px;stroke:currentColor;stroke-width:2;"></i> ' + dur + '</span>' +
              '<span><i data-lucide="users" style="width:11px;height:11px;stroke:currentColor;stroke-width:2;"></i> ' + attCount + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="recent-meeting-actions">' +
            '<button class="recent-meeting-action-btn" data-action="rename" title="Rename">' +
              '<i data-lucide="pencil" style="width:14px;height:14px;stroke:currentColor;stroke-width:2;"></i>' +
            '</button>' +
            '<button class="recent-meeting-action-btn recent-meeting-action-btn--danger" data-action="delete" title="Delete">' +
              '<i data-lucide="trash-2" style="width:14px;height:14px;stroke:currentColor;stroke-width:2;"></i>' +
            '</button>' +
          '</div>' +
          '<span class="recent-meeting-badge ' + badgeClass + '">' + badgeText + '</span>';

        // Click card body to view, but not action buttons
        card.addEventListener("click", (e) => {
          if (e.target.closest(".recent-meeting-actions")) return;
          showHistoryMeeting(m.id);
        });
        // Rename
        card.querySelector('[data-action="rename"]').addEventListener("click", (e) => {
          e.stopPropagation();
          renameRecentMeeting(m.id, displayName);
        });
        // Delete
        card.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
          e.stopPropagation();
          deleteRecentMeeting(m.id, displayName);
        });
        list.appendChild(card);
      });
      renderIcons();
    } catch (err) {
      console.warn("[recent-meetings]", err);
    }
  }

  async function renameRecentMeeting(meetingId, currentName) {
    const newName = prompt("Rename meeting:", currentName);
    if (newName === null) return; // cancelled
    const token = getToken();
    try {
      const res = await fetch("/api/meeting-history/" + encodeURIComponent(meetingId) + "/name", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (res.ok) loadRecentMeetings();
    } catch {}
  }

  async function deleteRecentMeeting(meetingId, meetingName) {
    if (!confirm("Delete \"" + meetingName + "\"? This cannot be undone.")) return;
    const token = getToken();
    try {
      const res = await fetch("/api/meeting-history/" + encodeURIComponent(meetingId), {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token },
      });
      if (res.ok) loadRecentMeetings();
    } catch {}
  }

  function formatRecentDate(iso) {
    try {
      const d = new Date(iso);
      const now = new Date();
      const diff = now - d;
      if (diff < 86400000 && d.getDate() === now.getDate()) {
        return "Today " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      if (d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth()) {
        return "Yesterday " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
      return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
        d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch { return ""; }
  }

  async function showHistoryMeeting(meetingId) {
    // Close the recent meetings modal if open
    const modal = $("recent-meetings-modal");
    if (modal) modal.classList.add("hidden");
    historyMeetingId = meetingId;
    summaryRoomCode = null;
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

    const token = getToken();
    try {
      const res = await fetch("/api/meeting-history/" + encodeURIComponent(meetingId), {
        headers: { Authorization: "Bearer " + token },
      });
      if (!res.ok) throw new Error("Failed to load meeting");
      const data = await res.json();

      if (loading) loading.classList.add("hidden");
      if (cards) cards.classList.remove("hidden");

      // Hide regenerate for history meetings
      const regenBtn = $("btn-regenerate-summary");
      if (regenBtn) regenBtn.classList.add("hidden");

      const titleEl = $("summary-title");
      if (titleEl) titleEl.textContent = data.meetingName || "Meeting Summary";

      const meta = $("summary-meta");
      if (meta) meta.textContent = new Date(data.createdAt).toLocaleString() + " \u00b7 Room: " + data.roomCode;

      const txt = $("summary-text");
      if (txt) txt.textContent = data.summary || "No summary available.";

      const dur = $("summary-duration");
      if (dur) dur.textContent = (data.durationMinutes || 0) + " min";

      const att = $("summary-attendees");
      if (att) {
        const count = (data.attendees || []).length;
        att.textContent = count + " participant" + (count !== 1 ? "s" : "");
      }

      populateAttendeePopup(data.attendeeDetails || [], data.attendees || []);

      renderSummarySection("summary-topics", "summary-topics-card", data.topics, (t) =>
        "<strong>" + escapeHtml(t.title) + "</strong><p>" + escapeHtml(t.details) + "</p>");
      renderSummarySection("summary-assignments", "summary-assignments-card", data.assignments, (a) =>
        '<span class="assignment-badge">' + escapeHtml(a.assignee) + "</span> " + escapeHtml(a.task));
      renderSummarySection("summary-decisions", "summary-decisions-card", data.keyDecisions, (d) => escapeHtml(d));
      renderContributions(data.participantSummaries);

      // Attention (host only — check if current user is the host of this meeting)
      const currentUserEmail = (() => { const t = getToken(); if (!t) return ""; const p = decodeJwtPayload(t); return (p && p.email) || ""; })();
      const wasHostOfMeeting = data.hostEmail && currentUserEmail && data.hostEmail === currentUserEmail;
      const attCard = $("summary-attention-card");
      const attEl = $("summary-attention");
      if (wasHostOfMeeting && attCard && attEl && data.attentionStats && data.attentionStats.length > 0) {
        attEl.innerHTML = "";
        data.attentionStats.forEach((a) => {
          const pct = typeof a.activePercent === "number" ? a.activePercent : 0;
          const level = pct >= 70 ? "high" : pct >= 40 ? "medium" : "low";
          const item = document.createElement("div");
          item.className = "attention-item";
          item.innerHTML =
            '<span class="attention-item-name">' + escapeHtml(a.name) + '</span>' +
            '<div class="attention-bar-wrap"><div class="attention-bar ' + level + '" style="width:' + pct + '%"></div></div>' +
            '<span class="attention-percent">' + pct + '%</span>';
          attEl.appendChild(item);
        });
        attCard.classList.remove("hidden");
      } else if (attCard) {
        attCard.classList.add("hidden");
      }

      renderIcons();
    } catch (err) {
      if (loading) loading.classList.add("hidden");
      if (cards) {
        cards.classList.remove("hidden");
        const txt = $("summary-text");
        if (txt) txt.textContent = "Could not load meeting summary.";
      }
      renderIcons();
    }
  }

  // ── Subtitle helpers ─────────────────────────────────────────
  function setSubtitlesEnabled(enabled) {
    subtitlesEnabled = !!enabled;
    const subtitleToggle = $("toggle-subtitles");
    if (subtitleToggle) subtitleToggle.checked = subtitlesEnabled;

    const box = $("subtitle-box");
    if (!subtitlesEnabled && box) box.innerHTML = "";
  }

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
    recognition.lang = SPEECH_LANG;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      if (!socket || !socket.connected) return;
      if (micMuted) return; // Don't emit captions when mic is muted
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
    socket.on("peer:left",   ({ peerId })        => { removePeer(peerId); liveAttention.delete(peerId); peerAttentionCounts.delete(peerId); updateAttentionMeter(); });

    // Attention updates — host receives these for all participants (including self)
    socket.on("attention:update", ({ peerId, name, status, score }) => {
      if (!meetingState.isHost) return;
      const isSelf = socket && peerId === socket.id;
      liveAttention.set(peerId, status);

      if (isSelf) {
        // Host's own data — show on local tile but DON'T add to peerAttentionCounts
        if (!hostSelfAttention) hostSelfAttention = { scoreSum: 0, total: 0 };
        hostSelfAttention.total++;
        hostSelfAttention.scoreSum += (typeof score === "number") ? score : 0;
        const pct = hostSelfAttention.total > 0 ? Math.round((hostSelfAttention.scoreSum / hostSelfAttention.total) * 100) : 0;
        const cls = pct >= 70 ? "Active" : pct >= 40 ? "Distracted" : "Eyes Closed";
        const wrap = $("local-tile");
        if (wrap) {
          let badge = wrap.querySelector(".attention-badge");
          if (!badge) { badge = document.createElement("span"); badge.className = "attention-badge"; wrap.appendChild(badge); }
          badge.setAttribute("data-status", cls);
          badge.textContent = pct + "%";
        }
      } else {
        // Participant data — track in peerAttentionCounts for overall meter
        if (!peerAttentionCounts.has(peerId)) peerAttentionCounts.set(peerId, { scoreSum: 0, total: 0 });
        const counts = peerAttentionCounts.get(peerId);
        counts.total++;
        counts.scoreSum += (typeof score === "number") ? score : 0;
        const pct = counts.total > 0 ? Math.round((counts.scoreSum / counts.total) * 100) : 0;
        const cls = pct >= 70 ? "Active" : pct >= 40 ? "Distracted" : "Eyes Closed";
        const wrap = document.getElementById("remote-" + peerId);
        if (wrap) {
          let badge = wrap.querySelector(".attention-badge");
          if (!badge) { badge = document.createElement("span"); badge.className = "attention-badge"; wrap.appendChild(badge); }
          badge.setAttribute("data-status", cls);
          badge.textContent = pct + "%";
        }
        updateAttentionMeter();
      }
    });

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

    /* ── Real-time voice captions — show translated text from others ── */
    socket.on("caption:voice", (data) => {
      if (!data.socketId) return;
      if (data.socketId === socket.id) return;
      // Always receive captions (server records transcript), but only show if subtitles on
      if (!subtitlesEnabled) return;

      const box = $("subtitle-box");
      if (!box || !data.isFinal) return;
      const displayText = data.text || "";
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

    socket.on("room:ended", async ({ reason, summaryCode, attentionData }) => {
      const labels = {
        host_ended: "Meeting ended by host.",
        host_left:  "Host left \u2014 meeting closed.",
        empty:      "Everyone left \u2014 meeting closed.",
      };
      meetingStatus(labels[reason] || "Meeting ended.");
      const wasHost = meetingState.isHost;
      summaryWasHost = wasHost;
      // Save attention data before cleanup (host only)
      pendingAttentionData = (wasHost && Array.isArray(attentionData)) ? attentionData : null;
      await cleanupMeeting();
      if (summaryCode) {
        // If host, persist attention data to summary (retry until summary exists)
        if (wasHost && pendingAttentionData && pendingAttentionData.length > 0) {
          (async () => {
            for (let i = 0; i < 15; i++) {
              try {
                const res = await fetch("/api/meeting-summary/" + encodeURIComponent(summaryCode) + "/attention", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ attention: pendingAttentionData }),
                });
                if (res.ok) break;
              } catch {}
              await new Promise(r => setTimeout(r, 2000));
            }
          })();
        }
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

  // ── Featured tile management (only used during screen share) ──
  function showFeatured(srcObject, label, muted) {
    const grid = $("meeting-grid");
    const fv = $("featured-video");
    const fl = $("featured-label");
    if (!grid || !fv) return;
    fv.srcObject = srcObject;
    fv.muted = !!muted;
    if (fl) fl.textContent = label || "";
    grid.classList.add("has-featured");
    featuredId = "__screen__";
  }

  function hideFeatured() {
    const grid = $("meeting-grid");
    const fv = $("featured-video");
    const fl = $("featured-label");
    if (grid) grid.classList.remove("has-featured");
    if (fv) fv.srcObject = null;
    if (fl) fl.textContent = "";
    featuredId = null;
  }

  function getLocalName() {
    const t = getToken();
    if (!t) return "You";
    const payload = decodeJwtPayload(t);
    return (payload && (payload.name || payload.email)) || "You";
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
        wrap.className = "grid-tile remote-wrap";
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
        $("meeting-grid").appendChild(wrap);
      }
      startSpeakerDetection(peerId, remoteStream);
    });

    peer.on("close", () => removePeer(peerId));
    peer.on("error", (e) => console.warn("peer error", peerId, e));
    peers.set(peerId, peer);
    peerNames.set(peerId, remoteName || "Guest");
    refreshParticipantsIfOpen();
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (peer) { try { peer.destroy(); } catch (_) {} peers.delete(peerId); }
    peerNames.delete(peerId);
    stopSpeakerDetection(peerId);
    const wrap = document.getElementById("remote-" + peerId);
    if (wrap) wrap.remove();
    if (pinnedPeerId === peerId) closeSpotlight();
    if (activeSpeakerId === peerId) activeSpeakerId = null;
    refreshParticipantsIfOpen();
  }

  // ── Participants overlay (full-screen video grid) ───────────────
  function openParticipantsOverlay() {
    const overlay = $("participants-overlay");
    if (!overlay) return;
    buildParticipantsGrid();
    overlay.classList.remove("hidden");
    const btn = $("btn-participants");
    if (btn) btn.classList.add("active");
    renderIcons();
  }

  function closeParticipantsOverlay() {
    const overlay = $("participants-overlay");
    if (overlay) overlay.classList.add("hidden");
    const btn = $("btn-participants");
    if (btn) btn.classList.remove("active");
    // Stop thumbnail videos to save resources
    const grid = $("participants-grid");
    if (grid) grid.querySelectorAll("video").forEach(v => { v.srcObject = null; });
  }

  function refreshParticipantsIfOpen() {
    const overlay = $("participants-overlay");
    if (overlay && !overlay.classList.contains("hidden")) {
      buildParticipantsGrid();
    }
  }

  function toggleParticipantsOverlay() {
    const overlay = $("participants-overlay");
    if (!overlay) return;
    if (overlay.classList.contains("hidden")) {
      openParticipantsOverlay();
    } else {
      closeParticipantsOverlay();
    }
  }

  function buildParticipantsGrid() {
    const grid = $("participants-grid");
    const countEl = $("participants-count");
    if (!grid) return;
    grid.innerHTML = "";

    const total = 1 + peerNames.size;
    if (countEl) countEl.textContent = total;
    const isHost = meetingState.isHost;

    // Local user tile
    const localName = getLocalName();
    const localTile = createParticipantTile(
      localStream, localName + " (You)", null, isHost, false
    );
    localTile.addEventListener("click", () => {
      closeParticipantsOverlay();
      spotlightLocal();
    });
    grid.appendChild(localTile);

    // Remote peer tiles
    peerNames.forEach((name, peerId) => {
      const remoteWrap = document.getElementById("remote-" + peerId);
      let stream = null;
      if (remoteWrap) {
        const srcVid = remoteWrap.querySelector("video");
        if (srcVid && srcVid.srcObject) stream = srcVid.srcObject;
      }
      const isSpeaking = activeSpeakerId === peerId;
      const tile = createParticipantTile(stream, name, peerId, isHost, isSpeaking);
      tile.addEventListener("click", () => {
        closeParticipantsOverlay();
        spotlightPeer(peerId);
      });
      grid.appendChild(tile);
    });
  }

  function createParticipantTile(stream, name, peerId, isHost, isSpeaking) {
    const tile = document.createElement("div");
    tile.className = "participant-tile" + (isSpeaking ? " speaking" : "");

    // Live video
    const vid = document.createElement("video");
    vid.playsInline = true;
    vid.autoplay = true;
    vid.muted = true;
    if (stream) vid.srcObject = stream;
    tile.appendChild(vid);

    // Name label
    const lab = document.createElement("span");
    lab.className = "participant-tile-name";
    lab.textContent = name || "Guest";
    tile.appendChild(lab);

    // Attention overlays (host only, remote peers only)
    if (isHost && peerId) {
      const counts = peerAttentionCounts.get(peerId);
      const pct = (counts && counts.total > 0) ? Math.round((counts.scoreSum / counts.total) * 100) : 0;
      const barClass = pct >= 70 ? "high" : pct >= 40 ? "medium" : "low";

      // Bottom attention bar
      const bar = document.createElement("div");
      bar.className = "participant-tile-attention";
      bar.innerHTML = '<div class="participant-tile-attention-fill ' + barClass + '" style="width:' + pct + '%"></div>';
      tile.appendChild(bar);

      // Top-right percentage badge
      const badge = document.createElement("span");
      badge.className = "participant-tile-pct " + barClass;
      badge.textContent = pct + "%";
      tile.appendChild(badge);
    }

    return tile;
  }

  // Click a participant → show them in spotlight overlay (large view)
  function spotlightPeer(peerId) {
    const wrap = document.getElementById("remote-" + peerId);
    if (!wrap) return;
    const vid = wrap.querySelector("video");
    if (!vid || !vid.srcObject) return;
    pinnedPeerId = peerId;
    const overlay = $("spotlight-overlay");
    const spotVid = $("spotlight-video");
    const spotLabel = $("spotlight-label");
    if (overlay && spotVid) {
      spotVid.srcObject = vid.srcObject;
      if (spotLabel) spotLabel.textContent = peerNames.get(peerId) || "Guest";
      overlay.classList.remove("hidden");
      renderIcons();
    }
    closeParticipantsOverlay();
  }

  function spotlightLocal() {
    pinnedPeerId = "__local__";
    const overlay = $("spotlight-overlay");
    const spotVid = $("spotlight-video");
    const spotLabel = $("spotlight-label");
    if (overlay && spotVid) {
      spotVid.srcObject = localStream;
      if (spotLabel) spotLabel.textContent = getLocalName() + " (You)";
      overlay.classList.remove("hidden");
      renderIcons();
    }
    closeParticipantsOverlay();
  }

  function closeSpotlight() {
    pinnedPeerId = null;
    const overlay = $("spotlight-overlay");
    const spotVid = $("spotlight-video");
    if (overlay) overlay.classList.add("hidden");
    if (spotVid) spotVid.srcObject = null;
  }

  // Active speaker detection via audio levels
  const audioContexts = new Map(); // peerId -> { ctx, analyser, intervalId }
  function startSpeakerDetection(peerId, remoteStream) {
    try {
      const audioTracks = remoteStream.getAudioTracks();
      if (!audioTracks.length) return;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(remoteStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const intervalId = setInterval(() => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;
        if (avg > 30) { // threshold for "speaking"
          if (activeSpeakerId !== peerId) {
            activeSpeakerId = peerId;
            refreshParticipantsIfOpen();
          }
        }
      }, 500);
      audioContexts.set(peerId, { ctx, intervalId });
    } catch (_) {}
  }

  function stopSpeakerDetection(peerId) {
    const entry = audioContexts.get(peerId);
    if (entry) {
      clearInterval(entry.intervalId);
      try { entry.ctx.close(); } catch (_) {}
      audioContexts.delete(peerId);
    }
  }

  function stopAllSpeakerDetection() {
    audioContexts.forEach((entry, peerId) => {
      clearInterval(entry.intervalId);
      try { entry.ctx.close(); } catch (_) {}
    });
    audioContexts.clear();
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
    const subBox = $("subtitle-box");
    if (subBox) subBox.innerHTML = "";
    resetDocPanel();
    syncDocHostUi();
    const dinput = $("doc-file-input");
    if (dinput) dinput.value = "";
    setMicMuted(true);
    setCamMuted(true);
    setSubtitlesEnabled(false);
  }

  function updateAttentionMeter() {
    const meter = $("attention-meter");
    if (!meter || !meetingState.isHost) return;
    if (peerAttentionCounts.size === 0) { meter.classList.add("hidden"); return; }
    meter.classList.remove("hidden");
    // Compute overall cumulative active % across all participants (score-based)
    let totalScore = 0, totalFrames = 0;
    for (const counts of peerAttentionCounts.values()) {
      totalScore += counts.scoreSum;
      totalFrames += counts.total;
    }
    const pct = totalFrames > 0 ? Math.round((totalScore / totalFrames) * 100) : 0;
    const fill = $("attention-meter-fill");
    const label = $("attention-meter-pct");
    if (fill) {
      fill.style.width = pct + "%";
      fill.className = "attention-meter-fill " + (pct >= 70 ? "high" : pct >= 40 ? "medium" : "low");
    }
    if (label) label.textContent = pct + "%";
  }

  function startAttentionDetection() {
    // All users run detection — participants send to server, host tracks self locally
    if (!window.AttentionDetection || AttentionDetection.isRunning()) return;
    const video = $("local-video");
    if (!video || !socket) return;
    console.log("[app] starting attention detection, isHost:", meetingState.isHost);
    AttentionDetection.start(video, socket, (status, score) => {
      // Self-attention display — host only
      if (meetingState.isHost) {
        const selfEl = $("self-attention");
        const selfPct = $("self-attention-pct");
        const selfStatus = $("self-attention-status");
        if (selfEl) selfEl.classList.remove("hidden");
        if (selfPct) selfPct.textContent = Math.round(score * 100) + "%";
        if (selfStatus) {
          selfStatus.textContent = status;
          selfStatus.setAttribute("data-status", status);
        }
      }
    }).catch((err) => {
      console.error("[attention] could not start:", err.message, err);
    });
  }

  async function cleanupMeeting() {
    if (window.AttentionDetection && AttentionDetection.isRunning()) {
      AttentionDetection.stop();
    }
    liveAttention.clear();
    const selfAtt = $("self-attention"); if (selfAtt) selfAtt.classList.add("hidden");
    const meter = $("attention-meter");
    if (meter) meter.classList.add("hidden");
    stopScreenShare();
    stopStt();
    resetDocPanel();
    const subBox2 = $("subtitle-box");
    if (subBox2) subBox2.innerHTML = "";
    peers.forEach(p => { try { p.destroy(); } catch (_) {} });
    peers.clear();
    peerNames.clear();
    peerAttentionCounts.clear();
    hostSelfAttention = null;
    stopAllSpeakerDetection();
    closeSpotlight();
    hideFeatured();
    pinnedPeerId = null;
    activeSpeakerId = null;
    document.querySelectorAll("#meeting-grid .remote-wrap").forEach(el => el.remove());
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
    const sp = $("settings-popup"); if (sp) sp.classList.add("hidden");
    const sb = $("btn-settings"); if (sb) sb.classList.remove("active");
    closeParticipantsOverlay();
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
    const token = getToken();
    if (!token) { busy = false; showView("login"); return; }

    showView("meeting");
    setupLocalVideo();
    socket = window.io(buildSocketOpts());
    socket.on("connect_error", onConnectError);
    registerSocketHandlers();
    const runCreate = () => {
      socket.emit("room:create", {}, async (ack) => {
        if (!ack || ack.error) {
          meetingStatus("Could not create room: " + (ack && ack.error ? ack.error : "unknown"));
          await cleanupMeeting(); showView("lobby"); return;
        }
        updateMeetingMeta(ack);
        (ack.peers || []).forEach(p => addPeer(p.id, p.name));
        busy = false;
        startStt();
        startAttentionDetection();
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
        startStt();
        startAttentionDetection();
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

  // ── Summary rendering helpers ──────────────────────────────
  function renderSummarySection(elId, cardId, items, renderItem) {
    const el = $(elId);
    const card = $(cardId);
    if (el && items && items.length > 0) {
      el.innerHTML = "";
      items.forEach((item) => {
        const div = document.createElement("div");
        div.className = elId.replace("summary-", "summary-") + "-item";
        if (typeof item === "string") {
          div.className = "summary-decision-item";
          div.innerHTML = renderItem(item);
        } else {
          div.innerHTML = renderItem(item);
        }
        el.appendChild(div);
      });
      if (card) card.classList.remove("hidden");
    } else if (card) {
      card.classList.add("hidden");
    }
  }

  function renderContributions(participantSummaries) {
    const contCard = $("summary-contributions-card");
    const contEl = $("summary-contributions");
    if (contCard && contEl && participantSummaries && participantSummaries.length > 0) {
      contEl.innerHTML = "";
      participantSummaries.forEach((p) => {
        const div = document.createElement("div");
        div.className = "contribution-person";
        let html = '<div class="contribution-person-name">' + escapeHtml(p.name) + '</div>';
        if (p.spoken && p.spoken !== "No contributions") {
          html += '<div class="contribution-section"><span class="contribution-tag voice">Voice</span><span class="contribution-text">' + escapeHtml(p.spoken) + '</span></div>';
        }
        if (p.chatted && p.chatted !== "No contributions") {
          html += '<div class="contribution-section"><span class="contribution-tag chat">Chat</span><span class="contribution-text">' + escapeHtml(p.chatted) + '</span></div>';
        }
        if ((!p.spoken || p.spoken === "No contributions") && (!p.chatted || p.chatted === "No contributions")) {
          html += '<div class="contribution-section"><span class="contribution-text" style="color:var(--text-3);font-style:italic;">No voice or chat contributions</span></div>';
        }
        div.innerHTML = html;
        contEl.appendChild(div);
      });
      contCard.classList.remove("hidden");
    } else if (contCard) {
      contCard.classList.add("hidden");
    }
  }

  // ── Meeting Summary ──────────────────────────────────────────
  async function showMeetingSummary(code) {
    summaryRoomCode = code;
    historyMeetingId = null; // live meeting, not from history
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
        const summaryUrl = "/api/meeting-summary/" + encodeURIComponent(code)
          + (pendingAttentionData ? "?includeAttention=true" : "");
        const res = await fetch(summaryUrl);
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

    // Show regenerate button if summary looks like a fallback
    const regenBtn = $("btn-regenerate-summary");
    const isFallback = !data.topics || data.topics.length === 0;
    if (regenBtn) regenBtn.classList.toggle("hidden", !isFallback);

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

    // Topics, Assignments, Key Decisions, Contributions
    renderSummarySection("summary-topics", "summary-topics-card", data.topics, (t) =>
      "<strong>" + escapeHtml(t.title) + "</strong><p>" + escapeHtml(t.details) + "</p>");
    renderSummarySection("summary-assignments", "summary-assignments-card", data.assignments, (a) =>
      '<span class="assignment-badge">' + escapeHtml(a.assignee) + "</span> " + escapeHtml(a.task));
    renderSummarySection("summary-decisions", "summary-decisions-card", data.keyDecisions, (d) => escapeHtml(d));
    renderContributions(data.participantSummaries);

    // Attention Report (host only — participants don't see this)
    const attCard = $("summary-attention-card");
    const attEl = $("summary-attention");
    const attData = data.attentionStats || (pendingAttentionData || null);
    if (summaryWasHost && attCard && attEl && attData && attData.length > 0) {
      attEl.innerHTML = "";
      attData.forEach((a) => {
        const pct = typeof a.activePercent === "number" ? a.activePercent : 0;
        const level = pct >= 70 ? "high" : pct >= 40 ? "medium" : "low";
        const item = document.createElement("div");
        item.className = "attention-item";
        item.innerHTML =
          '<span class="attention-item-name">' + escapeHtml(a.name) + '</span>' +
          '<div class="attention-bar-wrap"><div class="attention-bar ' + level + '" style="width:' + pct + '%"></div></div>' +
          '<span class="attention-percent">' + pct + '%</span>';
        attEl.appendChild(item);
      });
      attCard.classList.remove("hidden");
    } else if (attCard) {
      attCard.classList.add("hidden");
    }
    pendingAttentionData = null;

    renderIcons();
  }

  async function askSummaryQuestion(question) {
    if ((!summaryRoomCode && !historyMeetingId) || !question.trim()) return;

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
      let url, headers;
      if (historyMeetingId) {
        // Past meeting from Supabase
        url = "/api/meeting-history/" + encodeURIComponent(historyMeetingId) + "/ask";
        headers = { "Content-Type": "application/json", Authorization: "Bearer " + getToken() };
      } else {
        // In-memory live meeting summary
        url = "/api/meeting-summary/" + encodeURIComponent(summaryRoomCode) + "/ask";
        headers = { "Content-Type": "application/json" };
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
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

    // Recent Meetings modal
    on("btn-recent-meetings", "click", () => {
      const modal = $("recent-meetings-modal");
      if (modal) { modal.classList.remove("hidden"); loadRecentMeetings(); renderIcons(); }
    });
    on("btn-recent-close", "click", () => {
      const modal = $("recent-meetings-modal");
      if (modal) modal.classList.add("hidden");
    });
    const recentModal = $("recent-meetings-modal");
    if (recentModal) {
      recentModal.addEventListener("click", (e) => {
        if (e.target === recentModal) recentModal.classList.add("hidden");
      });
    }

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


    // Participants overlay
    on("btn-participants", "click", () => toggleParticipantsOverlay());
    on("btn-participants-close", "click", () => closeParticipantsOverlay());

    // Spotlight close button
    on("btn-spotlight-close", "click", () => closeSpotlight());
    const spotOverlay = $("spotlight-overlay");
    if (spotOverlay) {
      spotOverlay.addEventListener("click", (e) => {
        if (e.target === spotOverlay) closeSpotlight();
      });
    }

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



    // Doc language
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
      docInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const form = $("doc-chat-form");
          if (form) form.dispatchEvent(new Event("submit", { cancelable: true }));
        }
      });
    }

    // Summary view events
    on("btn-back-lobby", "click", () => {
      summaryRoomCode = null;
      summaryMeetingName = "";
      historyMeetingId = null;
      showView("lobby");
      refreshLobbyUser();
    });

    on("btn-export-summary", "click", () => {
      if (!summaryRoomCode) return;
      const attParam = summaryWasHost ? "?includeAttention=true" : "";
      window.open("/api/meeting-summary/" + encodeURIComponent(summaryRoomCode) + "/export" + attParam, "_blank");
    });

    on("btn-regenerate-summary", "click", async () => {
      if (!summaryRoomCode) return;
      const btn = $("btn-regenerate-summary");
      if (btn) { btn.disabled = true; btn.textContent = "Regenerating..."; }
      try {
        const url = "/api/meeting-summary/" + encodeURIComponent(summaryRoomCode) + "/regenerate"
          + (pendingAttentionData ? "?includeAttention=true" : "");
        const res = await fetch(url, { method: "POST" });
        if (res.ok) {
          const data = await res.json();
          // Re-render the full summary with new data
          const loading = $("summary-loading");
          if (loading) loading.classList.add("hidden");
          const cards = $("summary-cards");
          if (cards) cards.classList.remove("hidden");

          const isFallback = !data.topics || data.topics.length === 0;
          if (btn) btn.classList.toggle("hidden", !isFallback);

          const txt = $("summary-text");
          if (txt) txt.textContent = data.summary || "No summary available.";

          renderSummarySection("summary-topics", "summary-topics-card", data.topics, (t) =>
            "<strong>" + escapeHtml(t.title) + "</strong><p>" + escapeHtml(t.details) + "</p>");
          renderSummarySection("summary-assignments", "summary-assignments-card", data.assignments, (a) =>
            '<span class="assignment-badge">' + escapeHtml(a.assignee) + "</span> " + escapeHtml(a.task));
          renderSummarySection("summary-decisions", "summary-decisions-card", data.keyDecisions, (d) => escapeHtml(d));
          renderContributions(data.participantSummaries);
          renderIcons();
        } else {
          meetingStatus("Regeneration failed — API may still be rate limited. Try again.");
        }
      } catch {
        meetingStatus("Regeneration failed — check your connection.");
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="refresh-cw" style="width:14px;height:14px;stroke:currentColor;stroke-width:2;"></i> Regenerate'; renderIcons(); }
      }
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
      // Enter to send (Shift+Enter for new line)
      summaryInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const q = summaryInput.value.trim();
          if (!q) return;
          summaryInput.value = "";
          summaryInput.style.height = "auto";
          askSummaryQuestion(q);
        }
      });
    }

    initInsightTabs();
    initSidebarTabs();
  }

  // ── Boot ─────────────────────────────────────────────────────
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
