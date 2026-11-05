# Actualiza el Centro de Directos desde GitHub sin tocar tus claves, sesiones, clips ni ajustes.
# Lo usa el botón "Actualizar" de la app (en segundo plano) y también se puede correr a mano.
param([string]$Carpeta = 'C:\CentroDirectos')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'centro.js'))) { $Carpeta = $PSScriptRoot }
$log = Join-Path $Carpeta 'logs\actualizar.log'
New-Item -ItemType Directory -Force -Path (Join-Path $Carpeta 'logs') | Out-Null
function Paso($t) { Write-Host $t; Add-Content -Path $log -Value ("[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "] " + $t) -Encoding UTF8 }
try {
  Paso "Actualizando $Carpeta"
  $tmp = Join-Path $env:TEMP ('centro-act-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Paso 'Bajando la versión nueva de GitHub…'
  Invoke-WebRequest 'https://github.com/Juandegates/centro-directos/archive/refs/heads/main.zip' -OutFile (Join-Path $tmp 'nuevo.zip') -UseBasicParsing
  Expand-Archive (Join-Path $tmp 'nuevo.zip') -DestinationPath $tmp -Force
  $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
  if (-not (Test-Path (Join-Path $src.FullName 'centro.js'))) { throw 'La descarga vino incompleta' }
  Paso 'Apagando el Centro…'
  New-Item -ItemType File -Force -Path (Join-Path $Carpeta 'detener.flag') | Out-Null
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*centro.js*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }
  Start-Sleep -Seconds 3
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*iniciar-centro.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Carpeta 'detener.flag')
  Paso 'Copiando archivos nuevos (tus claves y datos no se tocan)…'
  robocopy $src.FullName $Carpeta /E /R:3 /W:2 /NFL /NDL /NJH /NJS /NP `
    /XF claves.txt tokens.json google-tokens.json kick-tokens.json meta-tokens.json publicacion.json publicos.json centro.pid detener.flag ajustes.json memoria.json conocidos.json bandeja.json config.json estadisticas.json busquedas.json `
    /XD candidatos logs grabacion clips piezas | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "No se pudieron copiar los archivos (robocopy $LASTEXITCODE)" }
  try { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction Stop } catch { } # si no se puede borrar la carpeta temporal, no importa
  $v = (Get-Content (Join-Path $Carpeta 'package.json') -Raw | ConvertFrom-Json).version
  Paso "Listo: versión $v. Encendiendo el Centro…"
} catch {
  Paso ('ERROR: ' + $_.Exception.Message)
}
Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $Carpeta 'centro-oculto.vbs') + '"')
