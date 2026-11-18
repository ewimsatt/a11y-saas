# Local alpha quickstart

This is the supported path for a **local single-user** test. It is not a public deployment guide. Read [friend-alpha-local.md](friend-alpha-local.md) for the complete boundary, friend handoff rules, Docker-context note, and cleanup guidance.

## Prerequisites

- Node 22 and pnpm
- A healthy Docker runtime
- Only synthetic local data and URLs you own or are authorized to test

If Colima is installed but not your active Docker context, set `DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"` in the shell that runs these commands. Do not copy another person's socket path or change global Docker contexts.

## Start the local stack

From a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm alpha:env .env.alpha
docker compose --env-file .env.alpha -f docker-compose.alpha.yml up -d postgres redis
docker compose --env-file .env.alpha -f docker-compose.alpha.yml run --rm migrate
docker compose --env-file .env.alpha -f docker-compose.alpha.yml up --build
```

`alpha:env` creates a fresh local database password and browser-control token in `.env.alpha` with mode 0600. It refuses to overwrite an existing environment file. Do not print, commit, or send that file.

Open the console at <http://127.0.0.1:3010>. Create a project for an authorized public HTTP(S) URL, then scan the base URL or paste up to 20 explicit URLs. The console reports queued/running/terminal status, page coverage, findings, node evidence, remediation references, comparisons, waivers, and report exports.

`http://127.0.0.1:3001/healthz` checks API liveness only. It does not prove the database, Redis, worker, or browser sidecar is ready.

## Stop the alpha

When you are finished with this disposable local test:

```sh
docker compose --env-file .env.alpha -f docker-compose.alpha.yml down --volumes
rm .env.alpha
```

That targets the alpha's dedicated Compose project. Do not use global Docker cleanup commands.

## Limits that still matter

Do not bind the app to a LAN interface, expose it through a tunnel, deploy it, scan private/internal targets, share its API endpoint, or use customer data. Failed or partial scans are not clean scans, and a zero-finding result is not a compliance certification.

For a source-only tester bundle, follow the [friend-alpha handoff section](friend-alpha-local.md#hand-a-source-bundle-to-one-friend). For API details and contributor verification, see the [README](../README.md).
