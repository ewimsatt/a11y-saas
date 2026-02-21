export type CreateProjectDto = { name: string; baseUrl: string };
export type RunScanDto = { maxPages?: number; depth?: number };
export type WaiveIssueDto = { reason: string; expiresAt?: string };
