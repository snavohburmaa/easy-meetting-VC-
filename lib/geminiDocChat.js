import { GoogleGenerativeAI } from "@google/generative-ai";
import { getKey, markLimited, isRateLimitError } from "./geminiKeys.js";

/**
 * Primary model (override with GEMINI_MODEL).
 * Use a current stable id — older names like gemini-1.5-flash often 404 on v1beta.
 * @see https://ai.google.dev/gemini-api/docs/models/gemini
 */
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/** Comma-separated extra models to try if the first fails (404 / not found). */
function fallbackModelList() {
  const extra = process.env.GEMINI_MODEL_FALLBACK || "";
  const defaults = "gemini-2.0-flash,gemini-1.5-flash-8b,gemini-1.5-flash";
  const merged = extra ? `${extra},${defaults}` : defaults;
  return merged
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniqueModels(primary) {
  const out = [];
  const seen = new Set();
  for (const m of [primary, ...fallbackModelList()]) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

/**
 * Answer a user question using only the provided document text (RAG-style).
 *
 * @param {object} opts
 * @param {string} opts.contextText
 * @param {string} opts.question
 * @param {string} opts.apiKey
 * @param {string} [opts.modelName]
 * @param {string} [opts.language] - e.g. "my" (Myanmar), "ja" (Japanese), "th" (Thai)
 * @returns {Promise<string>}
 */
async function askAboutDocument(opts) {
  const {
    contextText,
    question,
    apiKey,
    modelName = DEFAULT_MODEL,
    language = "",
  } = opts;
  if (!apiKey || !String(apiKey).trim()) {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  const ctx = (contextText || "").trim();
  const q = (question || "").trim();
  if (!ctx) {
    throw new Error("No document text available");
  }
  if (!q) {
    throw new Error("Question is required");
  }

  const langRule = `- Detect the language of the user's question and reply in that SAME language. If the question is in Myanmar/Burmese, reply in Myanmar. If in Thai, reply in Thai. If in Japanese, reply in Japanese. If in English, reply in English. Always match the user's language.`;

  const prompt = `You are a precise and helpful assistant for a video meeting. Answer the user's question using ONLY the document excerpt below.

Rules:
- If the answer is not contained in the document, say clearly that the document does not contain enough information.
- Quote or paraphrase briefly when helpful.
- Be concise unless the user asks for detail.
- Format your answer with clear structure: use bullet points, headings, or numbered lists when appropriate.
${langRule}

--- DOCUMENT ---
${ctx}
--- END DOCUMENT ---

User question: ${q}`;

  const modelsToTry = uniqueModels(modelName);
  let lastErr = null;

  // Try up to 3 API keys from the pool on rate limit
  for (let keyAttempt = 0; keyAttempt < 3; keyAttempt++) {
    const currentKey = getKey() || apiKey;
    const genAI = new GoogleGenerativeAI(currentKey.trim());

    for (const name of modelsToTry) {
      try {
        const model = genAI.getGenerativeModel({ model: name });
        const result = await model.generateContent(prompt);
        const response = result.response;
        const text = response.text();
        if (!text || !String(text).trim()) {
          throw new Error("Empty response from Gemini");
        }
        return String(text).trim();
      } catch (err) {
        lastErr = err;
        if (isRateLimitError(err)) {
          markLimited(currentKey, 60000);
          break; // try next key
        }
        const msg = err && err.message ? String(err.message) : String(err);
        const status = typeof err?.status === "number" ? err.status : 0;
        const isWrongModel =
          status === 404 ||
          /404|not found|NOT_FOUND|invalid model|Unsupported model|model.*not support|was not found/i.test(
            msg
          );
        if (!isWrongModel) {
          throw formatGeminiError(err, name);
        }
      }
    }
  }

  throw formatGeminiError(lastErr, modelsToTry.join(", "));
}

function formatGeminiError(err, modelHint) {
  const base = err && err.message ? String(err.message) : String(err);
  const hint =
    ` (tried model(s): ${modelHint}). ` +
    `Set GEMINI_MODEL to a valid id from https://ai.google.dev/gemini-api/docs/models — e.g. gemini-2.5-flash`;
  return new Error(`Gemini: ${base}${hint}`);
}

export {
  askAboutDocument,
  DEFAULT_MODEL,
};
