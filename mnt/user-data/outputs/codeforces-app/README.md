# Codeforces Training Platform — Statement Fetching Refactor

This is your existing single-page app (`index.html`), refactored so that
**all** Codeforces problem-statement fetching goes through a dedicated
Cloudflare Worker instead of the browser. Nothing else about the app was
touched — same UI, same features, same file layout.

## What changed (and only this)

All changes are inside `index.html`, scoped to the `CONFIG` object and the
`StatementFetcher` module:

| Before | After |
|---|---|
| `CONFIG.CUSTOM_PROXY_BASE` / `CONFIG.PUBLIC_FALLBACK_PROXY` (AllOrigins) | `CONFIG.WORKER_BASE_URL` |
| `StatementFetcher.fetchRawHtml()` tried 3 fallbacks: custom proxy → direct CORS fetch to `codeforces.com` → public AllOrigins proxy | `StatementFetcher.fetchRawHtml()` makes a single call to `${CONFIG.WORKER_BASE_URL}/api/problem/:contestId/:index` |
| Generic "CORS is probably blocking this" error message | Specific error messaging per Worker error code (`PROBLEM_NOT_FOUND`, `UPSTREAM_TIMEOUT`, `WORKER_NOT_CONFIGURED`, ...) |

Everything else — `CFApi` (official Codeforces JSON API for the problem
list), `CFAccount` (official Codeforces JSON API for user profile/
submissions), `AIEngine`, `SearchEngine`, `UI`, `Dashboard`, `ProblemViewer`,
`TrainingMode`, storage, styling, markup — is byte-for-byte unchanged. Those
already used Codeforces' official CORS-enabled JSON API (`codeforces.com/api/...`),
not HTML scraping, so they were never part of this problem.

## New: `worker/`

A standalone, production-ready Cloudflare Worker project. See
[`worker/README.md`](./worker/README.md) for the full API reference and
step-by-step deployment instructions. Quick start:

```bash
cd worker
npm install
npx wrangler login
npm run deploy
```

Then copy the printed `*.workers.dev` URL into `index.html`:

```js
const CONFIG = {
  ...
  WORKER_BASE_URL: "https://cf-statement-proxy.<your-subdomain>.workers.dev",
  ...
};
```

That's the only line you need to touch to go live — everything downstream
already reads from `CONFIG.WORKER_BASE_URL`.

## Running the frontend

`index.html` is still a standalone static file — open it in a browser or
serve it with any static file server. No build step, no bundler, no new
frontend dependencies were introduced.
