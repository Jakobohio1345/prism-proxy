'use strict';

/**
 * Server-side cookie jar. Every site is served from the proxy's own origin, so the browser
 * cannot keep per-site cookies; instead cookies set by upstream sites are stored here,
 * per proxy session, and replayed on later upstream requests.
 */
const MAX_SESSIONS = 2000;
const MAX_COOKIES_PER_SESSION = 3000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

class CookieStore {
  constructor() {
    this.sessions = new Map();
    const timer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  _jar(sid, create = true) {
    let j = this.sessions.get(sid);
    if (!j) {
      if (!create) return null;
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        this.sessions.delete(oldest);
      }
      j = { cookies: new Map(), last: Date.now() };
      this.sessions.set(sid, j);
    }
    j.last = Date.now();
    return j;
  }

  cleanup() {
    const now = Date.now();
    for (const [sid, j] of this.sessions) if (now - j.last > SESSION_TTL_MS) this.sessions.delete(sid);
  }

  clear(sid) {
    this.sessions.delete(sid);
  }

  /** Store one Set-Cookie style string received for `url` (a URL object). */
  set(sid, url, str, fromScript = false) {
    const parts = String(str).split(';');
    const nv = parts.shift();
    const eq = nv.indexOf('=');
    if (eq < 0) return;
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();
    if (!name) return;

    const host = url.hostname.toLowerCase();
    let domain = host;
    let hostOnly = true;
    let path = url.pathname.replace(/[^/]*$/, '') || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    let expires = null;
    let secure = false;
    let httpOnly = false;

    for (const raw of parts) {
      const i = raw.indexOf('=');
      const k = (i < 0 ? raw : raw.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? '' : raw.slice(i + 1).trim();
      if (k === 'domain' && v) {
        const d = v.replace(/^\./, '').toLowerCase();
        if (host === d || host.endsWith('.' + d)) {
          domain = d;
          hostOnly = false;
        } else {
          return; // cookie for a foreign domain: reject
        }
      } else if (k === 'path' && v.startsWith('/')) {
        path = v.length > 1 && v.endsWith('/') ? v.slice(0, -1) : v;
      } else if (k === 'max-age') {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) expires = Date.now() + n * 1000;
      } else if (k === 'expires' && expires === null) {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) expires = t;
      } else if (k === 'secure') secure = true;
      else if (k === 'httponly') httpOnly = true;
    }

    const jar = this._jar(sid);
    const key = `${domain}|${path}|${name}`;
    if (expires !== null && expires <= Date.now()) {
      jar.cookies.delete(key);
      return;
    }
    if (fromScript) {
      const existing = jar.cookies.get(key);
      if (existing && existing.httpOnly) return; // scripts may not overwrite HttpOnly cookies
      httpOnly = false;
    }
    if (jar.cookies.size >= MAX_COOKIES_PER_SESSION && !jar.cookies.has(key)) {
      jar.cookies.delete(jar.cookies.keys().next().value);
    }
    jar.cookies.set(key, { name, value, domain, hostOnly, path, expires, secure, httpOnly });
  }

  /** Build a Cookie header value for `url`. scriptOnly=true hides HttpOnly cookies. */
  header(sid, url, { scriptOnly = false } = {}) {
    const jar = this._jar(sid, false);
    if (!jar) return '';
    const host = url.hostname.toLowerCase();
    const reqPath = url.pathname || '/';
    const https = url.protocol === 'https:';
    const now = Date.now();
    const matched = [];
    for (const [key, c] of jar.cookies) {
      if (c.expires !== null && c.expires <= now) {
        jar.cookies.delete(key);
        continue;
      }
      if (c.secure && !https) continue;
      if (scriptOnly && c.httpOnly) continue;
      const domainOk = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain);
      if (!domainOk) continue;
      const pathOk = c.path === '/' || reqPath === c.path || reqPath.startsWith(c.path + '/');
      if (!pathOk) continue;
      matched.push(c);
    }
    matched.sort((a, b) => b.path.length - a.path.length);
    return matched.map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

module.exports = { CookieStore, parseCookieHeader };
