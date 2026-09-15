import { google } from 'googleapis'
import { createClient } from '@supabase/supabase-js'

// Corre server-side en Vercel (Cron), no en el navegador. Usa las mismas
// credenciales de servicio que Scripts/sync-sheets.js pero leídas de las
// env vars de Vercel en vez de .env.local.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const KAMS_MAP = {
  'roberto.chaban@rappi.com': { id: 1, nombre: 'Roberto Chaban' },
  'lucas.lopez@rappi.com': { id: 2, nombre: 'Lucas Lopez' },
  'agustin.kopp@rappi.com': { id: 3, nombre: 'Agustin Kopp' },
  'juan.luduena@rappi.com': { id: 4, nombre: 'Juan Ludueña' },
  'belen.carol@rappi.com': { id: 6, nombre: 'Belen Carol' },
  'luciano.gelmi@rappi.com': { id: 7, nombre: 'Luciano Gelmi' },
  'agustina.penalva@rappi.com': { id: 8, nombre: 'Agustina Peñalva' },
  'virginia.medina@rappi.com': { id: 9, nombre: 'Virginia Medina' },
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// La pestaña "raw" trae la fecha como "AAAA-MM-DD" (el lunes de esa semana);
// "dashboard weekly" usa el label "DD Mon" para la misma semana.
function formatWeekLabel(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number)
  if (!y || !m || !d) return null
  return `${String(d).padStart(2, '0')} ${MONTH_ABBR[m - 1]}`
}

async function syncData() {
  // Timestamp de este run: se graba en updated_at de cada fila que tocamos.
  const runStartedAt = new Date().toISOString()

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: process.env.GOOGLE_TYPE,
      project_id: process.env.GOOGLE_PROJECT_ID,
      private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
      private_key: process.env.GOOGLE_PRIVATE_KEY,
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      client_id: process.env.GOOGLE_CLIENT_ID,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })

  const sheets = google.sheets({ version: 'v4', auth })

  // Leemos TODO (orders, markdown, tráfico) desde "raw" — la consulta cruda a
  // Snowflake — y NO desde el pivot "dashboard weekly". El pivot tiene
  // filtros de Líder/KAM compartidos que cualquier persona del equipo puede
  // cambiar en cualquier momento (ej. un líder distinto filtrando su propia
  // cartera); si sincronizáramos desde ahí, cada corrida traería datos
  // distintos según quién haya tocado el filtro por última vez. "raw" es la
  // salida directa del query, sin filtros de UI.
  // Columnas de "raw" (fila 13 en adelante): [_, WEEK, BRAND_ID, BRAND_NAME,
  // BRAND_OWNER_LEADER, BRAND_OWNER_EMAIL, BRAND_CATEGORY,
  // BUCKET_CLASSIFICATION, TOTAL_ORDERS, TOTAL_USERS, GMV_USD, GMV_PRIME,
  // SS, MKD, MKD_PRIME, REVENUE_GROSS, REVENUE_NET].
  // markdown% = MKD/GMV_USD*100 y tráfico = SS — confirmado contra la
  // fórmula real del pivot y contra los valores que ya veníamos usando.
  const rawResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: "'raw'!A13:Q30000",
  })

  const rawRows = rawResponse.data.values || []

  // Semanas: las últimas 8 que aparezcan en "raw" (columna WEEK, formato
  // AAAA-MM-DD, ordena bien como string). Filtramos por el patrón exacto
  // para descartar filas vacías o basura que no sean una fecha real.
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
  const semanasIso = [...new Set(rawRows.map(r => r[1]).filter(v => ISO_DATE_RE.test(v || '')))].sort()
  const fechas = semanasIso.slice(-8).map(formatWeekLabel)

  const kamSummary = {}
  Object.entries(KAMS_MAP).forEach(([email, kam]) => {
    kamSummary[email] = { id: kam.id, nombre: kam.nombre, brandIds: new Set(), semanas: {} }
    fechas.forEach(fecha => {
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
      categoria: categoria,
      semana_fecha: weekLabel,
      orders: Math.round(orders),
      trafico: Math.round(ss),
      markdown: markdownPct,
      updated_at: runStartedAt,
    })
  }

  const dataToInsert = []
  Object.entries(kamSummary).forEach(([email, kamData]) => {
    if (kamData.brandIds.size === 0) return
    fechas.forEach(fecha => {
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

  // El sheet "dashboard weekly" tiene sus propios filtros de Líder/KAM — si
  // alguien lo filtra a un solo KAM en vez de "Todos", una lectura desde ahí
  // solo traería ESE KAM. Ya no dependemos de ese pivot para nada, pero
  // dejamos esta validación como red de seguridad general: solo limpiamos
  // (delete) datos viejos cuando vinieron los 8 KAMs completos; si vino
  // menos, guardamos lo que haya pero no tocamos lo de los demás KAMs.
  const kamsConDatos = Object.values(kamSummary).filter(k => k.brandIds.size > 0).length
  const safeToCleanup = kamsConDatos >= Object.keys(KAMS_MAP).length

  // Insertamos (upsert) SIEMPRE los datos nuevos primero y recién después
  // borramos los viejos (nunca al revés), para que la tabla nunca quede
  // vacía si esta función se corta a mitad de camino (ej. timeout) o corre
  // en paralelo con otra sincronización. Usamos upsert porque hay una
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
    processedBrands,
    kamsConDatos,
    safeToCleanup,
    totalKamRows: dataToInsert.length,
    brandRows: brandDataToInsert.length,
    syncedAt: new Date().toISOString(),
  }
}

export async function GET(request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const result = await syncData()
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('❌ Sync error:', err)
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
