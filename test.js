require('dotenv').config({ path: '.env.local' });

console.log('🔍 Verificando variables de entorno...\n');

// Google Cloud
console.log('✓ GOOGLE_SHEETS_ID:', process.env.GOOGLE_SHEETS_ID ? '✅ OK' : '❌ FALTA');
console.log('✓ GOOGLE_PROJECT_ID:', process.env.GOOGLE_PROJECT_ID ? '✅ OK' : '❌ FALTA');
console.log('✓ GOOGLE_PRIVATE_KEY_ID:', process.env.GOOGLE_PRIVATE_KEY_ID ? '✅ OK' : '❌ FALTA');
console.log('✓ GOOGLE_PRIVATE_KEY:', process.env.GOOGLE_PRIVATE_KEY ? '✅ OK (contiene texto)' : '❌ FALTA');
console.log('✓ GOOGLE_CLIENT_EMAIL:', process.env.GOOGLE_CLIENT_EMAIL ? '✅ OK' : '❌ FALTA');
console.log('✓ GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? '✅ OK' : '❌ FALTA');

console.log('\n🔍 Verificando Supabase...\n');

// Supabase
console.log('✓ SUPABASE_URL:', process.env.SUPABASE_URL ? '✅ OK' : '❌ FALTA');
console.log('✓ SUPABASE_KEY:', process.env.SUPABASE_KEY ? '✅ OK' : '❌ FALTA');

console.log('\n' + '='.repeat(50));

// Test de conexión
const { createClient } = require('@supabase/supabase-js');

async function testConnection() {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );

    // Prueba simple: obtener datos de la tabla kams
    const { data, error } = await supabase
      .from('kams')
      .select('*')
      .limit(1);

    if (error) {
      console.log('❌ Error de Supabase:', error.message);
    } else {
      console.log('✅ Conexión a Supabase: OK');
      console.log(`   Encontrados ${data?.length || 0} registros en tabla "kams"`);
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

testConnection();