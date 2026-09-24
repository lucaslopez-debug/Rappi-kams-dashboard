'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import AvailabilityWarnings from '@/components/AvailabilityWarnings'

// Una brand cuenta como "con markdown" cuando su MD archie llega al 80% de su
// target — misma regla con la que Snowflake arma BRANDS_WITH_MD_RESULT.
const MD_THRESHOLD = 80

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function isMonday(iso) {
  return parseDate(iso).getUTCDay() === 1
}

function formatDate(iso) {
  const date = parseDate(iso)
  const weekday = date.toLocaleDateString('es-AR', { weekday: 'long', timeZone: 'UTC' })
  const day = date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })
  return `${weekday} ${day}`
}

// 2 decimales: con 1 solo, un 79.96% (todavía fuera de markdown) se vería
// como "80.0%" y parecería que ya había llegado al corte.
function fmtPct(v) {
  return v == null ? '—' : `${Number(v).toFixed(2)}%`
}

// Compara la foto más reciente contra la del lunes anterior a ella: de martes
// a viernes hay una foto diaria (avance de la semana en curso contra el lunes)
// y el lunes se compara contra el lunes previo (cierre de la semana).
function pickComparison(dates) {
  const sorted = [...new Set(dates)].sort()
  const current = sorted[sorted.length - 1]
  if (!current) return null
  const earlier = sorted.filter((d) => d < current)
  const previous = [...earlier].reverse().find(isMonday) || earlier[earlier.length - 1]
  return previous ? { current, previous } : { current, previous: null }
}

// Pestaña "Avances and warnings": arriba los warnings diarios de availability
// (AvailabilityWarnings) y abajo el avance de la semana en Brands with Markdown.
export default function AvancesWarningsPanel({ kam }) {
  const [brandRows, setBrandRows] = useState([])
  const [kamRows, setKamRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!kam) return
    let cancelled = false
    setLoading(true)
    Promise.all([
      supabase
        .from('brand_compensation_weekly')
        .select('snapshot_date, brand_key, brand_name, bucket, md_archie_final_pct')
        .eq('kam_id', kam.id),
      supabase
        .from('brands_md_weekly')
        .select('snapshot_date, brands_md_result, brands_md_target')
        .eq('kam_id', kam.id),
    ]).then(([brands, totals]) => {
      if (cancelled) return
      if (brands.error) console.error('❌ Error cargando avances por aliado:', brands.error)
      if (totals.error) console.error('❌ Error cargando avances por KAM:', totals.error)
      setBrandRows(brands.data || [])
      setKamRows(totals.data || [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [kam])

  const avance = useMemo(() => {
    const cmp = pickComparison([...kamRows, ...brandRows].map((r) => r.snapshot_date))
    if (!cmp || !cmp.previous) return cmp ? { ...cmp, incomplete: true } : null
    const { current, previous } = cmp

    const byDate = (date) => new Map(brandRows.filter((r) => r.snapshot_date === date).map((r) => [r.brand_key, r]))
    const now = byDate(current)
    const before = byDate(previous)
    const inMd = (r) => r != null && r.md_archie_final_pct != null && Number(r.md_archie_final_pct) >= MD_THRESHOLD

    const entered = []
    const exited = []
    for (const [key, r] of now) {
      if (inMd(r) && !inMd(before.get(key))) entered.push({ ...r, before: before.get(key) })
    }
    for (const [key, r] of before) {
      if (inMd(r) && !inMd(now.get(key))) exited.push({ ...r, now: now.get(key) })
    }
    entered.sort((a, b) => b.md_archie_final_pct - a.md_archie_final_pct)
    exited.sort((a, b) => (b.md_archie_final_pct ?? 0) - (a.md_archie_final_pct ?? 0))

    const totalsAt = (date) => kamRows.find((r) => r.snapshot_date === date) || null
    const totalsNow = totalsAt(current)
    const totalsBefore = totalsAt(previous)

    // El detalle por aliado de una foto puede tener menos aliados que el total
    // oficial del KAM (ej. la foto del 21/09 salió de un import de Excel al que
    // le faltaron filas): se avisa en vez de mostrar números que no cierran.
    const gaps = [[previous, before, totalsBefore], [current, now, totalsNow]]
      .map(([date, map, totals]) => {
        if (!totals) return null
        const counted = [...map.values()].filter(inMd).length
        return counted !== totals.brands_md_result ? { date, counted, official: totals.brands_md_result } : null
      })
      .filter(Boolean)

    return {
      current,
      previous,
      entered,
      exited,
      totalsNow,
      totalsBefore,
      gaps,
      monthChanged: current.slice(0, 7) !== previous.slice(0, 7),
    }
  }, [brandRows, kamRows])

  if (loading) return <><AvailabilityWarnings kam={kam} /><div className="no-data">Cargando avances...</div></>

  if (!avance || !avance.previous) {
    return (
      <>
        <AvailabilityWarnings kam={kam} />
        <div className="no-data">
          Todavía no hay dos fotos para comparar. Se guarda una por día (lunes a viernes) al sincronizar con Snowflake.
        </div>
      </>
    )
  }

  const { current, previous, entered, exited, totalsNow, totalsBefore, gaps, monthChanged } = avance
  const delta = totalsNow && totalsBefore ? totalsNow.brands_md_result - totalsBefore.brands_md_result : null
  const achieved = (t) => (t && t.brands_md_target > 0 ? (t.brands_md_result / t.brands_md_target) * 100 : null)
  const partial = !isMonday(current)

  return (
    <div className="fade-in">
      <AvailabilityWarnings kam={kam} />

      <div className="table-card">
        <div className="table-title">
          Brands with Markdown — {formatDate(previous)} → {formatDate(current)}
          {partial && <span className="avances-partial">semana en curso · al {formatDate(current)}</span>}
        </div>
        {monthChanged && (
          <p className="table-subtitle">
            ⚠️ Cambió el mes entre las dos fotos: los valores de compensation son acumulados del mes, así que la foto nueva arranca de cero.
          </p>
        )}
        {gaps.map((g) => (
          <p key={g.date} className="table-subtitle">
            ⚠️ El detalle por aliado del {formatDate(g.date)} suma {g.counted} brands con markdown y el total oficial es {g.official}: puede faltar algún aliado en la lista.
          </p>
        ))}

        <div className="md-target-stats">
          <div className="md-target-stat">
            <div className="md-target-stat-label">{formatDate(previous)}</div>
            <div className="md-target-stat-value">
              {totalsBefore ? totalsBefore.brands_md_result : '—'}
              {totalsBefore && <span className="md-target-stat-unit"> / {totalsBefore.brands_md_target} ({fmtPct(achieved(totalsBefore))})</span>}
            </div>
          </div>
          <div className="md-target-stat">
            <div className="md-target-stat-label">{formatDate(current)}</div>
            <div className="md-target-stat-value">
              {totalsNow ? totalsNow.brands_md_result : '—'}
              {totalsNow && <span className="md-target-stat-unit"> / {totalsNow.brands_md_target} ({fmtPct(achieved(totalsNow))})</span>}
            </div>
          </div>
          <div className="md-target-stat">
            <div className="md-target-stat-label">Avance de la semana</div>
            <div
              className="md-target-stat-value"
              style={{ color: delta > 0 ? 'var(--success)' : delta < 0 ? 'var(--danger)' : undefined }}
            >
              {delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta}`}
              <span className="md-target-stat-unit"> brands ({entered.length} entraron, {exited.length} salieron)</span>
            </div>
          </div>
        </div>
      </div>

      <div className="table-card">
        <div className="table-title">🟢 Entraron en markdown ({entered.length})</div>
        <p className="table-subtitle">Aliados que llegaron al {MD_THRESHOLD}% de su target de MD (MD archie) desde el {formatDate(previous)}.</p>
        {entered.length === 0 ? (
          <div className="no-data">Ningún aliado nuevo en markdown esta semana.</div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Aliado</th>
                  <th>Bucket</th>
                  <th>MD archie {formatDate(previous)}</th>
                  <th>MD archie {formatDate(current)}</th>
                </tr>
              </thead>
              <tbody>
                {entered.map((r) => (
                  <tr key={r.brand_key}>
                    <td><strong>{r.brand_name}</strong></td>
                    <td>{r.bucket || '—'}</td>
                    <td>{r.before ? fmtPct(r.before.md_archie_final_pct) : 'sin dato'}</td>
                    <td style={{ color: 'var(--success)', fontWeight: 700 }}>{fmtPct(r.md_archie_final_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="table-card">
        <div className="table-title">🔴 Salieron de markdown ({exited.length})</div>
        <p className="table-subtitle">Aliados que estaban en el {MD_THRESHOLD}% o más el {formatDate(previous)} y hoy están por debajo.</p>
        {exited.length === 0 ? (
          <div className="no-data">Ningún aliado salió de markdown esta semana.</div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Aliado</th>
                  <th>Bucket</th>
                  <th>MD archie {formatDate(previous)}</th>
                  <th>MD archie {formatDate(current)}</th>
                </tr>
              </thead>
              <tbody>
                {exited.map((r) => (
                  <tr key={r.brand_key}>
                    <td><strong>{r.brand_name}</strong></td>
                    <td>{r.bucket || r.now?.bucket || '—'}</td>
                    <td>{fmtPct(r.md_archie_final_pct)}</td>
                    <td style={{ color: 'var(--danger)', fontWeight: 700 }}>{r.now ? fmtPct(r.now.md_archie_final_pct) : 'sin dato'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
