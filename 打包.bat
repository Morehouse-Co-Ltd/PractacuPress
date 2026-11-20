@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title Practacu Press - Package Windows
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem Practacu Press Windows 一键打包
rem
rem 双击：构建前端 + Go API，自检后产出 release\PractacuPress 与 zip。
rem 命令行（参数会转成 scripts\package.ps1 的 PowerShell 参数）：
rem   打包.bat --arch amd64            只打 x64（arm64 同理）
rem   打包.bat --skip-smoke           跳过打包后的启动自检
rem   打包.bat --no-zip               只生成 release\PractacuPress 目录
rem   打包.bat --release-dir D:\out   换输出目录
rem   打包.bat --port 18080           自检固定端口
rem   打包.bat --no-pause             结束不暂停（CI / 脚本调用）
rem   打包.bat --help                 显示这段说明
rem
rem 也可以直接透传 PowerShell 参数：打包.bat -Arch amd64 -SkipSmoke
rem ---------------------------------------------------------------------------

set "PS_ARGS="
set "PAUSE_AT_END=1"
set "ARG_COUNT=0"

:parse
if "%~1"=="" goto run
set /a ARG_COUNT+=1

if /I "%~1"=="--help" goto help
if /I "%~1"=="-h" goto help
if /I "%~1"=="-?" goto help

if /I "%~1"=="--no-pause" (
  set "PAUSE_AT_END=0"
  shift
  goto parse
)

if /I "%~1"=="--arch" (
  if "%~2"=="" (
    echo [ERROR] --arch needs a value: amd64 or arm64.
    goto fail
  )
  if /I not "%~2"=="amd64" if /I not "%~2"=="arm64" (
    echo [ERROR] --arch must be amd64 or arm64, got "%~2".
    goto fail
  )
  set PS_ARGS=!PS_ARGS! -Arch %~2
  shift
  shift
  goto parse
)

if /I "%~1"=="--skip-smoke" (
  set PS_ARGS=!PS_ARGS! -SkipSmoke
  shift
  goto parse
)

if /I "%~1"=="--no-zip" (
  set "NO_ZIP=1"
  set PS_ARGS=!PS_ARGS! -NoZip
  shift
  goto parse
)

if /I "%~1"=="--release-dir" (
  if "%~2"=="" (
    echo [ERROR] --release-dir needs a directory.
    goto fail
  )
  set PS_ARGS=!PS_ARGS! -ReleaseDir "%~2"
  shift
  shift
  goto parse
)

if /I "%~1"=="--port" (
  if "%~2"=="" (
    echo [ERROR] --port needs a number.
    goto fail
  )
  set PS_ARGS=!PS_ARGS! -Port %~2
  shift
  shift
  goto parse
)

rem 其它参数原样交给 package.ps1（兼容 -Arch / -SkipSmoke 这类 PowerShell 写法）。
set PS_ARGS=!PS_ARGS! %~1
shift
goto parse

:run
echo ============================================================
echo   Practacu Press - Windows package
echo ============================================================
if defined PS_ARGS echo   args:!PS_ARGS!
echo.

call powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\package.ps1" !PS_ARGS!
set "PP_EXIT=%ERRORLEVEL%"

echo.
if not "%PP_EXIT%"=="0" (
  echo [FAILED] packaging stopped with exit code %PP_EXIT%.
  echo Check the messages above. Common causes: Node.js ^< 22.12, Go missing,
  echo port in use during the self-test, or a locked file in release\.
) else (
  echo [DONE] output:
  echo   release\PractacuPress
  if not defined NO_ZIP echo   release\PractacuPress-Windows-*.zip  ^(+ .sha256^)
)
echo.

if "%PAUSE_AT_END%"=="1" pause
exit /b %PP_EXIT%

:help
echo Practacu Press Windows package
echo.
echo   double-click             build frontend + API, smoke test, zip
echo   打包.bat --arch amd64     x64 only (arm64 supported too)
echo   打包.bat --skip-smoke     skip the packaged self-test
echo   打包.bat --no-zip         keep only release\PractacuPress
echo   打包.bat --release-dir DIR
echo   打包.bat --port PORT      fixed port for the self-test
echo   打包.bat --no-pause       do not wait at the end (CI)
echo.
echo   PowerShell arguments such as -Arch amd64 are passed through as-is.
exit /b 0

:fail
echo.
echo [FAILED] invalid arguments. Run 打包.bat --help for usage.
if "%PAUSE_AT_END%"=="1" pause
exit /b 2
