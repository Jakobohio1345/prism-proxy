'use strict';

const dns = require('dns').promises;
const net = require('net');

/** True if an IPv4/IPv6 literal points at a private, loopback, link-local or otherwise non-public range. */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    if (/^f[cd]/.test(l)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(l)) return true; // fe80::/10 link-local
    return false;
  }
  return true; // unknown format: treat as unsafe
}

const BLOCKED_PORTS = new Set([22, 23, 25, 110, 143, 445, 3306, 5432, 6379, 11211, 27017]);

/**
 * SSRF guard: refuses targets that resolve to private networks (including the host's own
 * localhost / cloud metadata endpoints) or that use obviously dangerous ports.
 */
async function assertPublicTarget(url) {
  const port = url.port ? Number(url.port) : url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
  if (BLOCKED_PORTS.has(port)) throw new Error('Port not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('Local addresses are not allowed');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Private addresses are not allowed');
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new Error('Could not resolve host: ' + host);
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('Private addresses are not allowed');
  }
}

/** Tiny fixed-window rate limiter (per key). */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => hits.clear(), windowMs);
  if (timer.unref) timer.unref();
  return function allow(key) {
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    return n <= max;
  };
}

module.exports = { isPrivateIp, assertPublicTarget, createRateLimiter };
