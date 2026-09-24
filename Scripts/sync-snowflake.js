// Sync manual de Snowflake -> Supabase (Availability + Compensation + Brands with Markdown). Correr con
//   npm run sync:snowflake                 (todos)
//   npm run sync:snowflake availability    (solo uno)
//   npm run sync:snowflake compensation
//   npm run sync:snowflake brandsWithMd
//   npm run sync:snowflake availabilityDaily
//   npm run sync:snowflake avances         (lo diario de "Avances and warnings": foto de
//                                           compensation + availability por día; no toca
//                                           las tablas del resto de la app)
// Con login por navegador (externalbrowser) se aprueba una sola vez por corrida.
// Requiere estar en la VPN de Rappi (Snowflake restringido por IP).
require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')
const { connectSnowflake } = require('../lib/snowflakeClient')
const { buildAvailabilityQuery, loadKams, writeAvailability } = require('../lib/availabilitySync')
const { buildCompensationQuery, writeCompensation } = require('../lib/compensationSync')
const { buildBrandsWithMdQuery, writeBrandsWithMd } = require('../lib/brandsWithMdSync')
const { buildAvailabilityDailyQuery, writeAvailabilityDaily } = require('../lib/availabilityDailySync')

const JOBS = {
  availability: async (sf, supabase, kams) => {
    const rows = await sf.query(buildAvailabilityQuery(kams.map((k) => k.email)))
    const r = await writeAvailability(supabase, rows, kams)
    console.log(`✅ Availability: ${r.upserted} aliados en ${r.kams} KAMs (${r.previousWeek} → ${r.currentWeek}, datos hasta ${r.dataThrough}).`)
    if (r.removed) console.log(`   🧹 ${r.removed} filas viejas eliminadas.`)
    if (r.kamMismatch.length) console.log(`   ⚠️  KAM distinto entre la app y Snowflake: ${r.kamMismatch.join('; ')}`)
  },
  compensation: async (sf, supabase, kams) => {
    const rows = await sf.query(buildCompensationQuery(kams.map((k) => k.email)))
    const r = await writeCompensation(supabase, rows, kams)
    console.log(`✅ Compensation: ${r.upserted} aliados en ${r.kams} KAMs (mes ${r.month}, ${r.capped} con tope de 200%).`)
    if (r.removed) console.log(`   🧹 ${r.removed} filas viejas eliminadas.`)
  },
  brandsWithMd: async (sf, supabase, kams) => {
    const rows = await sf.query(buildBrandsWithMdQuery(kams.map((k) => k.email)))
    const r = await writeBrandsWithMd(supabase, rows, kams)
    console.log(`✅ Brands with Markdown: ${r.upserted} KAMs (mes ${r.month}).`)
    if (r.missing.length) console.log(`   ⚠️  Sin datos en Snowflake: ${r.missing.join(', ')}`)
  },
  // Availability por aliado y por día (warnings de "Avances and warnings").
  availabilityDaily: async (sf, supabase, kams) => {
    const rows = await sf.query(buildAvailabilityDailyQuery(kams.map((k) => k.email)))
    const r = await writeAvailabilityDaily(supabase, rows, kams)
    console.log(`✅ Availability diaria: ${r.rows} filas aliado/día (${r.firstDay} → ${r.lastDay}).`)
  },
  // Martes a viernes: lo diario de "Avances and warnings" (foto de compensation +
  // availability por día). El resto de la app se actualiza los lunes.
  avances: async (sf, supabase, kams) => {
    const emails = kams.map((k) => k.email)
    const comp = await writeCompensation(supabase, await sf.query(buildCompensationQuery(emails)), kams, { snapshotOnly: true })
    const bwmd = await writeBrandsWithMd(supabase, await sf.query(buildBrandsWithMdQuery(emails)), kams, { snapshotOnly: true })
    console.log(`✅ Avances: foto del ${comp.snapshotDate} (${comp.upserted} aliados, ${bwmd.upserted} KAMs).`)
    await JOBS.availabilityDaily(sf, supabase, kams)
  },
}

async function main() {
  const requested = process.argv.slice(2)
  // Sin argumentos: la corrida completa de los lunes (compensation y
  // brandsWithMd ya guardan la foto del día, así que "avances" no hace falta).
  const jobs = requested.length ? requested : ['availability', 'compensation', 'brandsWithMd', 'availabilityDaily']
  const unknown = jobs.filter((j) => !JOBS[j])
  if (unknown.length) throw new Error(`Sync desconocido: ${unknown.join(', ')} (opciones: ${Object.keys(JOBS).join(', ')})`)

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  const kams = await loadKams(supabase)

  console.log(`🔄 Conectando a Snowflake (${jobs.join(' + ')}, ${kams.length} KAMs)...`)
  const sf = await connectSnowflake()
  let failed = false
  try {
    // Cada sync es independiente: si uno falla, el otro igual corre.
    for (const job of jobs) {
      try {
        await JOBS[job](sf, supabase, kams)
      } catch (err) {
        failed = true
        console.error(`❌ ${job}: ${err.message}`)
      }
    }
  } finally {
    await sf.close()
  }
  if (failed) process.exit(1)
}

main().catch((err) => {
  console.error('❌ Error en el sync de Snowflake:', err.message)
  process.exit(1)
})
