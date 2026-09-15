require('dotenv').config({ path: '.env.local' });
const { syncData } = require('./sync-sheets');

// Cada cuánto se vuelve a leer el Sheet y escribir en Supabase, en milisegundos.
// Configurable con SYNC_INTERVAL_MS en .env.local (default: 5 minutos).
const INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS) || 5 * 60 * 1000;

async function tick() {
  console.log(`\n⏱️  ${new Date().toLocaleString()} — sincronizando Sheet → Supabase...`);
  await syncData();
  console.log(`💤 Próxima sincronización en ${Math.round(INTERVAL_MS / 1000)}s`);
}

console.log(`🔁 Auto-sync iniciado (cada ${Math.round(INTERVAL_MS / 1000)}s). Ctrl+C para detener.`);
tick();
setInterval(tick, INTERVAL_MS);
