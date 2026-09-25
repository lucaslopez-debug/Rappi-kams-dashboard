# Sync programado Snowflake -> Supabase. Lo corren dos tareas de Windows:
#   "Rappi KAMs - Sync Snowflake"         lunes 10:00, sin argumentos: todo
#                                         (Availability, Compensation, Brands
#                                         with MD + foto del lunes).
#   "Rappi KAMs - Avances semanales"      martes a viernes 10:00, "avances":
#                                         solo la foto diaria de Avances
#                                         semanales, sin tocar el resto.
# A mitad de semana, el sync completo solo se corre a mano, a pedido.
#
# Requiere la VPN de Rappi (Snowflake está restringido por IP) y, mientras no
# haya usuario de servicio, aprobar el login de Rappi en el navegador que se abre.
param([string]$Job = "")

$ProjectPath = "C:\Users\Usuario\Desktop\Proyecto de automatizacion\Rappi-kams-dashboard"
$LogsPath = Join-Path $ProjectPath "logs"
$LogFile = Join-Path $LogsPath "snowflake-sync.log"

if (-not (Test-Path $LogsPath)) {
    New-Item -ItemType Directory -Path $LogsPath -Force | Out-Null
}

Set-Location $ProjectPath
# Todo en UTF-8: con *>> PowerShell 5.1 escribe UTF-16 y el log queda ilegible.
Add-Content -Path $LogFile -Encoding utf8 -Value "`n===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Job ====="
if ($Job) {
    & npm.cmd run sync:snowflake -- $Job 2>&1 | Out-File -FilePath $LogFile -Append -Encoding utf8
} else {
    & npm.cmd run sync:snowflake 2>&1 | Out-File -FilePath $LogFile -Append -Encoding utf8
}
Add-Content -Path $LogFile -Encoding utf8 -Value "exit code: $LASTEXITCODE"
