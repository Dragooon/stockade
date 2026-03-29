#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Restrict agent-platform proxy ports to local-only access.

.DESCRIPTION
  The proxy package binds to 0.0.0.0 so Docker containers can reach it
  via host.docker.internal. However, Node.js has blanket "Allow" firewall
  rules that expose these ports to the network.

  This script creates explicit Block rules for the proxy ports, then
  Allow rules scoped to localhost + Docker subnet. Because Windows
  Firewall evaluates Block rules before Allow rules (when both match),
  the blanket Node.js Allow is overridden for these specific ports.

  Ports protected:
    10022  — SSH tunnel (credential proxy for containers)
    10255  — HTTP CONNECT proxy (MITM for credential injection)
    10256  — Gateway API (token exchange, credential resolution)

  Safe sources (allowed):
    127.0.0.0/8       — loopback
    172.16.0.0/12     — Docker default bridge/overlay networks
    192.168.0.0/16    — LAN (host.docker.internal resolves here)
    10.0.0.0/8        — Docker custom networks / WSL

  Run once (rules persist across reboots). Re-run to update if ports change.
#>

$ErrorActionPreference = "Stop"

$ruleName   = "Stockade-Proxy"
$proxyPorts = @(10022, 10255, 10256)
$localNets  = @("127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")

# Remove existing rules (idempotent re-run)
Get-NetFirewallRule -DisplayName "$ruleName-*" -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

Write-Host "Creating firewall rules for proxy ports: $($proxyPorts -join ', ')" -ForegroundColor Cyan

# 1. Block all inbound on proxy ports (overrides Node.js blanket Allow)
New-NetFirewallRule `
  -DisplayName "$ruleName-Block-Inbound" `
  -Description "Block external access to agent-platform proxy ports" `
  -Direction Inbound `
  -Action Block `
  -Protocol TCP `
  -LocalPort $proxyPorts `
  -Profile Any `
  -Enabled True |
  Out-Null

Write-Host "  [+] Block rule created for ports $($proxyPorts -join ', ')" -ForegroundColor Yellow

# 2. Allow from local/Docker networks (evaluated alongside block, but
#    Windows processes "more specific" allow rules for matching sources)
#    We need separate allow rules because Block+Allow at same specificity
#    means Block wins. So we use RemoteAddress scoping on the Allow rule
#    which makes it more specific than the blanket Block.
New-NetFirewallRule `
  -DisplayName "$ruleName-Allow-Local" `
  -Description "Allow local and Docker networks to reach proxy ports" `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $proxyPorts `
  -RemoteAddress $localNets `
  -Profile Any `
  -Enabled True |
  Out-Null

Write-Host "  [+] Allow rule created for local networks: $($localNets -join ', ')" -ForegroundColor Green

# Verify
Write-Host "`nActive rules:" -ForegroundColor Cyan
Get-NetFirewallRule -DisplayName "$ruleName-*" -Enabled True |
  Select-Object DisplayName, Action, Direction, Profile |
  Format-Table -AutoSize

Write-Host "Done. Proxy ports are now restricted to local access only." -ForegroundColor Green
