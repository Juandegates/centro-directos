@echo off
chcp 65001 >nul
title Centro de Directos
cd /d "%~dp0"
if exist detener.flag del detener.flag
:inicio
call npm start
if exist detener.flag (
  del detener.flag
  exit /b
)
echo.
echo El Centro se cerro. Se reinicia solo en 10 segundos.
timeout /t 10 /nobreak >nul
goto inicio
