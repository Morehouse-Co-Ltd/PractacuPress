@echo off
setlocal
chcp 65001 >nul 2>&1
title Practacu Press - Package Windows
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\package.ps1" %*
set "PP_EXIT=%ERRORLEVEL%"

echo.
if not "%PP_EXIT%"=="0" (
  echo [FAILED] packaging stopped with exit code %PP_EXIT%.
) else (
  echo [DONE] output: release\PractacuPress and release\PractacuPress-Windows-<arch>.zip
)
echo.
pause
exit /b %PP_EXIT%
