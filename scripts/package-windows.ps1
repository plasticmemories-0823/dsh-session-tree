$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$version = (Get-Content -Raw -LiteralPath (Join-Path $root 'package.json') | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
$staging = Join-Path $dist "dsh-session-tree-$version-windows"
$archive = Join-Path $dist 'dsh-session-tree-windows.zip'
$packageName = "dsh-session-tree-$version.tgz"
$manager = Join-Path $staging 'DSH Session Tree Manager.exe'
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'

New-Item -ItemType Directory -Force -Path $staging | Out-Null
Push-Location -LiteralPath $root
try {
    & npm.cmd pack --pack-destination $dist
    if ($LASTEXITCODE -ne 0) { throw "npm pack failed (exit $LASTEXITCODE)." }

    $versionFile = Join-Path $staging 'version.txt'
    Set-Content -LiteralPath $versionFile -Value $version -Encoding ASCII
    $resources = @(
        "/resource:$root\installer\Manager.xaml,Manager.xaml",
        "/resource:$dist\$packageName,plugin.tgz",
        "/resource:$versionFile,version.txt"
    )
    $references = @('WPF\PresentationFramework.dll', 'WPF\PresentationCore.dll', 'WPF\WindowsBase.dll',
                    'System.Xaml.dll', 'System.Web.Extensions.dll') | ForEach-Object { "/reference:$framework\$_" }
    $source = Join-Path $root 'installer\Manager.cs'
    & $compiler /nologo /target:winexe /optimize+ /codepage:65001 "/out:$manager" @resources @references $source
    if ($LASTEXITCODE -ne 0) { throw "Manager build failed (exit $LASTEXITCODE)." }
    Compress-Archive -LiteralPath $manager -DestinationPath $archive -Force
    Get-FileHash -LiteralPath @($archive, (Join-Path $dist $packageName)) -Algorithm SHA256 |
        ForEach-Object { '{0}  {1}' -f $_.Hash.ToLowerInvariant(), (Split-Path -Leaf $_.Path) } |
        Set-Content -LiteralPath (Join-Path $dist 'SHA256SUMS.txt') -Encoding ASCII
    Write-Host $archive
} finally {
    Pop-Location
}
