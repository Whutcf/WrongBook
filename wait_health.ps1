# Wait until the WrongBook server answers /api/health on 8765..8775.
# Runs the whole poll loop inside ONE powershell process (no per-probe spawning).
$ports = 8765..8775
$maxTries = 30
$found = $null
for ($i = 0; $i -lt $maxTries; $i++) {
    foreach ($port in $ports) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 1
            if ($r.StatusCode -eq 200) { $found = $port; break }
        } catch { }
    }
    if ($found) { break }
    Start-Sleep -Seconds 1
}
if ($found) { Write-Output $found } else { Write-Output "FAIL" }
