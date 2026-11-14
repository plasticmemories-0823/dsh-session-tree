param(
    [string]$DshExe,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$supportedVersion = '0.2.2-rc.3'
$app = 'DeepSeek Harness.exe'

function Get-InstalledHarness {
    Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
        ForEach-Object { if ($_.Path) { $_.Path } }

    $cli = Get-Command 'dsh.cmd' -ErrorAction SilentlyContinue
    if ($cli) {
        $path = Join-Path (Split-Path $cli.Source) "..\..\..\..\$app"
        if (Test-Path -LiteralPath $path -PathType Leaf) { (Get-Item -LiteralPath $path).FullName }
    }

    $registryRoots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($root in $registryRoots) {
        $entries = Get-ItemProperty -Path "$root\*" -ErrorAction SilentlyContinue
        foreach ($entry in $entries) {
            if ($entry.DisplayName -and $entry.DisplayName -match 'DeepSeek Harness') {
                if ($entry.InstallLocation) { Join-Path $entry.InstallLocation.Trim('"') $app }
                if ($entry.DisplayIcon -match '^"?([^"]+?\.exe)(?:"|,|$)') { $Matches[1] }
            }
        }
    }

    foreach ($root in @("$env:LOCALAPPDATA\Programs", $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $root) { continue }
        Join-Path $root "DeepSeek Harness\$app"
        Join-Path $root "dsh-desktop\$app"
        Join-Path $root "@deepseek-ai\dsh-desktop\$app"
    }
}

try {
    $package = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter 'dsh-session-tree-*.tgz')
    if ($package.Count -ne 1) {
        throw 'Extract the entire installation ZIP first. Keep the plugin archive next to Install.cmd.'
    }
    if (-not $DshExe) {
        $DshExe = Get-InstalledHarness | Where-Object {
            (Test-Path -LiteralPath $_ -PathType Leaf) -and
                (Get-Item -LiteralPath $_).VersionInfo.FileVersion -eq $supportedVersion
        } | Select-Object -First 1
    }
    if (-not $DshExe) {
        Add-Type -AssemblyName System.Windows.Forms
        $picker = New-Object System.Windows.Forms.OpenFileDialog
        try {
            $picker.Title = "Select DeepSeek Harness $supportedVersion"
            $picker.Filter = 'DeepSeek Harness (DeepSeek Harness.exe)|DeepSeek Harness.exe'
            if ($picker.ShowDialog() -ne 'OK') { throw 'No DeepSeek Harness executable selected.' }
            $DshExe = $picker.FileName
        } finally {
            $picker.Dispose()
        }
    }

    $exe = Get-Item -LiteralPath $DshExe
    $cliPath = Join-Path $exe.DirectoryName 'resources\runtime\cli\bin\dsh.cmd'
    if ($exe.Name -ne $app -or $exe.VersionInfo.FileVersion -ne $supportedVersion -or
        -not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
        throw "Select the installed $app from DeepSeek Harness $supportedVersion."
    }

    $dshHomePath = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    $profilePath = Join-Path $dshHomePath 'profiles\desktop'
    if (-not (Test-Path -LiteralPath (Join-Path $profilePath 'package.json') -PathType Leaf)) {
        throw 'Open DeepSeek Harness once to initialize the desktop profile, then quit and rerun Install.cmd.'
    }
    while (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $exe.FullName }) {
        Write-Host 'Quit DeepSeek Harness completely, including its tray icon.'
        if ((Read-Host 'Press Enter to recheck, or type Q to cancel') -eq 'Q') { exit 1 }
    }

    # Keep pnpm's file dependency usable after the download folder is removed.
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($package[0].FullName)
    try {
        $hash = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
    } finally {
        $stream.Dispose()
        $sha256.Dispose()
    }
    $cache = Join-Path (Join-Path $profilePath 'session-tree-packages') $hash.Substring(0, 16)
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $installedPackage = Join-Path $cache $package[0].Name
    Copy-Item -LiteralPath $package[0].FullName -Destination $installedPackage -Force
    $fileSpec = 'file:' + (Get-Item -LiteralPath $installedPackage).FullName.Replace('\', '/')
    & $cliPath plugin --profile desktop add $fileSpec
    if ($LASTEXITCODE -ne 0) { throw "DSH plugin installation failed (exit $LASTEXITCODE)." }

    Write-Host 'Installed dsh-session-tree in the desktop profile.'
    if (-not $NoLaunch) { Start-Process -FilePath $exe.FullName }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
