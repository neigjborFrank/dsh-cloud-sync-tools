# 一键更新：拉取本工具仓库的最新代码，必要时为 DSH profile 重装依赖
#
# 用法：
#   install\一键更新.cmd            # 更新并提示重启
#   install\一键更新.cmd -DryRun    # 只检查
param(
    [string]$DshHome = "",
    [string]$ProfileName = "desktop",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
function Write-Step($text) { Write-Host "[*] $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "[ok] $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "[!] $text" -ForegroundColor Yellow }
function Write-Err($text) { Write-Host "[x] $text" -ForegroundColor Red }

$scriptRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent $scriptRoot
if (-not (Test-Path (Join-Path $repoRoot ".git"))) { Write-Err "找不到工具仓库根目录：$repoRoot"; exit 1 }
Write-Ok "工具仓库：$repoRoot"

function Get-Head([string]$dir) {
    try { return (git -C $dir rev-parse HEAD 2>$null) } catch { return "" }
}

$before = Get-Head $repoRoot

if ($DryRun) {
    Write-Ok "（演练）git pull --ff-only origin main"
} else {
    Write-Step "拉取最新代码…"
    git -C $repoRoot pull --ff-only origin main
    if ($LASTEXITCODE -ne 0) {
        Write-Err "拉取失败：本地可能有改动或与远端分叉，请手动处理后再试"
        exit 1
    }
}

$after = Get-Head $repoRoot
if ($before -and $after -and $before -eq $after) {
    Write-Ok "已是最新版本（$($before.Substring(0,7))）"
    exit 0
}

Write-Ok "代码已更新：$($before.Substring(0,7)) → $($after.Substring(0,7))"

# 检查插件依赖是否变化，判断是否需要重装
$changed = $true
if (-not $DryRun) {
    $diff = git -C $repoRoot diff --name-only $before $after 2>$null
    $changed = $diff -match "plugin/package.json|plugin/lib/|plugin/index.js|plugin/client.js"
}
if ($changed) {
    if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
    $profileDir = Join-Path (Join-Path $DshHome "profiles") $ProfileName
    if (-not (Test-Path $profileDir)) {
        $first = Get-ChildItem (Join-Path $DshHome "profiles") -Directory | Select-Object -First 1
        if ($first) { $profileDir = $first.FullName }
    }
    $nodeExe = Join-Path $DshHome "dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
    if (-not (Test-Path $nodeExe)) { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
    $pnpmCjs = Join-Path $DshHome "dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
    if ((Test-Path $profileDir) -and (Test-Path $nodeExe) -and (Test-Path $pnpmCjs)) {
        Write-Step "插件代码有变化，刷新 DSH profile 依赖…"
        if ($DryRun) {
            Write-Ok "（演练）node pnpm.cjs install（在 $profileDir）"
        } else {
            Push-Location $profileDir
            try {
                & $nodeExe $pnpmCjs install
                if ($LASTEXITCODE -ne 0) { Write-Warn "pnpm install 失败（退出码 $LASTEXITCODE），请手动重试" }
                else { Write-Ok "依赖已刷新" }
            } finally { Pop-Location }
        }
    } else {
        Write-Warn "未找到 DSH profile / node / pnpm，跳过依赖刷新"
    }
}

Write-Host ""
Write-Ok "更新完成，请完全退出并重新启动 DSH（托盘也要退出）。" -ForegroundColor Cyan
