# A11Y SaaS

[![CI](https://github.com/ewimsatt/a11y-saas/actions/workflows/ci.yml/badge.svg)](https://github.com/ewimsatt/a11y-saas/actions/workflows/ci.yml)
[![Status: local alpha](https://img.shields.io/badge/status-local%20alpha-orange)](#status-and-boundaries)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**A local-first accessibility scanning and review application for developers, QA teams, and agencies.** Create a project, scan selected pages, inspect findings alongside screenshots and DOM evidence, and export reports for remediation discussions.

The application combines a React review console, a Fastify API, and a Playwright/axe-core scanning pipeline. It is more than a scanner endpoint: it keeps project and scan history, records which pages were actually analyzed, supports finding triage and waivers, and produces PDF, PowerPoint, and HTML reports.

**Current status: local-only alpha.** The core workflow is implemented, but this is not a hosted, multi-tenant SaaS release. Authentication, enforced scanner network isolation, and production storage/recovery remain unfinished. See [status and boundaries](#status-and-boundaries) before running it.

## What you can do

| Capability | Current implementation |
| --- | --- |
| Organize scans | Create projects with a base URL and review recent scans for each project. |
| Scan selected pages | Scan the project's base URL from the console, or submit up to 20 explicit URLs through the API. There is no automatic site discovery or link-following crawl. |
| Detect accessibility issues | Run axe-core's WCAG 2.0 A/AA-tagged checks in Chromium. Retain a separate finding for each violating node, with rule, severity, page URL, selector, and WCAG tags where provided. |
| Inspect evidence | View the page screenshot, node HTML, and axe failure explanation. Analysis and screenshots come from the same page visit rather than separate crawl and analysis visits. |
| Triage findings | Filter by severity, status, and WCAG reference; use triage presets, open evidence, and waive a finding with a recorded reason. There is no general free-text finding search. |
| Track scan outcomes | See lifecycle status and coverage in the console, with per-page outcomes available through scan detail in the API and reports. A failed page is not silently counted as a clean result. |
| Compare findings | Apply basic fingerprint-based `FIXED` / `REGRESSED` updates against the previous eligible complete scan. This is not yet a persistent cross-scan issue tracker. |
| Share results | Generate distinct PDF technical documents, executive PowerPoint (`.pptx`) summaries, HTML previews, and full untruncated CSV finding exports. PDF preserves every stored finding occurrence in its appendix; decks use explicitly labeled representative evidence. |

### A typical workflow

1. **Create a project** for a website you own or have permission to test.
2. **Run a scan.** The console polls the selected scan and loads its findings when processing finishes.
3. **Check coverage before interpreting results.** Use the report or scan-detail API to review failed pages as well as detected violations.
4. **Triage the findings.** Filter the list, inspect screenshots and DOM evidence, and record a reason when waiving a finding.
5. **Export a report** for the people doing the remediation. Rescan the same page set after changes.

## Status and boundaries

### Scan results are not a compliance certificate

The scanner currently selects axe tags `wcag2a` and `wcag2aa`. It does not claim comprehensive WCAG 2.1/2.2 coverage, manual testing, or legal compliance. Keyboard, screen-reader, content, and other human assessments remain necessary.

Coverage describes **the submitted page set**, not the whole website:

- **`COMPLETE`:** all requested pages were analyzed. Zero findings means these automated checks detected no violations on those pages, not that the site is accessible.
- **`PARTIAL`:** some pages were analyzed and others failed. Findings remain available, but reports withhold a score and grade.
- **`FAILED`:** the scan failed; reports do not issue a score or grade. Page-level outcomes and controlled error messages provide additional context.
- **`PENDING`:** coverage is not yet established. Reports withhold an assessment.

Scores on complete reports are internal heuristics, not WCAG conformance measurements. Comparison uses a prior complete scan and is skipped for incomplete current coverage. Keep the submitted URLs consistent: scope reconciliation and long-term issue/waiver continuity are not implemented.

### Local-only operation

- **No authentication or tenant isolation.** The API enforces loopback binding; the web dev server and Compose service ports default to loopback too. Do not expose them through a public tunnel, reverse proxy, shared server, or LAN binding.
- **CORS is not access control.** Local browser-origin restrictions do not authenticate a user or protect data from other local processes.
- **URL validation is not browser network isolation.** Input guards reject common unsafe targets, but enforced egress controls covering DNS, redirects, and subresources are not implemented. Do not treat the scanner as a safe service for arbitrary untrusted URLs.
- **Evidence is local.** Screenshots live under `evidence/` by default and are served by the API. MinIO is included in Compose, but S3/MinIO uploads are not connected to the evidence pipeline.
- **Waivers are limited.** A reason and optional expiry timestamp are persisted on the finding. Automatic expiry enforcement, carry-forward across scans, and a full waiver-management workflow are not implemented.
- **Queue recovery is not production-ready.** BullMQ handles asynchronous stages, but retry/dead-letter operations and reconciliation of stranded scans still need work.

## Run locally

### Prerequisites

- **Node.js 22** and **pnpm 10**, matching CI.
- **Docker with Compose**, running and reachable through your current Docker context or `DOCKER_HOST`.
- A local checkout of this repository.

Run the following commands from the repository root unless noted otherwise.

### 1. Install dependencies and Chromium

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

On Linux, use `pnpm exec playwright install --with-deps chromium` if browser system dependencies are missing. The API also needs Chromium for PDF rendering.

### 2. Configure the local environment

```bash
cp .env.example .env
openssl rand -hex 32
```

Skip the copy if you already have a `.env`. Generate unique credentials and fill every empty value in [.env.example](.env.example); do not commit `.env`.

| Variable | Local configuration |
| --- | --- |
| `POSTGRES_USER` | Defaults to `a11y` in the example. |
| `POSTGRES_PASSWORD` | A unique generated password. Hex avoids URL-encoding problems. |
| `DATABASE_URL` | `postgresql://a11y:<YOUR_POSTGRES_PASSWORD>@127.0.0.1:5433/a11y`; match your configured user and password. |
| `REDIS_URL` | `redis://127.0.0.1:6380`. |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | Unique local credentials; Compose requires these even though uploads are not wired up. |
| `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` | Retain the local endpoint/bucket and match the MinIO credentials. These are reserved configuration, not a working upload integration. |
| `EVIDENCE_DIR` | Optional absolute path. If overridden, API and worker must use the same directory. |

### 3. Start infrastructure

```bash
docker compose up -d
docker compose ps
```

[Compose](docker-compose.yml) starts PostgreSQL 16 on `127.0.0.1:5433`, Redis 7 on `127.0.0.1:6380`, and MinIO on `127.0.0.1:9000` with its console on `127.0.0.1:9001`. Wait for the services to be ready before migrating.

### 4. Generate the client and apply migrations

The root Prisma configuration expects `DATABASE_URL` in the process environment. Load `.env` explicitly rather than relying on automatic dotenv loading:

```bash
node --env-file=.env node_modules/prisma/build/index.js generate
node --env-file=.env node_modules/prisma/build/index.js migrate deploy
```

Use the checked-in migrations for a fresh database. An existing database with untracked schema changes needs a baselining review first; do not force it into shape with destructive `db push --accept-data-loss` commands. Rows predating the coverage migration retain conservative `PENDING` coverage and are not treated as valid comparison baselines.

### 5. Start the application

Run each command in a separate terminal, from the repository root:

```bash
# Terminal 1: API
pnpm --filter @a11y/api dev

# Terminal 2: background worker
pnpm --filter @a11y/worker dev

# Terminal 3: web console
pnpm --filter @a11y/web dev
```

The API and worker dev scripts load the root `.env` automatically.

- **Console:** <http://127.0.0.1:3010>
- **API liveness:** <http://127.0.0.1:3001/healthz>

Open the console, create a project with an authorized public HTTP(S) URL, and run a scan. Loopback and private scan targets are intentionally rejected by the public API. `/healthz` is a liveness check, not proof that the database, queue, and worker are ready.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| Docker cannot connect | Start your Docker runtime and check `docker context show` / `DOCKER_HOST`. Do not change application code to work around a stopped daemon. |
| Scan stays queued | Confirm the worker is running and the API and worker use the same `DATABASE_URL` and `REDIS_URL`. |
| Browser could not start | Install this checkout's matching Chromium with `pnpm exec playwright install chromium`; check any `PLAYWRIGHT_EXECUTABLE_PATH` override. |
| Missing screenshots | Check that API and worker share `EVIDENCE_DIR` and that the worker can write there. |
| Partial coverage | Inspect the failed page outcomes; do not interpret an incomplete scan as a clean bill of health. |
| Console cannot reach the API | Check the API terminal, port `3001`, and the default local CORS origins. |

## Verification

```bash
pnpm typecheck
pnpm test
pnpm --filter @a11y/web build
pnpm test:acceptance
pnpm test:ui
```

[CI](.github/workflows/ci.yml) runs these checks on pushes to `main` and on pull requests, using Node 22, pnpm 10, and the matching Playwright Chromium.

- **Unit tests** cover scanner node normalization, fingerprints, scan outcomes, diff rules, URL guards, controlled failure messages, report assessment/rendering, and local API boundaries.
- **Full-stack acceptance** starts uniquely named disposable PostgreSQL and Redis containers plus an owned fixture server, API, and worker. It checks clean zero-finding results, distinct violating nodes, retrievable DOM and PNG evidence, partial-coverage reporting, and an actual missing-browser failure. It seeds fixture projects directly in its disposable database rather than weakening the public API's URL policy. It removes its containers/processes on exit and retains logs on failure.
- **Rendered console regressions** exercise the real React UI with controlled API responses, including project/scan switching, stale-response handling, WCAG filtering, evidence loading, and waiver validation. These tests complement the real-API acceptance harness; they are not a public deployment acceptance test.

`test:acceptance` requires a reachable Docker daemon. If necessary, set `DOCKER_HOST` for that command; the harness does not change your global Docker context. Passing these checks does not establish safe public hosting.

## Architecture

```text
React console -> Fastify API -> PostgreSQL (projects, scans, pages, findings)
                      |
                      v
                 Redis / BullMQ
                      |
         crawl -> analyze -> diff -> evidence
                      |                 |
            Playwright + axe      finalize scan
                      |
               local screenshots
```

The queue names describe processing stages, not a site-discovery crawler. The analyze stage performs navigation, axe analysis, screenshot capture, and evidence persistence for the supplied URLs. The evidence stage finalizes the scan; it does not upload files to object storage.

| Path | Responsibility |
| --- | --- |
| [`apps/web`](apps/web) | React/Vite project, scan, and issues console. |
| [`apps/api`](apps/api) | Fastify routes, local evidence serving, and report rendering. |
| [`apps/worker`](apps/worker) | BullMQ processing, page outcomes, finding persistence, and scan comparison. |
| [`packages/scanner`](packages/scanner) | Playwright/axe adapter and fingerprint generation. |
| [`packages/db`](packages/db) | Prisma schema, migrations, generated client, and PostgreSQL connection. |
| [`packages/shared`](packages/shared) | Shared types, queue names, URL validation, and controlled failure messages. |
| [`scripts`](scripts) | Acceptance fixtures and rendered UI regression harnesses. |

### API reference

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | API liveness. |
| `GET`, `POST` | `/projects` | List projects or create one with `{ "name": "...", "baseUrl": "https://..." }`. |
| `GET` | `/projects/:projectId/scans` | List the most recent 20 scans for a project. |
| `POST` | `/scans/:projectId/run` | Enqueue a scan. `{}` uses the base URL; `{ "urls": [...] }` supplies up to 20 URLs. |
| `GET` | `/scans/:id` | Read lifecycle status, coverage, and per-page outcomes. |
| `GET` | `/scans/:id/issues` | List findings with rule/evidence data; waived findings are excluded. |
| `GET` | `/scans/:id/report?format=pdf` | Generate a report. Supported formats: `pdf`, `pptx`, `html`, `csv`; default: `pdf`. CSV contains every stored finding occurrence, page ID, fingerprint, stored target identity, and the complete stored evidence metadata object, with spreadsheet formula protection including leading whitespace/control prefixes. |
| `GET` | `/issues/:id/evidence` | Read screenshot URL, DOM snippet, and evidence metadata. |
| `POST` | `/issues/:id/waive` | Persist a waiver reason of at least 10 characters, with optional ISO datetime `expiresAt`. |
| `GET` | `/evidence/*` | Serve local evidence files. |

Legacy root aliases remain available for project listing/creation and issue evidence/waivers. Prefer the named routes above for new clients. Route implementations live in [`apps/api/src/routes`](apps/api/src/routes).

### Report fixture verification

Generate clearly synthetic report edge cases without a database or live service:

```sh
pnpm exec tsx scripts/generate-report-fixtures.ts
```

This writes zero-finding, incomplete/diffing, long-field, 162-occurrence, mixed-state, FIXED-only, and WAIVED-only HTML/PDF/PPTX/CSV fixtures to the platform temporary directory at `a11y-report-fixtures` by default. Set `REPORT_FIXTURE_DIR` to choose another output directory. These are test fixtures, never scan evidence. Render the generated PDFs and decks before release; the report generator rejects missing, corrupt, oversized, and unsupported page-context image payloads rather than embedding them.

## Work remaining before a shared release

- Authentication, authorization, and tenant boundaries.
- Enforced scanner sandbox/network isolation, including redirects, DNS, and subresources.
- Object-storage evidence uploads, retention, and access controls.
- Reliable queue retries, recovery/reconciliation, and operational monitoring.
- Persistent issue history, scope-aware comparison, waiver expiry, and waiver carry-forward.
- Broader scan discovery and supported authenticated-page workflows.
- Independent release/security review and deployment-specific acceptance checks.

This is remaining work, not a list of shipped capabilities or a release-date commitment. Older planning and bootstrap documents under `docs/` describe earlier stages and may contain obsolete commands or feature status; use this README and executable source for the current local workflow.

## Contributing and license

Keep changes focused, add regression coverage for behavior changes, and run the checks above. Be especially careful not to turn scan failures into clean results or weaken local-only boundaries for a demo.

Released under the [MIT License](LICENSE). Automated scanning supports accessibility work; it does not replace a manual audit or establish legal compliance.
