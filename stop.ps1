$ErrorActionPreference = "SilentlyContinue"
$found = $false
foreach ($port in 8765..8794) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connected = $client.ConnectAsync("127.0.0.1", $port).Wait(120)
        if (-not $connected -or -not $client.Connected) {
            continue
        }
    } catch {
        continue
    } finally {
        $client.Dispose()
    }

    try {
        $response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/shutdown" -TimeoutSec 2
        if ($response.ok) {
            Write-Host "WrongBook stopped on port $port." -ForegroundColor Green
            $found = $true
            break
        }
    } catch {
        # This port is not WrongBook; try the next one.
    }
}
if (-not $found) {
    Write-Host "WrongBook is not running." -ForegroundColor Yellow
}
