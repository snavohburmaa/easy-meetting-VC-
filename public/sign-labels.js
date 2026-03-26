/**
 * Central map: MediaPipe GestureRecognizer class names and fingerpose aliases → display text.
 * Phrases are configurable without retraining; MediaPipe cannot output arbitrary words like "hello".
 */
(function () {
  const MEDIAPIPE_PHRASES = {
    None: null,
    Closed_Fist: "(pause / send line in spell mode)",
    Open_Palm: "(space in spell mode)",
    Pointing_Up: "Up / one",
    Thumb_Down: "No",
    Thumb_Up: "Yes / OK",
    Victory: "Peace / V",
    ILoveYou: "Thanks / love",
  };

  /** fingerpose built-in gesture names (underscore) */
  const FINGERPOSE_PHRASES = {
    victory: "Peace / V",
    thumbs_up: "Yes / OK",
  };

  /** ASL letter spell names are single letters A–Z from GestureDescription.name */
  function phraseForSpellLetter(name) {
    if (typeof name !== "string" || name.length !== 1) return null;
    const u = name.toUpperCase();
    if (u < "A" || u > "Z") return null;
    return u;
  }

  /** Some runtimes / docs use alternate strings; normalize to our keys. */
  const MEDIAPIPE_ALIASES = {
    Thumbs_Up: "Thumb_Up",
    Thumbs_Down: "Thumb_Down",
    Pointing_Up: "Pointing_Up",
  };

  window.SignLabels = {
    MEDIAPIPE_PHRASES,
    MEDIAPIPE_ALIASES,
    FINGERPOSE_PHRASES,
    phraseForSpellLetter,
    mediapipePhrase(category) {
      if (!category) return null;
      const key = MEDIAPIPE_ALIASES[category] || category;
      return MEDIAPIPE_PHRASES[key] ?? MEDIAPIPE_PHRASES[category] ?? category;
    },
    fingerposePhrase(name) {
      if (!name) return null;
      return FINGERPOSE_PHRASES[name] ?? null;
    },
  };
})();
