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
CMD ["node", "server/server.js"]
