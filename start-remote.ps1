# Starts the scanner server + a Cloudflare Tunnel, waits until the public URL
# is CONFIRMED reachable, then emails a one-click auto-login link.
# Fully hands-off: double-click "Start Scanner.bat" and walk away.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$serverLog   = Join-Path $PSScriptRoot "tmp\server.log"
$tunnelLog   = Join-Path $PSScriptRoot "tmp\tunnel.log"
$urlFile     = Join-Path $PSScriptRoot "CURRENT_URL.txt"
$envFile     = Join-Path $PSScriptRoot ".env"

New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "tmp") | Out-Null

# ── Load .env into a hashtable ──────────────────────────────────
$env_vars = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)=(.*)$') {
        $env_vars[$matches[1]] = $matches[2].Trim()
    }
}
$dashUser = $env_vars["DASHBOARD_USER"]
$dashPass = $env_vars["DASHBOARD_PASS"]
$authToken = $env_vars["AUTH_TOKEN"]
$resendApiKey = $env_vars["RESEND_API_KEY"]
$notifyEmail = $env_vars["NOTIFY_EMAIL"]

Write-Host "Stopping any previous instance..." -ForegroundColor DarkGray

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*scanner_testing.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force

Start-Sleep -Seconds 1

# ── Start the server ─────────────────────────────────────────────
Write-Host "Starting server..." -ForegroundColor Cyan
Start-Process node -ArgumentList "scanner_testing.mjs" -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err"

$serverUp = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        Invoke-WebRequest -Uri "http://localhost:4000/api/status" -UseBasicParsing -TimeoutSec 2 | Out-Null
        $serverUp = $true; break
    } catch [System.Net.WebException] {
        if ($_.Exception.Response.StatusCode.value__ -eq 401) { $serverUp = $true; break }
    } catch {}
}
if (-not $serverUp) {
    Write-Host "Server didn't come up — check tmp\server.log" -ForegroundColor Red
    exit 1
}
Write-Host "Server is up." -ForegroundColor Green

# ── Start the tunnel ──────────────────────────────────────────────
Write-Host "Starting tunnel..." -ForegroundColor Cyan
Start-Process $cloudflared -ArgumentList "tunnel --url http://localhost:4000" -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden -RedirectStandardOutput $tunnelLog -RedirectStandardError "$tunnelLog.err"

$publicUrl = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path "$tunnelLog.err") {
        $match = Select-String -Path "$tunnelLog.err" -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
        if ($match) { $publicUrl = $match.Matches[0].Value; break }
    }
}
if (-not $publicUrl) {
    Write-Host "Tunnel didn't come up — check tmp\tunnel.log.err" -ForegroundColor Red
    exit 1
}
Write-Host "Tunnel created: $publicUrl" -ForegroundColor Green

# ── Confirm the public URL is ACTUALLY reachable end-to-end before ──
# emailing it — this is what avoids the "click the link, nothing loads yet"
# DNS-propagation lag.
Write-Host "Confirming the link actually works before emailing it..." -ForegroundColor Cyan
$authHeaderValue = "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$dashUser`:$dashPass"))
$confirmed = $false
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -Uri $publicUrl -Headers @{ Authorization = $authHeaderValue } -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $confirmed = $true; break }
    } catch {}
}
if ($confirmed) {
    Write-Host "Confirmed live." -ForegroundColor Green
} else {
    Write-Host "Couldn't confirm within 45s — emailing anyway, it may need another minute." -ForegroundColor Yellow
}

# ── Build the one-click auto-login link (a normal-looking URL with a
# ?auth= token — unlike embedded user:pass@host links, this isn't flagged
# by mobile browsers' phishing heuristics, so it actually auto-logs in on
# every device instead of silently failing to navigate). ──
$autoLoginUrl = "$publicUrl/?auth=$authToken"

Set-Content -Path $urlFile -Value "$publicUrl`r`nLogin: $dashUser (password is in .env)`r`nStarted: $(Get-Date)"
Set-Clipboard -Value $publicUrl

# ── Email it (via Resend API) ────────────────────────────────────
if ($resendApiKey -and $notifyEmail) {
    Write-Host "Emailing the link to $notifyEmail..." -ForegroundColor Cyan
    try {
        $body = @"
<p><b>Your scanner is live.</b> Click below — it should log you straight in:</p>
<p><a href="$autoLoginUrl">$publicUrl</a></p>
<p style="color:#666">If the link above asks for a login instead of opening straight in, use:<br>
Username: $dashUser<br>Password: $dashPass</p>
<p style="color:#999;font-size:12px">Started $(Get-Date). A new email is sent each time the scanner is (re)started, since the link changes every time.</p>
"@
        $payload = @{
            from    = "onboarding@resend.dev"
            to      = $notifyEmail
            subject = "Scanner is live: $publicUrl"
            html    = $body
        } | ConvertTo-Json

        Invoke-RestMethod -Uri "https://api.resend.com/emails" -Method Post `
            -Headers @{ Authorization = "Bearer $resendApiKey" } -ContentType "application/json" -Body $payload | Out-Null
        Write-Host "Email sent." -ForegroundColor Green
    } catch {
        Write-Host "Email failed to send: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "URL is still saved to CURRENT_URL.txt and on the clipboard." -ForegroundColor Yellow
    }
} else {
    Write-Host "RESEND_API_KEY/NOTIFY_EMAIL not set in .env — skipping email." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  $publicUrl" -ForegroundColor Yellow
Write-Host "  Login: $dashUser / $dashPass" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "This window can be closed — the server and tunnel keep running in the background."
