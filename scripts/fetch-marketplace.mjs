#!/usr/bin/env node
/*
  Fetch Veilance Bucket Hat price data from Grailed, eBay, and Wayback.
  Appends new points to supplementary-points.json (merge run separately via update-data.mjs).

  Grailed / eBay are JS-heavy; we try to extract prices from HTML or embedded JSON.
  Run: node scripts/fetch-marketplace.mjs
*/

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const SUPP_PATH = path.join(ROOT, 'src', 'data', 'supplementary-points.json');

const GRAILED_SEARCH = 'https://www.grailed.com/search?q=veilance+bucket+hat';
const EBAY_SOLD = 'https://www.ebay.com/sch/i.html?_nkw=veilance+bucket+hat+carmine&_sacat=0&LH_Sold=1&LH_Complete=1';
const EBAY_LISTINGS = 'https://www.ebay.com/sch/i.html?_nkw=veilance+bucket+hat+carmine&_sacat=0';

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; vbh-tracker/1.0; +https://github.com/snugglepilot/vbh-tracker)',
      'accept': 'text/html,application/xhtml+xml'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

function parseGrailedPrices(html) {
  const points = [];
  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set();
  // Grailed embeds __NEXT_DATA__; listing prices may be loaded client-side. Capture any price in plausible range.
  const priceMatches = html.matchAll(/"price"\s*:\s*"?(\d{2,3}(?:\.\d+)?)"?/g);
  const usdMatches = html.matchAll(/\$\s*(\d{2,3}(?:\.\d+)?)\s*(?:USD|usd)/gi);
  const plainDollar = html.matchAll(/\$(\d{2,3})(?:\s|"|,|<\/|\.)/g);
  for (const m of priceMatches) {
    const amount = Number(m[1]);
    if (amount >= 80 && amount <= 350 && !seen.has(amount)) {
      seen.add(amount);
      points.push({ date: today, kind: 'sale', price: { amount, currency: 'USD' }, sourceId: 'grailed', url: GRAILED_SEARCH });
    }
  }
  for (const m of usdMatches) {
    const amount = Number(m[1]);
    if (amount >= 80 && amount <= 350 && !seen.has(amount)) {
      seen.add(amount);
      points.push({ date: today, kind: 'sale', price: { amount, currency: 'USD' }, sourceId: 'grailed', url: GRAILED_SEARCH });
    }
  }
  for (const m of plainDollar) {
    const amount = Number(m[1]);
    if (amount >= 80 && amount <= 350 && !seen.has(amount)) {
      seen.add(amount);
      points.push({ date: today, kind: 'sale', price: { amount, currency: 'USD' }, sourceId: 'grailed', url: GRAILED_SEARCH });
    }
  }
  return points;
}

/** Parse eBay HTML for prices. If snapshotDate is set, use it for each point (Wayback); else use today. */
function parseEbayPrices(html, snapshotDate = null) {
  const points = [];
  const dateStr = snapshotDate || new Date().toISOString().slice(0, 10);
  const priceMatches = html.matchAll(/\$\s*(\d+(?:\.\d+)?)\s*(?:CAD|USD|CAD\s*\/\s*USD)?/gi);
  const spanPrice = html.matchAll(/s-item__price[^>]*>[\s$]*(\d+(?:\.\d+)?)/g);
  const seen = new Set();
  const url = snapshotDate ? EBAY_SOLD : EBAY_SOLD;
  for (const m of priceMatches) {
    const amount = Number(m[1]);
    if (amount >= 50 && amount <= 500 && !seen.has(amount)) {
      seen.add(amount);
      points.push({ date: dateStr, kind: 'sale', price: { amount, currency: 'USD' }, sourceId: 'ebay', url: EBAY_SOLD });
    }
  }
  for (const m of spanPrice) {
    const amount = Number(m[1]);
    if (amount >= 50 && amount <= 500 && !seen.has(amount)) {
      seen.add(amount);
      points.push({ date: dateStr, kind: 'sale', price: { amount, currency: 'USD' }, sourceId: 'ebay', url: EBAY_SOLD });
    }
  }
  return points;
}

/** Get Wayback CDX timestamps for a URL. Returns array of { timestamp, dateISO } sorted oldest first. */
async function getWaybackSnapshotsForUrl(url, limit = 50) {
  const cdxUrl = new URL('https://web.archive.org/cdx/search/cdx');
  cdxUrl.searchParams.set('url', url);
  cdxUrl.searchParams.set('output', 'json');
  cdxUrl.searchParams.set('fl', 'timestamp');
  cdxUrl.searchParams.set('filter', 'statuscode:200');
  cdxUrl.searchParams.set('collapse', 'timestamp'); // one per day
  cdxUrl.searchParams.set('limit', String(limit));

  const raw = await fetch(cdxUrl.toString(), {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; vbh-tracker/1.0)' }
  });
  if (!raw.ok) throw new Error(`Wayback CDX HTTP ${raw.status}`);
  const text = await raw.text();
  if (!text.trimStart().startsWith('[')) throw new Error('Wayback CDX returned non-JSON');
  const data = JSON.parse(text);
  const rows = data.slice(1) || [];
  const byDate = new Map();
  for (const [ts] of rows) {
    if (!ts) continue;
    const dateISO = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
    if (!byDate.has(dateISO)) byDate.set(dateISO, ts);
  }
  return Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dateISO, timestamp]) => ({ timestamp, dateISO }));
}

/** Fetch eBay sold listings from Wayback snapshots to get (date, price) with real archive dates. */
async function fetchEbayFromWayback(maxSnapshots = 15) {
  const points = [];
  let snapshots = [];
  for (const tryUrl of [EBAY_SOLD, 'https://www.ebay.com/sch/i.html*']) {
    try {
      snapshots = await getWaybackSnapshotsForUrl(tryUrl, 100);
      if (snapshots.length > 0) break;
    } catch (e) {
      if (tryUrl === EBAY_SOLD) console.warn('  Wayback CDX for eBay failed:', e?.message);
    }
  }
  if (snapshots.length === 0) {
    console.log('  No Wayback snapshots found for eBay URL.');
    return points;
  }
  // Sample spread: oldest, newest, and evenly in between
  const step = Math.max(1, Math.floor((snapshots.length - 1) / Math.max(1, maxSnapshots - 2)));
  const indices = new Set([0]);
  for (let i = step; i < snapshots.length; i += step) indices.add(i);
  indices.add(snapshots.length - 1);
  const sampled = snapshots.filter((_, i) => indices.has(i)).slice(0, maxSnapshots);

  console.log(`  Found ${snapshots.length} Wayback snapshots for eBay; fetching ${sampled.length} for prices.`);
  for (const { timestamp, dateISO } of sampled) {
    try {
      const waybackUrl = `https://web.archive.org/web/${timestamp}/${EBAY_SOLD}`;
      const res = await fetch(waybackUrl, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; vbh-tracker/1.0)' }
      });
      if (!res.ok) continue;
      const html = await res.text();
      const parsed = parseEbayPrices(html, dateISO);
      for (const pt of parsed) points.push(pt);
    } catch {
      // skip
    }
  }
  return points;
}

async function main() {
  let supplementary = [];
  try {
    const raw = await fs.readFile(SUPP_PATH, 'utf8');
    supplementary = JSON.parse(raw);
    if (!Array.isArray(supplementary)) supplementary = [];
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }

  const newPoints = [];
  const seenKey = (pt) => `${pt.date}|${pt.sourceId}|${pt.price?.amount}`;
  let existingKeys = new Set(supplementary.map(seenKey));

  console.log('Fetching Grailed...');
  try {
    const html = await fetchText(GRAILED_SEARCH);
    const grailed = parseGrailedPrices(html);
    for (const pt of grailed) {
      if (!existingKeys.has(seenKey(pt))) {
        newPoints.push(pt);
        existingKeys.add(seenKey(pt));
      }
    }
    console.log(`  Grailed: ${grailed.length} price(s) found, ${newPoints.filter((p) => p.sourceId === 'grailed').length} new`);
  } catch (e) {
    console.warn('  Grailed failed:', e.message);
  }

  console.log('Fetching eBay (live)...');
  try {
    const html = await fetchText(EBAY_SOLD);
    const ebay = parseEbayPrices(html);
    for (const pt of ebay) {
      if (!existingKeys.has(seenKey(pt))) {
        newPoints.push(pt);
        existingKeys.add(seenKey(pt));
      }
    }
    console.log(`  eBay live: ${ebay.length} price(s) found.`);
  } catch (e) {
    console.warn('  eBay failed:', e.message);
  }

  console.log('Fetching eBay from Wayback Machine (for dates)...');
  let waybackEbay = [];
  try {
    waybackEbay = await fetchEbayFromWayback(15);
    for (const pt of waybackEbay) {
      if (!existingKeys.has(seenKey(pt))) {
        newPoints.push(pt);
        existingKeys.add(seenKey(pt));
      }
    }
    console.log(`  eBay Wayback: ${waybackEbay.length} point(s) with snapshot dates.`);
  } catch (e) {
    console.warn('  eBay Wayback failed:', e.message);
  }

  const hasNewEbay = newPoints.some((p) => p.sourceId === 'ebay');
  if (hasNewEbay) {
    supplementary = supplementary.filter((p) => p.sourceId !== 'ebay');
  }

  if (newPoints.length > 0 || hasNewEbay) {
    const merged = [...supplementary, ...newPoints];
    merged.sort((a, b) => a.date.localeCompare(b.date) || (a.price?.amount ?? 0) - (b.price?.amount ?? 0));
    await fs.mkdir(path.dirname(SUPP_PATH), { recursive: true });
    await fs.writeFile(SUPP_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    console.log(`Wrote ${newPoints.length} new point(s) to supplementary-points.json (total ${merged.length}). Run npm run update:data to merge into price-series.`);
  } else {
    console.log('No new price points to add. You can add manual entries to src/data/supplementary-points.json.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
