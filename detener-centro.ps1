# Apaga el Centro por completo (no se vuelve a encender hasta que reinicies la PC o uses "Reiniciar Centro").
$carpeta = $PSScriptRoot
New-Item -ItemType File -Force -Path (Join-Path $carpeta 'detener.flag') | Out-Null
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*centro.js*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }
Start-Sleep -Seconds 2
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*iniciar-centro.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $carpeta 'detener.flag')
Write-Host 'Centro apagado.'
Start-Sleep -Seconds 2
