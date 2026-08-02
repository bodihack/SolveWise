/**
 * Cloudflare Worker — Codeforces Problem Statement Proxy
 * =========================================================================
 * Exposes:
 *   GET /api/problem/:contestId/:index
 *   GET /health
 *
 * Responsibilities:
 *   - Fetch the original Codeforces problem statement page HTML server-side
 *     (Codeforces problem pages do not send CORS headers, so the browser
 *     cannot fetch them directly — this Worker is the only place that talks
 *     to codeforces.com for statements).
 *   - Validate `contestId` / `index` before making any upstream request.
 *   - Retry transient upstream failures (network errors / 5xx) up to
 *     MAX_RETRIES times, each attempt bounded by a REQUEST_TIMEOUT_MS timeout.
 *   - Follow HTTP redirects transparently.
 *   - Cache successful responses on Cloudflare's edge for CACHE_TTL_SECONDS
 *     (24h by default) using the Cache API.
 *   - Return the original HTML on success, or a structured JSON error object
 *     on any failure.
 *   - Emit structured (JSON) logs for observability via `wrangler tail`.
 *   - Send permissive-but-controllable CORS headers so the front-end SPA
 *     (any static origin) can call this Worker directly.
 *
 * This file intentionally has zero external dependencies so it runs as-is
 * on the Workers runtime without a bundler.
 * =========================================================================
 */

// ---------------------------------------------------------------------------
// Configuration (overridable via wrangler.toml [vars] / Worker secrets)
// ---------------------------------------------------------------------------
const DEFAULTS = {
  ALLOWED_ORIGIN: "*",
  CACHE_TTL_SECONDS: 86400, // 24 hours
  REQUEST_TIMEOUT_MS: 10000, // 10 seconds, per attempt
  MAX_RETRIES: 3, // total attempts (1 initial + up to 2 retries)
  RETRY_BASE_DELAY_MS: 300,
};

const ROUTE_PATTERN = /^\/api\/problem\/([^/]+)\/([^/]+)\/?$/;

// Codeforces contest ids are positive integers (practically 1–6 digits).
const CONTEST_ID_PATTERN = /^[1-9]\d{0,5}$/;
// Codeforces problem indices: a leading letter, optionally followed by a
// few more letters/digits (e.g. "A", "B1", "E2", "F", "DIV2A" style rarely).
const PROBLEM_INDEX_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,4}$/;

const UPSTREAM_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export default {
  /**
   * @param {Request} request
   * @param {Record<string, string>} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const config = resolveConfig(env);
    const corsHeaders = buildCorsHeaders(config);
    const requestId = crypto.randomUUID();

    try {
      // ---- CORS preflight ----
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const url = new URL(request.url);

      // ---- Health check ----
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return jsonResponse({ success: true, service: "cf-statement-proxy", status: "ok" }, 200, corsHeaders);
      }

      const match = url.pathname.match(ROUTE_PATTERN);
      if (!match) {
        return errorResponse(
          "NOT_FOUND",
          "Unknown endpoint. Use GET /api/problem/:contestId/:index.",
          404,
          corsHeaders
        );
      }

      if (request.method !== "GET") {
        return errorResponse(
          "METHOD_NOT_ALLOWED",
          "Only GET requests are supported on this endpoint.",
          405,
          corsHeaders
        );
      }

      const contestId = safeDecode(match[1]).trim();
      const index = safeDecode(match[2]).trim().toUpperCase();

      const validationError = validateInputs(contestId, index);
      if (validationError) {
        log("warn", "validation_failed", requestId, { contestId, index, code: validationError.code });
        return errorResponse(validationError.code, validationError.message, 400, corsHeaders);
      }

      log("info", "request_received", requestId, { contestId, index });

      // ---- Edge cache lookup ----
      const cache = caches.default;
      const cacheKey = buildCacheKey(request, contestId, index);

      const cached = await cache.match(cacheKey);
      if (cached) {
        log("info", "cache_hit", requestId, { contestId, index });
        const headers = new Headers(cached.headers);
        applyHeaders(headers, corsHeaders);
        headers.set("X-Cache", "HIT");
        headers.set("X-Request-Id", requestId);
        return new Response(cached.body, { status: cached.status, headers });
      }
      log("info", "cache_miss", requestId, { contestId, index });

      // ---- Fetch from Codeforces (with retries + timeout) ----
      const targetUrl = `https://codeforces.com/problemset/problem/${encodeURIComponent(contestId)}/${encodeURIComponent(index)}`;

      let upstream;
      try {
        upstream = await fetchWithRetry(targetUrl, config, requestId);
      } catch (err) {
        const timedOut = err && err.name === "AbortError";
        log("error", "upstream_fetch_failed", requestId, {
          contestId,
          index,
          timedOut,
          message: String((err && err.message) || err),
        });
        return errorResponse(
          timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNREACHABLE",
          timedOut
            ? "Codeforces did not respond in time. Please try again shortly."
            : "Could not reach Codeforces right now. Please try again shortly.",
          504,
          corsHeaders
        );
      }

      if (upstream.status === 404) {
        log("warn", "problem_not_found", requestId, { contestId, index, status: upstream.status });
        return errorResponse(
          "PROBLEM_NOT_FOUND",
          `Problem ${contestId}${index} was not found on Codeforces.`,
          404,
          corsHeaders
        );
      }

      if (!upstream.ok) {
        log("error", "upstream_bad_status", requestId, { contestId, index, status: upstream.status });
        return errorResponse(
          "UPSTREAM_ERROR",
          `Codeforces responded with status ${upstream.status}.`,
          502,
          corsHeaders
        );
      }

      const html = await upstream.text();

      // Codeforces returns HTTP 200 even for some invalid/blocked problem
      // pages (e.g. redirected to an error page). Guard against caching or
      // serving those as if they were valid statements.
      if (!html || !html.includes("problem-statement")) {
        log("warn", "statement_markup_missing", requestId, { contestId, index });
        return errorResponse(
          "PROBLEM_NOT_FOUND",
          `Problem ${contestId}${index} could not be located in the returned page.`,
          404,
          corsHeaders
        );
      }

      const responseHeaders = new Headers({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": `public, max-age=${config.CACHE_TTL_SECONDS}`,
        "X-Cache": "MISS",
        "X-Request-Id": requestId,
      });
      applyHeaders(responseHeaders, corsHeaders);

      const response = new Response(html, { status: 200, headers: responseHeaders });

      // Store a copy in the edge cache without blocking the response.
      ctx.waitUntil(cache.put(cacheKey, response.clone()));

      log("info", "request_success", requestId, { contestId, index, bytes: html.length });
      return response;
    } catch (err) {
      log("error", "unhandled_exception", requestId, { message: String((err && err.stack) || err) });
      return errorResponse("INTERNAL_ERROR", "An unexpected error occurred.", 500, corsHeaders);
    }
  },
};

// ---------------------------------------------------------------------------
// Upstream fetch: retries + per-attempt timeout + redirect handling
// ---------------------------------------------------------------------------
async function fetchWithRetry(url, config, requestId) {
  let lastError;

  for (let attempt = 1; attempt <= config.MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow", // transparently follow CF redirects (e.g. contest/problem aliasing)
        signal: controller.signal,
        headers: {
          "User-Agent": UPSTREAM_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      clearTimeout(timer);

      // Retry on server-side (5xx) errors, not on client-side (4xx, e.g. 404).
      if (response.status >= 500 && attempt < config.MAX_RETRIES) {
        log("warn", "upstream_retry_5xx", requestId, { attempt, status: response.status });
        await sleep(config.RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      return response;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < config.MAX_RETRIES) {
        log("warn", "upstream_retry_error", requestId, {
          attempt,
          message: String((err && err.message) || err),
        });
        await sleep(config.RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function validateInputs(contestId, index) {
  if (!contestId || !CONTEST_ID_PATTERN.test(contestId)) {
    return {
      code: "INVALID_CONTEST_ID",
      message: "contestId must be a positive integer (e.g. 1, 1500, 1999).",
    };
  }
  if (!index || !PROBLEM_INDEX_PATTERN.test(index)) {
    return {
      code: "INVALID_PROBLEM_INDEX",
      message: "index must start with a letter and be at most 5 characters (e.g. A, B1, E2).",
    };
  }
  return null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------
function buildCacheKey(request, contestId, index) {
  // Normalize to a canonical URL so query strings / trailing slashes can't
  // fragment the cache or be used to bypass it.
  const origin = new URL(request.url).origin;
  const canonical = `${origin}/api/problem/${contestId}/${index}`;
  return new Request(canonical, { method: "GET" });
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
function buildCorsHeaders(config) {
  return {
    "Access-Control-Allow-Origin": config.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function applyHeaders(headers, extra) {
  Object.entries(extra).forEach(([key, value]) => headers.set(key, value));
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------
function jsonResponse(payload, status, corsHeaders) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  applyHeaders(headers, corsHeaders);
  return new Response(JSON.stringify(payload), { status, headers });
}

function errorResponse(code, message, status, corsHeaders) {
  return jsonResponse({ success: false, error: { code, message } }, status, corsHeaders);
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------
function resolveConfig(env) {
  return {
    ALLOWED_ORIGIN: (env && env.ALLOWED_ORIGIN) || DEFAULTS.ALLOWED_ORIGIN,
    CACHE_TTL_SECONDS: parseIntSafe(env && env.CACHE_TTL_SECONDS, DEFAULTS.CACHE_TTL_SECONDS),
    REQUEST_TIMEOUT_MS: parseIntSafe(env && env.REQUEST_TIMEOUT_MS, DEFAULTS.REQUEST_TIMEOUT_MS),
    MAX_RETRIES: parseIntSafe(env && env.MAX_RETRIES, DEFAULTS.MAX_RETRIES),
    RETRY_BASE_DELAY_MS: DEFAULTS.RETRY_BASE_DELAY_MS,
  };
}

function parseIntSafe(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Logging (structured JSON — visible via `wrangler tail` / dashboard logs)
// ---------------------------------------------------------------------------
function log(level, event, requestId, data) {
  const entry = { level, event, requestId, time: new Date().toISOString(), ...data };
  if (level === "error") console.error(JSON.stringify(entry));
  else if (level === "warn") console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}
