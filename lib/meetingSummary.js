/**
 * Meeting summary generation and AI Q&A using Gemini.
 * Generates structured summaries and allows follow-up questions.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getKey, markLimited, isRateLimitError } from "./geminiKeys.js";
import { compileTranscriptText, getTranscript } from "./meetingTranscript.js";

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
  ]
}

Rules:
- If the transcript is very short or empty, still provide a summary noting it was a brief meeting
- Extract action items and assign them to the person who was asked or volunteered
- Identify distinct topics/themes that were discussed
- Keep the summary professional and concise
- If no assignments were made, return an empty array for assignments
- If you cannot determine a topic clearly, group related discussion points

Here is the meeting transcript:
`;

/**
 * Generate a meeting summary from the transcript using Gemini.
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

  const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const prompt = SUMMARY_PROMPT + transcriptText;

  // Try up to 3 keys
  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = getKey();
    if (!apiKey) {
      console.error("[meeting-summary] No GEMINI_API_KEY configured");
      return createFallbackSummary(roomCode, durationMinutes, attendees, attendeeDetails, transcriptText);
    }

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const responseText = result.response.text().trim();

      // Parse JSON from response (strip markdown fences if present)
      let json;
      try {
        const cleaned = responseText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
        json = JSON.parse(cleaned);
      } catch {
        console.warn("[meeting-summary] Failed to parse Gemini JSON, using fallback");
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
      console.error("[meeting-summary] Gemini error:", err.message || err);
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

  const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
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
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return result.response.text().trim();
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

export { generateSummary, askAboutMeeting, getSummary, deleteSummary };
