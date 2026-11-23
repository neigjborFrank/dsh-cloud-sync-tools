# 一键安装脚本：把云端同步面板装进本机 DSH（Windows / PowerShell 5+）
#
# 做四件事：
#   1. 找到（或克隆）本仓库；
#   2. 把插件以 link 方式写进 DSH profile 的 package.json（保留原有 bundles）；
#   3. 用 DSH 自带的 pnpm 安装依赖；
#   4. 配置仓库基础项（longpaths / 提交身份 / main 分支）。
#
# 安全约定：**默认不把本次克隆的仓库登记为同步仓库**——工具仓库可能属于分发者，
# 使用者需要在 DSH 的「同步 → 仓库管理…」里显式登记自己的私有仓库。
# 确实要立即登记本次克隆，可加 -RegisterRepo。
param(
    [string]$RepoUrl = "",
    [string]$DshHome = "",
    [string]$ProfileName = "desktop",
    [switch]$DryRun,
    [switch]$RegisterRepo,
    [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"
function Write-Step($text) { Write-Host "[*] $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "[ok] $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "[!] $text" -ForegroundColor Yellow }
function Write-Err($text) { Write-Host "[x] $text" -ForegroundColor Red }

# ---------- 0. 依赖检查与自动安装 ----------
function Find-GitExe {
    $cmd = Get-Command git -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "$env:ProgramFiles\Git\cmd\git.exe",
        "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
        "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
    )
    foreach ($candidate in $candidates) { if (Test-Path $candidate) { return $candidate } }
    return $null
}
function Update-PathWithGit {
    $dirs = @("$env:ProgramFiles\Git\cmd", "$env:LOCALAPPDATA\Programs\Git\cmd")
    foreach ($dir in $dirs) {
        if ((Test-Path $dir) -and ($env:Path -notlike "*$dir*")) { $env:Path = "$dir;$env:Path" }
    }
}

Write-Step "依赖检查"
$gitExe = Find-GitExe
if (-not $gitExe) {
    Write-Warn "未检测到 Git（克隆公开仓库、提交推送都需要它）"
    if ($DryRun) {
        Write-Ok "（演练）将尝试自动安装 Git"
    } else {
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if ($winget) {
            Write-Step "尝试用 winget 自动安装 Git（需要网络，可能较慢）…"
            try {
                & winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
            } catch { Write-Warn "winget 安装失败：$_" }
            Update-PathWithGit
            $gitExe = Find-GitExe
        }
        if (-not $gitExe) {
            Write-Step "尝试下载 Git for Windows 安装包（当前用户安装，无需管理员）…"
            try {
                $gitInstaller = Join-Path $env:TEMP "Git-64-bit.exe"
                Invoke-WebRequest -Uri "https://github.com/git-for-windows/git/releases/latest/download/Git-64-bit.exe" -OutFile $gitInstaller -UseBasicParsing -TimeoutSec 300
                Start-Process -FilePath $gitInstaller -ArgumentList "/VERYSILENT", "/NORESTART", "/CURRENTUSER" -Wait
                Update-PathWithGit
                $gitExe = Find-GitExe
            } catch { Write-Warn "自动下载/安装 Git 失败：$_" }
        }
    }
}
if ($gitExe) {
    Write-Ok "Git：$gitExe"
} else {
    Write-Err "未找到 Git，自动安装也失败。请手动安装 Git for Windows（https://git-scm.com/download/win）后重新运行本脚本"
    exit 1
}

# git-lfs（可选：超过 95MB 的大文件需要）
try {
    $lfsVersion = (& $gitExe lfs version 2>$null)
    if ($LASTEXITCODE -eq 0) { Write-Ok "git-lfs：$lfsVersion" }
    else { Write-Warn "未检测到 git-lfs（可选；>95MB 大文件需要）。可运行：winget install GitHub.GitLFS" }
} catch { Write-Warn "git-lfs 检查失败（可选组件，可忽略）" }

# PowerShell 版本
if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Warn "PowerShell 版本较旧（$($PSVersionTable.PSVersion)），建议使用 5.1+"
}

# DSH 是否在运行（安装只改 profile，需要完全重启后生效）
$dshProcesses = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue
if ($dshProcesses) {
    Write-Warn "检测到 DSH 正在运行：安装会修改 profile，请安装完成后完全退出并重新启动 DSH"
} else {
    Write-Ok "DSH 当前未运行"
}

# 默认端口占用（插件宿主使用 8732）
$portBusy = $false
try {
    $portBusy = [bool](Get-NetTCPConnection -LocalPort 8732 -State Listen -ErrorAction SilentlyContinue)
} catch {}
if ($portBusy) {
    Write-Warn "端口 8732 当前被占用（可能是旧插件实例）；重启 DSH 后新插件会重新监听"
} else {
    Write-Ok "端口 8732 可用"
}

# ---------- 1. 定位仓库根目录 ----------
$scriptRoot = Split-Path -Parent $PSCommandPath
function Find-RepoRoot([string]$start) {
    $dir = Resolve-Path $start -ErrorAction SilentlyContinue
    while ($dir) {
        if (Test-Path (Join-Path $dir ".git")) { return $dir.Path }
        $parent = Split-Path -Parent $dir.Path
        if ($parent -eq $dir.Path) { break }
        $dir = Resolve-Path $parent -ErrorAction SilentlyContinue
    }
    return $null
}

$repoRoot = Find-RepoRoot $scriptRoot
if (-not $repoRoot) {
    if (-not $RepoUrl) {
        Write-Warn "当前目录不在 git 仓库内。"
        $RepoUrl = Read-Host "请输入仓库地址（如 git@github.com:you/repo.git）"
    }
    if (-not $RepoUrl) { Write-Err "未提供仓库地址，退出"; exit 1 }
    $name = ($RepoUrl -replace '^.*[\\/:]', '') -replace '\.git$', ''
    $cloneRoot = Join-Path $env:USERPROFILE "Documents\deepseek-harness"
    $clonePath = Join-Path $cloneRoot $name
    if (Test-Path (Join-Path $clonePath ".git")) {
        Write-Ok "仓库已存在：$clonePath"
    } else {
        Write-Step "克隆仓库到 $clonePath"
        if ($DryRun) { Write-Ok "（演练）git clone $RepoUrl $clonePath" }
        else {
            New-Item -ItemType Directory -Force -Path $cloneRoot | Out-Null
            git clone $RepoUrl $clonePath
            if ($LASTEXITCODE -ne 0) { Write-Err "克隆失败（检查 SSH key / 网络）"; exit 1 }
        }
    }
    $repoRoot = $clonePath
}
Write-Ok "仓库根目录：$repoRoot"

$pluginDir = Join-Path $repoRoot "plugin-v2"
if (-not (Test-Path $pluginDir)) { $pluginDir = Join-Path $repoRoot "plugin" }
if (-not (Test-Path $pluginDir)) { $pluginDir = Join-Path $repoRoot "_repo\tools\panel\plugin" }
if (-not (Test-Path $pluginDir)) { Write-Err "找不到插件目录：$pluginDir"; exit 1 }

# ---------- 2. 定位 DSH 与 profile ----------
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
if (-not (Test-Path $DshHome)) { Write-Err "找不到 DSH 数据目录：$DshHome（请先安装并启动一次 DSH）"; exit 1 }
$profilesRoot = Join-Path $DshHome "profiles"
if (-not (Test-Path $profilesRoot)) { Write-Err "找不到 profiles 目录：$profilesRoot"; exit 1 }
$profileDir = Join-Path $profilesRoot $ProfileName
if (-not (Test-Path $profileDir)) {
    $first = Get-ChildItem $profilesRoot -Directory | Select-Object -First 1
    if (-not $first) { Write-Err "没有可用的 DSH profile"; exit 1 }
    $profileDir = $first.FullName
    Write-Warn "未找到 $ProfileName profile，改用：$profileDir"
}
Write-Ok "DSH profile：$profileDir"

$nodeExe = Join-Path $DshHome "dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path $nodeExe)) {
    $found = Get-ChildItem (Join-Path $DshHome "dsh-runtimes") -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $nodeExe = $found.FullName }
    if ($NodePath -and (Test-Path $NodePath)) { $nodeExe = $NodePath }
}
if (-not (Test-Path $nodeExe)) { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $nodeExe) { Write-Err "找不到 node（DSH 未安装完整？）"; exit 1 }
$pnpmCjs = Join-Path $DshHome "dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
if (-not (Test-Path $pnpmCjs)) {
    $found = Get-ChildItem (Join-Path $DshHome "dsh-runtimes") -Recurse -Filter "pnpm.cjs" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $pnpmCjs = $found.FullName }
}
if (-not (Test-Path $pnpmCjs)) { $pnpmCjs = "" }
Write-Ok "node：$nodeExe"
if ($pnpmCjs -and (Test-Path $pnpmCjs)) { Write-Ok "pnpm：$pnpmCjs" } else { $pnpmCjs = ""; Write-Warn "未找到 pnpm，跳过依赖安装（不影响插件本身，插件无 npm 依赖）" }

# ---------- 3. 备份并改写 profile/package.json ----------
$packageFile = Join-Path $profileDir "package.json"
if (-not (Test-Path $packageFile)) { Write-Err "找不到 profile package.json"; exit 1 }
$stamp = Get-Date -Format "yyyyMMddHHmmss"
if (-not $DryRun) {
    Copy-Item $packageFile "$packageFile.bak-$stamp" -Force
    Write-Ok "已备份 profile package.json（.bak-$stamp）"
}

$pluginLink = ($pluginDir -replace '\\', '/')
$editJs = @'
const fs = require("fs");
const [file, linkPath] = process.argv.slice(2);
const json = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
json.dependencies = json.dependencies || {};
json.dependencies["dsh-plugin-cloud-sync-panel"] = "link:" + linkPath;
json.dsh = json.dsh || {};
json.dsh.profile = json.dsh.profile || {};
const bundles = Array.isArray(json.dsh.profile.bundles) ? json.dsh.profile.bundles : [];
if (!bundles.includes("dsh-plugin-cloud-sync-panel")) bundles.push("dsh-plugin-cloud-sync-panel");
json.dsh.profile.bundles = bundles;
fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
console.log("bundles:", bundles.join(", "));
'@
$editFile = Join-Path $env:TEMP "dsh-cloud-install-edit.cjs"
Set-Content -Path $editFile -Value $editJs -Encoding UTF8
if ($DryRun) {
    Write-Ok "（演练）改写 profile package.json → link:$pluginLink"
} else {
    & $nodeExe $editFile $packageFile $pluginLink
    if ($LASTEXITCODE -ne 0) { Write-Err "改写 profile package.json 失败"; exit 1 }
    Write-Ok "profile package.json 已更新"
}

# ---------- 4. pnpm install ----------
if ($pnpmCjs -and (Test-Path $pnpmCjs)) {
    if ($DryRun) {
        Write-Ok "（演练）node pnpm.cjs install（在 $profileDir）"
    } else {
        Write-Step "安装依赖（稍慢）…"
        Push-Location $profileDir
        try {
            & $nodeExe $pnpmCjs install
            if ($LASTEXITCODE -ne 0) { Write-Warn "pnpm install 失败（退出码 $LASTEXITCODE），可稍后手动重试" }
            else { Write-Ok "依赖安装完成" }
        } finally { Pop-Location }
    }
}

# ---------- 4.5 仓库基础配置（提交身份 / 长路径 / 分支） ----------
if (-not $DryRun) {
    try {
        git -C $repoRoot config core.longpaths true | Out-Null
        $uname = git -C $repoRoot config --get user.name 2>$null
        if (-not $uname) { git -C $repoRoot config user.name "DSH User" | Out-Null }
        $uemail = git -C $repoRoot config --get user.email 2>$null
        if (-not $uemail) { git -C $repoRoot config user.email "dsh@localhost" | Out-Null }
        $branch = git -C $repoRoot symbolic-ref --short HEAD 2>$null
        if ($branch -and $branch -ne "main") { git -C $repoRoot checkout -B main | Out-Null }
        Write-Ok "仓库基础配置完成（longpaths / 提交身份 / main 分支）"
    } catch {
        Write-Warn "仓库基础配置部分失败（可手动处理）：$_"
    }
}

# ---------- 5. 登记同步仓库（默认不登记） ----------
if ($RegisterRepo) {
    $reposFile = Join-Path $DshHome "cloud-sync\repos.json"
    if ($DryRun) {
        Write-Ok "（演练）登记仓库 $repoRoot 到 $reposFile"
    } else {
        $regJs = @'
const fs = require("fs");
const path = require("path");
const [repoRoot, reposFile] = process.argv.slice(2);
function run(cwd, args) {
  try { return require("child_process").execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); } catch { return ""; }
}
let registry = { schema: 2, repos: [], bindings: {} };
try { registry = JSON.parse(fs.readFileSync(reposFile, "utf8")); } catch {}
registry.repos = Array.isArray(registry.repos) ? registry.repos : [];
if (!registry.repos.some((r) => path.resolve(r.path) === path.resolve(repoRoot))) {
  registry.repos.push({
    id: "repo-" + require("crypto").randomBytes(4).toString("hex"),
    name: path.basename(repoRoot),
    url: run(repoRoot, ["config", "--get", "remote.origin.url"]),
    path: repoRoot,
    branch: "main",
    addedAt: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(reposFile), { recursive: true });
  fs.writeFileSync(reposFile, JSON.stringify(registry, null, 2), "utf8");
}
console.log("repos:", registry.repos.map((r) => r.name).join(", "));
'@
        $regFile = Join-Path $env:TEMP "dsh-cloud-install-repos.cjs"
        Set-Content -Path $regFile -Value $regJs -Encoding UTF8
        & $nodeExe $regFile $repoRoot $reposFile
        Write-Ok "已登记同步仓库：$repoRoot"
    }
} else {
    Write-Warn "未自动登记同步仓库（安全默认）。"
    Write-Host "  首次使用请打开 DSH 的「同步 → 仓库管理…」，登记你自己的私有仓库。" -ForegroundColor Gray
    Write-Host "  确实要登记本次克隆的仓库，可运行：一键安装.cmd -RegisterRepo" -ForegroundColor Gray
}

Write-Host ""
Write-Ok "安装完成。"
Write-Host "下一步：彻底退出 DSH（托盘也要退出）后重新启动（加载插件 v2）。" -ForegroundColor Cyan
Write-Host "侧边栏底部会出现「同步」按钮；先在「仓库管理…」登记你自己的私有仓库。" -ForegroundColor Cyan
if (-not $DryRun) {
    Write-Host ""
    Write-Host "注意：工具所在仓库不会被自动当作同步仓库；不同仓库地址之间互不相通。" -ForegroundColor Gray
}
