// Corré esto UNA sola vez, a mano, para autorizar "Exportar a Doc" con tu
// propia cuenta @rappi.com en vez de un service account externo (el
// Workspace de Rappi bloquea compartir Docs con cuentas fuera del dominio,
// así que el service account de sync-sheets.js no sirve para esto).
//
// Requiere GOOGLE_OAUTH_CLIENT_ID y GOOGLE_OAUTH_CLIENT_SECRET ya cargados
// en .env.local (ver la guía para crear ese OAuth Client en Google Cloud
// Console, tipo "Desktop app", en el mismo proyecto engaged-cosine-506020-k7).
//
// Uso: node Scripts/google-oauth-setup.js

require('dotenv').config({ path: '.env.local' });
const { google } = require('googleapis');
const http = require('http');
const { URL } = require('url');

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
// Los clientes OAuth tipo "Desktop app" aceptan cualquier puerto en
// localhost sin tener que registrarlo antes en Cloud Console.
const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Falta GOOGLE_OAUTH_CLIENT_ID y/o GOOGLE_OAUTH_CLIENT_SECRET en .env.local');
  console.error('   Creá el OAuth Client en Google Cloud Console primero (ver guía).');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  // "consent" fuerza a que Google devuelva un refresh_token siempre, incluso
  // si ya habías autorizado esta app antes (si no, la segunda vez en
  // adelante Google no lo reenvía).
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/documents'],
});

console.log('\n1) Abrí esta URL en tu navegador, iniciá sesión con tu cuenta @rappi.com y aceptá los permisos:\n');
console.log(authUrl);
console.log(`\n2) Esperando el redirect a ${REDIRECT_URI} ...\n`);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.end('Google devolvió un error — mirá la terminal.');
      console.error(`❌ Google devolvió error: ${error}`);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.end('No llegó ningún "code" en esta request. Cerrá la pestaña y volvé a intentar.');
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);
    res.end('Listo ✅ — ya podés cerrar esta pestaña y volver a la terminal.');
    server.close();

    if (!tokens.refresh_token) {
      console.log('\n⚠️  No vino refresh_token en la respuesta.');
      console.log('   Seguramente ya habías autorizado esta app antes. Solucionalo así:');
      console.log('   1. Andá a https://myaccount.google.com/permissions');
      console.log('   2. Buscá esta app y quitale el acceso ("Eliminar acceso")');
      console.log('   3. Volvé a correr: node Scripts/google-oauth-setup.js\n');
      process.exit(1);
    }

    console.log('\n✅ Autorización exitosa. Agregá esta línea a tu .env.local:\n');
    console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Error obteniendo el token:', err.message);
    res.end('Error — mirá la terminal.');
    server.close();
    process.exit(1);
  }
});

server.listen(PORT);
