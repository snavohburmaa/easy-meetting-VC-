import { getKey, markLimited, isRateLimitError } from "./geminiKeys.js";

const DEEPSEEK_BASE = "https://api.deepseek.com";
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

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
    throw new Error("DEEPSEEK_API_KEY is not configured");
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

  let lastErr = null;

  // Try up to 3 API keys from the pool on rate limit
  for (let keyAttempt = 0; keyAttempt < 3; keyAttempt++) {
    const currentKey = getKey() || apiKey;

    try {
      const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentKey.trim()}`,
        },
        body: JSON.stringify({
          model: modelName,
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
      if (!text || !String(text).trim()) {
        throw new Error("Empty response from DeepSeek");
      }
      return String(text).trim();
    } catch (err) {
      lastErr = err;
      if (isRateLimitError(err)) {
        markLimited(currentKey, 60000);
        continue; // try next key
      }
      throw formatDeepSeekError(err, modelName);
    }
  }

  throw formatDeepSeekError(lastErr, modelName);
}

function formatDeepSeekError(err, modelHint) {
  const base = err && err.message ? String(err.message) : String(err);
  return new Error(`DeepSeek: ${base} (model: ${modelHint})`);
}

export {
  askAboutDocument,
  DEFAULT_MODEL,
};
