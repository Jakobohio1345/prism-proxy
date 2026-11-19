'use strict';

/**
 * Proxied URL format (keeps relative URLs working naturally):
 *   /p/<scheme>/<host[:port]>/<path>?<query>
 *   e.g.  https://example.com/a/b?x=1  ->  /p/https/example.com/a/b?x=1
 */
const PROXY_RE = /^\/p\/(https?)\/([^\/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/;

/** Convert an absolute http(s) URL into its proxied path. */
function toProxyPath(abs) {
  const u = new URL(abs);
  return '/p/' + u.protocol.slice(0, -1) + '/' + u.host + u.pathname + u.search + u.hash;
}

/** Parse a proxied path (req.originalUrl) back into the real absolute URL, or null. */
function fromProxyPath(pathAndQuery) {
  const m = PROXY_RE.exec(pathAndQuery);
  if (!m) return null;
  return m[1] + '://' + m[2] + (m[3] || '/') + (m[4] || '') + (m[5] || '');
}

/** Given a full Referer header value, return the real URL it points to (if it is a proxied page). */
function realUrlFromReferer(referer) {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    return fromProxyPath(u.pathname + u.search + u.hash);
  } catch (_) {
    return null;
  }
}

const SKIP_SCHEMES = /^(data|javascript|mailto|tel|blob|about|sms|file|ftp|chrome|chrome-extension|android-app|ios-app):/i;

function decodeEntities(s) {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'");
}

/** Rewrite one URL value found in HTML/CSS, resolving it against `base` (a real absolute URL). */
function rewriteUrl(value, base) {
  if (value == null) return value;
  const raw = decodeEntities(String(value)).trim();
  if (!raw || raw.charAt(0) === '#' || SKIP_SCHEMES.test(raw)) return value;
  try {
    const abs = new URL(raw, base);
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return value;
    return toProxyPath(abs.href);
  } catch (_) {
    return value;
  }
}

module.exports = { PROXY_RE, toProxyPath, fromProxyPath, realUrlFromReferer, rewriteUrl, decodeEntities };
