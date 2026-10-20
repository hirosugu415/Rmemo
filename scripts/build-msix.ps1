# Builds the Microsoft Store package (MSIX) into dist-msix/.
#
#   powershell -ExecutionPolicy Bypass -File scripts/build-msix.ps1
#
# Needs the Windows 10/11 SDK (for makeappx.exe) and the identity values from
# Partner Center (製品 ID → パッケージ ID / 発行元) in msix/identity.json.
# The package is unsigned: the Store signs it on submission.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$identityPath = Join-Path $root "msix/identity.json"
if (-not (Test-Path $identityPath)) {
    throw "msix/identity.json がありません。msix/identity.example.json をコピーして、Partner Center の値を入れてください。"
}
$identity = Get-Content $identityPath -Raw -Encoding UTF8 | ConvertFrom-Json

# MSIX wants four parts, and the Store requires the last one to be 0.
$conf = Get-Content (Join-Path $root "src-tauri/tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = "$($conf.version).0"

$sdkBin = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName "x64\makeappx.exe") } |
    Sort-Object { [version]$_.Name } | Select-Object -Last 1
if (-not $sdkBin) { throw "makeappx.exe が見つかりません。Windows SDK をインストールしてください。" }
$makeappx = Join-Path $sdkBin.FullName "x64\makeappx.exe"

# The Store updates the app itself, so this build never checks GitHub.
Write-Host "==> Building rmemo.exe (Store build)"
$env:VITE_STORE_BUILD = "1"
try {
    npm run tauri build -- --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
} finally {
    Remove-Item Env:VITE_STORE_BUILD
}

$stage = Join-Path $root "dist-msix/stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage "Assets") | Out-Null

Copy-Item (Join-Path $root "src-tauri/target/release/rmemo.exe") $stage
foreach ($logo in "StoreLogo.png", "Square44x44Logo.png", "Square150x150Logo.png") {
    Copy-Item (Join-Path $root "src-tauri/icons/$logo") (Join-Path $stage "Assets")
}

$manifest = (Get-Content (Join-Path $root "msix/AppxManifest.xml") -Raw -Encoding UTF8).
    Replace("{{IDENTITY_NAME}}", $identity.identityName).
    Replace("{{PUBLISHER}}", $identity.publisher).
    Replace("{{PUBLISHER_DISPLAY_NAME}}", $identity.publisherDisplayName).
    Replace("{{VERSION}}", $version)
[IO.File]::WriteAllText((Join-Path $stage "AppxManifest.xml"), $manifest, (New-Object Text.UTF8Encoding $false))

$out = Join-Path $root "dist-msix/Rmemo_${version}_x64.msix"
Write-Host "==> Packing $out"
& $makeappx pack /d $stage /p $out /o
if ($LASTEXITCODE -ne 0) { throw "makeappx failed" }

Write-Host ""
Write-Host "Done: $out"
Write-Host "Test locally (Developer Mode): Add-AppxPackage -Register `"$stage\AppxManifest.xml`""
