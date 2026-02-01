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

Current price scrape:

```bash
npm run update:data
```

Best-effort history from Wayback (slower):

```bash
npm run update:data:wayback
```

## Notes

This is best-effort scraping of public retail pages. Retailers can change markup at any time; parsers may need updates.
