# 回滚：把 DSH profile 恢复到安装插件之前的状态
# 用法：右键“使用 PowerShell 运行”，或在 PowerShell 里执行本脚本

$ErrorActionPreference = "Stop"
$profileDir = $env:DSH_PROFILE_DIR
if (-not $profileDir) { $profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\desktop" }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$snapshot = Join-Path $here "profile-restore"

Write-Host "profile: $profileDir"
if (-not (Test-Path $profileDir)) { throw "找不到 profile 目录: $profileDir" }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $env:USERPROFILE ".dsh\profiles\backup-$stamp"
Write-Host "先备份当前状态到: $backup"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
Copy-Item "$profileDir\*" $backup -Recurse -Force -ErrorAction SilentlyContinue

# 1) 还原 package.json（无 BOM）
if (Test-Path "$snapshot\package.json") {
    $json = Get-Content "$snapshot\package.json" -Raw -Encoding utf8
    [System.IO.File]::WriteAllText((Join-Path $profileDir "package.json"), $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "已还原 package.json"
}

# 2) 还原 cordis.patch.yml（优先用快照，其次用 .bak）
$patch = Join-Path $profileDir "cordis.patch.yml"
if (Test-Path "$snapshot\cordis.patch.yml") {
    Copy-Item "$snapshot\cordis.patch.yml" $patch -Force
    Write-Host "已还原 cordis.patch.yml（快照）"
} elseif (Get-ChildItem $profileDir -Filter "cordis.patch.yml.bak-*" -ErrorAction SilentlyContinue) {
    $bak = Get-ChildItem $profileDir -Filter "cordis.patch.yml.bak-*" | Sort-Object LastWriteTime | Select-Object -Last 1
    Copy-Item $bak.FullName $patch -Force
    Write-Host "已还原 cordis.patch.yml（$($bak.Name)）"
}

# 3) 移除插件安装痕迹
foreach ($t in @("node_modules", ".plugin-manager")) {
    $p = Join-Path $profileDir $t
    if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "已删除 $t" }
}
$lock = Join-Path $profileDir "pnpm-lock.yaml"
if (Test-Path $lock) { Remove-Item $lock -Force; Write-Host "已删除 pnpm-lock.yaml" }

Write-Host ""
Write-Host "完成。当前 profile 内容:" -ForegroundColor Green
Get-ChildItem $profileDir -Force | Select-Object Length, Name | Format-Table -AutoSize
Write-Host "现在可以重新启动 DSH。"
