# Friend alpha, local-only

This is a one-machine single-user alpha. Do not bind it to a LAN interface, expose it through a tunnel, hand its API endpoint to another person, deploy it, or use it with customer data. Authentication and tenant isolation do not exist.

The scanner worker has no local browser fallback. It connects only to the internal Playwright Chromium sidecar, whose HTTP(S) traffic is forced through Smokescreen. Only Smokescreen joins the outbound Docker network. Browser and proxy ports are never published.

## Fresh synthetic setup

Prerequisites: Node 22, pnpm, Docker/Colima, and synthetic local data only.

```sh
cd /path/to/a11y-saas
pnpm install --frozen-lockfile
pnpm alpha:env .env.alpha
DOCKER_HOST=unix:///Users/ewimsatt/.colima/default/docker.sock \
  docker compose --env-file .env.alpha -f docker-compose.alpha.yml up -d postgres redis
DOCKER_HOST=unix:///Users/ewimsatt/.colima/default/docker.sock \
  docker compose --env-file .env.alpha -f docker-compose.alpha.yml run --rm migrate
DOCKER_HOST=unix:///Users/ewimsatt/.colima/default/docker.sock \
  docker compose --env-file .env.alpha -f docker-compose.alpha.yml up --build
```

`alpha:env` creates a fresh 256-bit browser-control token and unique local database password in an uncommitted file with mode 0600. It refuses to overwrite an existing file. Do not commit, print, or share `.env.alpha`; the token is part of the sidecar WebSocket endpoint.

The API is loopback-only at `http://127.0.0.1:3001`. Run the local web UI separately if wanted, pointed at that loopback API. The browser-sidecar and Smokescreen services have no host ports.

Stop only this alpha project when finished:

```sh
DOCKER_HOST=unix:///Users/ewimsatt/.colima/default/docker.sock \
  docker compose --env-file .env.alpha -f docker-compose.alpha.yml down --volumes
rm .env.alpha
```

## Supported scan input

Only `http:` or `https:` URLs on ports 80 or 443 are supported. Literal loopback, private, link-local, multicast, credentials-in-URL, and local/internal hostnames are rejected before enqueue. The worker repeats this validation immediately before browser work. Smokescreen remains the connection-time authority for DNS answers, redirects, and subresources.

Failures to connect to the browser sidecar, proxy, or a target become failed or partial scan outcomes. They do not become clean, fixed, or complete scan results.

## Evidence commands

```sh
pnpm test:scanner-egress
pnpm typecheck
pnpm test
pnpm test:ui
```

`test:scanner-egress` creates a uniquely named disposable Docker project and uses only its own fixtures. Set `DOCKER_HOST` per command if Colima uses a non-default socket; it never changes your Docker context.

## Known release blockers

This is not approved for public, shared, hosted, LAN, or multi-tenant use. Queue recovery, durable external evidence storage, auth/authorization, abuse limits, and complete real-HTTPS CONNECT fixture coverage remain separate release work. Do not claim that this alpha is a hostile-site browser sandbox.
