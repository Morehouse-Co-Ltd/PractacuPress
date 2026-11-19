@echo off
chcp 936 >nul
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title Practacu Press 一键启动

set "ROOT=%CD%"
set "WEB_URL=http://127.0.0.1:5173"
set "OPEN_URL=%WEB_URL%/?mode=live"
set "API_HEALTH=http://127.0.0.1:8080/healthz"
set "API_RUNNING=0"
set "WEB_RUNNING=0"
set "API_READY=0"
set "SECURITY_ARG="

echo ============================================================
echo   Practacu Press 一键启动
echo ============================================================
echo.

call :check_prereqs
if errorlevel 1 goto :fail

if /I "%~1"=="--check" (
    echo [check] 环境检查通过。
    echo [check] 将启动：scripts\dev.ps1 和 web 的 Vite 开发服务器。
    exit /b 0
)

rem ------------------------------------------------------------------
rem 1. 前端依赖
rem ------------------------------------------------------------------
if not exist "%ROOT%\web\node_modules" (
    echo [1/4] 首次启动，正在安装前端依赖...
    pushd "%ROOT%\web"
    call npm install
    if errorlevel 1 (
        popd
        echo [错误] 前端依赖安装失败，请检查网络或 npm 配置。
        goto :fail
    )
    popd
) else (
    echo [1/4] 前端依赖已存在。
)

rem ------------------------------------------------------------------
rem 2. 复用或启动 API
rem ------------------------------------------------------------------
call :probe_api
if "%API_RUNNING%"=="1" (
    echo [2/4] 检测到 API 已在 8080 运行，直接复用。
    echo [提示] 如果这是修复前启动的旧 API 进程，请先关闭 API 窗口再重跑本脚本，以启用桌面管理员模式。
) else (
    call :choose_security
    echo [2/4] 启动 API 与 SQLite 数据库...
    start "Practacu Press - API" /D "%ROOT%" cmd /k powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\dev.ps1" !SECURITY_ARG!
)

rem ------------------------------------------------------------------
rem 3. 复用或启动前端
rem ------------------------------------------------------------------
call :probe_web
if "%WEB_RUNNING%"=="1" (
    echo [3/4] 检测到前端已在 5173 运行，直接复用。
) else (
    echo [3/4] 启动前端开发服务器...
    start "Practacu Press - Web" /D "%ROOT%\web" cmd /k npm run dev -- --port 5173 --host 127.0.0.1 --strictPort
)

rem ------------------------------------------------------------------
rem 4. 等待前端，打开浏览器，并等待 API
rem ------------------------------------------------------------------
echo [4/4] 等待前端就绪...
set "WEB_TRIES=0"
:wait_web
call :probe_web
if "%WEB_RUNNING%"=="1" goto :web_ready
set /a WEB_TRIES+=1
if %WEB_TRIES% GEQ 90 goto :web_timeout
timeout /t 1 /nobreak >nul
goto :wait_web

:web_timeout
echo.
echo [错误] 前端 90 秒内没有就绪。
echo        请查看“Practacu Press - Web”窗口里的错误信息。
goto :fail

:web_ready
echo 前端已就绪。
echo 正在打开浏览器：%OPEN_URL%
start "" "%OPEN_URL%"

if "%API_RUNNING%"=="1" goto :api_ready

echo.
echo 等待 API 就绪（首次编译或迁移数据库可能需要几分钟）...
set "API_TRIES=0"
:wait_api
call :probe_api
if "%API_RUNNING%"=="1" goto :api_ready
set /a API_TRIES+=1
if %API_TRIES% GEQ 240 goto :api_timeout
<nul set /p "=."
timeout /t 1 /nobreak >nul
goto :wait_api

:api_timeout
echo.
echo [提示] API 仍在启动。浏览器已经打开，可以先使用演示数据；
echo        真实环境需要等 API 就绪后在安装引导里点“重试”。
goto :finish

:api_ready
set "API_READY=1"
echo.
echo API 已就绪。
goto :finish

:finish
echo.
echo ============================================================
echo   启动完成
echo ============================================================
echo   站点          %WEB_URL%
echo   真实环境入口  %OPEN_URL%
echo   API 健康检查  %API_HEALTH%
if "%API_READY%"=="1" (
    echo   API 状态      已就绪
) else (
    echo   API 状态      启动中（请看 API 窗口）
)
echo.
echo   停止方式：
echo     - 在“Practacu Press - API”窗口按 Ctrl+C
echo     - 关闭“Practacu Press - Web”窗口
echo.
echo   数据目录：%ROOT%\data
echo ============================================================
echo.
pause
exit /b 0

rem ------------------------------------------------------------------
rem 子过程
rem ------------------------------------------------------------------

:check_prereqs
where npm >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 npm。请先安装 Node.js 22 或更新版本。
    exit /b 1
)
if not exist "%ROOT%\web\package.json" (
    echo [错误] 找不到 web\package.json，请确认脚本位于项目根目录。
    exit /b 1
)
if not exist "%ROOT%\scripts\dev.ps1" (
    echo [错误] 找不到 scripts\dev.ps1。
    exit /b 1
)
exit /b 0

:probe_api
set "API_RUNNING=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri '%API_HEALTH%'; if ($r.StatusCode -eq 200) { exit 0 } } catch { }; exit 1" >nul 2>nul
if not errorlevel 1 set "API_RUNNING=1"
exit /b 0

:probe_web
set "WEB_RUNNING=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri '%WEB_URL%'; if ($r.StatusCode -eq 200) { exit 0 } } catch { }; exit 1" >nul 2>nul
if not errorlevel 1 set "WEB_RUNNING=1"
exit /b 0

:choose_security
set "SECURITY_ARG="
if exist "%ROOT%\services\security\target\release\practacu-security.exe" exit /b 0
where cargo >nul 2>nul
if errorlevel 1 (
    set "SECURITY_ARG=-SkipSecurity"
    echo [提示] 未找到 Rust 安全服务，API 将以无安全服务方式启动。
    echo        发布文章和完成上传会返回 503，其他功能不受影响。
) else (
    echo [提示] 未找到安全服务构建产物，首次启动会先编译 Rust 服务。
    echo        这可能需要几分钟；之后启动会直接复用。
)
exit /b 0

:fail
echo.
echo 启动失败。请根据上面的提示处理后重试。
pause
exit /b 1
