/**
 * In-memory meeting transcript storage.
 * Collects chat messages, voice captions, and document text during meetings.
 * Keyed by roomCode — cleared when summary is generated or expires.
 */

/** @type {Map<string, TranscriptData>} */
const transcripts = new Map();

/**
 * @typedef {Object} TranscriptEntry
 * @property {number} at - timestamp
 * @property {string} from - speaker name
 * @property {string} text - content
 * @property {"chat"|"voice"|"sign"} type - source type
 */

/**
 * @typedef {Object} TranscriptData
 * @property {number} startedAt - meeting start timestamp
 * @property {Set<string>} attendees - set of attendee names
 * @property {TranscriptEntry[]} entries - ordered transcript entries
 * @property {string|null} documentText - shared document text if any
 * @property {string|null} documentName - shared document filename
 */

function initRoom(roomCode) {
  if (transcripts.has(roomCode)) return;
  transcripts.set(roomCode, {
    startedAt: Date.now(),
    attendees: new Set(),
    attendeeDetails: [],  // { name, joinedAt, leftAt }
    entries: [],
    documentText: null,
    documentName: null,
  });
}

function addAttendee(roomCode, name) {
  const t = transcripts.get(roomCode);
  if (!t || !name) return;
  t.attendees.add(name);
  t.attendeeDetails.push({ name, joinedAt: Date.now(), leftAt: null });
}

function markAttendeeLeft(roomCode, name) {
  const t = transcripts.get(roomCode);
  if (!t || !name) return;
  // Mark the most recent join entry for this name that hasn't left yet
  for (let i = t.attendeeDetails.length - 1; i >= 0; i--) {
    if (t.attendeeDetails[i].name === name && !t.attendeeDetails[i].leftAt) {
      t.attendeeDetails[i].leftAt = Date.now();
      break;
    }
  }
}

function addEntry(roomCode, entry) {
  const t = transcripts.get(roomCode);
  if (!t) return;
  t.entries.push({
    at: entry.at || Date.now(),
    from: entry.from || "Unknown",
    text: entry.text || "",
    type: entry.type || "chat",
  });
}

function setDocument(roomCode, fileName, text) {
  const t = transcripts.get(roomCode);
  if (!t) return;
  t.documentText = text || null;
  t.documentName = fileName || null;
}

function getTranscript(roomCode) {
  return transcripts.get(roomCode) || null;
}

function deleteTranscript(roomCode) {
  transcripts.delete(roomCode);
}

/**
 * Compile the full transcript into a single text block for Gemini.
 */
function compileTranscriptText(roomCode) {
  const t = transcripts.get(roomCode);
  if (!t) return null;

  const duration = Date.now() - t.startedAt;
  const mins = Math.round(duration / 60000);
  const attendeeList = [...t.attendees].join(", ") || "Unknown";

  let text = `Meeting Duration: ${mins} minutes\n`;
  text += `Attendees: ${attendeeList}\n\n`;

  if (t.documentText) {
    text += `=== Shared Document: ${t.documentName || "Untitled"} ===\n`;
    text += t.documentText.slice(0, 50000) + "\n\n";
  }

  text += "=== Meeting Transcript ===\n";
  for (const e of t.entries) {
    const time = new Date(e.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    const tag = e.type === "voice" ? "[Voice]" : e.type === "sign" ? "[Sign]" : "[Chat]";
    text += `${time} ${tag} ${e.from}: ${e.text}\n`;
  }

  return text;
}

export {
  transcripts,
  initRoom,
  addAttendee,
  markAttendeeLeft,
  addEntry,
  setDocument,
  getTranscript,
  deleteTranscript,
  compileTranscriptText,
};
