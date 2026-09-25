// Sync de Availability: Snowflake -> Supabase (brand_availability_status).
// Reemplaza al botón "Importar Availability" (el Excel que se bajaba de Power
// BI): lee la misma fuente que ese dashboard, PP_AVAILABILITY_DASH_AVAILABILITY_DATASET.
//
// Lo usan Scripts/sync-snowflake.js (corrida local) y, cuando haya usuario
// de servicio de Snowflake, un endpoint de cron en Vercel. Este módulo no se
// conecta a Snowflake: arma la consulta y procesa las filas que devuelva.

const SOURCE_TABLE = 'RP_SILVER_DB_PROD.GLOBAL_REST_CATALOG.PP_AVAILABILITY_DASH_AVAILABILITY_DATASET'
const COUNTRY = 'AR'
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Mismo formato de label que usa el resto de la app ("21 Sep"). SEMANA viene
// como "AAAA-MM-DD" (lunes de la semana).
function formatWeekLabel(isoDate) {
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return null
  return `${String(d).padStart(2, '0')} ${MONTH_ABBR[m - 1]}`
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

// Trae SUMAS (no el cociente) de las dos últimas semanas: la división se hace
// acá en JS con precisión completa. Si se divide en Snowflake, el NUMBER
// resultante queda redondeado a 6 decimales y no coincide exacto con Power BI.
// La semana en curso viene parcial (hasta ayer), igual que en el dashboard.
function buildAvailabilityQuery(kamEmails) {
  const emails = kamEmails.map((e) => sqlString(e.toLowerCase())).join(', ')
  return `
    WITH weeks AS (
      SELECT DISTINCT SEMANA_AVAILABILITY AS semana
      FROM ${SOURCE_TABLE}
      WHERE COUNTRY = '${COUNTRY}'
      ORDER BY semana DESC
      LIMIT 2
    )
    SELECT
      LOWER(BRAND_OWNER_EMAIL) AS kam_email,
      BRAND_ID AS brand_id,
      ANY_VALUE(BRAND_NAME) AS brand_name,
      TO_VARCHAR(SEMANA_AVAILABILITY, 'YYYY-MM-DD') AS semana,
      TO_VARCHAR(MAX(DATE_AVAILABILITY), 'YYYY-MM-DD') AS ultimo_dia,
      SUM(AVAILABLE_) AS available,
      SUM(SHOULD_BE_AVAILABLE) AS should_be_available
    FROM ${SOURCE_TABLE}
    WHERE COUNTRY = '${COUNTRY}'
      AND SEMANA_AVAILABILITY IN (SELECT semana FROM weeks)
      AND LOWER(BRAND_OWNER_EMAIL) IN (${emails})
    GROUP BY 1, 2, 4
  `
}

function ratioPct(available, shouldBe) {
  const a = Number(available)
  const s = Number(shouldBe)
  if (!Number.isFinite(a) || !Number.isFinite(s) || s <= 0) return null
  return (a / s) * 100
}

async function fetchAll(supabase, table, columns) {
  const PAGE_SIZE = 1000
  const all = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    all.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) return all
  }
}

async function loadKams(supabase) {
  const { data, error } = await supabase.from('kams').select('id, nombre, email')
  if (error) throw error
  return (data || []).filter((k) => k.email)
}

// sfRows: resultado de buildAvailabilityQuery (columnas en mayúscula, como las
// devuelve Snowflake). Pisa brand_availability_status con la foto actual y
// borra las filas que ya no vinieron (aliados que cambiaron de KAM o dejaron
// de estar en la cartera).
async function writeAvailability(supabase, sfRows, kams) {
  if (!sfRows.length) throw new Error('Snowflake no devolvió filas de availability.')

  const kamByEmail = new Map(kams.map((k) => [k.email.toLowerCase(), k]))
  const weeks = [...new Set(sfRows.map((r) => r.SEMANA))].sort()
  if (weeks.length < 2) throw new Error(`Se esperaban 2 semanas y vinieron ${weeks.length}.`)
  const [previousWeek, currentWeek] = weeks.slice(-2)

  // Las tablas de la app muestran availability cruzando por nombre de aliado
  // contra weekly_data, dentro del KAM activo — así que cuando el brand_id
  // existe en weekly_data se guardan SU nombre y SU kam_id, para que el cruce
  // sea exacto aunque Snowflake tenga el nombre escrito distinto.
  const weekly = await fetchAll(supabase, 'weekly_data', 'kam_id, brand_id, brand_name, semana_fecha')
  const appBrandById = new Map()
  weekly.forEach((r) => {
    if (!r.brand_id || r.brand_name === 'TOTAL_KAM') return
    appBrandById.set(String(r.brand_id), { kam_id: r.kam_id, brand_name: r.brand_name })
  })

  // Un aliado puede tener locales asignados a más de un KAM del equipo: se
  // queda con el KAM que concentra más horas configuradas.
  const byBrand = new Map()
  for (const r of sfRows) {
    const kam = kamByEmail.get(r.KAM_EMAIL)
    if (!kam) continue
    const brandKey = String(r.BRAND_ID)
    if (!byBrand.has(brandKey)) byBrand.set(brandKey, new Map())
    const perKam = byBrand.get(brandKey)
    if (!perKam.has(kam.id)) perKam.set(kam.id, { kam, name: r.BRAND_NAME, weeks: {}, weight: 0, lastDay: null })
    const acc = perKam.get(kam.id)
    acc.weeks[r.SEMANA] = { available: Number(r.AVAILABLE), shouldBe: Number(r.SHOULD_BE_AVAILABLE) }
    acc.weight += Number(r.SHOULD_BE_AVAILABLE) || 0
    if (r.SEMANA === currentWeek) acc.lastDay = r.ULTIMO_DIA
  }

  const updatedAt = new Date().toISOString()
  const updates = []
  const kamMismatch = []
  let notInApp = 0
  let dataThrough = null

  for (const [brandKey, perKam] of byBrand) {
    const best = [...perKam.values()].sort((a, b) => b.weight - a.weight)[0]
    const cur = best.weeks[currentWeek]
    const availabilityCurrent = cur ? ratioPct(cur.available, cur.shouldBe) : null
    // Igual que el import de Excel: sin dato de la semana actual no se carga.
    if (availabilityCurrent === null) continue
    const prev = best.weeks[previousWeek]

    const appBrand = appBrandById.get(brandKey)
    if (!appBrand) notInApp++
    else if (appBrand.kam_id !== best.kam.id) kamMismatch.push(`${appBrand.brand_name} (Snowflake: ${best.kam.nombre})`)

    if (best.lastDay && (!dataThrough || best.lastDay > dataThrough)) dataThrough = best.lastDay

    updates.push({
      kam_id: appBrand ? appBrand.kam_id : best.kam.id,
      brand_key: brandKey,
      brand_name: appBrand ? appBrand.brand_name : best.name,
      availability_current: availabilityCurrent,
      availability_previous: prev ? ratioPct(prev.available, prev.shouldBe) : null,
      current_week: formatWeekLabel(currentWeek),
      previous_week: formatWeekLabel(previousWeek),
      updated_at: updatedAt,
    })
  }

  if (!updates.length) throw new Error('Ningún aliado de Snowflake coincidió con los KAMs del equipo.')

  const CHUNK = 500
  for (let i = 0; i < updates.length; i += CHUNK) {
    const { error } = await supabase
      .from('brand_availability_status')
      .upsert(updates.slice(i, i + CHUNK), { onConflict: 'kam_id,brand_key' })
    if (error) throw error
  }

  // Recién con el upsert completo OK se borra lo viejo (todo lo que no se tocó
  // en esta corrida), así una falla a mitad de camino nunca deja la tabla vacía.
  const { error: deleteError, count: removed } = await supabase
    .from('brand_availability_status')
    .delete({ count: 'exact' })
    .in('kam_id', kams.map((k) => k.id))
    .lt('updated_at', updatedAt)
  if (deleteError) throw deleteError

  return {
    upserted: updates.length,
    removed: removed || 0,
    kams: new Set(updates.map((u) => u.kam_id)).size,
    previousWeek: formatWeekLabel(previousWeek),
    currentWeek: formatWeekLabel(currentWeek),
    dataThrough,
    notInApp,
    kamMismatch,
  }
}

module.exports = { SOURCE_TABLE, buildAvailabilityQuery, loadKams, writeAvailability, fetchAll }
