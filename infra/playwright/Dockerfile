# Pin must match repository Playwright 1.58.2.
FROM mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d
USER root
WORKDIR /app
COPY package.json package-lock.json /app/
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts --omit=dev --no-audit --no-fund
COPY --chown=pwuser:pwuser server.mjs /app/server.mjs
USER pwuser
ENTRYPOINT ["node", "/app/server.mjs"]
