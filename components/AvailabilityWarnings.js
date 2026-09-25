'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'

// Caída "brusca": el día contra el promedio de los 7 días anteriores, en
// puntos de availability. Umbral de arranque — ajustable acá.
const DROP_THRESHOLD_PTS = 20
const BASELINE_DAYS = 7

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

function formatDay(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'UTC' })
}

const TZ = 'America/Argentina/Buenos_Aires'
// Cada cuánto se vuelve a consultar si hubo una actualización nueva, para que
// la alerta pase a verde (y los datos se refresquen) sin recargar la página.
const FRESHNESS_POLL_MS = 5 * 60 * 1000

// Fecha (AAAA-MM-DD) y hora en Argentina de un instante dado
function localDate(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date)
}

function localTime(date) {
  return date.toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}

// La carga automática corre de lunes a viernes: sábado y domingo alcanza con
// que se haya actualizado el viernes.
function expectedUpdateDate(now) {
  const today = localDate(now)
  const weekday = new Date(today + 'T12:00:00Z').getUTCDay()
  if (weekday === 6) return addDays(today, -1)
  if (weekday === 0) return addDays(today, -2)
  return today
}

function pct(available, shouldBe) {
  return shouldBe > 0 ? (available / shouldBe) * 100 : null
}

// Supabase corta cada respuesta en 1000 filas y un KAM puede tener ~100
// aliados x ~15 días, así que se pagina.
async function fetchDaily(kamId) {
  const PAGE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('brand_availability_daily')
      .select('day, brand_key, brand_name, available, should_be_available, stores, stores_zero')
      .eq('kam_id', kamId)
      .order('day')
      .range(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PAGE) return rows
  }
}

export default function AvailabilityWarnings({ kam }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedDay, setSelectedDay] = useState(null)
  // Última corrida de la carga diaria (es una sola para todos los KAMs).
  const [lastUpdate, setLastUpdate] = useState(null)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      const { data, error } = await supabase
        .from('brand_availability_daily')
        .select('updated_at, day')
        .order('updated_at', { ascending: false })
        .limit(1)
      if (cancelled) return
      if (error) { console.error('❌ Error consultando la última actualización:', error); return }
      setNow(new Date())
      if (data?.[0]) setLastUpdate(data[0].updated_at)
    }
    check()
    const interval = setInterval(check, FRESHNESS_POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  // Se recarga al cambiar de KAM y cada vez que aparece una actualización nueva.
  useEffect(() => {
    if (!kam) return
    let cancelled = false
    setLoading(true)
    fetchDaily(kam.id)
      .then((data) => { if (!cancelled) setRows(data) })
      .catch((err) => console.error('❌ Error cargando availability diaria:', err))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [kam, lastUpdate])

  const freshness = useMemo(() => {
    if (!lastUpdate) return null
    const updated = new Date(lastUpdate)
    const updatedDate = localDate(updated)
    const expected = expectedUpdateDate(now)
    const updatedToday = updatedDate === localDate(now)
    return {
      ok: updatedDate >= expected,
      label: `${updatedToday ? 'hoy' : `el ${formatDay(updatedDate)}`} a las ${localTime(updated)} hs`,
    }
  }, [lastUpdate, now])

  const days = useMemo(() => [...new Set(rows.map((r) => r.day))].sort(), [rows])
  // Días elegibles: los que tienen 7 días de historia antes para comparar.
  const selectableDays = useMemo(() => days.filter((d) => d >= addDays(days[0] || d, BASELINE_DAYS)).reverse().slice(0, 7), [days])
  const day = selectedDay && selectableDays.includes(selectedDay) ? selectedDay : selectableDays[0]

  const warnings = useMemo(() => {
    if (!day) return []
    const byBrand = new Map()
    rows.forEach((r) => {
      if (!byBrand.has(r.brand_key)) byBrand.set(r.brand_key, new Map())
      byBrand.get(r.brand_key).set(r.day, r)
    })

    const result = []
    for (const [brandKey, byDay] of byBrand) {
      const today = byDay.get(day)
      const shouldBe = Number(today?.should_be_available)
      // Sin horas configuradas ese día (cerrado) no hay nada que medir.
      if (!today || !(shouldBe > 0)) continue
      const value = pct(Number(today.available), shouldBe)

      let baseAvail = 0
      let baseShould = 0
      for (let i = 1; i <= BASELINE_DAYS; i++) {
        const r = byDay.get(addDays(day, -i))
        if (r) { baseAvail += Number(r.available); baseShould += Number(r.should_be_available) }
      }
      const baseline = pct(baseAvail, baseShould)

      // Días seguidos en 0 hasta el día elegido (los días cerrados no cortan
      // la racha). Si llega al primer día con datos, se muestra como "N+".
      let streak = 0
      let reachedStart = false
      for (let d = day; ; d = addDays(d, -1)) {
        if (d < days[0]) { reachedStart = true; break }
        const r = byDay.get(d)
        if (!r || !(Number(r.should_be_available) > 0)) continue
        if (Number(r.available) === 0) streak++
        else break
      }

      let type = null
      if (value === 0) type = streak === 1 ? 'new_zero' : 'zero'
      else if (baseline != null && baseline - value >= DROP_THRESHOLD_PTS) type = 'drop'
      if (!type) continue

      result.push({
        brandKey,
        name: today.brand_name,
        type,
        value,
        baseline,
        drop: baseline != null ? value - baseline : null,
        streak,
        streakLabel: reachedStart ? `${streak}+` : String(streak),
        stores: today.stores,
        storesZero: today.stores_zero,
      })
    }

    // Primero lo nuevo (cayó a 0 ese día), después las caídas más fuertes y al
    // final los que ya venían en 0 (de la racha más corta a la más larga).
    const rank = { new_zero: 0, drop: 1, zero: 2 }
    return result.sort((a, b) =>
      rank[a.type] - rank[b.type] ||
      (a.type === 'drop' ? a.drop - b.drop : 0) ||
      (a.type === 'zero' ? a.streak - b.streak : 0) ||
      a.name.localeCompare(b.name)
    )
  }, [rows, days, day])

  const count = (t) => warnings.filter((w) => w.type === t).length

  return (
    <div className="table-card fade-in">
      <div className="table-header-row">
        <div className="table-title">⚠️ Warnings de availability</div>
        {selectableDays.length > 0 && (
          <select className="control-select" value={day} onChange={(e) => setSelectedDay(e.target.value)}>
            {selectableDays.map((d) => <option key={d} value={d}>{formatDay(d)}</option>)}
          </select>
        )}
      </div>
      {freshness && (
        <div className={`freshness-alert ${freshness.ok ? 'freshness-ok' : 'freshness-stale'}`} role="status">
          <span className="freshness-dot" aria-hidden="true" />
          {freshness.ok ? (
            <span><strong>Actualizado</strong> {freshness.label}{day ? ` · datos hasta el ${formatDay(days[days.length - 1])}` : ''}</span>
          ) : (
            <span>
              <strong>Sin actualizar hoy</strong> · última actualización: {freshness.label}. La carga diaria corre a las 10:00 (PC prendida, VPN de Rappi y login de Snowflake aprobado).
            </span>
          )}
        </div>
      )}
      <p className="table-subtitle">
        Aliados que el día elegido tuvieron availability en 0% o cayeron {DROP_THRESHOLD_PTS} puntos o más contra su promedio de los {BASELINE_DAYS} días anteriores. Por defecto se muestra el último día con datos (ayer).
      </p>

      {loading ? (
        <div className="no-data">Cargando availability diaria...</div>
      ) : !day ? (
        <div className="no-data">Todavía no hay availability diaria cargada para este KAM.</div>
      ) : warnings.length === 0 ? (
        <div className="no-data">✅ Sin warnings el {formatDay(day)}: ningún aliado en 0% ni con caídas bruscas.</div>
      ) : (
        <>
          <div className="warnings-summary">
            <span className="warning-badge warning-new-zero">🔴 Cayeron a 0%: {count('new_zero')}</span>
            <span className="warning-badge warning-drop">🟠 Caída brusca: {count('drop')}</span>
            <span className="warning-badge warning-zero">⚫ Siguen en 0%: {count('zero')}</span>
          </div>
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Warning</th>
                  <th>Aliado</th>
                  <th>Locales en 0</th>
                  <th>Availability {formatDay(day)}</th>
                  <th>Promedio {BASELINE_DAYS} días previos</th>
                  <th>Variación</th>
                  <th>Días seguidos en 0</th>
                </tr>
              </thead>
              <tbody>
                {warnings.map((w) => (
                  <tr key={w.brandKey}>
                    <td>
                      {w.type === 'new_zero' && <span className="warning-badge warning-new-zero">🔴 Cayó a 0%</span>}
                      {w.type === 'drop' && <span className="warning-badge warning-drop">🟠 Caída brusca</span>}
                      {w.type === 'zero' && <span className="warning-badge warning-zero">⚫ Sigue en 0%</span>}
                    </td>
                    <td><strong>{w.name}</strong></td>
                    <td>{w.storesZero} de {w.stores}</td>
                    <td style={{ color: 'var(--danger)', fontWeight: 700 }}>{w.value.toFixed(2)}%</td>
                    <td>{w.baseline == null ? '—' : `${w.baseline.toFixed(2)}%`}</td>
                    <td style={{ color: 'var(--danger)', fontWeight: 700 }}>{w.drop == null ? '—' : `${w.drop.toFixed(1)} pts`}</td>
                    <td>{w.streak > 0 ? w.streakLabel : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
