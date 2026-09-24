// Conexión a Snowflake para los syncs (Scripts/sync-snowflake.js). Una sola
// conexión por corrida, así el login por navegador se aprueba una vez aunque
// se corran varias consultas.
//
// Auth: SNOWFLAKE_PRIVATE_KEY_PATH (usuario de servicio, key-pair) si está
// configurado; si no, SNOWFLAKE_AUTHENTICATOR (externalbrowser = login de Rappi).
// Snowflake de Rappi está restringido por IP: fuera de la VPN el login falla
// con "IP ... is not allowed to access Snowflake".
const fs = require('fs')
const snowflake = require('snowflake-sdk')

snowflake.configure({ logLevel: 'ERROR' })

function snowflakeOptions() {
  const opts = {
    account: process.env.SNOWFLAKE_ACCOUNT,
    username: process.env.SNOWFLAKE_USER,
  }
  if (process.env.SNOWFLAKE_ROLE) opts.role = process.env.SNOWFLAKE_ROLE
  if (process.env.SNOWFLAKE_WAREHOUSE) opts.warehouse = process.env.SNOWFLAKE_WAREHOUSE
  if (process.env.SNOWFLAKE_PRIVATE_KEY_PATH) {
    opts.authenticator = 'SNOWFLAKE_JWT'
    opts.privateKey = fs.readFileSync(process.env.SNOWFLAKE_PRIVATE_KEY_PATH, 'utf8')
  } else {
    opts.authenticator = process.env.SNOWFLAKE_AUTHENTICATOR || 'EXTERNALBROWSER'
  }
  return opts
}

async function connectSnowflake() {
  const conn = snowflake.createConnection(snowflakeOptions())
  // connectAsync resuelve igual aunque el login falle (ej. IP no habilitada):
  // el error solo llega por el callback.
  await new Promise((resolve, reject) => {
    conn.connectAsync((err) => (err ? reject(err) : resolve()))
  })

  return {
    query(sql) {
      return new Promise((resolve, reject) => {
        conn.execute({ sqlText: sql, complete: (err, _stmt, rows) => (err ? reject(err) : resolve(rows || [])) })
      })
    },
    close() {
      return new Promise((resolve) => conn.destroy(() => resolve()))
    },
  }
}

module.exports = { connectSnowflake }
