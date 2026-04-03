# Stockade platform launcher (PowerShell)
#
# Usage:
#   .\bin\stockade.ps1              Start proxy + orchestrator (full platform)
#   .\bin\stockade.ps1 proxy        Start proxy only
#   .\bin\stockade.ps1 validate     Validate config without starting

param([string]$Command)

$ErrorActionPreference = 'Stop'
$RepoDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RepoDir

# Resolve tsx CLI path dynamically (survives pnpm install recreating node_modules)
function Get-TsxCli {
    $tsxPath = node -e "console.log(require.resolve('tsx/cli'))" 2>$null
    if (-not $tsxPath) {
        Write-Host 'stockade: error: tsx not found, run pnpm install' -ForegroundColor Red
        exit 1
    }
    return $tsxPath
}

# Preflight
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'stockade: error: node is required' -ForegroundColor Red
    exit 1
}

# stockade validate
if ($Command -eq 'validate') {
    node --import tsx packages/orchestrator/src/validate.ts
    exit $LASTEXITCODE
}

# stockade proxy
if ($Command -eq 'proxy') {
    Write-Host 'stockade: starting proxy...'
    $tsxCli = Get-TsxCli
    node $tsxCli watch packages/proxy/src/index.ts
    exit $LASTEXITCODE
}

# stockade (full platform)
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host 'stockade: warning: docker not found, container isolation disabled' -ForegroundColor Yellow
}

# Track all child processes for cleanup
$childPids = [System.Collections.Generic.List[int]]::new()

try {
    # Stop stale containers that may hold file locks on node_modules
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        $running = docker ps -q 2>$null
        if ($running) {
            Write-Host 'stockade: stopping stale containers...'
            docker stop $running 2>$null | Out-Null
        }
    }

    # Kill stale node processes from previous runs
    Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    # Install + build before starting anything
    Write-Host 'stockade: installing dependencies...'
    pnpm install --frozen-lockfile 2>&1 | Select-Object -Last 1
    Write-Host 'stockade: building...'
    pnpm build 2>&1 | Select-Object -Last 1

    Write-Host 'stockade: starting proxy...'
    $tsxCli = Get-TsxCli
    $proxyProc = Start-Process -NoNewWindow -PassThru -FilePath 'node' -ArgumentList "$tsxCli watch packages/proxy/src/index.ts"
    $childPids.Add($proxyProc.Id)
    Start-Sleep -Seconds 1

    # Orchestrator with restart loop (only exit code 75 triggers restart)
    $keepRunning = $true
    while ($keepRunning) {
        Write-Host 'stockade: starting orchestrator...'
        $orchProc = Start-Process -NoNewWindow -PassThru -Wait -FilePath 'node' -ArgumentList 'packages/orchestrator/dist/index.js'
        $exitCode = $orchProc.ExitCode

        if ($exitCode -eq 75) {
            Write-Host 'stockade: orchestrator requested restart, rebuilding...'
            pnpm install --frozen-lockfile 2>&1 | Select-Object -Last 1
            pnpm build 2>&1 | Select-Object -Last 1
            Start-Sleep -Seconds 1
        } else {
            $keepRunning = $false
            Write-Host "stockade: orchestrator exited with code $exitCode"
        }
    }
}
finally {
    Write-Host ''
    Write-Host 'stockade: shutting down...'
    foreach ($cpid in $childPids) {
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$cpid" -ErrorAction SilentlyContinue |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Stop-Process -Id $cpid -Force -ErrorAction SilentlyContinue
    }
}
