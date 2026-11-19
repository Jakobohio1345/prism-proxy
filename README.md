# Prism — open-source web proxy browser

A browser inside your browser. Prism is a Node.js/Express server plus a minimal, browser-style
interface (tabs, address bar, back/forward, bookmarks). Pages are fetched by the server, their
links/images/forms/scripts are rewritten to go back through the server, and the result is shown in the tab.

```
prism-proxy/
├── package.json            dependencies (express, ws) and scripts
├── server.js               Express server: proxy, cookie jar, WebSocket relay, optional password
├── render.yaml             one-click config for Render
├── .env.example            environment variables
├── .gitignore
├── lib/
│   ├── urls.js             proxied-URL format + URL resolution
│   ├── rewrite.js          HTML / CSS rewriting and script injection
│   ├── cookies.js          server-side cookie jar (per visitor session)
│   ├── security.js         SSRF protection (blocks private networks) + rate limiter
│   └── blocklist.js        ad / tracker domain blocklist
├── public/
│   ├── index.html          the browser UI
│   └── _/
│       ├── app.css         UI styles (light/dark)
│       ├── app.js          tabs, history, bookmarks, settings
│       └── inject.js       runtime patches injected into every proxied page
└── test/
    └── rewrite.test.js     unit tests (npm test)
```

## How it works

* URLs look like `/p/https/example.com/path?q=1`. Because the real path is kept, relative links just work.
* The server fetches the page with a Chrome User-Agent, removes tracking/identifying request headers
  (`X-Forwarded-For`, `Via`, your real `Referer`, …), and drops response headers that would break
  framing (CSP, `X-Frame-Options`, HSTS).
* HTML and CSS are rewritten server-side. `inject.js` then patches `fetch`, `XMLHttpRequest`,
  `WebSocket`, dynamic `src`/`href` assignments, `history.pushState`, `document.cookie`, and
  `window.open` so runtime requests are also routed through the proxy.
* Cookies are kept in a server-side jar per visitor, so logins work per site without leaking between sites.
* Ads/trackers (a built-in domain list) are dropped before they are fetched. Toggle in ⋮ → Settings.
* The server refuses to fetch private/internal addresses (SSRF protection).

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # unit tests for the rewriter, cookie jar, SSRF guard
```

Needs Node.js 18.14 or newer (20 recommended).

## Deploy for free

> Free tiers change. These notes were checked in November 2026 — confirm on each provider's pricing page.

**Glitch no longer works**: it ended project hosting on July 8, 2025.

### Option A (recommended): Render

1. Create a free account at <https://github.com> and a **new repository** (e.g. `prism-proxy`).
   On the repo page choose **Add file → Upload files**, drag in the *contents* of this folder
   (including `lib`, `public`, `test`), and click **Commit changes**.
2. Create a free account at <https://render.com> (sign in with GitHub).
3. **New + → Web Service**, pick your repository.
4. Settings: **Runtime** Node · **Build Command** `npm install` · **Start Command** `npm start` ·
   **Instance Type** Free.
5. Under **Environment Variables** add `ACCESS_PASSWORD` = a password you choose. **Do not skip this**:
   without it, anyone who finds your URL can use your proxy.
6. Click **Create Web Service**. After a few minutes you get a URL like `https://prism-proxy-xxxx.onrender.com`.

Free-tier behaviour: the service sleeps after 15 minutes without traffic and takes roughly a minute
to wake up; there is a monthly free-hours allowance and bandwidth cap.

(Alternatively, with `render.yaml` in the repo: **New + → Blueprint** and select the repo.)

### Option B: Replit

1. Create an account at <https://replit.com> → **Create App → Import from GitHub** (or create a Node.js
   app and upload these files).
2. Open the **Secrets** tool and add `ACCESS_PASSWORD`.
3. Press **Run**. Replit shows a web preview URL; open it in a new browser tab.

Free Replit apps sleep when idle; always-on hosting now requires a paid plan.

### Open it on a Chromebook

1. Open Chrome, go to your deployment URL, enter the password.
2. Click the install icon in the address bar (or ⋮ → **Cast, save, and share → Install page as app**)
   if you want it in its own window.
3. Type a search or address in the Prism bar. Click **★** to bookmark, right-click a bookmark to remove it.
   `Alt+←` / `Alt+→` go back/forward.

If your Chromebook is managed by a school or employer, check their acceptable-use policy first.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Set automatically by most hosts |
| `ACCESS_PASSWORD` | *(none)* | Require a password to use the app (recommended) |
| `ALLOW_PRIVATE` | false | Allow fetching localhost/private IPs. Local testing only |
| `UPSTREAM_TIMEOUT_MS` | 30000 | How long to wait for a site |
| `RATE_LIMIT_PER_MIN` | 2400 | Max proxied requests per IP per minute |

## Known limitations (read this)

* **Not every site works.** This is a rewriting proxy, not a full browser engine. Simple sites, search
  engines (DuckDuckGo HTML, Brave Search), Wikipedia, news and forums work well. Heavy single-page apps,
  Google/YouTube/Netflix, anything with strict bot detection, CAPTCHAs, DRM video, or service workers may
  break or refuse to load.
* Scripts that read `window.location` see the proxy's address, not the real site's.
  Sites that check `top === self` (frame-busting) may refuse to render.
* **Same origin for all sites.** Every proxied page is served from your Prism domain, so one malicious page
  can in principle read another's `localStorage`. Don't sign in to banking, email, or other sensitive
  accounts through a proxy you operate for others.
* The server operator can see everything that passes through. Only use instances you run or trust.
* Rate limiting and SSRF protection are included, but a public open proxy attracts abuse. Keep `ACCESS_PASSWORD` set.
* Hosting providers may suspend services that are used as open proxies.

## License

MIT. Use it, fork it, improve it.
