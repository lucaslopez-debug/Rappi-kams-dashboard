import { google } from 'googleapis'
import { createClient } from '@supabase/supabase-js'
import { syncWeeklyFromSheet } from '@/lib/sheetsSync'

// Corre server-side en Vercel (Cron), no en el navegador. La lógica vive en
// lib/sheetsSync.js (la misma que usa Scripts/sync-sheets.js en local); acá
// solo se arman los clientes con las env vars de Vercel.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function syncData() {
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

  return syncWeeklyFromSheet({ supabase, sheets, spreadsheetId: process.env.GOOGLE_SHEETS_ID })
}

export async function GET(request) {
  // Sin CRON_SECRET configurado no se acepta ningún pedido (si no, el header
  // "Bearer undefined" pasaría la comparación).
  const authHeader = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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
