FROM node:20-slim

# Install Chromium and dependencies
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

COPY package*.json ./

# Force install all packages directly
RUN npm install
RUN npm install @google/generative-ai express puppeteer qrcode qrcode-terminal whatsapp-web.js

COPY . .

CMD [ "node", "index.js" ]
