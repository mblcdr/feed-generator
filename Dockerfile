# Feed Generator - light image: Node + Alpine's Chromium (works on amd64 and arm64).
FROM node:26-alpine

# Chromium renders the pages. Puppeteer's own Chrome download is skipped (it has no Linux arm64 build).
RUN apk add --no-cache chromium ttf-freefont \
 && CHROMIUM="$(command -v chromium || command -v chromium-browser)" \
 && test -n "$CHROMIUM" \
 && ln -s "$CHROMIUM" /usr/local/bin/chrome

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/local/bin/chrome \
    CHROME_NO_SANDBOX=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public

# Feeds, settings and the image cache live here; mount a volume to keep them.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/status >/dev/null || exit 1

CMD ["node", "server.js"]
