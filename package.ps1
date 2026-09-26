param(
    [switch]$IncludePrivateDeployment,
    [switch]$IncludeSessionBackend,
    [string]$ServerCjs = "$env:LOCALAPPDATA\Programs\@mirasimdesktop\resources\server.cjs",
    [string]$SettingJson = "$env:USERPROFILE\.mirasim\setting.json"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$utf8 = New-Object System.Text.UTF8Encoding($false)
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
[System.IO.Directory]::CreateDirectory($dist) | Out-Null
$version = (& node (Join-Path $root 'mirasim-bridge.js') --version).Trim()
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid project version' }
$sourceFiles = @(
    'mirasim-bridge.js', 'config.example.json', 'install.sh',
    'mirasim-bridge.service', 'README.md', 'DEPLOY.md', 'CHANGELOG.md', 'MULTI-MODEL.md',
    'DESIGN.md', 'DESIGN.v3.md', '.gitignore', '.gitattributes', 'package.ps1', 'tests/bridge.test.js',
    'lib/relay.js', 'lib/responses.js', 'tests/relay.test.js', 'RELAY.md',
    'THIRD-PARTY-NOTICES.md', 'licenses/cpa-plugin-mirasim.txt', 'licenses/CLIProxyAPI.txt', 'scripts/export-credential.js',
    'scripts/deployment.js', 'tests/resilience.test.js', 'tests/deployment.test.js', 'AUDIT.md',
    'Dockerfile', '.dockerignore', 'compose.yaml', 'compose.host.yaml', '.env.example', 'DOCKER.md',
    'scripts/prepare-container.js', 'scripts/container-config.js', 'scripts/healthcheck.js', 'tests/container.test.js', 'SUB2API-PLUGIN.md',
    'tests/model-sync.test.js', 'UPGRADE-0.4.3.md', 'UPGRADE-0.5.0.md', 'ACCOUNTS.md',
    'lib/login.js', 'lib/quota.js', 'lib/sse.js', 'lib/panel.js', 'scripts/account-login.js', 'scripts/panel-bridge.js', 'compose.profile.yaml', 'compose.profile.host.yaml',
    'tests/accounts-quota.test.js', 'tests/model-latency.test.js',
    'scripts/deploy-agent.py', 'tests/test_network_deploy.py', 'NETWORK-DEPLOY.md', '.github/workflows/publish.yml',
    'scripts/issue-deploy-command.py', '.github/workflows/remote-deploy.yml', 'REMOTE-CONTROL.md', 'PANEL.md',
    'scripts/panel-host.py', 'scripts/install-panel.py', 'web/index.html', 'web/app.js', 'web/style.css', 'web/icon.png',
    'tests/panel.test.js', 'tests/test_panel_host.py', 'tests/sse-failures.test.js', 'STREAM-TROUBLESHOOTING.md', 'HERMES.md',
    'CODEX.md', 'VERIFY.md', 'tests/identity-fallback.test.js', 'tests/codex-account.test.js',
    'tests/hosted-accounts.test.js', 'UPGRADE-0.8.0.md', 'tests/web-panel.test.js', 'scripts/verify-package.py', 'RECOVERY.md', 'tests/test_release_source.py', 'UPDATE-TROUBLESHOOTING.md'
)

function Get-ByteHash([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Write-Bundle([string]$Name, [bool]$Private) {
    $zipPath = Join-Path $dist $Name
    $entries = [ordered]@{}
    foreach ($relative in $sourceFiles) {
        $full = Join-Path $root $relative
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Missing project file: $relative" }
        if ([System.IO.Path]::GetExtension($relative) -eq '.png') {
            $entries[$relative] = [System.IO.File]::ReadAllBytes($full)
        } else {
            # Normalize text only: decoding a PNG as UTF-8 corrupts the logo.
            $text = [System.IO.File]::ReadAllText($full).Replace("`r`n", "`n").TrimStart([char]0xfeff)
            $entries[$relative] = $utf8.GetBytes($text)
        }
    }
    if ($Private) {
        foreach ($full in @($SettingJson)) {
            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Missing deployment dependency: $full" }
        }
        $login = [System.IO.File]::ReadAllText($SettingJson) | ConvertFrom-Json
        if ((-not $login.auth.token -or -not $login.device.privateKey) -and ($login.type -ne 'mirasim' -or -not $login.access_token -or -not $login.device_private_key)) { throw 'Login file lacks token/device private key' }
        $cfg = [System.IO.File]::ReadAllText((Join-Path $root 'config.json')) | ConvertFrom-Json
        if (-not $cfg.sub2api.admin_api_key) { throw 'Local config lacks sub2api admin_api_key' }
        if ($IncludeSessionBackend) {
            if (-not (Test-Path -LiteralPath $ServerCjs -PathType Leaf)) { throw 'Missing optional session backend server.cjs' }
            $entries['private/server.cjs'] = [System.IO.File]::ReadAllBytes($ServerCjs)
        }
        # Desktop mrs1 credentials are machine-encrypted. Export only this account's
        # auth/device data, never unrelated provider API keys or the master key.
        $exportPath = Join-Path $dist ('credential-' + [guid]::NewGuid().ToString('N') + '.tmp')
        try {
            & node (Join-Path $root 'scripts/export-credential.js') --settings $SettingJson --out $exportPath
            if ($LASTEXITCODE -ne 0) { throw 'Portable credential export failed' }
            $entries['private/setting.json'] = [System.IO.File]::ReadAllBytes($exportPath)
        } finally {
            if (Test-Path -LiteralPath $exportPath) { Remove-Item -LiteralPath $exportPath -Force }
        }
        $entries['private/admin-key'] = $utf8.GetBytes($cfg.sub2api.admin_api_key.Trim() + "`n")
        $entries['private/NOTICE.txt'] = $utf8.GetBytes("PRIVATE: contains live login credentials and an administrator API key.`nUpload only to your own server. Do not publish this archive.`n")
    }
    $manifest = New-Object System.Collections.Generic.List[string]
    foreach ($relative in $entries.Keys) {
        $manifest.Add((Get-ByteHash $entries[$relative]) + '  ' + $relative)
    }
    $entries['SHA256SUMS'] = $utf8.GetBytes(($manifest -join "`n") + "`n")
    # Write a sibling temporary archive, then atomically replace the destination.
    $tmpPath = $zipPath + '.tmp'
    $stream = [System.IO.File]::Open($tmpPath, [System.IO.FileMode]::Create)
    $zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($relative in $entries.Keys) {
            $entry = $zip.CreateEntry('mirasim-bridge/' + $relative, [System.IO.Compression.CompressionLevel]::Optimal)
            $out = $entry.Open()
            try { $out.Write($entries[$relative], 0, $entries[$relative].Length) }
            finally { $out.Dispose() }
        }
    } finally { $zip.Dispose(); $stream.Dispose() }
    $check = [System.IO.Compression.ZipFile]::OpenRead($tmpPath)
    try {
        if ($check.Entries.Count -ne $entries.Count) { throw 'Archive entry count mismatch' }
        foreach ($entry in $check.Entries) {
            $relative = $entry.FullName.Substring('mirasim-bridge/'.Length)
            $inputStream = $entry.Open()
            $memory = New-Object System.IO.MemoryStream
            try {
                $inputStream.CopyTo($memory)
                if ((Get-ByteHash $memory.ToArray()) -ne (Get-ByteHash $entries[$relative])) { throw "Archive hash mismatch: $relative" }
            } finally { $inputStream.Dispose(); $memory.Dispose() }
        }
    } finally { $check.Dispose() }
    Move-Item -LiteralPath $tmpPath -Destination $zipPath -Force
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText($zipPath + '.sha256', "$hash  $Name`n", $utf8)
    $size = [Math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 2)
    Write-Output "Created and verified: $zipPath ($size MB, $($entries.Count) files)"
}

Write-Bundle "mirasim-bridge-$version-source.zip" $false
if ($IncludePrivateDeployment) { Write-Bundle "mirasim-bridge-$version-linux-private.zip" $true }
