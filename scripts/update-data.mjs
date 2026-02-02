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

const ARCTERYX_SOURCE = {
  id: 'arcteryx-ca',
  name: "Arc'teryx (CA)",
  url: 'https://arcteryx.com/ca/en/shop/bucket-hat-9477',
  currency: 'CAD'
};

const GRAILED_SOURCE = {
  id: 'grailed',
  name: 'Grailed',
  url: 'https://www.grailed.com/search?q=veilance+bucket+hat',
  currency: 'USD'
};

const EBAY_SOURCE = {
  id: 'ebay',
  name: 'eBay',
  url: 'https://www.ebay.com/sch/i.html?_nkw=veilance+bucket+hat+carmine',
  currency: 'USD'
};

const SOURCES = [ARCTERYX_SOURCE, GRAILED_SOURCE, EBAY_SOURCE];
const SOURCE = ARCTERYX_SOURCE;

const ROOT = path.resolve(process.cwd());
const OUT_PATH = path.join(ROOT, 'src', 'data', 'price-series.json');
const SUPPLEMENTARY_PATH = path.join(ROOT, 'src', 'data', 'supplementary-points.json');

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
  // Arc'teryx pages typically embed structured product data. Prefer JSON-LD when present.
  // We'll look for an offers block containing price + priceCurrency.

  // 1) JSON-LD offers (best)
  // e.g. "offers":{"@type":"Offer","priceCurrency":"CAD","price":"225.00" ...}
  const jsonLdCurrency = html.match(/"priceCurrency"\s*:\s*"([A-Z]{3})"/i)?.[1];
  const jsonLdPrice = html.match(/"price"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/i)?.[1];

  // 2) Fallback: visible formatted price like $225.00
  const textPrice = html.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/)?.[1];

  const currency = (jsonLdCurrency || 'CAD').toUpperCase();
  const current = jsonLdPrice ? Number(jsonLdPrice) : (textPrice ? Number(textPrice) : null);

  // Arc'teryx generally doesn't expose a separate MSRP vs sale in markup for full-price items.
  // If they ever do, we can add detection for "highPrice" / "priceSpecification".
  const regular = null;

  return { current, regular, currency };
}

async function fxRate(dateISO, from, to) {
  // frankfurter.app supports historical (ECB-based). Note: weekends return last business day's rate.
  const url = `https://api.frankfurter.app/${dateISO}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const json = JSON.parse(await fetchText(url));
  const rate = json?.rates?.[to];
  if (!rate) throw new Error(`No FX rate for ${from}->${to} on ${dateISO}`);
  return Number(rate);
}

async function getWaybackAllSnapshots(originalUrl) {
  const cdxUrl = new URL('https://web.archive.org/cdx/search/cdx');
  cdxUrl.searchParams.set('url', originalUrl);
  cdxUrl.searchParams.set('output', 'json');
  cdxUrl.searchParams.set('fl', 'timestamp,statuscode');
  cdxUrl.searchParams.set('filter', 'statuscode:200');
  // collapse identical content so we don't store duplicate points for identical renders
  cdxUrl.searchParams.set('collapse', 'digest');

  const raw = JSON.parse(await fetchText(cdxUrl.toString()));
  const rows = raw.slice(1); // header

  const timestamps = rows.map(([timestamp]) => timestamp).filter(Boolean);
  timestamps.sort();
  return timestamps;
}

/** Load supplementary price points (Grailed, eBay, manual). Each item: { date, kind, price: { amount, currency }, sourceId, url } */
async function loadSupplementaryPoints() {
  try {
    const raw = await fs.readFile(SUPPLEMENTARY_PATH, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
}

/** Spread points that share the same (sourceId, date) across consecutive days so the graph has a time spread. */
function spreadSupplementaryDates(points) {
  const byKey = new Map();
  for (const pt of points) {
    const key = `${pt.sourceId}|${pt.date}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(pt);
  }
  const out = [];
  for (const [, group] of byKey) {
    if (group.length <= 1) {
      out.push(...group);
      continue;
    }
    const baseDate = group[0].date;
    const base = new Date(baseDate + 'T12:00:00Z');
    group.sort((a, b) => (a.price?.amount ?? 0) - (b.price?.amount ?? 0));
    for (let i = 0; i < group.length; i++) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() - (group.length - 1 - i));
      const dateStr = d.toISOString().slice(0, 10);
      out.push({ ...group[i], date: dateStr });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.price?.amount ?? 0) - (b.price?.amount ?? 0));
}

async function buildSeries({ includeWayback }) {
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);

  const html = await fetchText(SOURCE.url);
  const parsed = parsePriceFromHtml(html);

  // Always display CAD. If the source is already CAD, rate=1 and we skip FX lookup.
  const fxFrom = (parsed.currency || SOURCE.currency || 'CAD').toUpperCase();
  const fxRateToCad = fxFrom === 'CAD' ? 1 : await fxRate(todayISO, fxFrom, 'CAD');

  const points = [];

  if (parsed.current != null) {
    points.push({
      date: todayISO,
      kind: 'sale',
      price: { amount: parsed.current, currency: fxFrom },
      priceCad: {
        amount: Number((parsed.current * fxRateToCad).toFixed(2)),
        ...(fxFrom === 'CAD'
          ? {}
          : { fx: { pair: `${fxFrom}/CAD`, rate: fxRateToCad, source: 'frankfurter.app', date: todayISO } })
      },
      sourceId: SOURCE.id,
      url: SOURCE.url
    });
  }

  if (parsed.regular != null) {
    points.push({
      date: todayISO,
      kind: 'msrp',
      price: { amount: parsed.regular, currency: fxFrom },
      priceCad: {
        amount: Number((parsed.regular * fxRateToCad).toFixed(2)),
        ...(fxFrom === 'CAD'
          ? {}
          : { fx: { pair: `${fxFrom}/CAD`, rate: fxRateToCad, source: 'frankfurter.app', date: todayISO } })
      },
      sourceId: SOURCE.id,
      url: SOURCE.url
    });
  }

  if (includeWayback) {
    let snapshots = [];
    try {
      snapshots = await getWaybackAllSnapshots(ARCTERYX_SOURCE.url);
    } catch (e) {
      console.warn('Wayback CDX unavailable (skipping historical snapshots):', e?.message || e);
    }

    for (const ts of snapshots) {
      const dateISO = isoDateFromWaybackTimestamp(ts);
      let htmlSnap;
      try {
        htmlSnap = await fetchText(`https://web.archive.org/web/${ts}/${ARCTERYX_SOURCE.url}`);
      } catch {
        continue;
      }
      const p = parsePriceFromHtml(htmlSnap);
      if (p.current == null && p.regular == null) continue;

      const snapFrom = (p.currency || ARCTERYX_SOURCE.currency || 'CAD').toUpperCase();
      let rate;
      try {
        rate = snapFrom === 'CAD' ? 1 : await fxRate(dateISO, snapFrom, 'CAD');
      } catch {
        // if no rate, skip
        continue;
      }

      if (p.current != null) {
        points.push({
          date: dateISO,
          kind: 'sale',
          price: { amount: p.current, currency: snapFrom },
          priceCad: {
            amount: Number((p.current * rate).toFixed(2)),
            ...(snapFrom === 'CAD'
              ? {}
              : { fx: { pair: `${snapFrom}/CAD`, rate, source: 'frankfurter.app', date: dateISO } })
          },
          sourceId: ARCTERYX_SOURCE.id,
      url: ARCTERYX_SOURCE.url,
      wayback: { timestamp: ts }
        });
      }

      if (p.regular != null) {
        points.push({
          date: dateISO,
          kind: 'msrp',
          price: { amount: p.regular, currency: snapFrom },
          priceCad: {
            amount: Number((p.regular * rate).toFixed(2)),
            ...(snapFrom === 'CAD'
              ? {}
              : { fx: { pair: `${snapFrom}/CAD`, rate, source: 'frankfurter.app', date: dateISO } })
          },
          sourceId: ARCTERYX_SOURCE.id,
          url: ARCTERYX_SOURCE.url,
          wayback: { timestamp: ts }
        });
      }
    }
  }

  let supplementary = await loadSupplementaryPoints();
  supplementary = spreadSupplementaryDates(supplementary);
  for (const pt of supplementary) {
    if (!pt?.date || !pt?.kind || !pt?.price?.amount || !pt?.sourceId || !pt?.url) continue;
    const currency = (pt.price.currency || 'USD').toUpperCase();
    let rate = 1;
    if (currency !== 'CAD') {
      try {
        rate = await fxRate(pt.date, currency, 'CAD');
      } catch {
        continue;
      }
    }
    points.push({
      date: pt.date,
      kind: pt.kind === 'msrp' ? 'msrp' : 'sale',
      price: { amount: pt.price.amount, currency },
      priceCad: {
        amount: Number((pt.price.amount * rate).toFixed(2)),
        ...(currency === 'CAD' ? {} : { fx: { pair: `${currency}/CAD`, rate, source: 'frankfurter.app', date: pt.date } })
      },
      sourceId: pt.sourceId,
      url: pt.url,
      ...(pt.wayback ? { wayback: pt.wayback } : {})
    });
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
        'Historical points may be sourced from Arc\'teryx (retail), Web Archive snapshots, Grailed, and eBay (resale).',
        'Prices are displayed in CAD; non-CAD source prices are converted using historical FX for the capture date.'
      ]
    },
    sources: SOURCES,
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
