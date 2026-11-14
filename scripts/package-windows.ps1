$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$version = (Get-Content -Raw -LiteralPath (Join-Path $root 'package.json') | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
$staging = Join-Path $dist "dsh-session-tree-$version-windows"
$archive = Join-Path $dist 'dsh-session-tree-windows.zip'
$packageName = "dsh-session-tree-$version.tgz"

New-Item -ItemType Directory -Force -Path $staging | Out-Null
Push-Location -LiteralPath $root
try {
    & npm.cmd pack --pack-destination $dist
    if ($LASTEXITCODE -ne 0) { throw "npm pack failed (exit $LASTEXITCODE)." }

    foreach ($file in @('Install.cmd', 'Install.ps1')) {
        Copy-Item -LiteralPath (Join-Path 'installer' $file) -Destination $staging -Force
    }
    Copy-Item -LiteralPath (Join-Path $dist $packageName) -Destination $staging -Force
    Compress-Archive -LiteralPath @(
        (Join-Path $staging 'Install.cmd'),
        (Join-Path $staging 'Install.ps1'),
        (Join-Path $staging $packageName)
    ) -DestinationPath $archive -Force
    Get-FileHash -LiteralPath @($archive, (Join-Path $dist $packageName)) -Algorithm SHA256 |
        ForEach-Object { '{0}  {1}' -f $_.Hash.ToLowerInvariant(), (Split-Path -Leaf $_.Path) } |
        Set-Content -LiteralPath (Join-Path $dist 'SHA256SUMS.txt') -Encoding ASCII
    Write-Host $archive
} finally {
    Pop-Location
}
