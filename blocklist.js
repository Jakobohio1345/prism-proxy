'use strict';

/** Hostnames (and all their subdomains) of common ad networks and trackers. */
const BLOCKED_DOMAINS = new Set([
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'googletagservices.com',
  'googletagmanager.com', 'google-analytics.com', 'analytics.google.com', 'adservice.google.com',
  'pagead2.googlesyndication.com', 'connect.facebook.net', 'facebook.net', 'scorecardresearch.com',
  'quantserve.com', 'quantcast.com', 'hotjar.com', 'hotjar.io', 'fullstory.com', 'mouseflow.com',
  'crazyegg.com', 'adnxs.com', 'adsrvr.org', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net',
  'amazon-adsystem.com', 'moatads.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net',
  'casalemedia.com', 'adform.net', 'advertising.com', 'bluekai.com', 'demdex.net', 'omtrdc.net',
  '2o7.net', 'mathtag.com', 'rlcdn.com', 'agkn.com', 'krxd.net', 'exelator.com', 'tapad.com',
  'bidswitch.net', 'smartadserver.com', 'yieldmo.com', 'sharethrough.com', 'teads.tv', 'media.net',
  'mixpanel.com', 'segment.io', 'segment.com', 'amplitude.com', 'heap.io', 'heapanalytics.com',
  'optimizely.com', 'chartbeat.com', 'chartbeat.net', 'newrelic.com', 'nr-data.net', 'ads-twitter.com',
  'analytics.twitter.com', 'ads.linkedin.com', 'px.ads.linkedin.com', 'snap.licdn.com', 'bat.bing.com',
  'clarity.ms', 'ads.yahoo.com', 'analytics.yahoo.com', 'adsymptotic.com', 'zedo.com', 'popads.net',
  'propellerads.com', 'popcash.net', 'exoclick.com', 'juicyads.com', 'trafficjunky.net',
]);

function isBlocked(hostname) {
  const parts = hostname.toLowerCase().split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (BLOCKED_DOMAINS.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

module.exports = { isBlocked, BLOCKED_DOMAINS };
