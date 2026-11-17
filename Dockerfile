# syntax=docker/dockerfile:1
# Price Intelligence OS — production image.
#
#   docker build -t price-intelligence-os .
#   docker run -d -p 4000:4000 -v pios-data:/data price-intelligence-os
#
# The server runs its TypeScript sources directly (Node >= 22.18 strips types natively), so the image carries
# server/ and shared/ as they are plus the built web client.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    PIOS_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /data
USER node
# Database, uploaded evidence, import files, the Excel mirror and the secret key live here. Back it up.
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/index.ts"]
