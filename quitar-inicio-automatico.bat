@echo off
chcp 65001 >nul
powershell -NoProfile -Command "Remove-Item -ErrorAction SilentlyContinue ([Environment]::GetFolderPath('Startup')+'\Centro de Directos.lnk')"
echo Listo, el Centro ya no arranca solo.
pause
