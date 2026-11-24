# Current scope: local friend alpha

> Updated: 2026-11-18. This page describes the shipped local single-user alpha. For setup and safety limits, start with [the friend-alpha guide](friend-alpha-local.md).

## What works now

This is a one-machine, local single-user accessibility-audit workflow. Its supported journey is:

1. Start the packaged local stack with synthetic credentials.
2. Open the loopback console at `http://127.0.0.1:3010`.
3. Create a project for an owned or authorized public HTTP(S) URL.
4. Start a default base-URL scan, which shallowly discovers up to 20 total same-origin public HTTP(S) pages from anchors rendered on that seed page, or paste up to 20 explicit URLs, one per line, to bypass discovery.
5. Follow truthful queued/running/terminal status and page coverage.
6. Inspect findings, node-specific DOM/screenshot evidence, remediation details, comparisons, waivers, and exports.

### Local runtime

- The Compose alpha starts PostgreSQL, Redis, the API, worker, remote Playwright browser, egress proxy, PDF renderer, and production-built web console.
- The API and console bind only to loopback. Browser/proxy/renderer control ports are not published.
- `pnpm alpha:env .env.alpha` creates synthetic local credentials and an authenticated browser-control token in a mode-0600 file. It refuses to overwrite one.
- `pnpm alpha:bundle ../a11y-saas-friend-alpha.tgz` creates a source-only bundle that excludes `.env*`, `.git`, `node_modules`, evidence, generated output, and caches.

### Scan and evidence truthfulness

- The API persists the scan, requested pages, and initial dispatch intent before returning `202`.
- PostgreSQL-authoritative, token-fenced CRAWL, ANALYZE, DIFF, and EVIDENCE recovery reconciles the exact Redis job. A stale dispatcher or duplicate delivery cannot finalize its successor.
- A clean complete scan has zero findings. Failed and partial scans retain page outcomes and coverage, and are not presented as a clean grade or false fixed result.
- Every supported axe node becomes a distinct finding with matching selector, DOM, page context, and evidence. The worker validates readable image pixels before completion.
- Scan observations and evidence remain immutable. Derived fixed/regressed comparisons appear only for complete-coverage scans with an eligible prior scan of the same requested URL set; historical evidence is read-only.
- Console users can filter findings, inspect rule/help links and WCAG criterion references, export reports, and create/reverse expiring local waivers.

### Scanner boundary

The worker uses only the internal Playwright sidecar, whose HTTP(S) requests pass through Smokescreen. The local regression topology proves an allowed owned HTTPS fixture through CONNECT/443 and rejects private/loopback/link-local targets, redirects, subresources, and a fresh DNS rebind to private space. This is an egress boundary for the documented local alpha, not a general hostile-site browser sandbox.

## Safe setup

Use the current local-alpha commands, not legacy development snippets:

```sh
pnpm install --frozen-lockfile
pnpm alpha:env .env.alpha
docker compose --env-file .env.alpha -f docker-compose.alpha.yml up -d postgres redis
docker compose --env-file .env.alpha -f docker-compose.alpha.yml run --rm migrate
docker compose --env-file .env.alpha -f docker-compose.alpha.yml up --build
```

Then open `http://127.0.0.1:3010`. Run `docker compose --env-file .env.alpha -f docker-compose.alpha.yml down --volumes` and `rm .env.alpha` only when the local test is finished. See [friend-alpha-local.md](friend-alpha-local.md) before sharing a source bundle or changing the Docker context.

## Verification already in CI

GitHub Actions runs typecheck, real PostgreSQL/Redis service tests, production web build, full-stack owned-fixture acceptance, packaged local-alpha acceptance, scanner-egress acceptance, and rendered-console regressions. The contributor commands are documented in the [README](../README.md); Docker-backed checks require a healthy Docker runtime.

## Deliberately not shipped

This alpha is **not approved for public, shared, hosted, LAN, or multi-tenant use**. It has no authentication, authorization, tenant isolation, public hosting approval, customer-data workflow, durable external evidence storage, retention policy, independent scheduler, high availability, production monitoring, sitemap or recursive site discovery, authenticated-page support, comprehensive WCAG coverage, automatic remediation, or compliance certification.

Do not weaken scanner URL policy, expose the stack through a tunnel, bind it to a LAN interface, or treat a zero-finding result as legal/compliance assurance. The source and [friend-alpha guide](friend-alpha-local.md) are the current operational reference; historical planning documents are not.
