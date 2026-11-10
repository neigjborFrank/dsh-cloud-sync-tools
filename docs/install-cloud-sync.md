# 安装 cloud-sync skill 到本机 DSH

把仓库里 `tools/cloud-sync/` 复制到 `~/.dsh/skills/cloud-sync/`，安装后 DSH 即可识别该 skill。

```powershell
# 在仓库根目录执行
$dst = Join-Path $env:USERPROFILE ".dsh\skills\cloud-sync"
New-Item -ItemType Directory -Force -Path (Join-Path $dst "scripts") | Out-Null
Copy-Item ".\tools\cloud-sync\SKILL.md"        (Join-Path $dst "SKILL.md")    -Force
Copy-Item ".\tools\cloud-sync\scripts\sync.py" (Join-Path $dst "scripts\sync.py") -Force
Write-Host "已安装到 $dst"
```

安装后可用（在工作区目录内执行）：

```powershell
python "$env:USERPROFILE\.dsh\skills\cloud-sync\scripts\sync.py" check
python "$env:USERPROFILE\.dsh\skills\cloud-sync\scripts\sync.py" download
python "$env:USERPROFILE\.dsh\skills\cloud-sync\scripts\sync.py" upload "说明"
```

## 前提

- 已安装 Git for Windows（脚本会自行定位 `C:\Program Files\Git\cmd\git.exe`）。
- 本机 SSH 公钥已加入 GitHub（换设备需重新生成并添加）。
