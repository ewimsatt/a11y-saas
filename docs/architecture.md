# Architecture

```mermaid
flowchart LR
  A[Scan Run API] --> B[crawl queue]
  B --> C[Worker: Crawl]
  C --> D[analyze queue]
  D --> E[Worker: Analyze (Playwright + axe)]
  E --> F[Normalize + Fingerprint]
  F --> G[diff queue]
  G --> H[Worker: Diff]
  H --> I[Issues Materialized]
  I --> J[evidence queue]
  J --> K[Worker: Evidence Snapshot]
  I --> L[Web/API]
```

Core flow: `scan run -> findings normalized -> diff computed -> issues materialized`
