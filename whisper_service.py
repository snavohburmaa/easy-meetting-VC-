"""
Whisper transcription microservice.
Receives audio via HTTP POST, returns transcribed text.
Runs alongside the Node.js server on the same Railway instance.
"""

import os
import tempfile
from faster_whisper import WhisperModel
from flask import Flask, request, jsonify

app = Flask(__name__)

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
print(f"[whisper] Loading model: {MODEL_SIZE} ...")
model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
print(f"[whisper] Model loaded.")


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]
    language = request.form.get("language", None)

    # Write to a temp file so Whisper can read it
    suffix = ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        audio_file.save(tmp)
        tmp_path = tmp.name

    try:
        lang = language if (language and language != "auto") else None
        segments, info = model.transcribe(tmp_path, language=lang)
        text = " ".join(segment.text for segment in segments).strip()
        detected_lang = info.language if info else ""
        return jsonify({"text": text, "language": detected_lang})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "model": MODEL_SIZE})


if __name__ == "__main__":
    port = int(os.environ.get("WHISPER_PORT", 5555))
    print(f"[whisper] Listening on port {port}")
    app.run(host="127.0.0.1", port=port)
