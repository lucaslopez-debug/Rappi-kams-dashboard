// Sync de Compensation ("MD archie final" por aliado): Snowflake -> Supabase
// (brand_compensation_status). Reemplaza al botón "Importar Compensation".
//
// Fuente: DATA_ACHIEVEMENT_COMPENSATION_MONTH_RECOVERY_HISTORICO_Q4, la tabla
// mensual de compensación de Brand Development (una fila por aliado y mes,
// acumulado del mes a la fecha). MD_ACHI_BRAND = (MD_USD / GMV_USD) / TARGET_MES_MD,
// como fracción (1.0 = 100% del target); el "final" del reporte es ese valor
// con tope en 2 (200%).

const SOURCE_TABLE = 'RP_GOLD_DB_PROD.RESTAURANTES_GLOBAL_MDA.DATA_ACHIEVEMENT_COMPENSATION_MONTH_RECOVERY_HISTORICO_Q4'
const COUNTRY = 'AR'
const ACHIEVEMENT_CAP = 2

// Fecha de la foto semanal (brand_compensation_weekly / brands_md_weekly) en
// hora de Argentina: la corrida del lunes queda con la fecha de ese lunes.
function snapshotDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date())
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

// Mes en curso (el último que tenga la tabla). Mismo criterio que el reporte
// de Compensation: solo aliados con target de MD y ventas en el mes — sin
// alguno de los dos no hay % de cumplimiento que mostrar.
function buildCompensationQuery(kamEmails) {
  const emails = kamEmails.map((e) => sqlString(e.toLowerCase())).join(', ')
  return `
    SELECT
      COUNTRY_BRAND_ID AS brand_key,
      BRAND_ID AS brand_id,
      BRAND_NAME AS brand_name,
      LOWER(BRAND_OWNER_EMAIL) AS kam_email,
      BUCKET AS bucket,
      TO_VARCHAR(MONTH, 'YYYY-MM-DD') AS month,
      MD_ACHI_BRAND AS md_achi_brand
    FROM ${SOURCE_TABLE}
    WHERE COUNTRY = '${COUNTRY}'
      AND MONTH = (SELECT MAX(MONTH) FROM ${SOURCE_TABLE} WHERE COUNTRY = '${COUNTRY}')
      AND LOWER(BRAND_OWNER_EMAIL) IN (${emails})
      AND TARGET_MES_MD > 0
      AND GMV_USD > 0
      AND MD_ACHI_BRAND IS NOT NULL
  `
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

// snapshotOnly: solo guarda la foto del día (brand_compensation_weekly) para
// "Avances semanales", sin tocar brand_compensation_status — así la foto se
// actualiza todos los días y el resto de la app sigue comparando lunes a lunes.
async function writeCompensation(supabase, sfRows, kams, { snapshotOnly = false } = {}) {
  if (!sfRows.length) throw new Error('Snowflake no devolvió filas de Compensation.')

  const kamByEmail = new Map(kams.map((k) => [k.email.toLowerCase(), k]))

  // Mismo criterio que Availability: si el aliado existe en weekly_data se usa
  // SU nombre, así el cruce por nombre que hacen las tablas de la app es exacto.
  const weekly = await fetchAll(supabase, 'weekly_data', 'brand_id, brand_name')
  const appNameById = new Map()
  weekly.forEach((r) => {
    if (r.brand_id && r.brand_name !== 'TOTAL_KAM') appNameById.set(String(r.brand_id), r.brand_name)
  })

  const updatedAt = new Date().toISOString()
  const byKey = new Map()
  const bucketByKey = new Map()
  let capped = 0

  for (const r of sfRows) {
    const kam = kamByEmail.get(r.KAM_EMAIL)
    if (!kam) continue
    const achievement = Number(r.MD_ACHI_BRAND)
    if (!Number.isFinite(achievement)) continue
    if (achievement > ACHIEVEMENT_CAP) capped++

    // Siempre en puntos porcentuales (1.6857 -> 168.57). El import de Excel
    // escalaba solo los valores <= 1 y dejaba los de 100%-200% como 1.x.
    bucketByKey.set(`${kam.id}|${r.BRAND_KEY}`, r.BUCKET || null)
    byKey.set(`${kam.id}|${r.BRAND_KEY}`, {
      kam_id: kam.id,
      brand_key: r.BRAND_KEY,
      brand_name: appNameById.get(String(r.BRAND_ID)) || r.BRAND_NAME,
      // toPrecision(15) saca el ruido de punto flotante del *100
      // (1.68567933 * 100 = 168.56793299999998 -> 168.567933).
      md_archie_final_pct: Number((Math.min(achievement, ACHIEVEMENT_CAP) * 100).toPrecision(15)),
      updated_at: updatedAt,
    })
  }

  const updates = [...byKey.values()]
  if (!updates.length) throw new Error('Ningún aliado de Snowflake coincidió con los KAMs del equipo.')

  const CHUNK = 500
  let removed = 0
  if (!snapshotOnly) {
    for (let i = 0; i < updates.length; i += CHUNK) {
      const { error } = await supabase
        .from('brand_compensation_status')
        .upsert(updates.slice(i, i + CHUNK), { onConflict: 'kam_id,brand_key' })
      if (error) throw error
    }

    // Recién con el upsert completo OK se borra lo que no vino en esta corrida.
    const { error: deleteError, count } = await supabase
      .from('brand_compensation_status')
      .delete({ count: 'exact' })
      .lt('updated_at', updatedAt)
    if (deleteError) throw deleteError
    removed = count || 0
  }

  // Foto de la semana para "Avances semanales": misma data + bucket, con la
  // fecha de hoy. Si se vuelve a correr el mismo día, pisa la foto de ese día.
  const date = snapshotDate()
  const snapshot = updates.map((u) => ({
    snapshot_date: date,
    kam_id: u.kam_id,
    brand_key: u.brand_key,
    brand_name: u.brand_name,
    bucket: bucketByKey.get(`${u.kam_id}|${u.brand_key}`),
    md_archie_final_pct: u.md_archie_final_pct,
    updated_at: updatedAt,
  }))
  for (let i = 0; i < snapshot.length; i += CHUNK) {
    const { error } = await supabase
      .from('brand_compensation_weekly')
      .upsert(snapshot.slice(i, i + CHUNK), { onConflict: 'snapshot_date,kam_id,brand_key' })
    if (error) throw error
  }
  const { error: snapDeleteError } = await supabase
    .from('brand_compensation_weekly')
    .delete()
    .eq('snapshot_date', date)
    .lt('updated_at', updatedAt)
  if (snapDeleteError) throw snapDeleteError

  return {
    snapshotDate: date,
    upserted: updates.length,
    removed,
    kams: new Set(updates.map((u) => u.kam_id)).size,
    month: sfRows[0].MONTH,
    capped,
  }
}

module.exports = { SOURCE_TABLE, buildCompensationQuery, writeCompensation, snapshotDate }
