# Muestra la bitácora del Centro en vivo. Cerrar esta ventana NO apaga el Centro.
$Host.UI.RawUI.WindowTitle = 'Centro de Directos (bitácora en vivo)'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$carpeta = $PSScriptRoot
$log = Join-Path $carpeta 'logs\centro.log'
$vivo = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*centro.js*' }
Write-Host ''
if ($vivo) { Write-Host '  ✅ El Centro está funcionando en segundo plano.' -ForegroundColor Green }
else { Write-Host '  ⚠️  El Centro NO está funcionando. Usa el acceso "Reiniciar Centro".' -ForegroundColor Yellow }
Write-Host '  App del celular: la de siempre (PIN en claves.txt o en ajustes).'
Write-Host '  Cerrar esta ventana no apaga nada.'
Write-Host ''
if (Test-Path $log) { Get-Content $log -Tail 60 -Wait -Encoding UTF8 }
else { Write-Host '  Todavía no hay bitácora.'; Read-Host 'Enter para cerrar' }
