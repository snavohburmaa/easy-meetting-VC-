"""
Whisper transcription microservice.
Receives audio via HTTP POST, returns transcribed text.
Runs alongside the Node.js server on the same machine.
Uses openai-whisper (pip install openai-whisper).
"""

import os
import tempfile
import whisper
from flask import Flask, request, jsonify

app = Flask(__name__)

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
print(f"[whisper] Loading model: {MODEL_SIZE} ...")
model = whisper.load_model(MODEL_SIZE)
print(f"[whisper] Model loaded. Language forced to English.")


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]
    language = request.form.get("language", None)

    # Write to a temp file so Whisper/ffmpeg can read it
    orig_name = audio_file.filename or "chunk.webm"
    if orig_name.endswith(".mp4") or orig_name.endswith(".m4a"):
        suffix = ".mp4"
    elif orig_name.endswith(".ogg"):
        suffix = ".ogg"
    else:
        suffix = ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        audio_file.save(tmp)
        tmp_path = tmp.name

    try:
        result = model.transcribe(tmp_path, language="en", fp16=False)
        text = (result.get("text") or "").strip()
        return jsonify({"text": text, "language": "en"})
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
