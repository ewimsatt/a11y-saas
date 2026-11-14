FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json prisma.config.ts ./
COPY apps ./apps
COPY packages ./packages
# Packaged PDF rendering is isolated in the private pdf-renderer service.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN mkdir -p "$COREPACK_HOME" && chmod 755 "$COREPACK_HOME" && \
  corepack enable && corepack install --global pnpm@10.29.2 && \
  pnpm install --frozen-lockfile --ignore-scripts && pnpm --filter @a11y/db db:generate
