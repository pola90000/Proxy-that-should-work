# Veil — Always-on Personal Web Proxy

Browse the web through your own proxy with persistent sessions, manual CAPTCHA support, and full URL rewriting that keeps you inside the proxy.

## Features

- **Persistent sessions** — logins, carts, and logged-in states survive server restarts via Supabase cookie jar storage
- **Full URL rewriting** — every link, image, form, script, and CSS reference is rewritten so you never leave the proxy by accident
- **Single-page app support** — in-page fetch/XHR, History API, and dynamic DOM content are intercepted and re-routed
- **Manual CAPTCHA support** — reCAPTCHA, hCaptcha, and Cloudflare Turnstile render correctly so you can solve them by hand (no automated solving)
- **Anonymous sessions** — no user accounts; each visitor gets a random session ID stored in a browser cookie
- **One deployment** — a single Express server serves both the React app and the proxy engine at one URL

## Quick start (local development)

```bash
# Install dependencies
npm install

# Build the React client and start the proxy server
npm start

# Or run them separately:
npm run dev        # Vite dev server (frontend only, hot reload)
npm run build      # Build the React client
npx tsx server/index.ts  # Start the proxy server (serves built client)
```

The server listens on `http://localhost:3000` (or the `PORT` env var if set).

## How it works

1. Enter any web address in the address bar
2. The proxy server fetches the real site and rewrites all URLs so navigation stays inside the proxy
3. Cookies from the target site are stored in Supabase, keyed to your anonymous session
4. On future visits, your saved cookies are loaded so logins and carts persist
5. CAPTCHAs load directly from their providers (your real IP is visible to them) so the challenges work

## Configuration

All configurable settings are in [`server/config.ts`](server/config.ts):

| Setting | Default | Description |
|---|---|---|
| `timeout` | 30,000 ms | How long to wait for a target site before giving up |
| `userAgent` | Chrome 124 | User-Agent string sent to target sites |
| `acceptLanguage` | `en-US,en;q=0.9` | Accept-Language header |
| `allowedPorts` | `[]` (80/443 only) | Ports the proxy is allowed to fetch from. Empty = standard web ports only |
| `blockedHosts` | localhost, 127.0.0.1, etc. | Hostnames that are never proxied |
| `maxRewriteSize` | 5 MB | Max body size to buffer and rewrite; larger responses pass through unmodified |
| `port` | `PORT` env or 3000 | Server listen port |

### CAPTCHA allowlist

The following hosts are allowed to load directly (bypassing the proxy) so CAPTCHA widgets work:

- `www.google.com`, `www.gstatic.com`, `apis.google.com`, `www.recaptcha.net` (reCAPTCHA)
- `hcaptcha.com`, `newassets.hcaptcha.com`, `assets.hcaptcha.com`, `api.hcaptcha.com` (hCaptcha)
- `challenges.cloudflare.com`, `cloudflareinsights.com` (Cloudflare Turnstile)

**Trade-off:** your real IP is visible to these providers. This is accepted so the challenges are fully functional. No automatic CAPTCHA solving is used anywhere.

## Supabase session storage

Cookie jars are stored in the `proxy_sessions` table in Supabase. The table is created automatically by the migrations in `supabase/migrations/`.

### Required environment variables

The server needs these to connect to Supabase. They are pre-populated in the Bolt environment. For local development or deployment, set them in `.env` or your hosting provider's dashboard:

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS, used by the server) |
| `SUPABASE_ANON_KEY` | Anon key (fallback if service role key is not set) |

If `SUPABASE_SERVICE_ROLE_KEY` is not available, the server falls back to the anon key.

## Deploy to Render (free tier, no credit card)

### One-time setup

1. **Push to GitHub** — push this project to a GitHub repository

2. **Connect to Render** — go to [render.com](https://render.com), sign up with GitHub (free, no credit card required for the free tier)

3. **Create a new Web Service**:
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Render will detect the `render.yaml` blueprint automatically
   - Alternatively, configure manually:
     - **Runtime:** Node
     - **Build Command:** `npm install && npm run build`
     - **Start Command:** `npm start`
     - **Plan:** Free

4. **Set environment variables** — in the Render dashboard under "Environment", add:
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — your Supabase service role key
   - `SUPABASE_ANON_KEY` — your Supabase anon key

5. **Deploy** — Render will build and start the service. It gets a permanent `*.onrender.com` URL that auto-wakes on request.

### How the free tier works

- The service sleeps after 15 minutes of inactivity
- It auto-wakes when a request comes in (first request takes a few seconds)
- Your browsing sessions persist across sleeps because cookie jars are in Supabase, not memory
- No credit card required

## Architecture

```
Browser (React app)
  └── Address bar → /proxy?url=<target>
        └── Express server
              ├── Fetches the real site (follows redirects, sends browser headers)
              ├── Rewrites all URLs to /proxy?url=...
              ├── Injects client script (fetch/XHR/navigation interception)
              ├── Streams binary assets, rewrites text/HTML/CSS
              ├── Loads/saves cookies via Supabase proxy_sessions table
              └── Returns rewritten page to the browser
```

### Key files

- `server/index.ts` — Express server, proxy endpoint, session cookies
- `server/config.ts` — All configurable settings + CAPTCHA allowlist
- `server/rewriter.ts` — URL rewriting engine + client-side interception script
- `server/cookies.ts` — Supabase-backed cookie jar management
- `server/proxy-helpers.ts` — Request validation, header building, response cleaning
- `src/App.tsx` — React browsing shell (address bar, breadcrumbs, error states)
- `src/lib/proxy.ts` — URL building/parsing helpers
- `src/lib/proxy-check.ts` — Pre-check proxy targets before loading iframe

## Error handling

The proxy provides dedicated error states for:

- **Unreachable sites** — the host didn't respond or doesn't exist
- **SSL/certificate problems** — the site's certificate couldn't be verified
- **Timeouts** — the site took too long to respond
- **Unsupported content** — the response type can't be displayed
- **Blocked addresses** — the host/port is outside the allowed list

Each error page includes a clear explanation and a "Try again" option.
