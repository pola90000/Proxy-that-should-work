// Cookie jar management backed by Supabase.
//
// Each anonymous session's cookie jar is stored in the `proxy_sessions`
// table so logins and cart state survive server restarts and sleeps. The
// Express server uses the service role key to read/write this table; the
// browser never touches it directly.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number; // epoch ms, 0 = session cookie
  secure: boolean;
  httponly: boolean;
}

interface CookieJar {
  sessionId: string;
  cookies: StoredCookie[];
  dirty: boolean;
}

// --- Supabase client (server-side, service role key) ----------------------
let client: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Supabase env vars not configured");
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

// --- In-process cache with write-through to Supabase ----------------------
// A short-lived cache avoids hitting the DB on every single proxied asset
// request within a page load. The cache is per-process; durability comes
// from the DB write on every merge.
const cache = new Map<string, CookieJar>();

export async function getCookieJar(sessionId: string): Promise<CookieJar> {
  const cached = cache.get(sessionId);
  if (cached) return cached;

  // Load from Supabase (or start fresh if not found).
  let cookies: StoredCookie[] = [];
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("proxy_sessions")
      .select("cookies")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (!error && data && Array.isArray(data.cookies)) {
      cookies = data.cookies as StoredCookie[];
    }
  } catch {
    // If Supabase is unreachable, fall back to an empty jar rather than
    // crashing the request — the session just won't persist cookies.
  }

  const jar: CookieJar = { sessionId, cookies, dirty: false };
  cache.set(sessionId, jar);
  return jar;
}

/** Merge Set-Cookie header values from a response into the jar and persist. */
export async function mergeSetCookies(
  jar: CookieJar,
  target: URL,
  setCookies: string[]
): Promise<void> {
  for (const raw of setCookies) {
    const parsed = parseSetCookie(raw, target);
    if (!parsed) continue;
    // Remove any existing cookie with the same name+domain+path.
    jar.cookies = jar.cookies.filter(
      (c) =>
        !(
          c.name === parsed.name &&
          c.domain === parsed.domain &&
          c.path === parsed.path
        )
    );
    // Drop if already expired.
    if (parsed.expires && parsed.expires > 0 && parsed.expires < Date.now()) {
      continue;
    }
    jar.cookies.push(parsed);
  }
  jar.dirty = true;
  await persistJar(jar);
}

/** Build a Cookie header value for the target URL from the jar. */
export async function cookieHeaderFor(
  jar: CookieJar,
  target: URL
): Promise<string> {
  const now = Date.now();
  const matching = jar.cookies.filter((c) => {
    if (c.expires && c.expires > 0 && c.expires < now) return false;
    return (
      domainMatches(target.hostname, c.domain) &&
      pathMatches(target.pathname, c.path)
    );
  });
  if (matching.length === 0) return "";
  matching.sort((a, b) => b.path.length - a.path.length);
  return matching.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Persist the jar to Supabase (upsert). */
async function persistJar(jar: CookieJar): Promise<void> {
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from("proxy_sessions")
      .upsert({
        session_id: jar.sessionId,
        cookies: jar.cookies,
      }, { onConflict: "session_id" });

    if (error) {
      // Log but don't throw — cookie persistence is best-effort.
      console.error("Failed to persist cookie jar:", error.message);
    }
  } catch (err) {
    console.error("Failed to persist cookie jar:", err);
  }
}

// --- Parsing helpers ------------------------------------------------------

function parseSetCookie(raw: string, target: URL): StoredCookie | null {
  const parts = raw.split(";");
  if (!parts[0]) return null;
  const [name, value] = parts[0].trim().split("=");
  if (!name) return null;

  let domain = target.hostname;
  let cookiePath = "/";
  let expires: number | undefined;
  let secure = false;
  let httponly = false;

  for (const part of parts.slice(1)) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed === "secure") secure = true;
    else if (trimmed === "httponly") httponly = true;
    else if (trimmed.startsWith("domain=")) {
      let d = part.trim().slice(7).trim().toLowerCase();
      if (d.startsWith(".")) d = d.slice(1);
      domain = d;
    } else if (trimmed.startsWith("path=")) {
      cookiePath = part.trim().slice(5).trim() || "/";
    } else if (trimmed.startsWith("expires=")) {
      const d = new Date(part.trim().slice(8).trim());
      if (!isNaN(d.getTime())) expires = d.getTime();
    } else if (trimmed.startsWith("max-age=")) {
      const secs = Number(part.trim().slice(8).trim());
      if (!isNaN(secs)) {
        expires = secs <= 0 ? 0 : Date.now() + secs * 1000;
      }
    }
  }

  return {
    name: name.trim(),
    value: (value ?? "").trim(),
    domain,
    path: cookiePath,
    expires,
    secure,
    httponly,
  };
}

function domainMatches(hostname: string, cookieDomain: string): boolean {
  const h = hostname.toLowerCase();
  const d = cookieDomain.toLowerCase();
  if (h === d) return true;
  return h.endsWith("." + d);
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (cookiePath === "/") return true;
  if (reqPath === cookiePath) return true;
  return reqPath.startsWith(cookiePath + "/") || reqPath.startsWith(cookiePath);
}
