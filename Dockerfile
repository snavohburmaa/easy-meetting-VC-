FROM python:3.11-slim

# Install Node.js 20, ffmpeg (required by Whisper), and curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ffmpeg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies (Whisper + Flask)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Install Node.js dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Pre-download Whisper model at build time so startup is fast
ARG WHISPER_MODEL=base
ENV WHISPER_MODEL=${WHISPER_MODEL}
RUN python -c "import whisper; whisper.load_model('${WHISPER_MODEL}')"

RUN chmod +x start.sh

EXPOSE 3000

CMD ["bash", "start.sh"]
