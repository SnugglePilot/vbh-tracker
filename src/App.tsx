import { useEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts'
import { format, parseISO } from 'date-fns'

import raw from './data/price-series.json'
import './App.css'

type PricePoint = {
  date: string
  kind: 'sale' | 'msrp'
  price: { amount: number; currency: string }
  priceCad?: { amount: number; fx?: { pair: string; rate: number; source: string; date: string } }
  sourceId: string
  url: string
  wayback?: { timestamp: string }
}

type DataFile = {
  product: { name: string; brand: string; line: string; color: string; notes: string[] }
  sources: { id: string; name: string; url: string; currency: string }[]
  series: PricePoint[]
}

const data = raw as DataFile

function useEChart(option: echarts.EChartsOption) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!ref.current) return

    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    chart.setOption(option)

    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(ref.current)

    return () => {
      ro.disconnect()
      chart.dispose()
    }
  }, [option])

  return ref
}

function App() {
  const [showSale, setShowSale] = useState(true)
  const [showMsrp, setShowMsrp] = useState(true)

  const sourcesById = useMemo(() => Object.fromEntries(data.sources.map((s) => [s.id, s])), [])

  const points = useMemo(() => {
    // prefer CAD if present; otherwise fall back to original.
    return data.series
      .map((p) => ({
        ...p,
        y: p.priceCad?.amount ?? p.price.amount,
        currency: p.priceCad?.amount != null ? 'CAD' : p.price.currency
      }))
      .filter((p) => (p.kind === 'sale' ? showSale : showMsrp))
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [showSale, showMsrp])

  const { saleSeries, msrpSeries } = useMemo(() => {
    const sale: [string, number][] = []
    const msrp: [string, number][] = []

    for (const p of points) {
      const tup: [string, number] = [p.date, p.y]
      if (p.kind === 'sale') sale.push(tup)
      if (p.kind === 'msrp') msrp.push(tup)
    }

    return { saleSeries: sale, msrpSeries: msrp }
  }, [points])

  const domain = useMemo(() => {
    const dates = points.map((p) => p.date)
    return {
      min: dates[0] ?? null,
      max: dates[dates.length - 1] ?? null
    }
  }, [points])

  const option = useMemo<echarts.EChartsOption>(() => {
    const currency = 'CAD'

    const tooltipFormatter = (params: any) => {
      const rows = Array.isArray(params) ? params : [params]
      const date = rows?.[0]?.axisValue
      const prettyDate = date ? format(parseISO(date), 'MMM d, yyyy') : ''

      const bullets = rows
        .map((r: any) => {
          const kind = r.seriesName
          const value = Number(r.data?.[1])
          return `${kind}: <b>${value.toFixed(2)} ${currency}</b>`
        })
        .join('<br/>')

      // Try to show at least one underlying source link for this date.
      const match = data.series.find((p) => p.date === date)
      const source = match ? sourcesById[match.sourceId] : null
      const link = match?.url

      const sourceLine = source ? `<br/><span class="tt-muted">Source: ${source.name}</span>` : ''
      const linkLine = link ? `<br/><a class="tt-link" href="${link}" target="_blank" rel="noreferrer">open listing</a>` : ''

      return `<div class="tt">${prettyDate}<br/>${bullets}${sourceLine}${linkLine}</div>`
    }

    const series: echarts.SeriesOption[] = []

    if (showSale) {
      series.push({
        name: 'Sale / current',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: saleSeries,
        emphasis: { focus: 'series' },
        lineStyle: { width: 3, color: '#ff3b3b' },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(255, 59, 59, 0.35)' },
            { offset: 1, color: 'rgba(255, 59, 59, 0.00)' }
          ])
        },
        animationDuration: 900,
        animationEasing: 'cubicOut'
      })
    }

    if (showMsrp) {
      series.push({
        name: 'MSRP / retail',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: msrpSeries,
        emphasis: { focus: 'series' },
        lineStyle: { width: 2, type: 'dashed', color: '#ffd0d0' },
        animationDuration: 900,
        animationEasing: 'cubicOut'
      })
    }

    return {
      backgroundColor: 'transparent',
      grid: { left: 18, right: 18, top: 30, bottom: 30, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, formatter: tooltipFormatter },
      xAxis: {
        type: 'time',
        boundaryGap: [0, 0],
        min: domain.min ?? undefined,
        max: domain.max ?? undefined,
        axisLabel: {
          color: 'rgba(255,255,255,0.85)',
          formatter: (value: number) => format(new Date(value), 'MMM yyyy')
        },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.25)' } },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } }
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          color: 'rgba(255,255,255,0.85)',
          formatter: (v: number) => `${v.toFixed(0)} ${currency}`
        },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.25)' } },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } }
      },
      series
    }
  }, [domain.max, domain.min, msrpSeries, saleSeries, showMsrp, showSale, sourcesById])

  const chartRef = useEChart(option)

  return (
    <div className="page">
      <header className="header">
        <div className="badge">VBH Tracker</div>
        <div className="titleWrap">
          <h1 className="title">Veilance Bucket Hat — Carmine</h1>
          <p className="subtitle">Market + retail price history (CAD)</p>
        </div>
      </header>

      <section className="panel">
        <div className="controls">
          <label className="toggle">
            <input type="checkbox" checked={showSale} onChange={(e) => setShowSale(e.target.checked)} />
            <span>Sale / current</span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={showMsrp} onChange={(e) => setShowMsrp(e.target.checked)} />
            <span>MSRP / retail</span>
          </label>
        </div>

        <div ref={chartRef} className="chart" />

        <div className="meta">
          <div className="notes">
            {data.product.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>

          <div className="sources">
            <div className="sourcesTitle">Sources</div>
            <ul>
              {data.sources.map((s) => (
                <li key={s.id}>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.name}
                  </a>
                  <span className="muted"> ({s.currency})</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <footer className="footer">
        <span className="muted">
          Built for hat-obsessed people. Data updates via <code>npm run update:data</code>.
        </span>
      </footer>
    </div>
  )
}

export default App
