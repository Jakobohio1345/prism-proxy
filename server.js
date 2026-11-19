'use strict';

/**
 * Prism — an open-source web proxy browser.
 * Express backend: fetches remote sites, rewrites HTML/CSS so every link/asset/form goes back through
 * the proxy, relays WebSockets, keeps a server-side cookie jar, strips tracking headers and blocks ads.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { WebSocketServer, WebSocket } = require('ws');

const { fromProxyPath, realUrlFromReferer, rewriteUrl } = require('./lib/urls');
const { rewriteHtml, rewriteCss } = require('./lib/rewrite');
const { CookieStore, parseCookieHeader } = require('./lib/cookies');
const { assertPublicTarget, createRateLimiter } = require('./lib/security');
const { isBlocked } = require('./lib/blocklist');

/* ----------------------------------------------------------------------------
 * Configuration (environment variables)
 * ------------------------------------------------------------------------- */
const PORT = parseInt(process.env.PORT, 10) || 3000;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || ''; // optional: protects your instance
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === 'true'; // only for local testing
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS, 10) || 30000;
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN, 10) || 2400;

const CHROME_MAJOR = '142';
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
const SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not_A Brand";v="24"`;

const store = new CookieStore();
const allow = createRateLimiter({ windowMs: 60 * 1000, max: RATE_LIMIT_PER_MIN });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function errorPage(res, status, title, detail) {
  if (res.headersSent) return res.end();
  res
    .status(status)
    .set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#1d2330}
@media(prefers-color-scheme:dark){body{background:#14161c;color:#e7e9ee}}
main{max-width:520px;padding:32px}h1{font-size:22px;margin:0 0 8px}p{opacity:.75;margin:0 0 16px}code{background:#8882;padding:2px 6px;border-radius:6px}</style>
<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail || '')}</p><p><code>HTTP ${status}</code></p></main>`);
}

function sessionFrom(req, res) {
  const cookies = parseCookieHeader(req.headers.cookie);
  let sid = cookies.px_sid;
  if (!sid || !/^[a-f0-9]{48}$/.test(sid)) {
    sid = crypto.randomBytes(24).toString('hex');
    res.append(
      'Set-Cookie',
      `px_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${req.secure ? '; Secure' : ''}`
    );
  }
  return sid;
}

function sidFromReq(req) {
  const sid = parseCookieHeader(req.headers.cookie).px_sid;
  return sid && /^[a-f0-9]{48}$/.test(sid) ? sid : null;
}

/* ----------------------------------------------------------------------------
 * Optional password gate (set ACCESS_PASSWORD to enable)
 * ------------------------------------------------------------------------- */
const AUTH_TOKEN = crypto.createHmac('sha256', ACCESS_PASSWORD || 'none').update('prism-auth').digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isAuthed(req) {
  if (!ACCESS_PASSWORD) return true;
  return safeEqual(parseCookieHeader(req.headers.cookie).px_auth || '', AUTH_TOKEN);
}

function loginPage(error) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prism — Sign in</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#1d2330}
@media(prefers-color-scheme:dark){body{background:#14161c;color:#e7e9ee}input,button{background:#222632;color:inherit;border-color:#3a4050}}
form{width:min(340px,90vw);display:grid;gap:12px}h1{margin:0 0 4px;font-size:24px}
input,button{font:inherit;padding:12px 14px;border-radius:10px;border:1px solid #c9ced8}
button{background:#4f6bff;color:#fff;border:0;cursor:pointer;font-weight:600}.err{color:#d33}</style>
<form method="post" action="/login"><h1>Prism</h1><span>This instance is password protected.</span>
<input type="password" name="password" placeholder="Password" autofocus required>
${error ? '<span class="err">Wrong password.</span>' : ''}<button>Sign in</button></form>`;
}

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/login', (req, res) => {
  if (!ACCESS_PASSWORD || isAuthed(req)) return res.redirect('/');
  res.type('html').send(loginPage(false));
});

app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  if (!ACCESS_PASSWORD) return res.redirect('/');
  if (safeEqual(req.body.password || '', ACCESS_PASSWORD)) {
    res.append(
      'Set-Cookie',
      `px_auth=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${req.secure ? '; Secure' : ''}`
    );
    return res.redirect('/');
  }
  res.status(401).type('html').send(loginPage(true));
});

app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return res.redirect('/login');
  res.status(401).type('text').send('Unauthorized');
});

/* ----------------------------------------------------------------------------
 * Frontend (the browser UI). Assets live under /_/ so they never collide with proxied sites' paths.
 * ------------------------------------------------------------------------- */
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(
  '/_',
  express.static(path.join(PUBLIC_DIR, '_'), {
    maxAge: '1h',
    setHeaders: (res, file) => {
      if (file.endsWith('inject.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

app.get('/', (req, res, next) => {
  // A proxied page requesting "/" (root-relative) is handled by the fallback below.
  if (realUrlFromReferer(req.headers.referer)) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// document.cookie bridge: pages report cookies they set from JavaScript
app.post('/_/cookie', express.text({ type: () => true, limit: '8kb' }), (req, res) => {
  try {
    const target = new URL(String(req.query.u || ''));
    if (!/^https?:$/.test(target.protocol)) throw new Error('bad url');
    const sid = sessionFrom(req, res);
    if (typeof req.body === 'string' && req.body) store.set(sid, target, req.body, true);
    res.status(204).end();
  } catch (_) {
    res.status(400).end();
  }
});

app.post('/_/clear', (req, res) => {
  const sid = sidFromReq(req);
  if (sid) store.clear(sid);
  res.status(204).end();
});

/* ----------------------------------------------------------------------------
 * The proxy
 * ------------------------------------------------------------------------- */
const COPY_RESPONSE_HEADERS = [
  'content-type', 'content-disposition', 'content-language', 'cache-control', 'expires',
  'last-modified', 'etag', 'accept-ranges', 'content-range',
];

function isHtml(ct) {
  return /^(text\/html|application\/xhtml\+xml)/i.test(ct);
}
function isCss(ct) {
  return /^text\/css/i.test(ct);
}

function decodeBody(buf, contentType) {
  let charset = (/charset\s*=\s*["']?([\w-]+)/i.exec(contentType) || [])[1];
  if (!charset) {
    const head = buf.subarray(0, 2048).toString('latin1');
    charset = (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) || [])[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch (_) {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function buildUpstreamHeaders(req, target, sid) {
  const h = {
    'user-agent': USER_AGENT,
    accept: req.headers.accept || '*/*',
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };

  const dest = req.headers['sec-fetch-dest'];
  const mode = req.headers['sec-fetch-mode'];
  if (dest) h['sec-fetch-dest'] = dest;
  if (mode) h['sec-fetch-mode'] = mode;
  if (dest === 'document' || dest === 'iframe') h['upgrade-insecure-requests'] = '1';

  // Referer / Origin as the *real* page would send them (never the proxy's address)
  const realReferer = realUrlFromReferer(req.headers.referer);
  const refererUrl = realReferer ? new URL(realReferer) : null;
  if (refererUrl) {
    h.referer = refererUrl.origin === target.origin ? refererUrl.href : refererUrl.origin + '/';
    h['sec-fetch-site'] = refererUrl.origin === target.origin ? 'same-origin' : 'cross-site';
  } else {
    h['sec-fetch-site'] = 'none';
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') h.origin = refererUrl ? refererUrl.origin : target.origin;
  else if (req.headers.origin) h.origin = refererUrl ? refererUrl.origin : target.origin;

  for (const k of ['range', 'if-none-match', 'if-modified-since', 'content-type']) {
    if (req.headers[k]) h[k] = req.headers[k];
  }
  const cookie = store.header(sid, target);
  if (cookie) h.cookie = cookie;
  return h;
}

async function proxyHandler(req, res) {
  const targetStr = fromProxyPath(req.originalUrl);
  if (!targetStr) return errorPage(res, 400, 'Bad proxy address', 'The address could not be understood.');

  let target;
  try {
    target = new URL(targetStr);
  } catch (_) {
    return errorPage(res, 400, 'Bad URL', 'That URL is not valid.');
  }

  if (!allow(req.ip)) return errorPage(res, 429, 'Slow down', 'Too many requests from your address. Try again in a minute.');

  const cookies = parseCookieHeader(req.headers.cookie);
  const blocking = cookies.px_block !== 'off';
  if (blocking && isBlocked(target.hostname)) return res.status(204).set('Cache-Control', 'no-store').end();

  if (!ALLOW_PRIVATE) {
    try {
      await assertPublicTarget(target);
    } catch (e) {
      return errorPage(res, 403, 'Blocked', e.message);
    }
  }

  const sid = sessionFrom(req, res);
  const headers = buildUpstreamHeaders(req, target, sid);

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD' && Buffer.isBuffer(req.body) && req.body.length) body = req.body;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });

  let up;
  try {
    up = await fetch(target, { method: req.method, headers, body, redirect: 'manual', signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    if (res.destroyed) return;
    const msg = e && e.name === 'AbortError' ? 'The site took too long to respond.' : 'Could not connect to ' + target.host + '.';
    return errorPage(res, 502, 'Could not load page', msg);
  }
  clearTimeout(timer);

  // Save cookies from the upstream site into our jar
  try {
    const setCookies = typeof up.headers.getSetCookie === 'function' ? up.headers.getSetCookie() : [];
    for (const c of setCookies) store.set(sid, target, c, false);
  } catch (_) { /* ignore malformed cookies */ }

  // Redirects: rewrite Location so the browser follows through the proxy
  const location = up.headers.get('location');
  if (up.status >= 300 && up.status < 400 && location) {
    res.status(up.status).set({ Location: rewriteUrl(location, target.href), 'Cache-Control': 'no-store' }).end();
    return;
  }

  res.status(up.status);
  for (const name of COPY_RESPONSE_HEADERS) {
    const v = up.headers.get(name);
    if (v) res.setHeader(name, v);
  }
  // Privacy/safety: never forward upstream cookies, CSP, frame blocking, HSTS, tracking headers
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const ct = up.headers.get('content-type') || '';
  const hasBody = req.method !== 'HEAD' && up.status !== 204 && up.status !== 304 && up.body;

  try {
    if (hasBody && (isHtml(ct) || isCss(ct))) {
      const buf = Buffer.from(await up.arrayBuffer());
      const text = decodeBody(buf, ct);
      let out;
      if (isHtml(ct)) {
        out = rewriteHtml(text, target.href, { cookies: store.header(sid, target, { scriptOnly: true }) });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.removeHeader('ETag');
        res.removeHeader('Last-Modified');
      } else {
        out = rewriteCss(text, target.href);
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.removeHeader('ETag');
      }
      res.removeHeader('Content-Range');
      res.setHeader('Content-Length', Buffer.byteLength(out));
      res.end(out);
      return;
    }

    if (!hasBody) return res.end();

    // Everything else (images, video, JS, JSON, fonts…) is streamed straight through.
    const len = up.headers.get('content-length');
    if (len && !up.headers.get('content-encoding')) res.setHeader('Content-Length', len);
    const stream = Readable.fromWeb(up.body);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) errorPage(res, 502, 'Could not read page', 'The site sent a response that could not be processed.');
    else res.destroy();
  }
}

app.use('/p/', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  proxyHandler(req, res).catch(() => errorPage(res, 500, 'Proxy error', 'Something went wrong inside the proxy.'));
});

/* ----------------------------------------------------------------------------
 * Fallback: a proxied page asked for a root-relative URL we could not rewrite (e.g. built in JS).
 * The Referer tells us which site it belongs to, so we redirect it into the proxy.
 * ------------------------------------------------------------------------- */
app.use((req, res) => {
  const real = realUrlFromReferer(req.headers.referer);
  if (real) {
    try {
      const origin = new URL(real);
      const dest = `/p/${origin.protocol.slice(0, -1)}/${origin.host}${req.originalUrl}`;
      return res.redirect(307, dest);
    } catch (_) { /* fall through */ }
  }
  errorPage(res, 404, 'Not found', 'That page does not exist.');
});

/* ----------------------------------------------------------------------------
 * WebSocket relay:  ws(s)://<proxy>/_ws/<ws|wss>/<host>/<path>
 * ------------------------------------------------------------------------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

function safeClose(ws, code, reason) {
  try {
    const ok = code === 1000 || (code >= 3000 && code <= 4999);
    ws.close(ok ? code : 1000, reason ? String(reason).slice(0, 100) : undefined);
  } catch (_) {
    try { ws.terminate(); } catch (__) { /* ignore */ }
  }
}

server.on('upgrade', async (req, socket, head) => {
  try {
    if (!isAuthed(req)) return socket.destroy();
    const m = /^\/_ws\/(ws|wss)\/([^\/?#]+)(\/[^?#]*)?(\?.*)?$/.exec(req.url);
    if (!m) return socket.destroy();

    const targetStr = `${m[1]}://${m[2]}${m[3] || '/'}${m[4] || ''}`;
    const target = new URL(targetStr);
    if (!ALLOW_PRIVATE) await assertPublicTarget(target);

    const sid = sidFromReq(req);
    const httpEquiv = new URL(targetStr.replace(/^ws/, 'http'));
    const wsHeaders = { 'User-Agent': USER_AGENT, Origin: httpEquiv.origin };
    const cookie = sid ? store.header(sid, httpEquiv) : '';
    if (cookie) wsHeaders.Cookie = cookie;
    const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);

    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(targetStr, protocols, { headers: wsHeaders, followRedirects: false, handshakeTimeout: 15000 });
      const queue = [];

      client.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else if (queue.length < 200) queue.push([data, isBinary]);
      });
      upstream.on('open', () => {
        for (const [d, b] of queue) upstream.send(d, { binary: b });
        queue.length = 0;
      });
      upstream.on('message', (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      client.on('close', (code, reason) => safeClose(upstream, code, reason));
      upstream.on('close', (code, reason) => safeClose(client, code, reason));
      client.on('error', () => upstream.terminate());
      upstream.on('error', () => safeClose(client, 1011, 'upstream error'));
    });
  } catch (_) {
    socket.destroy();
  }
});

server.requestTimeout = 0; // allow long downloads / streams
server.headersTimeout = 65000;

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Prism proxy listening on port ${PORT}${ACCESS_PASSWORD ? ' (password protected)' : ''}`);
  });
}

module.exports = { app, server };
