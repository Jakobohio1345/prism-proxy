'use strict';

const { rewriteUrl, decodeEntities } = require('./urls');

/* ----------------------------------------------------------------------------
 * CSS
 * ------------------------------------------------------------------------- */
function rewriteCss(css, base) {
  return css
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import ${q}${rewriteUrl(u, base)}${q}`)
    .replace(/url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi, (m, q, u) => `url(${q}${rewriteUrl(u, base)}${q})`);
}

/* ----------------------------------------------------------------------------
 * HTML
 * ------------------------------------------------------------------------- */
// attribute list that tolerates ">" inside quoted values
const ATTRS = `(?:"[^"]*"|'[^']*'|[^'">])*`;

const TOKEN_RE = new RegExp(
  '<!--[\\s\\S]*?-->' +
    `|(<script\\b${ATTRS}>)([\\s\\S]*?)(</script\\s*>)` +
    `|(<style\\b${ATTRS}>)([\\s\\S]*?)(</style\\s*>)` +
    `|<([a-zA-Z][a-zA-Z0-9:-]*)(${ATTRS})>`,
  'gi'
);

const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const URL_ATTRS = {
  a: ['href'], area: ['href'], link: ['href'], base: ['href'],
  script: ['src'], img: ['src'], iframe: ['src'], frame: ['src'], embed: ['src'],
  source: ['src'], track: ['src'], video: ['src', 'poster'], audio: ['src'],
  input: ['src', 'formaction'], button: ['formaction'], form: ['action'],
  object: ['data'], image: ['href', 'xlink:href'], use: ['href', 'xlink:href'],
};
const GENERIC_URL_ATTRS = ['data-src', 'data-href', 'data-original', 'data-lazy-src'];
const SRCSET_ATTRS = ['srcset', 'imagesrcset', 'data-srcset'];
const DROP_ATTRS = ['integrity', 'nonce', 'crossorigin', 'ping'];

function rewriteSrcset(value, base) {
  return decodeEntities(value)
    .split(/,\s+/)
    .map((part) => {
      const t = part.trim();
      if (!t) return '';
      const i = t.search(/\s/);
      if (i === -1) return rewriteUrl(t, base);
      return rewriteUrl(t.slice(0, i), base) + t.slice(i);
    })
    .filter(Boolean)
    .join(', ');
}

function escAttr(v) {
  return String(v).replace(/"/g, '&quot;');
}

/**
 * Rewrite a single opening tag. Returns the new tag string, or '' to drop it.
 * `state.base` is updated when a <base href> is seen.
 */
function rewriteTag(name, attrString, state) {
  const tag = name.toLowerCase();
  const attrs = [];
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrString))) {
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    attrs.push({ name: m[1], lname: m[1].toLowerCase(), value });
  }
  const get = (n) => {
    const a = attrs.find((x) => x.lname === n);
    return a ? (a.value || '') : '';
  };

  // Tags we remove entirely
  if (tag === 'meta') {
    const he = get('http-equiv').toLowerCase();
    if (he === 'content-security-policy' || he === 'content-security-policy-report-only') return '';
    if (get('name').toLowerCase() === 'referrer') return '';
  }
  if (tag === 'link') {
    const rel = get('rel').toLowerCase();
    if (/\b(preconnect|dns-prefetch)\b/.test(rel)) return '';
  }

  const urlAttrs = (URL_ATTRS[tag] || []).concat(GENERIC_URL_ATTRS);
  const out = [];

  for (const a of attrs) {
    const { lname, value } = a;
    if (DROP_ATTRS.includes(lname)) continue;

    if (value === undefined) {
      out.push(a.name);
      continue;
    }

    let nv = value;
    if (urlAttrs.includes(lname)) {
      if (tag === 'base' && lname === 'href') {
        try { state.base = new URL(decodeEntities(value), state.base).href; } catch (_) { /* ignore */ }
      }
      // For <base>, state.base is already the resolved absolute URL.
      nv = tag === 'base' ? rewriteUrl(state.base, state.base) : rewriteUrl(value, state.base);
    } else if (SRCSET_ATTRS.includes(lname)) {
      nv = rewriteSrcset(value, state.base);
    } else if (lname === 'style') {
      nv = rewriteCss(decodeEntities(value), state.base);
    } else if (tag === 'meta' && lname === 'content' && get('http-equiv').toLowerCase() === 'refresh') {
      nv = value.replace(/^(\s*[\d.]+\s*;\s*url\s*=\s*)(['"]?)(.*?)\2\s*$/i, (mm, pre, q, u) => pre + rewriteUrl(u, state.base));
    }
    out.push(`${a.name}="${escAttr(nv)}"`);
  }

  const selfClose = /\/\s*$/.test(attrString) && !/=\s*[^\s"'=<>`]*\/\s*$/.test(attrString) ? ' /' : '';
  return `<${name}${out.length ? ' ' + out.join(' ') : ''}${selfClose}>`;
}

function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Rewrite an HTML document.
 * @param {string} html
 * @param {string} baseUrl  real absolute URL of the page
 * @param {{cookies?: string}} opts
 */
function rewriteHtml(html, baseUrl, opts = {}) {
  const state = { base: baseUrl };

  const body = html.replace(TOKEN_RE, (match, sOpen, sBody, sClose, stOpen, stBody, stClose, tagName, tagAttrs) => {
    if (sOpen !== undefined) {
      const open = sOpen.slice(7, -1); // strip "<script" and ">"
      return rewriteTag('script', open, state) + sBody + sClose;
    }
    if (stOpen !== undefined) {
      const open = stOpen.slice(6, -1);
      return rewriteTag('style', open, state) + rewriteCss(stBody, state.base) + stClose;
    }
    if (tagName !== undefined) {
      return rewriteTag(tagName, tagAttrs, state);
    }
    return match; // comments
  });

  const injection =
    `<script>window.__PX_BASE=${safeJson(baseUrl)};window.__PX_COOKIES=${safeJson(opts.cookies || '')};</script>` +
    `<script src="/_/inject.js"></script>`;

  if (/<head[^>]*>/i.test(body)) return body.replace(/<head[^>]*>/i, (m) => m + injection);
  if (/<html[^>]*>/i.test(body)) return body.replace(/<html[^>]*>/i, (m) => m + '<head>' + injection + '</head>');
  return injection + body;
}

module.exports = { rewriteHtml, rewriteCss, rewriteSrcset };
