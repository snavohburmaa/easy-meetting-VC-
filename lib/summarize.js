/**
 * Document analysis using DeepSeek API (replaces HuggingFace inference).
 * Generates overview, key points, deep dive, study questions, objectives.
 */
import { getKey, markLimited, isRateLimitError } from "./geminiKeys.js";

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

async function deepseekChat(prompt, maxTokens = 1000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const apiKey = getKey();
    if (!apiKey) return "";
    try {
      const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: maxTokens,
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const err = new Error(`DeepSeek ${res.status}: ${errText.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      return (data.choices?.[0]?.message?.content || "").trim();
    } catch (err) {
      if (isRateLimitError(err)) { markLimited(apiKey, 60000); continue; }
      console.error("[summarize] DeepSeek error:", err.message);
      return "";
    }
  }
  return "";
}

function emptyInsight() {
  return { overview: "", keyPoints: "", deepDive: "", studyQuestions: "", objectives: "" };
}

/**
 * Analyze document text using DeepSeek.
 * @param {string} text - extracted document text
 * @param {string} _hfToken - unused (kept for backward compat)
 * @param {string} francCode - detected language code
 */
async function analyzeDocument(text, _hfToken, francCode) {
  const apiKey = getKey();
  if (!apiKey) return emptyInsight();

  const chunk = text.slice(0, 12000);
  if (!chunk.trim()) return emptyInsight();

  const [overview, keyPoints, studyQuestions, objectives] = await Promise.all([
    deepseekChat(
      `Provide a concise overview (3-5 sentences) of the following document:\n\n${chunk}`,
      500
    ),
    deepseekChat(
      `List the main ideas as short bullet points (start each with -):\n\n${chunk}`,
      600
    ),
    deepseekChat(
      `Write exactly four short study or discussion questions about this text:\n\n${chunk}`,
      400
    ),
    deepseekChat(
      `List key objectives and action items from this document as bullet points:\n\n${chunk}`,
      400
    ),
  ]);

  return {
    overview: overview || "",
    keyPoints: keyPoints || "",
    deepDive: overview || "",
    studyQuestions: studyQuestions || "What is the core message?\nWhat evidence stands out?\nHow could you apply this?\nWhat needs clarification?",
    objectives: objectives || "",
  };
}

export { analyzeDocument, emptyInsight };
