[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$ApplicationPath,
  [switch]$BrowserEnabled
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$resolvedApplication = (Resolve-Path -LiteralPath $ApplicationPath).Path
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ("dsh-desktop-smoke-$([guid]::NewGuid().ToString('N'))")
$smokeHome = Join-Path $tempRoot 'home'
$appData = Join-Path $smokeHome 'AppData\Roaming'
$localAppData = Join-Path $smokeHome 'AppData\Local'
$userDataDir = Join-Path $appData 'DSH Codex Desktop'
$dshHome = Join-Path $tempRoot 'dsh-home'
$stdoutPath = Join-Path $tempRoot 'application.stdout.log'
$stderrPath = Join-Path $tempRoot 'application.stderr.log'
New-Item -ItemType Directory -Path $userDataDir, $localAppData, $dshHome -Force | Out-Null
if ($BrowserEnabled) {
  Set-Content -LiteralPath (Join-Path $userDataDir 'browser-automation.json') -Value "{`n  `"enabled`": true,`n  `"schemaVersion`": 1`n}" -Encoding UTF8
}
$previous = @{
  USERPROFILE = $env:USERPROFILE
  HOME = $env:HOME
  APPDATA = $env:APPDATA
  LOCALAPPDATA = $env:LOCALAPPDATA
  DSH_HOME = $env:DSH_HOME
}
$env:USERPROFILE = $smokeHome
$env:HOME = $smokeHome
$env:APPDATA = $appData
$env:LOCALAPPDATA = $localAppData
$env:DSH_HOME = $dshHome
$application = $null
$bootstrapProcessId = $null

function Read-ApplicationOutput {
  $output = @()
  foreach ($path in @($stdoutPath, $stderrPath)) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $output += Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
    }
  }
  return ($output -join "`n").Trim()
}

try {
  $application = Start-Process -FilePath $resolvedApplication -WorkingDirectory $tempRoot -ArgumentList "`"--user-data-dir=$userDataDir`"", '--smoke-test' -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  $deadline = (Get-Date).AddSeconds(180)
  $baseUrl = $null
  while ((Get-Date) -lt $deadline -and $null -eq $baseUrl) {
    $application.Refresh()
    if ($application.HasExited) { throw "打包应用提前退出（退出码 $($application.ExitCode)）：$(Read-ApplicationOutput)" }
    $ready = [regex]::Match((Read-ApplicationOutput), 'DSH_SMOKE_READY\s+(?<url>http://127\.0\.0\.1:\d+)')
    if ($ready.Success) { $baseUrl = $ready.Groups['url'].Value }
    if ($null -eq $baseUrl) { Start-Sleep -Milliseconds 250 }
  }
  if ($null -eq $baseUrl) { throw "打包应用在 180 秒内未输出最终 DSH 就绪地址：$(Read-ApplicationOutput)" }

  $bootstrap = Get-CimInstance Win32_Process | Where-Object {
    $_.ParentProcessId -eq $application.Id -and $_.CommandLine -like '*bootstrap.mjs*'
  } | Select-Object -First 1
  if ($null -ne $bootstrap) { $bootstrapProcessId = $bootstrap.ProcessId }

  $page = Invoke-WebRequest -Uri "$baseUrl/" -UseBasicParsing
  if ($page.StatusCode -ne 200) { throw "根页面返回 HTTP $($page.StatusCode)。" }
  $asset = [regex]::Match($page.Content, '(?:src|href)=["''](?<path>/[^"'']+\.(?:js|css))')
  if (-not $asset.Success) { throw '根页面未找到可验证的前端资源。' }
  $assetResponse = Invoke-WebRequest -Uri "$baseUrl$($asset.Groups['path'].Value)" -UseBasicParsing
  if ($assetResponse.StatusCode -ne 200) { throw "前端资源返回 HTTP $($assetResponse.StatusCode)。" }
  if ($BrowserEnabled -and (Read-ApplicationOutput) -notmatch 'DSH_SMOKE_BROWSER\s+enabled=true\s+runtime=true') {
    throw "应用没有成功加载随包浏览器自动化运行时：$(Read-ApplicationOutput)"
  }
  if (-not $application.WaitForExit(30000)) { throw '应用未在冒烟模式下受控退出。' }
  Write-Host "SMOKE_OK application=$resolvedApplication health=$baseUrl controlledExit=true browserEnabled=$($BrowserEnabled.IsPresent.ToString().ToLowerInvariant()) isolatedUserData=true"
} finally {
  if ($null -ne $application) {
    $application.Refresh()
    if (-not $application.HasExited) {
      Stop-Process -Id $application.Id -Force -ErrorAction SilentlyContinue
      $application.WaitForExit(10000) | Out-Null
    }
  }
  $bootstrapStillRunning = $false
  if ($null -ne $bootstrapProcessId) {
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $bootstrapProcessId -ErrorAction SilentlyContinue)) {
      Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $bootstrapProcessId -ErrorAction SilentlyContinue) {
      $bootstrapStillRunning = $true
    }
  }
  $env:USERPROFILE = $previous.USERPROFILE
  $env:HOME = $previous.HOME
  $env:APPDATA = $previous.APPDATA
  $env:LOCALAPPDATA = $previous.LOCALAPPDATA
  $env:DSH_HOME = $previous.DSH_HOME
  $resolvedTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
  if ($resolvedTempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($bootstrapStillRunning) { throw "DSH 引导进程 $bootstrapProcessId 未在应用退出后结束。" }
}
