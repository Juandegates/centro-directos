# Reinicia el Centro (o lo enciende si estaba apagado), siempre en segundo plano.
$carpeta = $PSScriptRoot
$nodo = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*centro.js*' }
$ciclo = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*iniciar-centro.bat*' }
if ($nodo -and $ciclo) {
  $nodo | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }
  Write-Host 'Reiniciando… el Centro vuelve solo en unos 15 segundos.'
} else {
  $nodo | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }
  $ciclo | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $carpeta 'centro-oculto.vbs') + '"')
  Write-Host 'Encendiendo el Centro en segundo plano…'
}
Start-Sleep -Seconds 3
