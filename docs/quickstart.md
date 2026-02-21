# Quickstart

## First scan in 10 minutes

1. `cp .env.example .env`
2. `docker compose up -d`
3. Install deps (`pnpm install`)
4. Generate Prisma client and migrate (`pnpm --filter @a11y/db prisma migrate dev`)
5. Start API, worker, web apps
6. Create project: `POST /projects`
7. Run scan: `POST /scans/:projectId/run`
8. View issues in web UI stub

## Initial API contracts
- `POST /projects`
- `POST /scans/:projectId/run`
- `GET /scans/:id/issues`
- `GET /issues/:id/evidence`
- `POST /issues/:id/waive`
