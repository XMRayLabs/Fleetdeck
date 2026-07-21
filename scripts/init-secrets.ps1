param(
    [switch]$Force
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$secretsDirectory = Join-Path $projectRoot 'secrets'
New-Item -ItemType Directory -Path $secretsDirectory -Force | Out-Null

function New-HexSecret([int]$byteCount) {
    $bytes = New-Object byte[] $byteCount
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($bytes)
    } finally {
        $random.Dispose()
    }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Write-Secret([string]$name, [int]$byteCount) {
    $target = Join-Path $secretsDirectory $name
    if ((Test-Path -LiteralPath $target) -and -not $Force) {
        Write-Host "Keeping existing secret: $target"
        return
    }
    [System.IO.File]::WriteAllText($target, (New-HexSecret $byteCount), [System.Text.UTF8Encoding]::new($false))
    Write-Host "Created: $target"
}

Write-Secret 'encryption_key' 32
Write-Secret 'session_secret' 64
Write-Secret 'remote_gateway_secret' 48
Write-Host 'Secrets initialized. Back up encryption_key offline; stored credentials cannot be recovered without it.'
