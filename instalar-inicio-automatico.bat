@echo off
chcp 65001 >nul
title Instalar arranque automatico
echo Configurando el Centro de Directos para que arranque solo al entrar a Windows...
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Centro de Directos.lnk'); $s.TargetPath='%~dp0iniciar-centro.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if errorlevel 1 (
  echo.
  echo No se pudo configurar. Mandale una captura de esta ventana a Claude.
) else (
  echo.
  echo Listo. Desde ahora el Centro se abre solo ^(minimizado^) cada vez que entras a Windows.
)
echo.
pause
