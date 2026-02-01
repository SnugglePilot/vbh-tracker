#!/usr/bin/env node
/*
  VBH Tracker data updater

  - Pulls current price + MSRP (when present on page) from the product page.
  - Optionally builds historical points from Wayback Machine snapshots.
  - Converts to CAD using historical FX rates.

  Notes:
  - This is best-effort scraping of publicly available pages.
  - Retailers can change markup at any time; keep parser defensive.
*/

import fs from 'node:fs/promises';
import path from 'node:path';

const PRODUCT_NAME = "Veilance Bucket Hat";
const COLOR = "Carmine";
const SOURCE = {
  id: 'chcm',
  name: "C'H'C'M'",
  url: 'https://chcmshop.com/collections/hats/products/veilance-bucket-hat-carmine',
  currency: 'USD'
};

const ROOT = path.resolve(process.cwd());
const OUT_PATH = path.join(ROOT, 'src', 'data', 'price-series.json');

function isoDateFromWaybackTimestamp(ts) {
  // ts: YYYYMMDDhhmmss
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
}

async function fetchText(url, init) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'vbh-tracker/1.0 (+https://github.com/snugglepilot/vbh-tracker)'
    },
    ...init
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function parsePriceFromHtml(html) {
  // CHCM is Shopify. Their OpenGraph meta is reliable for the *current* price.
  const ogAmount = html.match(/property="og:price:amount"\s+content="([0-9.]+)"/i)?.[1];
  const ogCurrency = html.match(/property="og:price:currency"\s+content="([A-Z]{3})"/i)?.[1];

  // MSRP/regular price is often rendered as text; CHCM shows it as: "Regular price $ 225.00"
  // We grab the first currency-looking amount AFTER the words "Regular price".
  const regularBlock = html.match(/Regular price[\s\S]{0,200}?\$\s*([0-9,.]+)/i);
  const regular = regularBlock?.[1] ? Number(regularBlock[1].replace(/,/g, '')) : null;

  // Sale/Current price (often same as og:price:amount)
  const current = ogAmount ? Number(ogAmount) : null;

  return {
    current,
    regular,
    currency: ogCurrency || 'USD'
  };
}

async function fxRate(dateISO, from, to) {
  // frankfurter.app supports historical (ECB-based). Note: weekends return last business day's rate.
  const url = `https://api.frankfurter.app/${dateISO}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const json = JSON.parse(await fetchText(url));
  const rate = json?.rates?.[to];
  if (!rate) throw new Error(`No FX rate for ${from}->${to} on ${dateISO}`);
  return Number(rate);
}

async function getWaybackMonthlySnapshots(originalUrl, maxMonths = 48) {
  const cdxUrl = new URL('https://web.archive.org/cdx/search/cdx');
  cdxUrl.searchParams.set('url', originalUrl);
  cdxUrl.searchParams.set('output', 'json');
  cdxUrl.searchParams.set('fl', 'timestamp,statuscode');
  cdxUrl.searchParams.set('filter', 'statuscode:200');
  cdxUrl.searchParams.set('collapse', 'digest');

  const raw = JSON.parse(await fetchText(cdxUrl.toString()));
  const rows = raw.slice(1); // header

  // pick first snapshot per YYYYMM
  const byMonth = new Map();
  for (const [timestamp] of rows) {
    const yyyymm = timestamp.slice(0, 6);
    if (!byMonth.has(yyyymm)) byMonth.set(yyyymm, timestamp);
  }

  const months = [...byMonth.keys()].sort();
  const tail = months.slice(Math.max(0, months.length - maxMonths));
  return tail.map(m => byMonth.get(m));
}

async function buildSeries({ includeWayback }) {
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);

  const usdToCad = await fxRate(todayISO, 'USD', 'CAD');

  const html = await fetchText(SOURCE.url);
  const parsed = parsePriceFromHtml(html);

  const points = [];

  if (parsed.current != null) {
    points.push({
      date: todayISO,
      kind: 'sale',
      price: { amount: parsed.current, currency: parsed.currency },
      priceCad: { amount: Number((parsed.current * usdToCad).toFixed(2)), fx: { pair: 'USD/CAD', rate: usdToCad, source: 'frankfurter.app', date: todayISO } },
      sourceId: SOURCE.id,
      url: SOURCE.url
    });
  }

  if (parsed.regular != null) {
    points.push({
      date: todayISO,
      kind: 'msrp',
      price: { amount: parsed.regular, currency: parsed.currency },
      priceCad: { amount: Number((parsed.regular * usdToCad).toFixed(2)), fx: { pair: 'USD/CAD', rate: usdToCad, source: 'frankfurter.app', date: todayISO } },
      sourceId: SOURCE.id,
      url: SOURCE.url
    });
  }

  if (includeWayback) {
    const snapshots = await getWaybackMonthlySnapshots(SOURCE.url);

    for (const ts of snapshots) {
      const dateISO = isoDateFromWaybackTimestamp(ts);
      let htmlSnap;
      try {
        htmlSnap = await fetchText(`https://web.archive.org/web/${ts}/${SOURCE.url}`);
      } catch {
        continue;
      }
      const p = parsePriceFromHtml(htmlSnap);
      if (p.current == null && p.regular == null) continue;

      let rate;
      try {
        rate = await fxRate(dateISO, 'USD', 'CAD');
      } catch {
        // if no rate, skip
        continue;
      }

      if (p.current != null) {
        points.push({
          date: dateISO,
          kind: 'sale',
          price: { amount: p.current, currency: p.currency || 'USD' },
          priceCad: { amount: Number((p.current * rate).toFixed(2)), fx: { pair: 'USD/CAD', rate, source: 'frankfurter.app', date: dateISO } },
          sourceId: SOURCE.id,
          url: SOURCE.url,
          wayback: { timestamp: ts }
        });
      }

      if (p.regular != null) {
        points.push({
          date: dateISO,
          kind: 'msrp',
          price: { amount: p.regular, currency: p.currency || 'USD' },
          priceCad: { amount: Number((p.regular * rate).toFixed(2)), fx: { pair: 'USD/CAD', rate, source: 'frankfurter.app', date: dateISO } },
          sourceId: SOURCE.id,
          url: SOURCE.url,
          wayback: { timestamp: ts }
        });
      }
    }
  }

  // de-dupe exact (date+kind+amount+source)
  const seen = new Set();
  const deduped = [];
  for (const pt of points) {
    const k = `${pt.date}|${pt.kind}|${pt.price.amount}|${pt.price.currency}|${pt.sourceId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(pt);
  }

  deduped.sort((a, b) => a.date.localeCompare(b.date));

  return {
    product: {
      name: PRODUCT_NAME,
      brand: "Arc'teryx",
      line: 'Veilance',
      color: COLOR,
      currencyDisplay: 'CAD',
      notes: [
        `This tracker focuses on the ${PRODUCT_NAME} in the ${COLOR} colour.`,
        'Historical points may be sourced from Web Archive snapshots when available.',
        'Prices are converted to CAD using historical FX rates (USD→CAD) for the capture date.'
      ]
    },
    sources: [SOURCE],
    series: deduped
  };
}

async function main() {
  const includeWayback = process.argv.includes('--wayback');
  const data = await buildSeries({ includeWayback });
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${OUT_PATH} with ${data.series.length} points`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
