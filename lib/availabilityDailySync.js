// Availability DIARIA por aliado: Snowflake -> Supabase (brand_availability_daily).
// Alimenta los warnings de "Avances and warnings" (aliados en 0% o con caída
// brusca el día anterior). Misma fuente y mismo criterio que availabilitySync.js
// (validado 100% contra Power BI), pero sin agrupar por semana: una fila por
// aliado y día. No toca brand_availability_status (eso se actualiza los lunes).
const { SOURCE_TABLE, fetchAll } = require('./availabilitySync')

const COUNTRY = 'AR'
// Días hacia atrás que se (re)escriben en cada corrida: cubren el día anterior,
// el fin de semana si la corrida es un lunes, y la base de 7 días para detectar
// caídas. Snowflake a veces corrige horas configuradas de días pasados, por eso
// se reescriben en vez de agregar solo el último.
const LOOKBACK_DAYS = 15
const RETENTION_DAYS = 60

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function buildAvailabilityDailyQuery(kamEmails) {
  const emails = kamEmails.map((e) => sqlString(e.toLowerCase())).join(', ')
  return `
    SELECT
      LOWER(BRAND_OWNER_EMAIL) AS kam_email,
      BRAND_ID AS brand_id,
      ANY_VALUE(BRAND_NAME) AS brand_name,
      TO_VARCHAR(DATE_AVAILABILITY, 'YYYY-MM-DD') AS day,
      SUM(AVAILABLE_) AS available,
      SUM(SHOULD_BE_AVAILABLE) AS should_be_available,
      COUNT(DISTINCT STORE_ID) AS stores,
      COUNT(DISTINCT IFF(SHOULD_BE_AVAILABLE > 0 AND AVAILABLE_ = 0, STORE_ID, NULL)) AS stores_zero
    FROM ${SOURCE_TABLE}
    WHERE COUNTRY = '${COUNTRY}'
      AND DATE_AVAILABILITY >= DATEADD(day, -${LOOKBACK_DAYS}, CURRENT_DATE())
      AND LOWER(BRAND_OWNER_EMAIL) IN (${emails})
    GROUP BY 1, 2, 4
  `
}

async function writeAvailabilityDaily(supabase, sfRows, kams) {
  if (!sfRows.length) throw new Error('Snowflake no devolvió filas de availability diaria.')

  const kamByEmail = new Map(kams.map((k) => [k.email.toLowerCase(), k]))

  // Mismo cruce que availabilitySync: si el aliado está en weekly_data se usan
  // su kam_id y su nombre (así coincide con el resto de la app).
  const weekly = await fetchAll(supabase, 'weekly_data', 'kam_id, brand_id, brand_name')
  const appBrandById = new Map()
  weekly.forEach((r) => {
    if (r.brand_id && r.brand_name !== 'TOTAL_KAM') appBrandById.set(String(r.brand_id), { kam_id: r.kam_id, brand_name: r.brand_name })
  })

  // Un aliado con locales de más de un KAM: se queda con el que concentra más
  // horas configuradas en el período (igual que el sync semanal).
  const weightByBrandKam = new Map()
  for (const r of sfRows) {
    const kam = kamByEmail.get(r.KAM_EMAIL)
    if (!kam) continue
    const key = `${r.BRAND_ID}|${kam.id}`
    weightByBrandKam.set(key, (weightByBrandKam.get(key) || 0) + (Number(r.SHOULD_BE_AVAILABLE) || 0))
  }
  const ownerKamByBrand = new Map()
  for (const [key, weight] of weightByBrandKam) {
    const [brandId, kamId] = key.split('|')
    const best = ownerKamByBrand.get(brandId)
    if (!best || weight > best.weight) ownerKamByBrand.set(brandId, { kamId: Number(kamId), weight })
  }

  const updatedAt = new Date().toISOString()
  const byKey = new Map()
  for (const r of sfRows) {
    const kam = kamByEmail.get(r.KAM_EMAIL)
    if (!kam) continue
    const brandKey = String(r.BRAND_ID)
    const appBrand = appBrandById.get(brandKey)
    const kamId = appBrand ? appBrand.kam_id : ownerKamByBrand.get(brandKey).kamId
    const key = `${r.DAY}|${kamId}|${brandKey}`
    // Si el aliado tenía locales de dos KAMs se suman en una sola fila.
    const acc = byKey.get(key) || {
      day: r.DAY,
      kam_id: kamId,
      brand_key: brandKey,
      brand_name: appBrand ? appBrand.brand_name : r.BRAND_NAME,
      available: 0,
      should_be_available: 0,
      stores: 0,
      stores_zero: 0,
      updated_at: updatedAt,
    }
    acc.available += Number(r.AVAILABLE) || 0
    acc.should_be_available += Number(r.SHOULD_BE_AVAILABLE) || 0
    acc.stores += Number(r.STORES) || 0
    acc.stores_zero += Number(r.STORES_ZERO) || 0
    byKey.set(key, acc)
  }

  const rows = [...byKey.values()]
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from('brand_availability_daily')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'day,kam_id,brand_key' })
    if (error) throw error
  }

  // Dentro del período reescrito, lo que no vino en esta corrida ya no aplica
  // (ej. aliado que cambió de KAM); fuera del período, solo se poda lo viejo.
  const days = [...new Set(rows.map((r) => r.day))].sort()
  const { error: staleError } = await supabase
    .from('brand_availability_daily')
    .delete()
    .gte('day', days[0])
    .in('kam_id', kams.map((k) => k.id))
    .lt('updated_at', updatedAt)
  if (staleError) throw staleError

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10)
  const { error: pruneError } = await supabase.from('brand_availability_daily').delete().lt('day', cutoff)
  if (pruneError) throw pruneError

  return { rows: rows.length, firstDay: days[0], lastDay: days[days.length - 1] }
}

module.exports = { buildAvailabilityDailyQuery, writeAvailabilityDaily }
