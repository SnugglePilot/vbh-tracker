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

const SOURCE_COLORS: Record<string, string> = {
  'arcteryx-ca': '#93c5fd',
  grailed: '#fcd34d',
  ebay: '#6ee7b7'
}

function App() {
  const [visibleSources, setVisibleSources] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(data.sources.map((s) => [s.id, true]))
  )

  const sourcesById = useMemo(() => Object.fromEntries(data.sources.map((s) => [s.id, s])), [])

  const pointsBySource = useMemo(() => {
    const bySource: Record<string, Array<{ date: string; y: number; url: string }>> = {}
    for (const p of data.series) {
      const y = p.priceCad?.amount ?? p.price.amount
      const sid = p.sourceId
      if (!bySource[sid]) bySource[sid] = []
      bySource[sid].push({ date: p.date, y, url: p.url })
    }
    for (const sid of Object.keys(bySource)) {
      bySource[sid].sort((a, b) => a.date.localeCompare(b.date))
    }
    return bySource
  }, [])

  const seriesDataBySource = useMemo(() => {
    const out: Record<string, [string, number][]> = {}
    for (const [sid, pts] of Object.entries(pointsBySource)) {
      out[sid] = pts.map((p) => [p.date, p.y])
    }
    return out
  }, [pointsBySource])

  const allDates = useMemo(() => {
    const set = new Set<string>()
    for (const pts of Object.values(pointsBySource)) for (const p of pts) set.add(p.date)
    return Array.from(set).sort()
  }, [pointsBySource])

  const domain = useMemo(() => {
    if (allDates.length === 0) return { min: null as string | null, max: null as string | null }
    return { min: allDates[0], max: allDates[allDates.length - 1] }
  }, [allDates])

  const option = useMemo<echarts.EChartsOption>(() => {
    const currency = 'CAD'

    const tooltipFormatter = (params: any) => {
      const rows = Array.isArray(params) ? params : [params]
      const date = rows?.[0]?.axisValue
      const prettyDate = date ? format(parseISO(date), 'MMM d, yyyy') : ''

      const bullets = rows
        .filter((r: any) => r.data?.[1] != null)
        .map((r: any) => {
          const name = r.seriesName
          const value = Number(r.data?.[1])
          return `${name}: <b>${value.toFixed(2)} ${currency}</b>`
        })
        .join('<br/>')

      const match = data.series.find((p) => p.date === date)
      const link = match?.url
      const linkLine = link ? `<br/><a class="tt-link" href="${link}" target="_blank" rel="noreferrer">open listing</a>` : ''

      return `<div class="tt">${prettyDate}<br/>${bullets}${linkLine}</div>`
    }

    const series: echarts.SeriesOption[] = []
    for (const src of data.sources) {
      if (!visibleSources[src.id]) continue
      const seriesData = seriesDataBySource[src.id]
      if (!seriesData || seriesData.length === 0) continue
      const color = SOURCE_COLORS[src.id] ?? 'rgba(255,255,255,0.8)'
      series.push({
        name: src.name,
        type: 'line',
        smooth: true,
        showSymbol: true,
        symbolSize: 6,
        data: seriesData,
        emphasis: { focus: 'series' },
        lineStyle: { width: 2.5, color },
        itemStyle: { color },
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
  }, [domain.max, domain.min, seriesDataBySource, visibleSources])

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
          {data.sources.map((s) => (
            <label key={s.id} className="toggle">
              <input
                type="checkbox"
                checked={visibleSources[s.id] !== false}
                onChange={(e) =>
                  setVisibleSources((prev) => ({ ...prev, [s.id]: e.target.checked }))
                }
              />
              <span
                className="sourceLegend"
                style={{ color: SOURCE_COLORS[s.id] ?? 'rgba(255,255,255,0.8)' }}
              >
                {s.name}
              </span>
            </label>
          ))}
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
        <span className="muted">Built for hat-obsessed people.</span>
      </footer>
    </div>
  )
}

export default App
