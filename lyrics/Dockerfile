# The lyrics follower: Kirtan Saathi's engine (MIT, github.com/sethigoldy/Kirtan-saathi) built at a
# pinned commit, its pinned and checksummed model, and this package's gate and HTTP server.

# --- Kirtan Saathi's engine, model and corpus ---
FROM node:22-slim AS engine
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ARG KS_COMMIT=b43274f6f581d742c0512673fee2d5f6950062ce
WORKDIR /ks
RUN git init -q && git remote add origin https://github.com/sethigoldy/Kirtan-saathi.git \
 && git fetch -q --depth 1 origin "$KS_COMMIT" && git checkout -q FETCH_HEAD
# Only what the engine needs, not the desktop app's (Electron) dependencies.
WORKDIR /tools
RUN npm init -y >/dev/null && npm install --no-audit --no-fund typescript@5.9.3 @types/node@22
WORKDIR /runtime
RUN npm init -y >/dev/null && npm install --no-audit --no-fund --ignore-scripts onnxruntime-node@1.23.2
WORKDIR /ks
RUN /tools/node_modules/.bin/tsc --outDir dist/engine --rootDir src/engine --module commonjs --target es2022 \
      --lib es2022 --esModuleInterop --skipLibCheck --strict --typeRoots /tools/node_modules/@types --types node \
      src/engine/*.ts \
 && node scripts/fetch-assets.mjs --model-only

# --- This package ---
FROM node:22-slim AS app
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM node:22-slim
LABEL org.opencontainers.image.source=https://github.com/thehimmat/google-home-radiocaster
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=engine /ks/dist/engine /opt/kirtan-saathi/dist/engine
COPY --from=engine /ks/models /opt/kirtan-saathi/models
COPY --from=engine /ks/resources/corpus.json.gz /opt/kirtan-saathi/resources/
COPY --from=engine /ks/README.md /ks/THIRD_PARTY_NOTICES.md /ks/package.json /opt/kirtan-saathi/
COPY --from=engine /runtime/node_modules /opt/kirtan-saathi/node_modules
WORKDIR /app
COPY --from=app /app/dist/ ./dist/
ENV KS_DIR=/opt/kirtan-saathi NODE_ENV=production
EXPOSE 3002
CMD ["node", "dist/server.js"]
