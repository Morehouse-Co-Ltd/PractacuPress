# Sets the toolchain and proxy environment this machine needs.
#
# These scripts are unsigned, so dot-sourcing works only when the execution policy
# allows it. Run it through the bypass instead:
#
#   powershell -ExecutionPolicy Bypass -Command ". .\scripts\env.ps1"
#
# For the verification gate prefer scripts\test.ps1, which sets the same values
# itself and needs no dot-sourcing.
#
# 1. Go on PATH is a 32-bit install; the repository targets windows/amd64.
# 2. go does not read the WinINET proxy, so honour the system proxy here.

$goRoot = 'C:\Program Files\Go'
if (Test-Path (Join-Path $goRoot 'bin\go.exe')) {
    $env:PATH = (Join-Path $goRoot 'bin') + ';' + $env:PATH
}

if (-not $env:HTTPS_PROXY) {
    $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($ie -and $ie.ProxyEnable -eq 1 -and $ie.ProxyServer) {
        $env:HTTP_PROXY  = 'http://' + $ie.ProxyServer
        $env:HTTPS_PROXY = $env:HTTP_PROXY
    }
}

if (-not $env:NO_PROXY) {
    $env:NO_PROXY = 'localhost,127.0.0.1'
}
