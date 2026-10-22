@echo off
title Centro de Directos
cd /d "%~dp0"
:inicio
call npm start
echo.
echo El Centro se cerro. Se reinicia solo en 10 segundos. Para apagarlo, cierra esta ventana.
timeout /t 10 /nobreak >nul
goto inicio
