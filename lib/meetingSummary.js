/**
 * Meeting summary generation and AI Q&A using DeepSeek.
 * Generates structured summaries and allows follow-up questions.
 */

import { getKey, markLimited, isRateLimitError } from "./geminiKeys.js";
import { compileTranscriptText, getTranscript } from "./meetingTranscript.js";

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";

/** @type {Map<string, SummaryData>} */
const summaries = new Map();

/**
 * @typedef {Object} SummaryData
 * @property {string} roomCode
 * @property {string} summary - AI-generated summary text
 * @property {number} durationMinutes
 * @property {string[]} attendees
 * @property {Object[]} topics - { title, details }
 * @property {Object[]} assignments - { assignee, task }
 * @property {string} rawTranscript - full transcript text for Q&A context
 * @property {number} createdAt
 */

const SUMMARY_PROMPT = `You are a meeting summary assistant. Analyze the following meeting transcript and generate a structured summary.

Return your response in this EXACT JSON format (no markdown, no code fences, just raw JSON):
{
  "summary": "A concise 2-4 sentence overview of the meeting",
  "topics": [
    { "title": "Topic name", "details": "What was discussed about this topic" }
  ],
  "assignments": [
    { "assignee": "Person name", "task": "What they need to do" }
  ],
  "keyDecisions": [
    "Decision that was made"
  ],
  "participantSummaries": [
    { "name": "Person name", "spoken": "Brief summary of what they said via voice", "chatted": "Brief summary of what they typed in chat" }
  ]
}

Rules:
- If the transcript is very short or empty, still provide a summary noting it was a brief meeting
- Extract action items and assign them to the person who was asked or volunteered
- Identify distinct topics/themes that were discussed
- Keep the summary professional and concise
- If no assignments were made, return an empty array for assignments
- If you cannot determine a topic clearly, group related discussion points
- For participantSummaries, include every participant. Summarize what each person said via [Voice] entries in "spoken" and what they typed via [Chat] entries in "chatted". If a participant had no voice or chat contributions, use "No contributions" for that field. Keep each summary to 1-3 sentences.

Here is the meeting transcript:
`;

/**
 * Call DeepSeek chat completions API.
 * @param {string} apiKey
 * @param {string} prompt
 * @param {string} [modelName]
 * @returns {Promise<string>}
 */
async function callDeepSeek(apiKey, prompt, modelName) {
  const model = modelName || process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(`DeepSeek ${res.status}: ${errText.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty response from DeepSeek");
  return text.trim();
}

/**
 * Generate a meeting summary from the transcript using DeepSeek.
 * @param {string} roomCode
 * @returns {Promise<SummaryData|null>}
 */
async function generateSummary(roomCode) {
  const transcript = getTranscript(roomCode);
  if (!transcript) return null;

  const transcriptText = compileTranscriptText(roomCode);
  if (!transcriptText) return null;

  const duration = Date.now() - transcript.startedAt;
  const durationMinutes = Math.round(duration / 60000);
  const attendees = [...transcript.attendees];
  const attendeeDetails = (transcript.attendeeDetails || []).map(a => ({
    name: a.name,
    joinedAt: a.joinedAt,
    leftAt: a.leftAt || Date.now(),
  }));

  const prompt = SUMMARY_PROMPT + transcriptText;

  // Try up to 3 keys
  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = getKey();
    if (!apiKey) {
      console.error("[meeting-summary] No DEEPSEEK_API_KEY configured");
      return createFallbackSummary(roomCode, durationMinutes, attendees, attendeeDetails, transcriptText);
    }

    try {
      const responseText = await callDeepSeek(apiKey, prompt);

      // Parse JSON from response (strip markdown fences if present)
      let json;
      try {
        const cleaned = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
        json = JSON.parse(cleaned);
      } catch {
        console.warn("[meeting-summary] Failed to parse DeepSeek JSON, using fallback");
        return createFallbackSummary(roomCode, durationMinutes, attendees, attendeeDetails, transcriptText);
      }

      const summaryData = {
        roomCode,
        summary: json.summary || "Meeting summary unavailable.",
        durationMinutes,
        attendees,
        attendeeDetails,
        topics: Array.isArray(json.topics) ? json.topics : [],
        assignments: Array.isArray(json.assignments) ? json.assignments : [],
        keyDecisions: Array.isArray(json.keyDecisions) ? json.keyDecisions : [],
        participantSummaries: Array.isArray(json.participantSummaries) ? json.participantSummaries : [],
        rawTranscript: transcriptText,
        createdAt: Date.now(),
      };

      summaries.set(roomCode, summaryData);
      return summaryData;
    } catch (err) {
      if (isRateLimitError(err)) {
        markLimited(apiKey, 60000);
        continue;
      }
      console.error("[meeting-summary] DeepSeek error:", err.message || err);
      return createFallbackSummary(roomCode, durationMinutes, attendees, attendeeDetails, transcriptText);
    }
  }

  return createFallbackSummary(roomCode, durationMinutes, attendees, attendeeDetails, transcriptText);
}

function createFallbackSummary(roomCode, durationMinutes, attendees, attendeeDetails, transcriptText) {
  const data = {
    roomCode,
    summary: "AI summary could not be generated. You can still review the transcript and ask questions.",
    durationMinutes,
    attendees,
    attendeeDetails,
    topics: [],
    assignments: [],
    keyDecisions: [],
    rawTranscript: transcriptText,
    createdAt: Date.now(),
  };
  summaries.set(roomCode, data);
  return data;
}

/**
 * Ask AI a question about a specific meeting.
 * @param {string} roomCode
 * @param {string} question
 * @returns {Promise<string>}
 */
async function askAboutMeeting(roomCode, question) {
  const data = summaries.get(roomCode);
  if (!data) return "Meeting summary not found. The summary may have expired.";

  const prompt = `You are an AI assistant that answers questions about a meeting. Use the transcript and summary below to answer accurately.

=== Meeting Summary ===
${data.summary}

=== Full Transcript ===
${data.rawTranscript.slice(0, 100000)}

=== User Question ===
${question}

Answer the question based only on the meeting content. Be concise and helpful. If the answer isn't in the transcript, say so.`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = getKey();
    if (!apiKey) return "No API key configured for AI Q&A.";

    try {
      return await callDeepSeek(apiKey, prompt);
    } catch (err) {
      if (isRateLimitError(err)) {
        markLimited(apiKey, 60000);
        continue;
      }
      return "AI Q&A failed: " + (err.message || "Unknown error");
    }
  }
  return "All API keys are rate limited. Please try again shortly.";
}

/**
 * Regenerate a summary from the stored rawTranscript (used when initial generation was rate-limited).
 * @param {string} roomCode
 * @returns {Promise<SummaryData|null>}
 */
async function regenerateSummary(roomCode) {
  const existing = summaries.get(roomCode);
  if (!existing || !existing.rawTranscript) return null;

  const prompt = SUMMARY_PROMPT + existing.rawTranscript;

  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = getKey();
    if (!apiKey) return existing;

    try {
      const responseText = await callDeepSeek(apiKey, prompt);

      let json;
      try {
        const cleaned = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
        json = JSON.parse(cleaned);
      } catch {
        return existing;
      }

      existing.summary = json.summary || existing.summary;
      existing.topics = Array.isArray(json.topics) ? json.topics : existing.topics;
      existing.assignments = Array.isArray(json.assignments) ? json.assignments : existing.assignments;
      existing.keyDecisions = Array.isArray(json.keyDecisions) ? json.keyDecisions : existing.keyDecisions;
      existing.participantSummaries = Array.isArray(json.participantSummaries) ? json.participantSummaries : existing.participantSummaries;
      return existing;
    } catch (err) {
      if (isRateLimitError(err)) {
        markLimited(apiKey, 60000);
        continue;
      }
      return existing;
    }
  }
  return existing;
}

function getSummary(roomCode) {
  return summaries.get(roomCode) || null;
}

function deleteSummary(roomCode) {
  summaries.delete(roomCode);
}

// Auto-cleanup summaries older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [code, data] of summaries.entries()) {
    if (data.createdAt < cutoff) summaries.delete(code);
  }
}, 10 * 60 * 1000);

export { generateSummary, regenerateSummary, askAboutMeeting, getSummary, deleteSummary };
