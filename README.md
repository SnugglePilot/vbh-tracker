# VBH Tracker

Tracks the historical + current price of the **Arc'teryx Veilance Bucket Hat** in **Carmine**.

- Frontend: Vite + React + ECharts (animated)
- Currency display: **CAD** (USD sources converted using historical FX)
- Deploy: GitHub Pages via Actions

## Local dev

```bash
npm install
npm run update:data
npm run dev
```

## Data updates

**Current retail price** (Arc'teryx CA):

```bash
npm run update:data
```

**Historical points from Wayback Machine** (Arc'teryx product page snapshots; slower):

```bash
npm run update:data:wayback
```

**Grailed + eBay** (resale / sold listings): the script fetches search pages and extracts prices into `src/data/supplementary-points.json`. Run `update:data` after to merge into the main series (USD→CAD via historical FX).

```bash
npm run fetch:marketplace
npm run update:data
```

You can also add **manual points** (e.g. from Grailed sold listings, eBay sold, or Wayback) by editing `src/data/supplementary-points.json`. Each entry: `{ "date": "YYYY-MM-DD", "kind": "sale", "price": { "amount": 120, "currency": "USD" }, "sourceId": "grailed" | "ebay", "url": "..." }`. Run `npm run update:data` to merge.

## Notes

This is best-effort scraping of public retail pages. Retailers can change markup at any time; parsers may need updates.
