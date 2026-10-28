# Friend alpha, local-only

This is a one-machine single-user alpha. Do not bind it to a LAN interface, expose it through a tunnel, hand its API endpoint to another person, deploy it, or use it with customer data. Authentication and tenant isolation do not exist.

The scanner worker has no local browser fallback. It connects only to the internal Playwright Chromium sidecar, whose HTTP(S) traffic is forced through Smokescreen. Only Smokescreen joins the outbound Docker network. Browser and proxy ports are never published.

## Hand a source bundle to one friend

Send a source bundle only to a person who understands and accepts this local-only boundary. The bundle is not a release, does not include credentials or alpha environments, and must not be uploaded to a file host, deployed, or unpacked onto a shared machine.

From a clean, reviewed checkout, create the archive **outside** that checkout so the command can refuse accidental self-inclusion and replacement:

```sh
pnpm alpha:bundle ../a11y-saas-friend-alpha.tgz
```

The command prints the archive path and SHA-256 checksum. Before sharing, inspect the exact archive yourself:

```sh
tar -tzf ../a11y-saas-friend-alpha.tgz
shasum -a 256 ../a11y-saas-friend-alpha.tgz
```

It packages tracked source while excluding `.env*`, `node_modules`, `.git`, `evidence`, build/cache outputs, and generated alpha environments. It refuses an existing destination instead of overwriting it. A recipient should extract it into a new local directory, inspect it, and then run the synthetic setup below. The first safe preparation step is `pnpm install --frozen-lockfile`; it does not start Docker or scan a site.

## Fresh synthetic setup

Prerequisites: Node 22, pnpm, a working Docker context, and synthetic local data only. The commands below use your current Docker context. If you use Colima and it is not already your active context, set `DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"` in your shell before running them. Do not copy another person's absolute Docker socket path.

```sh
cd /path/to/a11y-saas
pnpm install --frozen-lockfile
pnpm alpha:env .env.alpha
docker compose --env-file .env.alpha -f docker-compose.alpha.yml up -d postgres redis
docker compose --env-file .env.alpha -f docker-compose.alpha.yml run --rm migrate
docker compose --env-file .env.alpha -f docker-compose.alpha.yml up --build
```

`alpha:env` creates a fresh 256-bit browser-control token and unique local database password in an uncommitted file with mode 0600. It refuses to overwrite an existing file. Do not commit, print, or share `.env.alpha`; the token is part of the sidecar WebSocket endpoint.

The Compose file uses the dedicated `a11y-friend-alpha` project namespace, so its `down --volumes` command targets only this alpha's containers, networks, and volumes. The API is loopback-only at `http://127.0.0.1:3001`. Run the local web UI separately if wanted, pointed at that loopback API. The browser-sidecar and Smokescreen services have no host ports. The API reads the worker's local evidence volume read-only, so screenshots and report evidence remain available within this one alpha project.

Stop only this alpha project when finished:

```sh
docker compose --env-file .env.alpha -f docker-compose.alpha.yml down --volumes
rm .env.alpha
```

## Supported scan input

Only `http:` or `https:` URLs on ports 80 or 443 are supported. Literal loopback, private, link-local, multicast, credentials-in-URL, and local/internal hostnames are rejected before enqueue. The worker repeats this validation immediately before browser work. Smokescreen remains the connection-time authority for DNS answers, redirects, and subresources.

Failures to connect to the browser sidecar, proxy, or a target become failed or partial scan outcomes. They do not become clean, fixed, or complete scan results.

## Durable scan intake and local queue recovery

`POST /scans/:projectId/run` accepts an optional `Idempotency-Key` header. Replaying the same key with the same project and exact requested URL payload returns the original durable scan; reusing it for different input returns `409`. The scan, requested pages, and PostgreSQL dispatch intent are committed in one transaction before the API returns `202`.

The API makes a best-effort Redis enqueue after that commit. A temporary Redis error still returns the accepted `queued` scan and leaves its intent `PENDING`; the failed in-process queue instance is retired so a later due attempt can create a fresh bounded Redis connection. The local API dispatcher retries due intents with deterministic `<scanId>-crawl` job IDs and retained BullMQ jobs. Redis commands use a short connection/request bound, so an unavailable local Redis does not hold an HTTP request open indefinitely.

This is deliberately a bounded alpha recovery slice, not HITLIST 07 completion: recovery runs only while the local API process is running and again when it starts. A continuously unavailable Redis leaves the durable intent queued for later recovery rather than claiming the scan failed, and this slice does not yet reconcile later worker stages, terminalize exhausted dispatch attempts, or provide an independent scheduler. Processing remains at-least-once.

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
