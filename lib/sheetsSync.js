// Sync del Google Sheet -> Supabase (weekly_data: órdenes, markdown % y tráfico
// por aliado y semana, más una fila TOTAL_KAM por KAM y semana). Lo usan el
// cron de Vercel (app/api/sync) y la corrida local (Scripts/sync-sheets.js).
//
// Los KAMs salen de la tabla `kams` (email -> id): para sumar un KAM alcanza
// con agregarlo ahí, sin tocar código.

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// La pestaña "raw" trae la fecha como "AAAA-MM-DD" (el lunes de esa semana);
// la app usa el label "DD Mon" para la misma semana.
function formatWeekLabel(isoDate) {
  const [y, m, d] = String(isoDate || '').split('-').map(Number)
  if (!y || !m || !d) return null
  return `${String(d).padStart(2, '0')} ${MONTH_ABBR[m - 1]}`
}

async function loadKamsMap(supabase) {
  const { data, error } = await supabase.from('kams').select('id, nombre, email')
  if (error) throw error
  const map = {}
  for (const k of data || []) {
    if (k.email) map[k.email.toLowerCase().trim()] = { id: k.id, nombre: k.nombre }
  }
  return map
}

// onlyEmails: si viene, procesa solo esos KAMs (ej. KAMs recién sumados) y no
// borra nada — el resto de la tabla queda exactamente como estaba.
async function syncWeeklyFromSheet({ supabase, sheets, spreadsheetId, onlyEmails = null }) {
  // Timestamp de este run: se graba en updated_at de cada fila que tocamos.
  const runStartedAt = new Date().toISOString()

  let KAMS_MAP = await loadKamsMap(supabase)
  const scoped = Array.isArray(onlyEmails) && onlyEmails.length > 0
  if (scoped) {
    const wanted = new Set(onlyEmails.map((e) => e.toLowerCase().trim()))
    KAMS_MAP = Object.fromEntries(Object.entries(KAMS_MAP).filter(([email]) => wanted.has(email)))
    const missing = [...wanted].filter((e) => !KAMS_MAP[e])
    if (missing.length) throw new Error(`No están en la tabla kams: ${missing.join(', ')}`)
  }

  // Leemos TODO (orders, markdown, tráfico) desde "raw" — la consulta cruda a
  // Snowflake — y NO desde el pivot "dashboard weekly". El pivot tiene
  // filtros de Líder/KAM compartidos que cualquier persona del equipo puede
  // cambiar en cualquier momento; si sincronizáramos desde ahí, cada corrida
  // traería datos distintos según quién haya tocado el filtro por última vez.
  // Columnas de "raw" (fila 13 en adelante): [_, WEEK, BRAND_ID, BRAND_NAME,
  // BRAND_OWNER_LEADER, BRAND_OWNER_EMAIL, BRAND_CATEGORY,
  // BUCKET_CLASSIFICATION, TOTAL_ORDERS, TOTAL_USERS, GMV_USD, GMV_PRIME,
  // SS, MKD, MKD_PRIME, REVENUE_GROSS, REVENUE_NET].
  // markdown% = MKD/GMV_USD*100 y tráfico = SS — confirmado contra la
  // fórmula real del pivot y contra los valores que ya veníamos usando.
  const rawResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'raw'!A13:Q30000",
  })
  const rawRows = rawResponse.data.values || []

  // Semanas: las últimas 8 que aparezcan en "raw" (columna WEEK, formato
  // AAAA-MM-DD, ordena bien como string). Filtramos por el patrón exacto
  // para descartar filas vacías o basura que no sean una fecha real.
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
  const semanasIso = [...new Set(rawRows.map((r) => r[1]).filter((v) => ISO_DATE_RE.test(v || '')))].sort()
  const fechas = semanasIso.slice(-8).map(formatWeekLabel)

  const kamSummary = {}
  Object.entries(KAMS_MAP).forEach(([email, kam]) => {
    kamSummary[email] = { id: kam.id, nombre: kam.nombre, brandIds: new Set(), semanas: {} }
    fechas.forEach((fecha) => {
      kamSummary[email].semanas[fecha] = { orders: 0, markdown: 0, trafico: 0, brandIds: new Set() }
    })
  })

  let processedBrands = 0
  const brandDataToInsert = []

  for (const row of rawRows) {
    const weekLabel = formatWeekLabel(row[1])
    const brandId = row[2]?.toString().trim() || null
    const brandName = row[3]?.toString().trim()
    const kamEmail = row[5]?.toString().toLowerCase().trim()
    const categoria = row[6]?.toString().trim() || null

    if (!weekLabel || !fechas.includes(weekLabel)) continue
    if (!brandName || !kamEmail || !KAMS_MAP[kamEmail]) continue

    processedBrands++
    const brandKey = brandId || brandName
    kamSummary[kamEmail].brandIds.add(brandKey)
    kamSummary[kamEmail].semanas[weekLabel].brandIds.add(brandKey)

    const orders = parseFloat(row[8]) || 0
    const gmv = parseFloat((row[10] || '0').toString().replace(/,/g, '')) || 0
    const mkd = parseFloat((row[13] || '0').toString().replace(/,/g, '')) || 0
    const ss = parseFloat((row[12] || '0').toString().replace(/,/g, '')) || 0
    const markdownPct = gmv > 0 ? (mkd / gmv) * 100 : 0

    kamSummary[kamEmail].semanas[weekLabel].orders += orders
    kamSummary[kamEmail].semanas[weekLabel].markdown += markdownPct
    kamSummary[kamEmail].semanas[weekLabel].trafico += ss

    brandDataToInsert.push({
      kam_id: KAMS_MAP[kamEmail].id,
      brand_name: brandName,
      brand_id: brandId,
      categoria,
      semana_fecha: weekLabel,
      orders: Math.round(orders),
      trafico: Math.round(ss),
      markdown: markdownPct,
      updated_at: runStartedAt,
    })
  }

  const dataToInsert = []
  Object.values(kamSummary).forEach((kamData) => {
    if (kamData.brandIds.size === 0) return
    fechas.forEach((fecha) => {
      const brandsEsaSemana = kamData.semanas[fecha].brandIds.size
      const avgMarkdown = brandsEsaSemana > 0
        ? Math.round((kamData.semanas[fecha].markdown / brandsEsaSemana) * 100) / 100
        : 0
      dataToInsert.push({
        kam_id: kamData.id,
        brand_name: 'TOTAL_KAM',
        brand_id: 'TOTAL',
        categoria: 'TOTAL',
        semana_fecha: fecha,
        orders: Math.round(kamData.semanas[fecha].orders),
        trafico: Math.round(kamData.semanas[fecha].trafico),
        markdown: avgMarkdown,
        updated_at: runStartedAt,
      })
    })
  })

  // Solo se limpian datos viejos cuando vinieron TODOS los KAMs de la tabla
  // (red de seguridad) y la corrida no está acotada a algunos KAMs.
  const kamsConDatos = Object.values(kamSummary).filter((k) => k.brandIds.size > 0).length
  const safeToCleanup = !scoped && kamsConDatos >= Object.keys(KAMS_MAP).length

  // Insertamos (upsert) SIEMPRE los datos nuevos primero y recién después
  // borramos los viejos (nunca al revés), para que la tabla nunca quede
  // vacía si la corrida se corta a mitad de camino. Upsert porque hay una
  // unique constraint en (kam_id, brand_name, semana_fecha).
  if (dataToInsert.length > 0) {
    const { error } = await supabase
      .from('weekly_data')
      .upsert(dataToInsert, { onConflict: 'kam_id,brand_name,semana_fecha' })
    if (error) throw new Error(`Error guardando totales: ${error.message}`)

    if (safeToCleanup) {
      await supabase
        .from('weekly_data')
        .delete()
        .eq('brand_name', 'TOTAL_KAM')
        .lt('updated_at', runStartedAt)
    }
  }

  if (brandDataToInsert.length > 0) {
    const BATCH_SIZE = 500
    for (let i = 0; i < brandDataToInsert.length; i += BATCH_SIZE) {
      const batch = brandDataToInsert.slice(i, i + BATCH_SIZE)
      const { error } = await supabase
        .from('weekly_data')
        .upsert(batch, { onConflict: 'kam_id,brand_name,semana_fecha' })
      if (error) throw new Error(`Error guardando brands: ${error.message}`)
    }

    if (safeToCleanup) {
      await supabase
        .from('weekly_data')
        .delete()
        .neq('brand_name', 'TOTAL_KAM')
        .in('semana_fecha', fechas)
        .lt('updated_at', runStartedAt)
    }
  }

  return {
    ok: true,
    fechas,
    kams: Object.keys(KAMS_MAP).length,
    processedBrands,
    kamsConDatos,
    safeToCleanup,
    totalKamRows: dataToInsert.length,
    brandRows: brandDataToInsert.length,
    syncedAt: new Date().toISOString(),
  }
}

module.exports = { syncWeeklyFromSheet, formatWeekLabel }
