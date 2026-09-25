// Sync de Brands with Markdown (Result / Target por KAM): Snowflake -> Supabase
// (brand_markdown_status). Reemplaza al botón "Importar Excel" (archivo de
// comisiones con columnas Comercial / Brands w/MD Result / Brands w/MD Target).
//
// Fuente: DATA_ACHIEVEMENT_MONTH_COMPENSATION_BYKAM_HISTORICO_V1_Q4, la
// compensación mensual por KAM (mes en curso, acumulado a la fecha). Validado:
// BRANDS_WITH_MD_RESULT = cantidad de aliados del KAM con MD_ACHI_BRAND >= 0.8
// en la tabla de compensation por aliado (ver lib/compensationSync.js).

const { snapshotDate } = require('./compensationSync')

const SOURCE_TABLE = 'RP_GOLD_DB_PROD.RESTAURANTES_GLOBAL_MDA.DATA_ACHIEVEMENT_MONTH_COMPENSATION_BYKAM_HISTORICO_V1_Q4'
const COUNTRY = 'AR'

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function buildBrandsWithMdQuery(kamEmails) {
  const emails = kamEmails.map((e) => sqlString(e.toLowerCase())).join(', ')
  return `
    SELECT
      LOWER(COMERCIAL) AS kam_email,
      TO_VARCHAR(MONTH, 'YYYY-MM-DD') AS month,
      BRANDS_WITH_MD_RESULT AS result,
      BRAND_WITH_MD_TGT AS target
    FROM ${SOURCE_TABLE}
    WHERE COUNTRY = '${COUNTRY}'
      AND MONTH = (SELECT MAX(MONTH) FROM ${SOURCE_TABLE} WHERE COUNTRY = '${COUNTRY}')
      AND LOWER(COMERCIAL) IN (${emails})
  `
}

// snapshotOnly: solo la foto del día (brands_md_weekly), ver compensationSync.js.
async function writeBrandsWithMd(supabase, sfRows, kams, { snapshotOnly = false } = {}) {
  const kamByEmail = new Map(kams.map((k) => [k.email.toLowerCase(), k]))
  const seen = new Set()
  const updatedAt = new Date().toISOString()
  const updates = []
  const noTarget = []

  for (const r of sfRows) {
    const kam = kamByEmail.get(r.KAM_EMAIL)
    if (!kam) continue
    // Una fila por KAM y mes: si viniera repetida es un problema de la fuente
    // y no hay forma segura de elegir, así que se corta en vez de adivinar.
    if (seen.has(kam.id)) throw new Error(`${kam.email} vino más de una vez en ${SOURCE_TABLE}.`)
    seen.add(kam.id)

    // Un KAM nuevo puede no tener target cargado todavía (TGT = NULL). Number(null)
    // daría 0 y la app dividiría por cero: se saltea y se informa.
    if (r.RESULT == null || r.TARGET == null) {
      noTarget.push(kam.nombre)
      continue
    }
    const result = Number(r.RESULT)
    const target = Number(r.TARGET)
    if (!Number.isFinite(result) || !Number.isFinite(target) || target <= 0) {
      noTarget.push(kam.nombre)
      continue
    }

    updates.push({
      kam_id: kam.id,
      email: kam.email,
      brands_md_result: result,
      brands_md_target: target,
      updated_at: updatedAt,
    })
  }

  if (!updates.length) throw new Error('Ningún KAM del equipo vino en Brands with Markdown.')

  if (!snapshotOnly) {
    const { error } = await supabase.from('brand_markdown_status').upsert(updates, { onConflict: 'kam_id' })
    if (error) throw error
  }

  // Foto semanal de los totales por KAM (ver compensationSync.js).
  const date = snapshotDate()
  const { error: snapError } = await supabase.from('brands_md_weekly').upsert(
    updates.map((u) => ({
      snapshot_date: date,
      kam_id: u.kam_id,
      brands_md_result: u.brands_md_result,
      brands_md_target: u.brands_md_target,
      updated_at: updatedAt,
    })),
    { onConflict: 'snapshot_date,kam_id' }
  )
  if (snapError) throw snapError

  const missing = kams.filter((k) => !seen.has(k.id)).map((k) => k.nombre)
  return { upserted: updates.length, month: sfRows[0]?.MONTH, missing, noTarget }
}

module.exports = { SOURCE_TABLE, buildBrandsWithMdQuery, writeBrandsWithMd }
