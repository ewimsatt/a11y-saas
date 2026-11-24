# This image contains only the production scanner entrypoint and its runtime deps.
# It intentionally has no browser binary or source bind mount.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
COPY infra/scanner-probe/package.json infra/scanner-probe/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund
COPY packages/scanner/src ./scanner/src
COPY test/network-fixtures/scanner-probe.ts ./scanner-probe/scanner-probe.ts
USER node
