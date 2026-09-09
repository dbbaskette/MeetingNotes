# Build with repository root as context: docker build -f server/Dockerfile .
FROM mwader/static-ffmpeg:7.1.1 AS ffmpeg
FROM node:22.23.1-bookworm-slim AS build
WORKDIR /app/server
COPY server/package*.json server/.npmrc ./
RUN npm ci --ignore-scripts
COPY shared /app/shared
COPY electron/main/pipeline/prompts.ts /app/electron/main/pipeline/prompts.ts
COPY server /app/server
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22.23.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3=3.11.2-1+b1 python3-venv=3.11.2-1+b1 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe
WORKDIR /app/server
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY server/package.json ./package.json
COPY server/migrations ./dist/server/migrations
COPY server/python ./dist/server/python
RUN python3 -m venv /opt/inference && /opt/inference/bin/pip install --no-cache-dir -r dist/server/python/requirements.txt
ENV PATH="/opt/inference/bin:$PATH" NODE_ENV=production HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
USER node
EXPOSE 8080
CMD ["node", "dist/server/src/api.js"]
