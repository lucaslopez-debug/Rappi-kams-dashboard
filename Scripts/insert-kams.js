require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const KAMS = [
  { id: 1, nombre: 'Roberto Chaban', email: 'roberto.chaban@rappi.com', region: 'Mendoza' },
  { id: 2, nombre: 'Lucas Lopez', email: 'lucas.lopez@rappi.com', region: 'Tucuman' },
  { id: 3, nombre: 'Agustin Kopp', email: 'agustin.kopp@rappi.com', region: 'Cordoba' },
  { id: 4, nombre: 'Juan Ludueña', email: 'juan.luduena@rappi.com', region: 'Cordoba' },
  { id: 6, nombre: 'Belen Carol', email: 'belen.carol@rappi.com', region: 'San Juan' },
  { id: 7, nombre: 'Luciano Gelmi', email: 'luciano.gelmi@rappi.com', region: 'Corrientes' },
  { id: 8, nombre: 'Agustina Peñalva', email: 'agustina.penalva@rappi.com', region: 'Salta' },
  { id: 9, nombre: 'Virginia Medina', email: 'virginia.medina@rappi.com', region: 'Bariloche' },
  { id: 10, nombre: 'Sofia Abella', email: 'sofia.abella@rappi.com', region: 'Rosario' },
  { id: 11, nombre: 'Lucas Correa', email: 'l.correa@rappi.com', region: 'Rosario' },
  { id: 12, nombre: 'Mauro Montangie', email: 'mauro.montangie@rappi.com', region: 'Santa Fe' },
];

async function insertKams() {
  try {
    console.log('Insertando KAMs...');
    const { error } = await supabase.from('kams').upsert(KAMS);
    
    if (error) throw error;
    
    console.log('✅ KAMs insertados correctamente');
  } catch (err) {
    console.error('❌ Error:', err);
  }
}

insertKams();