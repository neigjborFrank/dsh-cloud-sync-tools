# DSH 云端同步插件

把 DSH 的**工作区 + 会话**归档到你自己私有的 Git 仓库（GitHub / Gitee / 自建均可），用于多设备迁移与历史查看。
不需要 GitHub Token，不依赖任何云服务；版本历史与恢复直接使用 Git / GitHub。

## 当前状态（v2 重构）

| 目录 | 说明 |
|---|---|
| `plugin-v2/` | **新版实现**（M1–M4 已完成，M5 安装脚本就绪），重构后的默认安装目标 |
| `plugin/` | 旧版实现（v3.4），保留用于回退；切换见安装说明 |
| `install/` | 一键安装 / 一键更新（Windows PowerShell） |
| `tests/` | 单元测试（`tests/unit`）与集成测试（`tests/integration`） |
| `docs/` | 策划案、架构说明、安装说明、落盘规则 |
| `tools/`、`logs/` | 辅助工具与历史故障记录 |

## 快速开始（新设备 / 全新安装）

1. 克隆本仓库：
   ```powershell
   git clone git@github.com:neigjborFrank/dsh-cloud-sync-tools.git C:\Users\<你>\Documents\deepseek-harness\cloud-sync-tools
   ```
2. 运行一键安装（默认安装 `plugin-v2`，**不会**自动登记任何仓库）：
   ```powershell
   C:\Users\<你>\Documents\deepseek-harness\cloud-sync-tools\install\一键安装.cmd
   ```
3. 完全退出 DSH（含托盘）后重新启动；
4. 侧边栏底部「同步」→ **仓库管理…** → 填入你的私密仓库地址（如 `git@github.com:<你>/deepseek_cloud.git`）→ 添加；
5. 「上传会话…」选择工作区与会话 → 确认目标仓库 → 上传；
6. 「云端与同步…」查看状态（一致 / 有未上传改动 / 仅云端）。

> 私密仓库需要提前创建并配置好本机访问凭据（SSH key 或 HTTPS 凭据）。插件不调用平台 API。

## 云端数据布局

```
store/<最大工作区>/files/...     # 工作区内容（保持原始目录结构，可人工浏览/单文件下载）
store/<最大工作区>/large/...     # 大文件（git-lfs）
index/projects/<项目>/           # 清单、会话、映射关系（不含文件内容）
  ├── meta.json                 #   cwd、aliases（合并的子目录）、会话列表
  ├── manifest.json             #   路径 → 哈希
  ├── conflicts/<ts>/…          #   合并冲突隔离
  └── sessions/<会话id>/…       #   会话日志 + workspace-ref
```

工作区按「最大包含」合并：子目录工作区并入父项目对应子路径；上传父目录时把旧项目并入更大工作区。

## 文档

- [重构策划案（v2）](docs/重构策划案-v2.md) —— 需求全集、多颗粒度设计、分期计划
- [系统架构说明（v2）](docs/架构说明-v2.md) —— 模块地图、数据契约、API、不变量（**每个里程碑更新**）
- [安装说明](docs/安装说明.md) —— 安装、更新、故障恢复、目录结构
- [归档与落盘规则](docs/归档与落盘规则.md)

## 测试

```powershell
# 单元测试（13 项）
node --test tests/unit/core.test.mjs
node --test tests/unit/session_repo.test.mjs

# 集成测试（22 项，使用真实 git 仓库与 bare 远端；不会碰真实 DSH 数据）
node tests/integration/api.test.mjs <仓库根>/plugin-v2 <临时目录> 8910
```

## 安全与边界

- 不自动登记仓库：工具仓库与同步仓库严格分离；
- 不破坏 DSH 的 workspace 注册表：写前备份、写后校验、失败不写；
- 不静默覆盖数据：同路径不同内容进 `conflicts/`，下载多余文件进回收目录；
- 容器仓库不强制一一对应：多个工作区可放同一个仓库，也可分开放；仓库由使用者自行整理。

## 许可

见 [LICENSE](LICENSE)。
