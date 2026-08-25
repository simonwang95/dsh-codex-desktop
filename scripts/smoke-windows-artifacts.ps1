[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$NsisPath,
  [Parameter(Mandatory)][string]$ZipPath,
  [Parameter(Mandatory)][string]$EvidencePath
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$nsis = (Resolve-Path -LiteralPath $NsisPath).Path
$zip = (Resolve-Path -LiteralPath $ZipPath).Path
$evidence = [System.IO.Path]::GetFullPath($EvidencePath)
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$root = Join-Path $tempBase ("dsh-artifact-smoke-$([guid]::NewGuid().ToString('N'))")
$smokeHome = Join-Path $root 'home'
$dshProfile = Join-Path $smokeHome '.dsh'
$sentinel = Join-Path $dshProfile 'i004-profile-sentinel.txt'
$appData = Join-Path $smokeHome 'AppData\Roaming'
$localAppData = Join-Path $smokeHome 'AppData\Local'
$zipDir = Join-Path $root 'zip'
$installDir = Join-Path $root 'installed'
New-Item -ItemType Directory -Path $dshProfile, $appData, $localAppData, $zipDir, $installDir -Force | Out-Null
Set-Content -LiteralPath $sentinel -Value 'I004_PROFILE_MUST_SURVIVE_UNINSTALL' -Encoding UTF8

$previous = @{
  USERPROFILE = $env:USERPROFILE
  HOME = $env:HOME
  DSH_HOME = $env:DSH_HOME
  APPDATA = $env:APPDATA
  LOCALAPPDATA = $env:LOCALAPPDATA
}

try {
  $env:USERPROFILE = $smokeHome
  $env:HOME = $smokeHome
  $env:DSH_HOME = $dshProfile
  $env:APPDATA = $appData
  $env:LOCALAPPDATA = $localAppData

  Expand-Archive -LiteralPath $zip -DestinationPath $zipDir -Force
  $zipApplication = Get-ChildItem -LiteralPath $zipDir -Recurse -File -Filter 'DSH Codex Desktop.exe' | Select-Object -First 1 -ExpandProperty FullName
  if ([string]::IsNullOrWhiteSpace($zipApplication)) { throw 'ZIP 解压后未找到应用可执行文件。' }
  & "$PSScriptRoot\smoke-package.ps1" -ApplicationPath $zipApplication

  $installer = Start-Process -FilePath $nsis -ArgumentList '/S', "/D=$installDir" -Wait -PassThru
  if ($installer.ExitCode -ne 0) { throw "NSIS 安装失败：$($installer.ExitCode)" }
  $installedApplication = Join-Path $installDir 'DSH Codex Desktop.exe'
  if (-not (Test-Path -LiteralPath $installedApplication -PathType Leaf)) { throw 'NSIS 安装后未找到应用可执行文件。' }
  & "$PSScriptRoot\smoke-package.ps1" -ApplicationPath $installedApplication

  $uninstaller = Get-ChildItem -LiteralPath $installDir -File -Filter 'Uninstall*.exe' | Select-Object -First 1 -ExpandProperty FullName
  if ([string]::IsNullOrWhiteSpace($uninstaller)) { throw 'NSIS 安装后未找到卸载器。' }
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "NSIS 卸载失败：$($uninstall.ExitCode)" }
  if (-not (Test-Path -LiteralPath $sentinel -PathType Leaf)) { throw '卸载错误删除了隔离 HOME 下的 ~/.dsh 哨兵。' }
  if ((Get-Content -LiteralPath $sentinel -Raw).Trim() -ne 'I004_PROFILE_MUST_SURVIVE_UNINSTALL') { throw 'Profile 哨兵内容被改写。' }

  $os = Get-CimInstance Win32_OperatingSystem
  $lines = @(
    "RUNNER windows=$($os.Caption) version=$($os.Version) arch=$env:PROCESSOR_ARCHITECTURE",
    "ZIP_EXTRACT_START_OK file=$([System.IO.Path]::GetFileName($zip)) controlledExit=true",
    "NSIS_INSTALL_START_UNINSTALL_OK file=$([System.IO.Path]::GetFileName($nsis)) controlledExit=true",
    'PROFILE_SENTINEL_OK path=isolated-home/.dsh/i004-profile-sentinel.txt preservedAfterUninstall=true',
    "ARTIFACT file=$([System.IO.Path]::GetFileName($nsis)) bytes=$((Get-Item -LiteralPath $nsis).Length) sha256=$((Get-FileHash -LiteralPath $nsis -Algorithm SHA256).Hash.ToLowerInvariant())",
    "ARTIFACT file=$([System.IO.Path]::GetFileName($zip)) bytes=$((Get-Item -LiteralPath $zip).Length) sha256=$((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant())",
    'WINDOWS_ARTIFACT_SMOKE_OK nsis=true zip=true uninstall=true profilePreserved=true'
  )
  $evidenceDir = Split-Path -Parent $evidence
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  Set-Content -LiteralPath $evidence -Value $lines -Encoding UTF8
  $lines | ForEach-Object { Write-Host $_ }
} finally {
  $env:USERPROFILE = $previous.USERPROFILE
  $env:HOME = $previous.HOME
  $env:DSH_HOME = $previous.DSH_HOME
  $env:APPDATA = $previous.APPDATA
  $env:LOCALAPPDATA = $previous.LOCALAPPDATA
  $resolvedRoot = [System.IO.Path]::GetFullPath($root)
  if ($resolvedRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
