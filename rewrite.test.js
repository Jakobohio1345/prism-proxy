'use strict';
/* Zero-dependency tests for the rewriting, cookie and SSRF logic.  Run with: npm test */
const assert = require('assert');
const { rewriteHtml, rewriteCss } = require('../lib/rewrite');
const { fromProxyPath, toProxyPath, rewriteUrl } = require('../lib/urls');
const { CookieStore } = require('../lib/cookies');
const { isPrivateIp } = require('../lib/security');
const { isBlocked } = require('../lib/blocklist');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}

const BASE = 'https://example.com/dir/page.html?x=1';

test('proxy path round trip', () => {
  const p = toProxyPath('https://a.com:8443/x/y?q=1#h');
  assert.strictEqual(p, '/p/https/a.com:8443/x/y?q=1#h');
  assert.strictEqual(fromProxyPath(p), 'https://a.com:8443/x/y?q=1#h');
  assert.strictEqual(fromProxyPath('/p/http/a.com'), 'http://a.com/');
  assert.strictEqual(fromProxyPath('/nope'), null);
});

test('rewriteUrl handles relative, root-relative, protocol-relative, absolute', () => {
  assert.strictEqual(rewriteUrl('img.png', BASE), '/p/https/example.com/dir/img.png');
  assert.strictEqual(rewriteUrl('/a/b', BASE), '/p/https/example.com/a/b');
  assert.strictEqual(rewriteUrl('//cdn.x.com/a.js', BASE), '/p/https/cdn.x.com/a.js');
  assert.strictEqual(rewriteUrl('http://o.org/?a=1&amp;b=2', BASE), '/p/http/o.org/?a=1&b=2');
  assert.strictEqual(rewriteUrl('#top', BASE), '#top');
  assert.strictEqual(rewriteUrl('mailto:a@b.c', BASE), 'mailto:a@b.c');
  assert.strictEqual(rewriteUrl('data:image/png;base64,AAAA', BASE), 'data:image/png;base64,AAAA');
});

test('HTML: attributes rewritten, injection present, integrity removed', () => {
  const out = rewriteHtml(
    '<!doctype html><html><head><title>t</title><link rel="stylesheet" href="s.css" integrity="sha256-x" crossorigin="anonymous"></head>' +
    '<body><a href="/go" target="_blank">x</a><img src="//i.com/a.png" srcset="a.png 1x, b.png 2x"><form action="search"><input name=q></form></body></html>',
    BASE, { cookies: 'a=b' });
  assert.ok(out.includes('href="/p/https/example.com/dir/s.css"'));
  assert.ok(!out.includes('integrity'));
  assert.ok(!out.includes('crossorigin'));
  assert.ok(out.includes('href="/p/https/example.com/go"'));
  assert.ok(out.includes('src="/p/https/i.com/a.png"'));
  assert.ok(out.includes('srcset="/p/https/example.com/dir/a.png 1x, /p/https/example.com/dir/b.png 2x"'));
  assert.ok(out.includes('action="/p/https/example.com/dir/search"'));
  assert.ok(out.includes('<script src="/_/inject.js"></script>'));
  assert.ok(out.includes('window.__PX_BASE="https://example.com/dir/page.html?x=1"'));
  assert.ok(out.indexOf('__PX_BASE') < out.indexOf('<title>'));
});

test('HTML: inline <script> bodies are never touched', () => {
  const js = `var t='<a href="'+u+'">x</a>';`;
  const out = rewriteHtml(`<html><head></head><body><script>${js}</script></body></html>`, BASE);
  assert.ok(out.includes(`<script>${js}</script>`));
});

test('HTML: CSP meta and referrer meta are removed, meta refresh rewritten', () => {
  const out = rewriteHtml(
    '<html><head><meta http-equiv="Content-Security-Policy" content="default-src none"><meta name="referrer" content="no-referrer">' +
    '<meta http-equiv="refresh" content="0; url=/next"></head></html>', BASE);
  assert.ok(!/content-security-policy/i.test(out.replace(/<script>[\s\S]*?<\/script>/, '')));
  assert.ok(!out.includes('no-referrer'));
  assert.ok(out.includes('url=/p/https/example.com/next'));
});

test('HTML: <base href> changes how later URLs resolve', () => {
  const out = rewriteHtml('<html><head><base href="https://cdn.io/lib/"></head><body><img src="a.png"></body></html>', BASE);
  assert.ok(out.includes('src="/p/https/cdn.io/lib/a.png"'));
  assert.ok(out.includes('<base href="/p/https/cdn.io/lib/">'));
});

test('HTML: quoted ">" inside attribute does not break parsing', () => {
  const out = rewriteHtml('<html><head></head><body><a title="a>b" href="x">l</a></body></html>', BASE);
  assert.ok(out.includes('title="a>b"'));
  assert.ok(out.includes('href="/p/https/example.com/dir/x"'));
});

test('HTML: style attr and <style> block url() rewritten', () => {
  const out = rewriteHtml('<html><head><style>body{background:url(bg.png)}@import "x.css";</style></head><body><div style="background:url(\'/i.png\')"></div></body></html>', BASE);
  assert.ok(out.includes('url(/p/https/example.com/dir/bg.png)'));
  assert.ok(out.includes('@import "/p/https/example.com/dir/x.css"'));
  assert.ok(out.includes("url('/p/https/example.com/i.png')"));
});

test('CSS rewriting', () => {
  const out = rewriteCss('a{background:url("../i.png")}@import url(other.css);b{src:url(data:font/woff;base64,AAA)}', 'https://e.com/css/main.css');
  assert.ok(out.includes('url("/p/https/e.com/i.png")'));
  assert.ok(out.includes('url(/p/https/e.com/css/other.css)'));
  assert.ok(out.includes('url(data:font/woff;base64,AAA)'));
});

test('cookie jar: set, domain/path/secure matching, deletion, HttpOnly', () => {
  const s = new CookieStore();
  const u = new URL('https://www.example.com/a/b');
  s.set('sid', u, 'a=1; Path=/; Domain=example.com');
  s.set('sid', u, 'h=2; HttpOnly; Path=/a');
  s.set('sid', u, 'sec=3; Secure');
  s.set('sid', u, 'evil=1; Domain=other.com');
  assert.strictEqual(s.header('sid', new URL('https://api.example.com/x')), 'a=1');
  const all = s.header('sid', new URL('https://www.example.com/a/b/c'));
  assert.ok(all.includes('a=1') && all.includes('h=2') && all.includes('sec=3') && !all.includes('evil'));
  assert.ok(!s.header('sid', new URL('http://www.example.com/a/b'), {}).includes('sec=3'));
  assert.ok(!s.header('sid', u, { scriptOnly: true }).includes('h=2'));
  s.set('sid', u, 'a=; Max-Age=0; Path=/; Domain=example.com');
  assert.ok(!s.header('sid', u).includes('a=1'));
  s.set('sid', u, 'h=hacked', true); // script cannot overwrite HttpOnly
  assert.ok(s.header('sid', new URL('https://www.example.com/a/x')).includes('h=2'));
  assert.strictEqual(s.header('other-session', u), '');
});

test('SSRF guard recognises private ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '172.31.255.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
    assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111'])
    assert.ok(!isPrivateIp(ip), ip);
});

test('ad/tracker blocklist matches subdomains but not lookalikes', () => {
  assert.ok(isBlocked('doubleclick.net'));
  assert.ok(isBlocked('stats.g.doubleclick.net'));
  assert.ok(!isBlocked('notdoubleclick.net.example.com'));
  assert.ok(!isBlocked('example.com'));
});

console.log(`\n${passed} tests passed`);
