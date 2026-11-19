/* Prism browser UI: tabs, address bar, back/forward, bookmarks, settings. Vanilla JS, no build step. */
(function () {
  'use strict';

  /* ---------- tiny helpers ---------- */
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var storage = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var PROXY_RE = /^\/p\/(https?)\/([^\/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/;
  function proxify(url) {
    try {
      var u = new URL(url);
      return '/p/' + u.protocol.slice(0, -1) + '/' + u.host + u.pathname + u.search + u.hash;
    } catch (e) { return null; }
  }
  function unproxify(href) {
    try {
      var u = new URL(href, location.origin);
      if (u.origin !== location.origin) return null;
      var m = PROXY_RE.exec(u.pathname + u.search + u.hash);
      return m ? m[1] + '://' + m[2] + (m[3] || '/') + (m[4] || '') + (m[5] || '') : null;
    } catch (e) { return null; }
  }
  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; } }

  /* ---------- settings ---------- */
  var ENGINES = {
    duckduckgo: { name: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/?q=%s' },
    brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
    bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
    wikipedia: { name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search=%s' }
  };
  var settings = Object.assign({ engine: 'duckduckgo', block: true, theme: 'auto' }, storage.get('px_settings', {}));
  function saveSettings() {
    storage.set('px_settings', settings);
    document.documentElement.setAttribute('data-theme', settings.theme);
    document.cookie = 'px_block=' + (settings.block ? 'on' : 'off') + '; Path=/; Max-Age=31536000; SameSite=Lax';
  }

  /** Turn whatever the user typed into a real URL (or a search). */
  function normalizeInput(text) {
    var t = String(text || '').trim();
    if (!t) return null;
    if (/^https?:\/\//i.test(t)) return t;
    if (/^[\w-]+:\/\//.test(t)) return null; // unsupported scheme
    var looksLikeHost = /^(localhost|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z]{2,})(:\d+)?([\/?#].*)?$/i.test(t);
    if (looksLikeHost && !/\s/.test(t)) return 'https://' + t;
    return ENGINES[settings.engine].url.replace('%s', encodeURIComponent(t));
  }

  /* ---------- tabs ---------- */
  var tabs = [];
  var activeId = null;
  var nextId = 1;
  var MAX_TABS = 15;

  var elStrip = $('#tabstrip'), elViewport = $('#viewport'), elStart = $('#start');
  var elUrl = $('#url'), elSecure = $('#secure'), elStar = $('#btn-star');
  var elBack = $('#btn-back'), elFwd = $('#btn-forward'), elProgress = $('#progress');

  function activeTab() { return tabs.find(function (t) { return t.id === activeId; }) || null; }

  function createTab(url, background) {
    if (tabs.length >= MAX_TABS) { alert('Too many tabs open. Close one first.'); return null; }
    var tab = { id: nextId++, url: '', title: 'New tab', icon: '', history: [], idx: -1, loading: false, pending: false, frame: null };
    tabs.push(tab);
    if (!background) activeId = tab.id;
    if (url) navigate(tab, url);
    renderAll();
    if (!url && !background) setTimeout(function () { $('#start-input').focus(); }, 0);
    return tab;
  }

  function closeTab(id) {
    var i = tabs.findIndex(function (t) { return t.id === id; });
    if (i < 0) return;
    var tab = tabs[i];
    if (tab.frame) { tab.frame.src = 'about:blank'; tab.frame.remove(); }
    tabs.splice(i, 1);
    if (!tabs.length) { createTab(); return; }
    if (activeId === id) activeId = tabs[Math.min(i, tabs.length - 1)].id;
    renderAll();
  }

  function activateTab(id) { activeId = id; renderAll(); }

  function ensureFrame(tab) {
    if (tab.frame) return tab.frame;
    var f = document.createElement('iframe');
    f.className = 'view';
    f.setAttribute('allow', 'autoplay; fullscreen; clipboard-write; encrypted-media; picture-in-picture; web-share');
    f.setAttribute('allowfullscreen', '');
    f.addEventListener('load', function () {
      tab.loading = false;
      tab.pending = false;
      syncFromFrame(tab);
      renderAll();
    });
    elViewport.appendChild(f);
    tab.frame = f;
    return f;
  }

  /** Navigate a tab to a real URL. opts.fromHistory = moving within the existing history stack. */
  function navigate(tab, url, opts) {
    opts = opts || {};
    var p = proxify(url);
    if (!p) return;
    if (!opts.fromHistory) {
      tab.history = tab.history.slice(0, tab.idx + 1);
      tab.history.push(url);
      tab.idx = tab.history.length - 1;
    }
    tab.url = url;
    tab.title = hostOf(url);
    tab.icon = '';
    tab.loading = true;
    tab.pending = true;
    var f = ensureFrame(tab);
    try { f.contentWindow.location.replace(p); } catch (e) { f.src = p; }
    renderAll();
  }

  /** Called whenever the page in a tab reports (or we read) its real URL. */
  function handleLocation(tab, url, title, icon) {
    if (url) {
      if (tab.pending) {
        // first report after we navigated: server redirects may have changed the URL — replace, don't push
        if (tab.idx >= 0) tab.history[tab.idx] = url;
        tab.pending = false;
      } else if (tab.history[tab.idx] !== url) {
        tab.history = tab.history.slice(0, tab.idx + 1);
        tab.history.push(url);
        tab.idx = tab.history.length - 1;
      }
      tab.url = url;
    }
    if (title !== undefined && title !== null) tab.title = title || hostOf(tab.url);
    if (icon) tab.icon = icon;
  }

  function syncFromFrame(tab) {
    try {
      var win = tab.frame.contentWindow;
      var real = unproxify(win.location.href);
      if (!real) return;
      var title = '';
      try { title = win.document.title; } catch (e) { /* ignore */ }
      handleLocation(tab, real, title, null);
    } catch (e) { /* cross-origin or not ready */ }
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'px-nav') {
      var tab = tabs.find(function (t) { return t.frame && t.frame.contentWindow === e.source; });
      if (!tab || typeof d.url !== 'string') return;
      handleLocation(tab, d.url, d.title, d.icon);
      renderAll();
    } else if (d.type === 'px-open' && typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) {
      createTab(d.url);
    }
  });

  function goBack() {
    var t = activeTab();
    if (t && t.idx > 0) { t.idx--; navigate(t, t.history[t.idx], { fromHistory: true }); }
  }
  function goForward() {
    var t = activeTab();
    if (t && t.idx < t.history.length - 1) { t.idx++; navigate(t, t.history[t.idx], { fromHistory: true }); }
  }
  function reload() {
    var t = activeTab();
    if (!t || !t.frame || !t.url) return;
    t.loading = true;
    try { t.frame.contentWindow.location.reload(); } catch (e) { navigate(t, t.url, { fromHistory: true }); }
    renderAll();
  }
  function goHome() {
    var t = activeTab();
    if (!t) return;
    if (t.frame) { t.frame.remove(); t.frame = null; }
    t.url = ''; t.title = 'New tab'; t.icon = ''; t.history = []; t.idx = -1; t.loading = false;
    renderAll();
    $('#start-input').focus();
  }

  /* ---------- bookmarks ---------- */
  var bookmarks = storage.get('px_bookmarks', null);
  if (!bookmarks) {
    bookmarks = [
      { title: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/' },
      { title: 'Wikipedia', url: 'https://en.wikipedia.org/' },
      { title: 'Hacker News', url: 'https://news.ycombinator.com/' },
      { title: 'Brave Search', url: 'https://search.brave.com/' }
    ];
    storage.set('px_bookmarks', bookmarks);
  }
  function saveBookmarks() { storage.set('px_bookmarks', bookmarks); }
  function isBookmarked(url) { return bookmarks.some(function (b) { return b.url === url; }); }

  function toggleBookmark() {
    var t = activeTab();
    if (!t || !t.url) return;
    var i = bookmarks.findIndex(function (b) { return b.url === t.url; });
    if (i >= 0) bookmarks.splice(i, 1);
    else bookmarks.push({ title: (t.title && t.title !== 'New tab' ? t.title : hostOf(t.url)).slice(0, 60), url: t.url });
    saveBookmarks();
    renderAll();
  }

  function openBookmark(b, newTab) {
    var t = activeTab();
    if (newTab || !t) createTab(b.url);
    else navigate(t, b.url);
  }

  /* ---------- rendering ---------- */
  function renderTabs() {
    elStrip.innerHTML = '';
    tabs.forEach(function (t) {
      var el = document.createElement('div');
      el.className = 'tab' + (t.id === activeId ? ' active' : '') + (t.loading ? ' loading' : '');
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', t.id === activeId ? 'true' : 'false');
      el.title = t.title || '';
      el.innerHTML =
        (t.icon ? '<img class="fav" alt="" referrerpolicy="no-referrer">' : '<span class="fav ph"></span>') +
        '<span class="title">' + esc(t.title || 'New tab') + '</span>' +
        '<button class="close" aria-label="Close tab"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
      var img = $('img.fav', el);
      if (img) {
        img.src = t.icon;
        img.addEventListener('error', function () { var ph = document.createElement('span'); ph.className = 'fav ph'; img.replaceWith(ph); });
      }
      el.addEventListener('mousedown', function (ev) {
        if (ev.button === 1) { ev.preventDefault(); closeTab(t.id); }
      });
      el.addEventListener('click', function (ev) {
        if (ev.target.closest('.close')) closeTab(t.id); else activateTab(t.id);
      });
      elStrip.appendChild(el);
    });
    var add = document.createElement('button');
    add.id = 'new-tab';
    add.title = 'New tab';
    add.setAttribute('aria-label', 'New tab');
    add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
    add.addEventListener('click', function () { createTab(); });
    elStrip.appendChild(add);
  }

  function renderViewport() {
    var t = activeTab();
    tabs.forEach(function (x) { if (x.frame) x.frame.hidden = x !== t; });
    elStart.hidden = !!(t && t.url);
  }

  function renderToolbar() {
    var t = activeTab();
    elBack.disabled = !(t && t.idx > 0);
    elFwd.disabled = !(t && t.idx < t.history.length - 1);
    if (document.activeElement !== elUrl) elUrl.value = t && t.url ? t.url : '';
    elSecure.className = 'secure' + (t && t.url ? (/^https:/i.test(t.url) ? ' https' : ' http') : '');
    var on = !!(t && t.url && isBookmarked(t.url));
    elStar.classList.toggle('on', on);
    elStar.disabled = !(t && t.url);
    elProgress.hidden = !(t && t.loading);
    document.title = t && t.url && t.title ? t.title + ' — Prism' : 'Prism';
  }

  function renderBookmarks() {
    var bar = $('#bookmarks');
    bar.innerHTML = '';
    bookmarks.forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'bm';
      btn.title = b.title + '\n' + b.url + '\n(Right-click to remove)';
      btn.innerHTML = '<span class="dot">' + esc((b.title || '?').charAt(0).toUpperCase()) + '</span><span class="t">' + esc(b.title) + '</span>';
      btn.addEventListener('click', function (ev) { openBookmark(b, ev.ctrlKey || ev.metaKey); });
      btn.addEventListener('auxclick', function (ev) { if (ev.button === 1) openBookmark(b, true); });
      btn.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        if (confirm('Remove bookmark "' + b.title + '"?')) {
          bookmarks = bookmarks.filter(function (x) { return x !== b; });
          saveBookmarks();
          renderAll();
        }
      });
      bar.appendChild(btn);
    });
    var tiles = $('#tiles');
    tiles.innerHTML = '';
    bookmarks.slice(0, 12).forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'tile';
      btn.innerHTML = '<span class="ico">' + esc((b.title || '?').charAt(0).toUpperCase()) + '</span><span class="n">' + esc(b.title) + '</span>';
      btn.addEventListener('click', function () { openBookmark(b, false); });
      tiles.appendChild(btn);
    });
  }

  function renderAll() {
    renderTabs();
    renderViewport();
    renderToolbar();
    renderBookmarks();
  }

  /* ---------- events ---------- */
  function submitAddress(text) {
    var url = normalizeInput(text);
    if (!url) return;
    var t = activeTab() || createTab();
    navigate(t, url);
    elUrl.blur();
  }

  $('#omnibox').addEventListener('submit', function (e) { e.preventDefault(); submitAddress(elUrl.value); });
  $('#start-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('#start-input').value;
    $('#start-input').value = '';
    submitAddress(v);
  });
  elUrl.addEventListener('focus', function () { setTimeout(function () { elUrl.select(); }, 0); });
  elUrl.addEventListener('blur', function () { renderToolbar(); });

  elBack.addEventListener('click', goBack);
  elFwd.addEventListener('click', goForward);
  $('#btn-reload').addEventListener('click', reload);
  $('#btn-home').addEventListener('click', goHome);
  elStar.addEventListener('click', toggleBookmark);

  // settings menu
  var elMenu = $('#menu');
  var elEngine = $('#set-engine');
  Object.keys(ENGINES).forEach(function (k) {
    var o = document.createElement('option');
    o.value = k; o.textContent = ENGINES[k].name;
    elEngine.appendChild(o);
  });
  elEngine.value = settings.engine;
  $('#set-theme').value = settings.theme;
  $('#set-block').checked = !!settings.block;

  $('#btn-menu').addEventListener('click', function (e) { e.stopPropagation(); elMenu.hidden = !elMenu.hidden; });
  document.addEventListener('click', function (e) { if (!elMenu.hidden && !e.target.closest('.menu-wrap')) elMenu.hidden = true; });
  window.addEventListener('blur', function () { /* clicking into the page iframe blurs the window */ setTimeout(function () { elMenu.hidden = true; }, 0); });
  elEngine.addEventListener('change', function () { settings.engine = elEngine.value; saveSettings(); });
  $('#set-theme').addEventListener('change', function (e) { settings.theme = e.target.value; saveSettings(); });
  $('#set-block').addEventListener('change', function (e) { settings.block = e.target.checked; saveSettings(); reload(); });
  $('#btn-clear').addEventListener('click', function () {
    if (!confirm('Delete all bookmarks and saved site cookies?')) return;
    storage.del('px_bookmarks');
    bookmarks = [];
    fetch('/_/clear', { method: 'POST' }).catch(function () {});
    elMenu.hidden = true;
    renderAll();
  });

  // keyboard shortcuts that Chromebooks don't reserve for ChromeOS
  document.addEventListener('keydown', function (e) {
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
    else if (e.key === 'Escape') elMenu.hidden = true;
  });

  /* ---------- boot ---------- */
  saveSettings();
  var params = new URLSearchParams(location.search);
  var initial = params.get('url');
  createTab(initial && /^https?:\/\//i.test(initial) ? initial : null);
})();
