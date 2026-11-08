# A11Y SaaS

[![CI](https://github.com/ewimsatt/a11y-saas/actions/workflows/ci.yml/badge.svg)](https://github.com/ewimsatt/a11y-saas/actions/workflows/ci.yml)
[![Status: local alpha](https://img.shields.io/badge/status-local%20alpha-orange)](#status-and-boundaries)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**An accessibility review workspace that turns automated checks into evidence, remediation priorities, and shareable reports.**

Create a project, scan selected pages, inspect each affected element, compare repeat scans, and export a technical report or executive slide deck. A11Y SaaS combines a React console, a Fastify API, and a Playwright/axe-core scanning pipeline with PostgreSQL-backed scan history.

The useful output is not just a violation count. Findings retain their page, rule, selector, DOM evidence, and failure explanation. Reports distinguish actionable findings from waived or historical observations, identify repeated patterns, and explain what to inspect, change, and retest.

**Current status: single-user, local-only alpha.** Despite the repository name, this is not a hosted or multi-tenant SaaS product. Use synthetic test data on one machine, not customer data. There is no authentication or tenant isolation. Do not expose the application through a public tunnel, reverse proxy, shared server, or LAN binding.

## Capabilities at a glance

| Capability | What is implemented |
| --- | --- |
| Projects and scan history | Create projects with a base URL, start scans, and switch between recent runs in the console. |
| Selected-page scanning | Scan the base URL from the console or submit up to 20 explicit HTTP(S) URLs through the API. No automatic site discovery, sitemap import, or link-following crawl. |
| Automated accessibility checks | Run axe-core's WCAG 2.0 A/AA-tagged checks in Chromium, retaining a separate observation for each violating node. |
| Finding-level evidence | Review page screenshots, affected selectors, DOM snippets, rule help, and failure explanations. Screenshot capture and analysis use the same page visit. |
| Triage and waivers | Filter by severity, status, and WCAG reference; use triage presets; waive findings with a reason and optional future expiry; inspect waived findings and explicitly unwaive them. |
| Repeat-scan comparison | Compare finalized, complete scans of the same requested URL set. Distinguish new, persisting, fixed, and regressed observations without rewriting historical scans as though they were current evidence. |
| Coverage and failure reporting | Track requested, analyzed, and failed pages. Incomplete scans do not become clean results or receive a complete-scan score. |
| Remediation reporting | Generate technical PDF documents, executive PowerPoint decks, HTML previews, and full finding-level CSV exports. |
| Durable scan intake | Commit the scan, requested pages, and dispatch intent together; support idempotent API requests and bounded recovery from temporary Redis enqueue failures. |
| Packaged local environment | Start the console, API, worker, database, queue, browser sidecar, and egress proxy with the dedicated alpha Compose configuration. |

## From a scan to a remediation handoff

1. **Create a project** for an authorized test website.
2. **Run a scan** of the base URL, or use the API to specify a repeatable page set.
3. **Check coverage first.** Review failed pages before interpreting findings or comparisons.
4. **Investigate the evidence.** Filter findings, inspect the page screenshot and node HTML, and use the axe explanation to understand the observed failure.
5. **Record exceptions deliberately.** Add a waiver reason and, when appropriate, an expiry; unwaive the finding when the exception no longer applies.
6. **Share the right deliverable.** Give implementers the technical PDF or CSV and stakeholders the executive deck.
7. **Rescan the same URLs** after remediation to review what persisted, disappeared, or returned.

### Reports for different audiences

| Format | Purpose and contents |
| --- | --- |
| **PDF technical document** | Coverage, finding groups, remediation priorities, evidence, suggested inspection/fix/retest guidance, and an appendix preserving every stored finding occurrence. |
| **PowerPoint (`.pptx`)** | An executive summary with prioritized themes and explicitly labeled representative evidence, rather than a claim to show every occurrence. |
| **HTML preview** | A browser-readable report for inspection before sharing or rendering. |
| **CSV** | Untruncated occurrence-level data, including finding/page IDs, fingerprints, target identity, selectors, DOM snippets, and stored evidence metadata. Cells receive spreadsheet-formula protection. |

Reports group observations by rule and affected pages. Remediation priority uses **OPEN and REGRESSED** findings, rather than allowing fixed or waived observations to inflate the active backlog. Contrast summaries can group observed foreground/background pairs and required thresholds when axe's failure text supplies parseable values; they do not infer shared components or prove a common root cause.

Suggested fixes are review guidance, not automatic code changes. Screenshots provide page context, not a guarantee that every affected element is visually annotated. A generated report is not an accessibility certification.

### Comparisons and waiver behavior

- A comparison requires a finalized, complete scan and an eligible prior scan with the **same exact requested URL set**, regardless of submission order. A changed page set is not evidence that omitted findings were fixed.
- A finding that persists is not automatically a regression. Reappearance after absence is distinguished using older comparable observations.
- Historical fixed observations remain identifiable as historical evidence, not new findings from the current page visit.
- Waivers store a reason and optional future expiry. Expired waivers reopen when the scan's findings are listed (or the finding is processed for another waiver); this is not an independent background expiry scheduler. A direct report export does not itself reconcile expired waivers.
- Waivers are finding-specific. Cross-scan waiver carry-forward and a full long-term issue-management workflow remain unfinished.

## Status and boundaries

### Automated checks are only part of an audit

The scanner selects axe tags `wcag2a` and `wcag2aa`. It does **not** claim comprehensive WCAG 2.1/2.2 coverage, manual keyboard or screen-reader testing, legal compliance, or full-site coverage. Human review remains necessary.

Coverage describes the **submitted page set**:

| Coverage | Interpretation |
| --- | --- |
| `COMPLETE` | All requested pages were analyzed. Zero findings means the selected automated checks detected no violations on those pages. |
| `PARTIAL` | Some pages were analyzed and others failed. Findings remain available, but reports withhold a score and grade. |
| `FAILED` | The scan failed. Reports do not issue a score or grade. |
| `PENDING` | Coverage is not yet established; reports withhold an assessment. |

A recorded `COMPLETE` value alone is not enough for a final assessment: lifecycle status and page outcomes must also be final. Scores on eligible complete reports are internal heuristics, not WCAG conformance measurements.

### Local execution and data

- **Local access only.** The alpha publishes the console and API on loopback. CORS is not authentication and does not protect against other local processes.
- **Remote browser sidecar, no scanner fallback.** The worker connects to the internal Playwright sidecar. It does not silently launch a local browser if that connection fails.
- **Controlled browser egress.** The sidecar's HTTP(S) traffic passes through Smokescreen; browser and proxy ports are not published. Input validation rejects common unsafe targets, and connection-time controls cover DNS answers, redirects, and subresources. This is a local-alpha boundary, not proof of a hostile-site sandbox or safe public scanning service.
- **Supported targets.** Public HTTP(S) URLs on ports 80 or 443, without embedded credentials. Literal loopback, private/link-local targets, and local/internal hostnames are rejected by the public API and rechecked by the worker.
- **Local evidence storage.** The alpha worker writes screenshots to a Docker volume mounted read-only by the API. S3/MinIO uploads, external retention, and production access controls are not connected to the evidence pipeline.
- **Bounded queue recovery.** PostgreSQL retains dispatch intent before acceptance. The API retries pending intake while running and after restart. Later worker-stage reconciliation, exhausted-attempt handling, and an independent recovery scheduler remain unfinished; processing is at-least-once.

## Run the local alpha

Use the dedicated alpha configuration, not just the infrastructure-only `docker-compose.yml`. The scanner requires its browser sidecar and egress proxy.

### Prerequisites

- **Node.js 22** and **pnpm 10**, matching CI.
- **Docker with Compose**, reachable through the current Docker context or `DOCKER_HOST`.
- A local checkout and **synthetic test data only**.
- Available loopback ports `3001` and `3010`.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm alpha:env .env.alpha

docker compose --env-file .env.alpha -f docker-compose.alpha.yml up -d postgres redis
docker compose --env-file .env.alpha -f docker-compose.alpha.yml run --rm migrate
docker compose --env-file .env.alpha -f docker-compose.alpha.yml up --build
```

`alpha:env` creates a private, uncommitted environment file with a unique database password and browser-control token. It refuses to overwrite an existing file. Do not print, commit, or share `.env.alpha`.

Compose builds and starts the console, API, worker, browser, and proxy. The API reads the worker's evidence volume read-only. The alpha uses its own `a11y-friend-alpha` project namespace.

- **Console:** <http://127.0.0.1:3010>
- **API liveness:** <http://127.0.0.1:3001/healthz>

Open the console, create a project for an authorized public test URL, and run a scan. `/healthz` confirms API liveness, not database/queue/worker readiness. Do not work around rejected private scan targets by weakening URL policy.

Stop the alpha without deleting its stored data:

```sh
docker compose --env-file .env.alpha -f docker-compose.alpha.yml down
```

See [the local alpha guide](docs/friend-alpha-local.md) for Docker-context setup, source-bundle handoff, recovery details, and the explicit destructive reset procedure. `pnpm alpha:bundle ../a11y-saas-friend-alpha.tgz` creates a source-only handoff that excludes credentials, evidence, dependencies, and generated outputs; it is not a hosted release.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| Docker cannot connect | Start the Docker runtime and check `docker context show` / `DOCKER_HOST`. |
| Scan stays queued | Inspect the API, worker, and Redis services. Durable intake can remain queued while Redis is unavailable. |
| Browser unavailable | Check the alpha browser and proxy services and the generated environment. Installing host Chromium does not replace the required scanner sidecar. |
| Missing screenshots | Check worker volume access and the API's read-only mount of the same evidence volume. |
| Partial coverage | Inspect failed-page outcomes; do not treat the scan as a clean bill of health. |
| Console cannot reach the API | Check loopback port `3001`, API logs, and the configured CORS origins. |

## API reference

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | API liveness. |
| `GET`, `POST` | `/projects` | List projects or create one with `{ "name": "...", "baseUrl": "https://..." }`. |
| `GET` | `/projects/:projectId/scans` | List the most recent 20 scans for a project. |
| `POST` | `/scans/:projectId/run` | Enqueue a scan. `{}` uses the base URL; `{ "urls": [...] }` supplies up to 20 URLs. Supports `Idempotency-Key`. |
| `GET` | `/scans/:id` | Read lifecycle status, coverage, and per-page outcomes. |
| `GET` | `/scans/:id/issues` | Read findings, including waived findings, and comparison data. Reconciles expired waivers. |
| `GET` | `/scans/:id/report?format=pdf` | Export `pdf`, `pptx`, `html`, or `csv`; default `pdf`. |
| `GET` | `/issues/:id/evidence` | Read screenshot URL, DOM snippet, and evidence metadata. |
| `POST` | `/issues/:id/waive` | Store a reason of at least 10 characters and an optional future ISO datetime `expiresAt`. |
| `POST` | `/issues/:id/unwaive` | Clear an active waiver and reopen the finding. |
| `GET` | `/evidence/*` | Serve local evidence files. |

For scan submission, reuse an `Idempotency-Key` only with the same project and exact requested URL payload. A matching replay returns the original scan; different input returns `409`. The API commits the scan, pages, and dispatch intent before returning `202`, even if initial Redis enqueue is temporarily unavailable. Acceptance is not scan completion.

Legacy root aliases remain for project listing/creation and issue evidence/waivers. Prefer the named routes above. Implementations live in [`apps/api/src/routes`](apps/api/src/routes).

## Architecture

```text
React console -> Fastify API -> PostgreSQL
                     |         projects, scans, pages, findings, dispatch intents
                     v
                Redis / BullMQ
                     |
                    worker -> internal Playwright + axe-core browser
                     |                         |
             local evidence volume        Smokescreen -> permitted HTTP(S) targets
                     |
             API evidence / report exports
```

The queues are named `crawl`, `analyze`, `diff`, and `evidence`. They describe processing stages, not an automatic site-discovery crawler. The analyze stage navigates the supplied URLs, runs axe, captures screenshots, and persists evidence. The evidence stage finalizes the scan; it does not upload to object storage.

| Path | Responsibility |
| --- | --- |
| [`apps/web`](apps/web) | React/Vite project, scan, findings, comparison, evidence, and waiver console. |
| [`apps/api`](apps/api) | Fastify routes, dispatch recovery, local evidence serving, and reports. |
| [`apps/worker`](apps/worker) | BullMQ processing, page outcomes, finding persistence, and scan comparison. |
| [`packages/scanner`](packages/scanner) | Remote Playwright/axe adapter and fingerprint generation. |
| [`packages/db`](packages/db) | Prisma schema, migrations, and PostgreSQL client. |
| [`packages/shared`](packages/shared) | Shared types, finality rules, URL validation, and controlled failures. |
| [`infra`](infra) | Alpha application images, browser sidecar, and egress proxy. |
| [`scripts`](scripts) | Alpha packaging, acceptance harnesses, UI regressions, and report fixtures. |

## Verification

For contributor checks, install dependencies and this checkout's matching Chromium. Local Chromium supports test/report tooling, not a scanner fallback:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm typecheck
pnpm test
pnpm --filter @a11y/web build
pnpm test:acceptance
pnpm test:scanner-egress
pnpm test:ui
```

On Linux, use `pnpm exec playwright install --with-deps chromium` when system dependencies are needed. Docker-backed checks require a reachable daemon; set `DOCKER_HOST` for the command if needed rather than changing the global Docker context.

[CI](.github/workflows/ci.yml) runs typechecking, unit tests, the web build, full-stack owned-fixture acceptance, scanner-egress acceptance, and rendered console regressions on `main` pushes and pull requests. Coverage includes finding identity, evidence, incomplete scans, comparison finality/scope, waivers, scan dispatch, report rendering, and local boundaries. Controlled fixtures are not evidence of production readiness or real-world site compliance.

### Report fixtures

```sh
pnpm exec tsx scripts/generate-report-fixtures.ts
```

Generate explicitly synthetic zero-finding, incomplete, long-field, high-occurrence, and mixed-state report cases without a database or live service. Outputs go to the platform temporary directory under `a11y-report-fixtures` unless `REPORT_FIXTURE_DIR` is set. Inspect rendered PDFs and decks before release. These fixtures are never scan evidence.

## Not shipped yet

- Authentication, authorization, tenant isolation, or public hosting approval.
- Comprehensive WCAG coverage, manual audit automation, automatic fixes, or compliance certification.
- Site discovery, sitemap crawling, and supported authenticated-page workflows.
- Durable external evidence storage, retention policy, and production access controls.
- Complete queue-stage recovery, independent recovery scheduling, and operational monitoring.
- Full long-term issue tracking and cross-scan waiver carry-forward.
- Complete release/security hardening and deployment-specific acceptance.

The local sidecar and egress controls are implemented, but broader sandbox assurance and complete real-HTTPS CONNECT fixture coverage remain release work. See [the alpha guide](docs/friend-alpha-local.md) for those boundaries. Older bootstrap/planning documents under `docs/` may describe obsolete feature status; use this README, the alpha guide, and executable source for the current workflow.

## Contributing and license

Keep changes focused, cover behavior changes with regressions, and run the applicable checks above. Never turn failed scans into clean results or weaken local-only boundaries for a demo.

Released under the [MIT License](LICENSE). Automated scanning supports accessibility work; it does not replace a manual audit or establish legal compliance.
