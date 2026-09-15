# Arranca el dashboard local (npm run dev) en segundo plano, sin ventanas
# visibles. Pensado para correr solo al iniciar sesión de Windows, vía Task
# Scheduler.
#
# IMPORTANTE: ya NO arranca `npm run sync:watch` acá. El sync del Sheet ->
# Supabase corre como cron job en Vercel (una vez por día), que es la única
# fuente de verdad. Correr el sync local Y el de la nube al mismo tiempo
# causó una corrupción de datos (dos procesos borrando/reinsertando la
# misma tabla en paralelo dejaron TOTAL_KAM con datos de un solo KAM). Si
# alguna vez hace falta un sync manual desde acá, usar `npm run sync` una
# sola vez (no `sync:watch`).

$ProjectPath = "C:\Users\Usuario\Desktop\Proyecto de automatizacion\Rappi-kams-dashboard"
$LogsPath = Join-Path $ProjectPath "logs"

if (-not (Test-Path $LogsPath)) {
    New-Item -ItemType Directory -Path $LogsPath -Force | Out-Null
}

Start-Process -FilePath "npm.cmd" `
    -ArgumentList "run", "dev" `
    -WorkingDirectory $ProjectPath `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogsPath "dev.log") `
    -RedirectStandardError (Join-Path $LogsPath "dev-error.log")
