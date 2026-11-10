import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  config,
} from "./config.js";
import {
  resolveTarget,
  buildTargetHeaders,
  parseSetCookies,
  cleanResponseHeaders,
  isHtmlType,
  isTextType,
} from "./proxy-helpers.js";
import {
  rewriteHtml,
  rewriteCss,
  injectClientScript,
} from "./rewriter.js";
import {
  getCookieJar,
  mergeSetCookies,
  cookieHeaderFor,
} from "./cookies.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_PATH = "/proxy";

const app = express();
app.disable("x-powered-by");

// Serve the built React app from /dist when in production.
const distDir = path.resolve(__dirname, "../dist");
app.use(express.static(distDir, { index: "index.html", fallthrough: true }));

// --- Main proxy endpoint --------------------------------------------------
//
// Handles document requests, asset requests, and redirect chains. Binary
// assets are streamed through; text/html/css is buffered and rewritten.
//
app.get(PROXY_PATH, async (req, res) => {
  const check = resolveTarget(req.query.url as string | null);
  if (!check.ok) {
    res.locals.prefetch = req.headers["x-veil-prefetch"] === "1";
    return sendProxyError(res, check.reason === "blocked" ? "blocked" : "invalid", req.query.url as string);
  }
  const target = check.url;

  // Mark whether this is a prefetch (pre-check) request from the React shell.
  res.locals.prefetch = req.headers["x-veil-prefetch"] === "1";

  const sessionId = getSessionId(req);
  const jar = await getCookieJar(sessionId);

  await fetchTarget(req, res, target, sessionId, jar, 0);
});

// --- Recursive fetch with redirect following ------------------------------
async function fetchTarget(
  req: express.Request,
  res: express.Response,
  target: URL,
  sessionId: string,
  jar: Awaited<ReturnType<typeof getCookieJar>>,
  redirects: number
) {
  if (redirects > 10) {
    return sendProxyError(res, "unreachable", target.href, "Too many redirects");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout);

  const headers = buildTargetHeaders(target, req.headers as Record<string, string | string[] | undefined>);
  const cookies = await cookieHeaderFor(jar, target);
  if (cookies) headers["Cookie"] = cookies;

  let response: Response;
  try {
    response = await fetch(target.href, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("aborted") || msg.includes("timeout")) {
      return sendProxyError(res, "timeout", target.href);
    }
    if (msg.includes("certificate") || msg.includes("SSL") || msg.includes("TLS")) {
      return sendProxyError(res, "ssl", target.href, msg);
    }
    return sendProxyError(res, "unreachable", target.href, msg);
  }
  clearTimeout(timer);

  // --- Handle redirects by re-fetching through the proxy ------------------
  const status = response.status;
  if (status >= 300 && status < 400) {
    const location = response.headers.get("location");
    if (location) {
      // Merge any cookies set on the redirect response before following.
      const setCookies = parseSetCookies(response.headers);
      if (setCookies.length) {
        await mergeSetCookies(jar, target, setCookies);
      }
      const nextUrl = new URL(location, target.href);
      // Re-check the redirect target against the allowlist.
      const nextCheck = resolveTarget(nextUrl.href);
      if (!nextCheck.ok) {
        return sendProxyError(res, nextCheck.reason === "blocked" ? "blocked" : "invalid", nextUrl.href);
      }
      return fetchTarget(req, res, nextCheck.url, sessionId, jar, redirects + 1);
    }
  }

  // --- Merge cookies set on the response ----------------------------------
  const setCookies = parseSetCookies(response.headers);
  if (setCookies.length) {
    await mergeSetCookies(jar, target, setCookies);
  }

  // --- Set the session cookie on the visitor's browser --------------------
  setSessionCookie(res, sessionId);

  // --- Prefetch: return just the status, no body -------------------------
  if (isPrefetch(res)) {
    if (status >= 400) {
      return sendProxyError(res, "unknown", target.href, `Target returned ${status}`);
    }
    res.status(200).setHeader("Content-Type", "text/plain");
    res.send("ok");
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const cleaned = cleanResponseHeaders(response.headers);

  // --- Stream binary/non-text assets straight through ---------------------
  if (!isTextType(contentType) && !isHtmlType(contentType)) {
    res.status(status);
    for (const [k, v] of Object.entries(cleaned)) res.setHeader(k, v);
    res.setHeader("X-Proxy", "veil");
    // Re-add the visitor session cookie on binary responses too.
    setSessionCookie(res, sessionId);

    // Stream the body without buffering.
    if (response.body) {
      const reader = response.body.getReader();
      const pump = async () => {
        try {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        } catch {
          res.end();
        }
      };
      pump();
    } else {
      res.end();
    }
    return;
  }

  // --- Buffer and rewrite text content ------------------------------------
  const chunks: Buffer[] = [];
  const reader = response.body?.getReader();
  if (!reader) {
    return sendProxyError(res, "unsupported", target.href, "No response body");
  }

  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > config.maxRewriteSize) {
      // Too big to safely rewrite — pass through unmodified.
      res.status(status);
      for (const [k, v] of Object.entries(cleaned)) res.setHeader(k, v);
      res.setHeader("X-Proxy", "veil");
      setSessionCookie(res, sessionId);
      const buf = Buffer.concat(chunks);
      res.write(buf);
      res.write(value);
      // drain rest
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        res.write(r.value);
      }
      res.end();
      return;
    }
    chunks.push(Buffer.from(value));
  }

  const body = Buffer.concat(chunks).toString("utf-8");

  res.status(status);
  for (const [k, v] of Object.entries(cleaned)) res.setHeader(k, v);
  res.setHeader("X-Proxy", "veil");
  setSessionCookie(res, sessionId);

  if (isHtmlType(contentType)) {
    const rewritten = rewriteHtml(body, target);
    const withScript = injectClientScript(rewritten);
    res.send(withScript);
  } else if (contentType.toLowerCase().includes("text/css")) {
    res.send(rewriteCss(body, target));
  } else {
    res.send(body);
  }
}

// --- Session cookie helpers (anonymous, set on the visitor) ---------------
const SESSION_COOKIE = "veil_session";

function getSessionId(req: express.Request): string {
  const existing = req.cookies?.[SESSION_COOKIE];
  if (existing && typeof existing === "string") return existing;
  // Generate a fresh anonymous ID. (cookie-parser isn't installed; we parse
  // manually to avoid an extra dependency.)
  const fromHeader = parseCookie(req.headers.cookie, SESSION_COOKIE);
  if (fromHeader) return fromHeader;
  return cryptoRandomId();
}

function setSessionCookie(res: express.Response, sessionId: string) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`
  );
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === name) return v;
  }
  return undefined;
}

function cryptoRandomId(): string {
  return randomUUID();
}

// --- Error response -------------------------------------------------------
// Returns JSON for prefetch requests (the React shell interprets it), or
// a friendly HTML error page for direct browser access.
function sendProxyError(
  res: express.Response,
  kind: string,
  target: string,
  detail?: string
) {
  res.status(502);
  res.setHeader("X-Proxy-Error", kind);

  if (isPrefetch(res)) {
    res.setHeader("Content-Type", "application/json");
    res.json({ error: kind, target, detail });
    return;
  }

  // Direct browser access — show a standalone HTML error page.
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(buildErrorPage(kind, target, detail));
}

function isPrefetch(res: express.Response): boolean {
  // The React shell sends this header on pre-check requests.
  const locals = res.locals as Record<string, unknown>;
  return locals.prefetch === true;
}

// --- Standalone HTML error page (for direct browser access) ---------------
function buildErrorPage(kind: string, target: string, detail?: string): string {
  const titles: Record<string, string> = {
    unreachable: "Can't reach that site",
    ssl: "Secure connection failed",
    timeout: "The site took too long",
    unsupported: "Can't display that here",
    blocked: "That address isn't allowed",
    invalid: "That address isn't valid",
    unknown: "Something went wrong",
  };
  const details: Record<string, string> = {
    unreachable: "The site didn't respond or the address doesn't exist. Check the spelling and try again.",
    ssl: "The site's security certificate could not be verified, so the proxy refused to connect.",
    timeout: "The request timed out before the site responded. Sometimes a second attempt works.",
    unsupported: "The site returned a type of content the proxy can't show in the browser.",
    blocked: "The target host or port is outside the proxy's allowed list.",
    invalid: "The URL you entered doesn't look like a valid web address.",
    unknown: "An unexpected error happened while loading the site. Please try again.",
  };
  const title = titles[kind] ?? titles.unknown;
  const desc = details[kind] ?? details.unknown;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font:14px/1.6 system-ui,sans-serif;background:#f8fafc;color:#1e293b;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:2rem}
.card{max-width:28rem;text-align:center}.icon{width:56px;height:56px;border-radius:50%;background:#fef3c7;color:#d97706;display:flex;align-items:center;justify-content:center;margin:0 auto 1.25rem;font-size:28px}
h1{font-size:1.375rem;font-weight:600;margin-bottom:.5rem}.desc{color:#64748b;margin-bottom:1rem}.url{font-size:.8125rem;color:#94a3b8;background:#fff;border:1px solid #e2e8f0;border-radius:.5rem;padding:.5rem .75rem;margin-bottom:1.5rem;word-break:break-all}
.detail{font-size:.75rem;color:#94a3b8;margin-bottom:1rem}.btns{display:flex;gap:.75rem;justify-content:center}
a.btn{display:inline-flex;align-items:center;gap:.5rem;padding:.5rem 1rem;border-radius:.5rem;font-weight:500;text-decoration:none;cursor:pointer;border:none}
a.btn-primary{background:#1e293b;color:#fff}a.btn-primary:hover{background:#334155}a.btn-secondary{background:#fff;color:#475569;border:1px solid #cbd5e1}a.btn-secondary:hover{background:#f1f5f9}
</style></head><body><div class="card"><div class="icon">!</div><h1>${title}</h1><p class="desc">${desc}</p>${target ? `<div class="url">${target}</div>` : ""}${detail ? `<p class="detail">${detail}</p>` : ""}<div class="btns"><a class="btn btn-primary" href="javascript:location.reload()">Try again</a><a class="btn btn-secondary" href="/">Home</a></div></div></body></html>`;
}

// --- SPA fallback: any non-/proxy route serves index.html -----------------
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

const port = config.port;
app.listen(port, () => {
  console.log(`Veil proxy server listening on port ${port}`);
});

export { app };
