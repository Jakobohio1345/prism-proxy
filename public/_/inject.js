/* Prism client runtime — injected into every proxied HTML page.
 * Server-side rewriting handles static markup; this script catches everything created at runtime
 * (fetch, XHR, WebSocket, dynamically-created elements, history, cookies, new-tab links). */
(function () {
  'use strict';
  if (window.__pxInjected) return;
  window.__pxInjected = true;

  var LOC_ORIGIN = location.origin;
  var PROXY_RE = /^\/p\/(https?)\/([^\/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/;
  var ALREADY_RE = /^(?:https?:\/\/[^\/]+)?\/p\/https?\//i;
  var SKIP_RE = /^(data|javascript|mailto|tel|blob|about|sms):/i;
  var isMainFrame = window.parent === window.top && window !== window.top;

  /* ---------- URL helpers ---------- */
  function decodeProxy(href) {
    try {
      var u = new URL(href, LOC_ORIGIN);
      if (u.origin !== LOC_ORIGIN) return null;
      var m = PROXY_RE.exec(u.pathname + u.search + u.hash);
      if (!m) return null;
      return m[1] + '://' + m[2] + (m[3] || '/') + (m[4] || '') + (m[5] || '');
    } catch (e) { return null; }
  }

  function realBase() {
    return decodeProxy(document.baseURI) || decodeProxy(location.href) || window.__PX_BASE;
  }

  function toProxy(u, base) {
    try {
      if (u === null || u === undefined) return u;
      var s = typeof u === 'string' ? u : (u.href !== undefined ? u.href : String(u));
      var t = s.trim();
      if (!t || t.charAt(0) === '#' || SKIP_RE.test(t)) return u;
      if (ALREADY_RE.test(t)) return s;
      var abs = new URL(t, base || realBase());
      if (abs.origin === LOC_ORIGIN) {
        // The browser already resolved a root-relative URL against the proxy's origin;
        // re-anchor it on the real site.
        abs = new URL(abs.pathname + abs.search + abs.hash, new URL(realBase()).origin);
      }
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return u;
      return '/p/' + abs.protocol.slice(0, -1) + '/' + abs.host + abs.pathname + abs.search + abs.hash;
    } catch (e) { return u; }
  }

  /* ---------- fetch / XHR / beacon / EventSource / Worker ---------- */
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          var nu = toProxy(input.url);
          if (nu !== input.url) input = new Request(nu, input);
        } else {
          input = toProxy(input);
        }
      } catch (e) { /* fall through */ }
      return nativeFetch.call(this, input, init);
    };
  }

  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    try { args[1] = toProxy(url); } catch (e) { /* ignore */ }
    return xhrOpen.apply(this, args);
  };

  if (navigator.sendBeacon) {
    var nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) { return nativeBeacon(toProxy(url), data); };
  }

  if (window.EventSource) {
    var NativeES = window.EventSource;
    var PXES = function (url, cfg) { return new NativeES(toProxy(url), cfg); };
    PXES.prototype = NativeES.prototype;
    window.EventSource = PXES;
  }

  if (window.Worker) {
    var NativeWorker = window.Worker;
    var PXWorker = function (url, opts) { return new NativeWorker(toProxy(url), opts); };
    PXWorker.prototype = NativeWorker.prototype;
    window.Worker = PXWorker;
  }

  /* Service workers could escape the proxy: block registration. */
  if (window.ServiceWorkerContainer) {
    ServiceWorkerContainer.prototype.register = function () {
      return Promise.reject(new DOMException('Service workers are disabled in Prism.', 'SecurityError'));
    };
  }

  /* ---------- WebSocket ---------- */
  var NativeWS = window.WebSocket;
  function PXWebSocket(url, protocols) {
    var abs;
    try { abs = new URL(String(url), realBase()); } catch (e) { return new NativeWS(url, protocols); }
    var secure = abs.protocol === 'wss:' || abs.protocol === 'https:';
    var wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
      '/_ws/' + (secure ? 'wss' : 'ws') + '/' + abs.host + abs.pathname + abs.search;
    return protocols === undefined ? new NativeWS(wsUrl) : new NativeWS(wsUrl, protocols);
  }
  PXWebSocket.prototype = NativeWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { PXWebSocket[k] = NativeWS[k]; });
  window.WebSocket = PXWebSocket;

  /* ---------- Element URL properties & setAttribute ---------- */
  function patchProp(ctor, prop) {
    if (typeof ctor === 'undefined' || !ctor.prototype) return;
    var d = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
    if (!d || !d.set) return;
    Object.defineProperty(ctor.prototype, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set: function (v) { d.set.call(this, toProxy(v)); }
    });
  }
  [
    [window.HTMLAnchorElement, 'href'], [window.HTMLAreaElement, 'href'], [window.HTMLLinkElement, 'href'],
    [window.HTMLBaseElement, 'href'], [window.HTMLImageElement, 'src'], [window.HTMLScriptElement, 'src'],
    [window.HTMLIFrameElement, 'src'], [window.HTMLEmbedElement, 'src'], [window.HTMLSourceElement, 'src'],
    [window.HTMLTrackElement, 'src'], [window.HTMLMediaElement, 'src'], [window.HTMLInputElement, 'src'],
    [window.HTMLFormElement, 'action'], [window.HTMLObjectElement, 'data'], [window.HTMLVideoElement, 'poster']
  ].forEach(function (p) { patchProp(p[0], p[1]); });

  var URL_ATTRS = { href: 1, src: 1, action: 1, poster: 1, formaction: 1, data: 1 };
  var nativeSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    try {
      var n = String(name).toLowerCase();
      if (URL_ATTRS[n] && (n !== 'data' || this.tagName === 'OBJECT')) value = toProxy(value);
    } catch (e) { /* ignore */ }
    return nativeSetAttr.call(this, name, value);
  };

  /* Elements inserted via innerHTML etc. */
  var FIX_ATTRS = ['src', 'href', 'action', 'poster'];
  function fixEl(el) {
    if (!el || el.nodeType !== 1) return;
    for (var i = 0; i < FIX_ATTRS.length; i++) {
      var a = FIX_ATTRS[i];
      if (el.hasAttribute && el.hasAttribute(a)) {
        var v = el.getAttribute(a);
        var nv = toProxy(v);
        if (nv !== v) nativeSetAttr.call(el, a, nv);
      }
    }
  }
  try {
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        if (r.type === 'attributes') { fixEl(r.target); return; }
        r.addedNodes.forEach(function (n) {
          fixEl(n);
          if (n.querySelectorAll) n.querySelectorAll('[src],[href],[action],[poster]').forEach(fixEl);
        });
      });
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: FIX_ATTRS });
  } catch (e) { /* ignore */ }

  /* ---------- history API ---------- */
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function (state, title, url) {
      if (url !== undefined && url !== null && url !== '') { try { url = toProxy(url); } catch (e) { /* ignore */ } }
      var r = orig.call(this, state, title, url);
      notify();
      return r;
    };
  });

  /* ---------- document.cookie (server keeps the real jar) ---------- */
  var cookieMap = {};
  (function seed() {
    String(window.__PX_COOKIES || '').split(';').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) cookieMap[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
  })();
  try {
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      get: function () {
        return Object.keys(cookieMap).map(function (k) { return k + '=' + cookieMap[k]; }).join('; ');
      },
      set: function (v) {
        var s = String(v);
        var first = s.split(';')[0];
        var i = first.indexOf('=');
        var name = i < 0 ? '' : first.slice(0, i).trim();
        var val = i < 0 ? first.trim() : first.slice(i + 1).trim();
        var expired = false;
        var ma = /max-age\s*=\s*(-?\d+)/i.exec(s);
        var ex = /expires\s*=\s*([^;]+)/i.exec(s);
        if (ma && parseInt(ma[1], 10) <= 0) expired = true;
        else if (!ma && ex && Date.parse(ex[1]) <= Date.now()) expired = true;
        if (expired) delete cookieMap[name]; else cookieMap[name] = val;
        try {
          nativeFetch.call(window, '/_/cookie?u=' + encodeURIComponent(realBase()), {
            method: 'POST', body: s, headers: { 'Content-Type': 'text/plain' }, keepalive: true
          }).catch(function () {});
        } catch (e) { /* ignore */ }
      }
    });
  } catch (e) { /* ignore */ }

  /* ---------- window.open & target=_blank -> new Prism tab ---------- */
  function openInNewTab(url) {
    try { window.top.postMessage({ type: 'px-open', url: url }, '*'); } catch (e) { /* ignore */ }
  }
  window.open = function (url) {
    if (navigator.userActivation && !navigator.userActivation.isActive) return null;
    if (!url) return null;
    var abs;
    try { abs = new URL(String(url), realBase()).href; } catch (e) { return null; }
    openInNewTab(abs);
    return null;
  };
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    var a = e.target && e.target.closest ? e.target.closest('a[target]') : null;
    if (!a) return;
    var t = (a.getAttribute('target') || '').toLowerCase();
    if (t !== '_blank' && t !== '_new') return;
    var real = decodeProxy(a.href);
    if (!real) return;
    e.preventDefault();
    openInNewTab(real);
  }, true);

  /* ---------- Navigation API: catch location.href = "https://…" and absolute links ---------- */
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigate', function (e) {
      try {
        if (!e.cancelable) return;
        var u = new URL(e.destination.url);
        if (u.origin === LOC_ORIGIN) return;
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
        e.preventDefault();
        var p = toProxy(u.href);
        if (e.navigationType === 'replace') location.replace(p); else location.assign(p);
      } catch (err) { /* ignore */ }
    });
  }

  /* ---------- Tell the Prism UI where we are ---------- */
  var lastKey = '';
  function notify() {
    if (!isMainFrame) return;
    try {
      var real = decodeProxy(location.href) || window.__PX_BASE;
      var link = document.querySelector('link[rel~="icon"],link[rel="shortcut icon"]');
      var icon = link ? toProxy(link.getAttribute('href')) : toProxy('/favicon.ico');
      var title = document.title || '';
      lastKey = real + '\n' + title;
      window.parent.postMessage({ type: 'px-nav', url: real, title: title, icon: icon }, '*');
    } catch (e) { /* ignore */ }
  }
  document.addEventListener('DOMContentLoaded', notify);
  window.addEventListener('load', notify);
  window.addEventListener('popstate', notify);
  window.addEventListener('hashchange', notify);
  setInterval(function () {
    var real = decodeProxy(location.href) || '';
    if (real + '\n' + (document.title || '') !== lastKey) notify();
  }, 800);
  notify();
})();
