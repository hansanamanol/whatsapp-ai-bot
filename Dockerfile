FROM ghcr.io/puppeteer/puppeteer:21.5.0

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /usr/src/app

# Files ඔක්කොම මුලින්ම Copy කරගෙන ඊටපස්සේ Install කරන්න
COPY . .

RUN npm install

CMD [ "node", "index.js" ]
