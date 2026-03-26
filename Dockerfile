FROM node:20-slim

# Build tools needed for better-sqlite3 native addon
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App code
COPY . .

EXPOSE ${PORT:-3000}

CMD ["node", "server.js"]
