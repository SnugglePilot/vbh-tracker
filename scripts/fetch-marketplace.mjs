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

function parseEbayPrices(html) {
  const points = [];
  const today = new Date().toISOString().slice(0, 10);
  // eBay often has s-item__price or similar
  const priceMatches = html.matchAll(/\$\s*(\d+(?:\.\d+)?)\s*(?:CAD|USD|CAD\s*\/\s*USD)?/gi);
  const spanPrice = html.matchAll(/s-item__price[^>]*>[\s$]*(\d+(?:\.\d+)?)/g);
  const seen = new Set();
  for (const m of priceMatches) {
    const amount = Number(m[1]);
    if (amount >= 50 && amount <= 500 && !seen.has(amount)) {
      seen.add(amount);
      points.push({ date: today, kind: 'sale', price: { amount, currency: 'USD' }, sourceId: 'ebay', url: EBAY_SOLD });
    }
  }
  for (const m of spanPrice) {
    const amount = Number(m[1]);
    if (amount >= 50 && amount <= 500 && !seen.has(amount)) {
      seen.add(amount);
      points.push({ date: today, kind: 'sale', price: { amount, currency: 'USD' }, sourceId: 'ebay', url: EBAY_LISTINGS });
    }
  }
  return points;
}

async function getWaybackPoints() {
  const cdxUrl = new URL('https://web.archive.org/cdx/search/cdx');
  cdxUrl.searchParams.set('url', 'arcteryx.com*bucket*hat*');
  cdxUrl.searchParams.set('output', 'json');
  cdxUrl.searchParams.set('fl', 'timestamp,original');
  cdxUrl.searchParams.set('filter', 'statuscode:200');
  cdxUrl.searchParams.set('collapse', 'digest');
  cdxUrl.searchParams.set('limit', '100');

  const raw = await fetchText(cdxUrl.toString());
  const data = JSON.parse(raw);
  const rows = data.slice(1) || [];
  const byDate = new Map();
  for (const [ts, original] of rows) {
    const date = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
    if (!byDate.has(date)) byDate.set(date, { date, url: `https://web.archive.org/web/${ts}/${original}` });
  }
  return Array.from(byDate.values());
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
  const existingKeys = new Set(supplementary.map(seenKey));

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

  console.log('Fetching eBay...');
  try {
    const html = await fetchText(EBAY_SOLD);
    const ebay = parseEbayPrices(html);
    for (const pt of ebay) {
      if (!existingKeys.has(seenKey(pt))) {
        newPoints.push(pt);
        existingKeys.add(seenKey(pt));
      }
    }
    console.log(`  eBay: ${ebay.length} price(s) found, ${newPoints.filter((p) => p.sourceId === 'ebay').length} new`);
  } catch (e) {
    console.warn('  eBay failed:', e.message);
  }

  if (newPoints.length > 0) {
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
