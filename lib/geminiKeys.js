/**
 * DeepSeek API key pool — rotates between keys when one hits rate limits.
 * Keys: DEEPSEEK_API_KEY (primary), DEEPSEEK_API_KEY_2, DEEPSEEK_API_KEY_3, ...
 */

const keys = [];
let loaded = false;

function loadKeys() {
  // If already loaded and we have keys, don't re-read
  if (loaded && keys.length > 0) return;

  keys.length = 0;
  const primary = (process.env.DEEPSEEK_API_KEY || "").trim();
  if (primary) keys.push({ key: primary, blockedUntil: 0 });

  for (let i = 2; i <= 10; i++) {
    const k = (process.env[`DEEPSEEK_API_KEY_${i}`] || "").trim();
    if (k) keys.push({ key: k, blockedUntil: 0 });
  }

  if (keys.length > 0) {
    loaded = true;
    console.log("[geminiKeys] Loaded " + keys.length + " DeepSeek API key(s)");
  } else {
    // Don't mark as loaded so we retry next call (Railway delayed injection)
    console.warn("[geminiKeys] WARNING: No DEEPSEEK_API_KEY found in environment");
  }
}

let lastIndex = 0;

function getKey() {
  loadKeys();
  if (!keys.length) return null;

  const now = Date.now();
  for (let i = 0; i < keys.length; i++) {
    const idx = (lastIndex + i) % keys.length;
    if (keys[idx].blockedUntil <= now) {
      lastIndex = (idx + 1) % keys.length;
      return keys[idx].key;
    }
  }
  const soonest = keys.reduce((a, b) => (a.blockedUntil < b.blockedUntil ? a : b));
  return soonest.key;
}

function markLimited(key, ms = 60000) {
  loadKeys();
  const entry = keys.find((k) => k.key === key);
  if (entry) entry.blockedUntil = Date.now() + ms;
}

function isRateLimitError(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.includes("429") || /rate.?limit|quota.*exceeded/i.test(msg);
}

export { getKey, markLimited, isRateLimitError };
