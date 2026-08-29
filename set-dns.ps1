Set-DnsClientServerAddress -InterfaceAlias "Wi-Fi" -ServerAddresses ("1.1.1.1", "1.0.0.1")
Write-Host "DNS set to Cloudflare (1.1.1.1 / 1.0.0.1)." -ForegroundColor Green
Get-DnsClientServerAddress -InterfaceAlias "Wi-Fi" -AddressFamily IPv4
