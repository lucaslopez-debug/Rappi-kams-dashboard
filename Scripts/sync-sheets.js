// Sync manual del Google Sheet -> Supabase (weekly_data). Misma lógica que el
// cron de Vercel (lib/sheetsSync.js). Correr con
//   npm run sync                                  (todos los KAMs de la tabla kams)
//   npm run sync -- --kams=a@rappi.com,b@rappi.com (solo esos KAMs; no borra nada
//                                                  del resto — ej. KAMs recién sumados)
require('dotenv').config({ path: '.env.local' })
const { google } = require('googleapis')
const { createClient } = require('@supabase/supabase-js')
const { syncWeeklyFromSheet } = require('../lib/sheetsSync')

async function main() {
  const kamsArg = process.argv.find((a) => a.startsWith('--kams='))
  const onlyEmails = kamsArg ? kamsArg.slice('--kams='.length).split(',').filter(Boolean) : null

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: process.env.GOOGLE_TYPE,
      project_id: process.env.GOOGLE_PROJECT_ID,
      private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      client_id: process.env.GOOGLE_CLIENT_ID,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })
  const sheets = google.sheets({ version: 'v4', auth })

  console.log(`🔄 Sync del Sheet${onlyEmails ? ` (solo ${onlyEmails.join(', ')})` : ''}...`)
  const r = await syncWeeklyFromSheet({ supabase, sheets, spreadsheetId: process.env.GOOGLE_SHEETS_ID, onlyEmails })
  console.log(`✅ ${r.kamsConDatos}/${r.kams} KAMs con datos · ${r.brandRows} filas aliado/semana · ${r.totalKamRows} totales · semanas ${r.fechas.join(', ')}`)
  console.log(r.safeToCleanup ? '🧹 Se limpiaron datos viejos.' : 'ℹ️  No se borró nada (corrida acotada o faltaron KAMs).')
}

main().catch((err) => {
  console.error('❌ Error en el sync del Sheet:', err.message)
  process.exit(1)
})
