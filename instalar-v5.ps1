# Versión 5: mueve el Centro a C:\CentroDirectos, lo deja en segundo plano al prender la PC
# y pone 3 accesos en el escritorio. Se puede correr varias veces sin problema.
param([string]$Destino = 'C:\CentroDirectos')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$origen = $PSScriptRoot
$Destino = [IO.Path]::GetFullPath($Destino)
Write-Host ''
Write-Host "== Centro de Directos · instalación v5 ==" -ForegroundColor Cyan
Write-Host "Origen:  $origen"
Write-Host "Destino: $Destino"
Write-Host ''

# 1) Apagar el Centro (si está abierto)
Write-Host '1/5 Apagando el Centro…'
New-Item -ItemType File -Force -Path (Join-Path $origen 'detener.flag') | Out-Null
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*centro.js*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }
Start-Sleep -Seconds 2
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*iniciar-centro.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $origen 'detener.flag')

# 2) Copiar todo (claves, sesiones, clips) a la carpeta nueva
if (Test-Path (Join-Path $Destino 'claves.txt')) {
  # Ya se había copiado antes: no se vuelve a copiar (para no regresar datos viejos encima de los nuevos).
  Write-Host "2/5 $Destino ya tiene el Centro; no copio nada."
} elseif ((Resolve-Path $origen).Path.TrimEnd('\') -ne $Destino.TrimEnd('\')) {
  Write-Host "2/5 Copiando a $Destino (puede tardar si hay muchos clips)…"
  New-Item -ItemType Directory -Force -Path $Destino | Out-Null
  robocopy $origen $Destino /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP /XD grabacion /XF centro.pid detener.flag | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "No se pudo copiar (robocopy $LASTEXITCODE)" }
  if (-not (Test-Path (Join-Path $Destino 'claves.txt'))) { throw 'No se copió claves.txt' }
} else { Write-Host '2/5 Ya está en la carpeta correcta.' }

# 3) Arranque automático sin ventana
Write-Host '3/5 Arranque automático en segundo plano…'
$sh = New-Object -ComObject WScript.Shell
$inicio = [Environment]::GetFolderPath('Startup')
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $inicio 'Centro de Directos.lnk')
$l = $sh.CreateShortcut((Join-Path $inicio 'Centro de Directos.lnk'))
$l.TargetPath = 'wscript.exe'
$l.Arguments = '"' + (Join-Path $Destino 'centro-oculto.vbs') + '"'
$l.WorkingDirectory = $Destino
$l.Save()

# 4) Accesos en el escritorio
Write-Host '4/5 Accesos en el escritorio…'
$esc = [Environment]::GetFolderPath('Desktop')
function Acceso($nombre, $script, $icono) {
  $a = $sh.CreateShortcut((Join-Path $esc "$nombre.lnk"))
  $a.TargetPath = 'powershell.exe'
  $a.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Destino $script) + '"'
  $a.WorkingDirectory = $Destino
  $a.IconLocation = $icono
  $a.Save()
}
Acceso 'Centro de Directos' 'ver-centro.ps1' 'imageres.dll,109'
Acceso 'Reiniciar Centro' 'reiniciar-centro.ps1' 'shell32.dll,238'
Acceso 'Detener Centro' 'detener-centro.ps1' 'shell32.dll,27'

# 5) Encender el Centro desde la carpeta nueva
Write-Host '5/5 Encendiendo el Centro en segundo plano…'
Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $Destino 'centro-oculto.vbs') + '"')
Start-Sleep -Seconds 12
$vivo = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*centro.js*' }
Write-Host ''
if ($vivo) { Write-Host '✅ Listo: el Centro ya corre en segundo plano desde ' $Destino -ForegroundColor Green }
else { Write-Host '⚠️  El Centro no arrancó. Abre el acceso "Centro de Directos" del escritorio y mándale captura a Claude.' -ForegroundColor Yellow }
if ((Resolve-Path $origen).Path.TrimEnd('\') -ne $Destino.TrimEnd('\')) {
  Write-Host ''
  Write-Host "La carpeta vieja ($origen) ya no se usa. Bórrala cuando confirmes que todo funciona." -ForegroundColor Cyan
}
Write-Host ''
Read-Host 'Enter para cerrar'
