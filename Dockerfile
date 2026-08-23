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

# project files ඔක්කොම මුලින්ම Copy කරන්න
COPY . .

# production modules ඇතුළුව සියලුම packages clean install කරන්න
RUN npm ci || npm install

CMD [ "node", "index.js" ]
