# SoundWave — single-container production image (Fly.io / VPS / any Docker host)
FROM node:20-alpine
WORKDIR /app

COPY server/package.json server/
RUN npm --prefix server install --omit=dev

COPY client/package.json client/
RUN npm --prefix client install && npm --prefix client cache clean --force

COPY server/ server/
COPY client/ client/
RUN npm --prefix client run build && rm -rf client/node_modules client/src

ENV NODE_ENV=production PORT=5000 ITUNES_COUNTRY=IN
EXPOSE 5000
# --openssl-legacy-provider is REQUIRED: without it the Saavn decryption path
# throws at runtime. This must match the server's own "start" script.
CMD ["node", "--openssl-legacy-provider", "server/server.js"]
