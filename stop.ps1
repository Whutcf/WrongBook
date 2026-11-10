$ErrorActionPreference = "SilentlyContinue"
$killed = $false

# Method 1: kill pythonw/python processes running this project's app.py
$procs = Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
    Where-Object { $_.CommandLine -like "*WrongBook*app.py*" }
foreach ($p in $procs) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    $killed = $true
}

# Method 2: kill whatever is listening on 8765..8794 (defensive)
foreach ($port in 8765..8794) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        $killed = $true
    }
}

# Method 3: optional graceful shutdown if a /api/shutdown route is ever added
foreach ($port in 8765..8794) {
    try {
        $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/shutdown" -TimeoutSec 2 -ErrorAction Stop
        if ($r.ok) { $killed = $true }
    } catch { }
}

if ($killed) {
    Write-Host "WrongBook stopped."
} else {
    Write-Host "WrongBook is not running."
}
