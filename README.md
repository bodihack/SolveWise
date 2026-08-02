# cf-statement-proxy

A production-ready Cloudflare Worker that fetches Codeforces **problem
statement pages** on behalf of the frontend app.

It exists because `codeforces.com/problemset/problem/...` does not send
`Access-Control-Allow-Origin` headers, so browsers cannot fetch those pages
directly. This Worker is the **only** thing that talks to Codeforces HTML
pages — the frontend never fetches Codeforces directly, and no public CORS
proxy (AllOrigins, corsproxy.io, thingproxy, etc.) is used anywhere.

```
Browser (SPA)  ──GET /api/problem/:contestId/:index──▶  Cloudflare Worker  ──GET──▶  codeforces.com
                ◀──────────── HTML or JSON error ──────────────────────────
```

## Endpoint

### `GET /api/problem/:contestId/:index`

| Param       | Type   | Example | Rule                                              |
|-------------|--------|---------|----------------------------------------------------|
| `contestId` | number | `1999`  | Positive integer, 1–6 digits                       |
| `index`     | string | `A`, `B1`, `E2` | Starts with a letter, ≤ 5 chars total       |

**Success (200)** — returns the original Codeforces page HTML as-is:

```
Content-Type: text/html; charset=utf-8
Cache-Control: public, max-age=86400
X-Cache: HIT | MISS
X-Request-Id: <uuid>

<!DOCTYPE html> ...
```

**Failure** — returns a structured JSON error and a matching HTTP status:

```json
{
  "success": false,
  "error": {
    "code": "PROBLEM_NOT_FOUND",
    "message": "Problem 1999A was not found on Codeforces."
  }
}
```

| HTTP status | `error.code`            | Meaning                                             |
|-------------|--------------------------|------------------------------------------------------|
| 400         | `INVALID_CONTEST_ID`     | `contestId` failed validation                         |
| 400         | `INVALID_PROBLEM_INDEX`  | `index` failed validation                             |
| 404         | `NOT_FOUND`               | Unknown route                                        |
| 404         | `PROBLEM_NOT_FOUND`      | Codeforces returned 404, or no statement was found on the page |
| 405         | `METHOD_NOT_ALLOWED`      | Non-GET request to the problem route                  |
| 502         | `UPSTREAM_ERROR`          | Codeforces responded with a non-2xx/404 status after retries |
| 504         | `UPSTREAM_TIMEOUT`        | All attempts timed out (10s each, by default)          |
| 504         | `UPSTREAM_UNREACHABLE`    | Network failure reaching Codeforces after retries       |
| 500         | `INTERNAL_ERROR`          | Unexpected Worker error                               |

### `GET /health`
Returns `{ "success": true, "service": "cf-statement-proxy", "status": "ok" }`. Useful for uptime checks.

## Production behavior

- **Retries**: up to `MAX_RETRIES` (default `3`) total attempts. Network
  errors and `5xx` responses are retried with a small linear backoff; `4xx`
  responses (e.g. 404) are never retried.
- **Timeout**: each individual attempt is aborted after `REQUEST_TIMEOUT_MS`
  (default `10000` ms) using `AbortController`.
- **Redirects**: followed automatically (`redirect: "follow"`).
- **Caching**: successful responses are stored in Cloudflare's edge Cache API
  (`caches.default`) for `CACHE_TTL_SECONDS` (default `86400` = 24h), keyed by
  the canonical `/api/problem/:contestId/:index` path (query strings can't
  fragment or bypass the cache). Errors are never cached.
- **CORS**: `Access-Control-Allow-Origin` is set from `ALLOWED_ORIGIN`
  (default `*`); `OPTIONS` preflight requests are handled explicitly.
- **Validation**: both path params are validated before any upstream request
  is made.
- **Logging**: every request emits structured JSON log lines
  (`request_received`, `cache_hit`/`cache_miss`, `upstream_retry_*`,
  `request_success`, error events) visible via `wrangler tail` or the
  Cloudflare dashboard's Logs tab.

## Project structure

```
worker/
├── src/
│   └── index.js       # Worker source (no external dependencies)
├── wrangler.toml       # Worker configuration
├── package.json
└── README.md            # this file
```

## Prerequisites

- Node.js ≥ 18
- A Cloudflare account (the free tier is enough)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency below)

## Deployment instructions

1. **Install dependencies**

   ```bash
   cd worker
   npm install
   ```

2. **Authenticate Wrangler with Cloudflare**

   ```bash
   npx wrangler login
   ```

   This opens a browser window to authorize the CLI against your Cloudflare account.

3. **(Optional) Adjust configuration**

   Open `wrangler.toml` and:
   - Change `name` if you want a different Worker/subdomain name.
   - Set `ALLOWED_ORIGIN` to your deployed frontend's exact origin once you
     have one (keep `*` only for local development/testing).
   - Tune `CACHE_TTL_SECONDS`, `REQUEST_TIMEOUT_MS`, `MAX_RETRIES` if needed.

4. **Run locally (optional but recommended)**

   ```bash
   npm run dev
   ```

   Wrangler prints a local URL (e.g. `http://localhost:8787`). Test it:

   ```bash
   curl -i "http://localhost:8787/api/problem/1999/A"
   curl -i "http://localhost:8787/api/problem/abc/A"   # → 400 INVALID_CONTEST_ID
   curl -i "http://localhost:8787/health"
   ```

5. **Deploy to Cloudflare**

   ```bash
   npm run deploy
   ```

   Wrangler prints the live URL, e.g.:

   ```
   https://cf-statement-proxy.<your-subdomain>.workers.dev
   ```

6. **Point the frontend at the Worker**

   In the frontend's `CONFIG` object, set:

   ```js
   WORKER_BASE_URL: "https://cf-statement-proxy.<your-subdomain>.workers.dev",
   ```

   No other frontend code needs to change — every statement request already
   goes through `CONFIG.WORKER_BASE_URL`.

7. **(Optional) Use a custom domain**

   Uncomment the `[[routes]]` block in `wrangler.toml`, set your zone, then
   redeploy with `npm run deploy`. Update `CONFIG.WORKER_BASE_URL` in the
   frontend to match.

8. **Verify in production**

   ```bash
   curl -i "https://cf-statement-proxy.<your-subdomain>.workers.dev/api/problem/1999/A"
   ```

   You should get back `200 OK` with the raw Codeforces problem HTML and
   `X-Cache: MISS` on the first call, `X-Cache: HIT` on subsequent calls
   within the 24h TTL.

9. **Monitor logs**

   ```bash
   npm run tail
   ```

   Streams structured JSON logs for every request in real time.

## Security notes

- Lock `ALLOWED_ORIGIN` down to your real frontend origin before shipping to
  production; `*` is fine for local development only.
- The Worker only ever calls `codeforces.com` — the upstream host is not
  derived from user input, only `contestId`/`index` are, and both are
  strictly validated before being interpolated into the upstream URL.
- No public third-party proxies are used or required.
