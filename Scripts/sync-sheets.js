require('dotenv').config({ path: '.env.local' });
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const KAMS_MAP = {
  'roberto.chaban@rappi.com': { id: 1, nombre: 'Roberto Chaban' },
  'lucas.lopez@rappi.com': { id: 2, nombre: 'Lucas Lopez' },
  'agustin.kopp@rappi.com': { id: 3, nombre: 'Agustin Kopp' },
  'juan.luduena@rappi.com': { id: 4, nombre: 'Juan Ludueña' },
  'belen.carol@rappi.com': { id: 6, nombre: 'Belen Carol' },
  'luciano.gelmi@rappi.com': { id: 7, nombre: 'Luciano Gelmi' },
  'agustina.penalva@rappi.com': { id: 8, nombre: 'Agustina Peñalva' },
  'virginia.medina@rappi.com': { id: 9, nombre: 'Virginia Medina' },
};

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// La pestaña "raw" trae la fecha como "AAAA-MM-DD" (el lunes de esa semana);
// "dashboard weekly" usa el label "DD Mon" para la misma semana. Convertimos
// para poder cruzar tráfico (TOTAL_USERS) por brand_id + semana.
function formatWeekLabel(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return null;
  return `${String(d).padStart(2, '0')} ${MONTH_ABBR[m - 1]}`;
}

async function syncData() {
  try {
    // Timestamp de este run: se graba en updated_at de cada fila que
    // tocamos, para poder distinguir "datos de este sync" de "datos viejos
    // a limpiar" sin depender del orden delete-antes-de-insert (ver abajo).
    const runStartedAt = new Date().toISOString();

    console.log('🔐 Autenticando...');
    
    const auth = new google.auth.GoogleAuth({
      keyFile: null,
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
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Leemos TODO (orders, markdown, tráfico) desde "raw" — la consulta cruda
    // a Snowflake — y NO desde el pivot "dashboard weekly". El pivot tiene
    // filtros de Líder/KAM compartidos que cualquier persona del equipo
    // puede cambiar en cualquier momento (ej. un líder distinto filtrando su
    // propia cartera); si sincronizáramos desde ahí, cada corrida traería
    // datos distintos según quién haya tocado el filtro por última vez. La
    // pestaña "raw" es la salida directa del query, sin filtros de UI,
    // así que siempre trae TODOS los líderes/KAMs sin importar qué esté
    // mirando alguien en la pantalla.
    // Columnas de "raw" (fila 13 en adelante): [_, WEEK, BRAND_ID,
    // BRAND_NAME, BRAND_OWNER_LEADER, BRAND_OWNER_EMAIL, BRAND_CATEGORY,
    // BUCKET_CLASSIFICATION, TOTAL_ORDERS, TOTAL_USERS, GMV_USD, GMV_PRIME,
    // SS, MKD, MKD_PRIME, REVENUE_GROSS, REVENUE_NET].
    // markdown% = MKD/GMV_USD*100 y tráfico = SS — confirmado contra la
    // fórmula real del pivot y contra los valores que ya veníamos usando.
    console.log('📡 Leyendo pestaña "raw"...');
    const rawResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "'raw'!A13:Q30000",
    });

    const rawRows = rawResponse.data.values || [];
    console.log(`   Filas totales: ${rawRows.length}\n`);

    // Semanas: las últimas 8 que aparezcan en "raw" (columna WEEK, formato
    // AAAA-MM-DD, ordena bien como string). Filtramos por el patrón exacto
    // para descartar filas vacías o basura que no sean una fecha real.
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const semanasIso = [...new Set(rawRows.map(r => r[1]).filter(v => ISO_DATE_RE.test(v || '')))].sort();
    const semanasIsoUltimas8 = semanasIso.slice(-8);
    const fechas = semanasIsoUltimas8.map(formatWeekLabel);

    console.log(`📅 Fechas encontradas: ${fechas.length}`);
    console.log(`   ${fechas.join(' | ')}\n`);

    // Agrupar datos por KAM y semana
    const kamSummary = {};

    // Inicializar estructura para cada KAM
    Object.entries(KAMS_MAP).forEach(([email, kam]) => {
      kamSummary[email] = {
        id: kam.id,
        nombre: kam.nombre,
        brandIds: new Set(),
        semanas: {}
      };
      fechas.forEach(fecha => {
        kamSummary[email].semanas[fecha] = {
          orders: 0,
          markdown: 0,
          trafico: 0,
          brandIds: new Set()
        };
      });
    });

    let processedBrands = 0;

    // Datos por brand (no el agregado por KAM), para poder comparar cada brand
    // semana vs. semana en el dashboard
    const brandDataToInsert = [];

    console.log('📊 Procesando brands...\n');
    for (const row of rawRows) {
      const weekLabel = formatWeekLabel(row[1]);
      const brandId = row[2]?.toString().trim() || null;
      const brandName = row[3]?.toString().trim();
      const kamEmail = row[5]?.toString().toLowerCase().trim();
      const categoria = row[6]?.toString().trim() || null;

      if (!weekLabel || !fechas.includes(weekLabel)) continue;
      if (!brandName || !kamEmail || !KAMS_MAP[kamEmail]) continue;

      processedBrands++;
      const brandKey = brandId || brandName;
      kamSummary[kamEmail].brandIds.add(brandKey);
      kamSummary[kamEmail].semanas[weekLabel].brandIds.add(brandKey);

      const orders = parseFloat(row[8]) || 0;
      const gmv = parseFloat((row[10] || '0').toString().replace(/,/g, '')) || 0;
      const mkd = parseFloat((row[13] || '0').toString().replace(/,/g, '')) || 0;
      const ss = parseFloat((row[12] || '0').toString().replace(/,/g, '')) || 0;
      const markdownPct = gmv > 0 ? (mkd / gmv) * 100 : 0;

      kamSummary[kamEmail].semanas[weekLabel].orders += orders;
      kamSummary[kamEmail].semanas[weekLabel].markdown += markdownPct;
      kamSummary[kamEmail].semanas[weekLabel].trafico += ss;

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
      });
    }

    // Preparar datos para insertar
    const dataToInsert = [];

    Object.entries(kamSummary).forEach(([email, kamData]) => {
      if (kamData.brandIds.size === 0) return;

      fechas.forEach(fecha => {
        const brandsEsaSemana = kamData.semanas[fecha].brandIds.size;
        const avgMarkdown = brandsEsaSemana > 0
          ? Math.round((kamData.semanas[fecha].markdown / brandsEsaSemana) * 100) / 100
          : 0;

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
        });
      });
    });

    // El sheet "dashboard weekly" tiene sus propios filtros de Líder/KAM en
    // la parte de arriba — si alguien los cambia (ej. filtra a un solo KAM
    // en vez de "Todos"), esta lectura solo trae ESE KAM, no un error. Si
    // borráramos y reinsertáramos como si el sheet siempre tuviera los 8,
    // perderíamos los datos de los KAMs que no aparecen en esta lectura
    // puntual. Por eso solo hacemos la limpieza (delete de lo viejo) cuando
    // efectivamente vinieron los 8 KAMs completos; si vino menos, guardamos
    // lo que haya (upsert, nunca borra) pero no tocamos lo demás.
    const kamsConDatos = Object.values(kamSummary).filter(k => k.brandIds.size > 0).length
    const safeToCleanup = kamsConDatos >= Object.keys(KAMS_MAP).length

    console.log(`Procesados ${processedBrands} brands\n`);
    if (!safeToCleanup) {
      console.log(`⚠️  Solo vinieron ${kamsConDatos}/${Object.keys(KAMS_MAP).length} KAMs en esta lectura del sheet (¿está filtrado el "KAM" en "Dashboard Weekly"? debería estar en "Todos"). Se guardan los datos que llegaron pero NO se borra nada de los demás KAMs.\n`)
    }
    console.log('✅ TOTALES POR KAM:');
    Object.entries(kamSummary).forEach(([email, kamData]) => {
      if (kamData.brandIds.size === 0) return;
      console.log(`\n   ${kamData.nombre} (${kamData.brandIds.size} brands):`);
      fechas.forEach(fecha => {
        const brandsEsaSemana = kamData.semanas[fecha].brandIds.size;
        const avgMarkdown = brandsEsaSemana > 0
          ? (kamData.semanas[fecha].markdown / brandsEsaSemana).toFixed(2)
          : 0;
        console.log(`      ${fecha}: ${Math.round(kamData.semanas[fecha].orders)} órdenes | ${avgMarkdown}% markdown promedio`);
      });
    });

    // Insertamos (upsert) SIEMPRE los datos nuevos primero y recién después
    // borramos los viejos (nunca al revés). Así, si el proceso se corta a la
    // mitad o llega a correr en paralelo con otra sincronización, la tabla
    // nunca queda vacía. Usamos upsert (no insert) porque hay una unique
    // constraint en (kam_id, brand_name, semana_fecha): si dos runs llegan a
    // solaparse, un insert plano rompería con error de clave duplicada y
    // perdería todo ese lote silenciosamente; upsert resuelve el conflicto
    // en vez de fallar.
    console.log(`\n💾 Guardando ${dataToInsert.length} registros en Supabase...\n`);

    if (dataToInsert.length > 0) {
      const { error } = await supabase
        .from('weekly_data')
        .upsert(dataToInsert, { onConflict: 'kam_id,brand_name,semana_fecha' });

      if (error) {
        console.error('❌ Error:', error);
      } else {
        console.log('✅ ¡LISTO! Datos guardados en Supabase');
        console.log(`   ${dataToInsert.length} registros sincronizados\n`);

        if (safeToCleanup) {
          // Borrar SOLO los TOTAL_KAM de antes de este run (nunca los recién insertados)
          await supabase
            .from('weekly_data')
            .delete()
            .eq('brand_name', 'TOTAL_KAM')
            .lt('updated_at', runStartedAt);
        }
      }
    } else {
      console.log('⚠️  No hay datos para guardar\n');
    }

    console.log(`💾 Guardando ${brandDataToInsert.length} registros de brands en Supabase...\n`);

    if (brandDataToInsert.length > 0) {
      // Insertar en lotes para no pasarnos del límite de filas por request
      const BATCH_SIZE = 500;
      let brandInsertError = null;
      for (let i = 0; i < brandDataToInsert.length; i += BATCH_SIZE) {
        const batch = brandDataToInsert.slice(i, i + BATCH_SIZE);
        const { error } = await supabase
          .from('weekly_data')
          .upsert(batch, { onConflict: 'kam_id,brand_name,semana_fecha' });
        if (error) {
          brandInsertError = error;
          break;
        }
      }

      if (brandInsertError) {
        console.error('❌ Error guardando brands:', brandInsertError);
      } else {
        console.log('✅ ¡LISTO! Brands guardadas en Supabase');
        console.log(`   ${brandDataToInsert.length} registros de brands sincronizados\n`);

        if (safeToCleanup) {
          // Borrar solo las filas de brands de esas semanas de antes de este
          // run (nunca las recién insertadas)
          await supabase
            .from('weekly_data')
            .delete()
            .neq('brand_name', 'TOTAL_KAM')
            .in('semana_fecha', fechas)
            .lt('updated_at', runStartedAt);
        }
      }
    } else {
      console.log('⚠️  No hay datos de brands para guardar\n');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

module.exports = { syncData };

if (require.main === module) {
  syncData();
}