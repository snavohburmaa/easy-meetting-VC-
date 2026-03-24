FROM node:20-slim

# Install Python3, pip, ffmpeg, curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv ffmpeg curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*

WORKDIR /app

# Python deps in venv (faster-whisper uses CTranslate2, no PyTorch needed)
COPY requirements.txt ./
RUN python3 -m venv .venv && \
    .venv/bin/pip install --no-cache-dir -r requirements.txt && \
    find .venv -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null; true

# Node deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App code
COPY . .

# Pre-download tiny Whisper model (~75MB) at build time
ENV WHISPER_MODEL=tiny
RUN .venv/bin/python3 -c "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8')"

RUN chmod +x start.sh

EXPOSE 3000

CMD ["bash", "start.sh"]
