---
name: cloud-sync
description: Treat a private Git remote (Gitee/GitHub/self-hosted) as the user's cloud copy of the DSH workspace, and move files on demand. Use when the user asks 检查是否和云端一致/同步/下载/上传/备份, mentions 云端仓库, 私有仓库, 多设备, or wants to know whether local and cloud differ. Read-only check by default; upload and download never force, never auto-resolve diverged history.
---

# 云端协同（cloud-sync）

把私有 Git 远端当作**云端副本**，本地工作区是它的一个副本。所有操作按"需求"触发，不做后台自动同步。

## 一、命令

用 `load_workspace_dependencies` 返回的 Python 执行 `scripts/sync.py`（脚本自行定位 git.exe，不依赖 PATH）：

| 意图 | 命令 | 说明 |
|---|---|---|
| 是否一致 | `check`（或 `status`） | **只读**：fetch 后比较，不修改工作区 |
| 下载云端 | `download` | 拉取；本地有改动时默认拒绝，加 `--stash` 才暂存后拉取 |
| 上传本地 | `upload "说明"` | add + commit + push |
| 看差异 | `diff` | 两侧改动的文件统计 |
| 绑定云端 | `init <url> [branch]` | 首次配置 |
| 历史 | `log` | 最近 10 条 |

面板/脚本调用可加 `--json`，返回结构化状态。

## 二、状态语义

`check` 返回六种状态之一：

| 状态 | 含义 | 建议动作 |
|---|---|---|
| `in-sync` | 与云端一致 | 无需操作 |
| `dirty` | 有未提交改动 | 先 upload |
| `behind` | 云端有新提交 | download |
| `ahead` | 本地领先 | upload |
| `diverged` | 两侧都有新提交 | **停止**，`diff` 后由人决定 |
| `offline` / `unbound` / `no-repo` | 连不上/未绑定/未建仓 | 检查网络或执行 init |

## 三、硬规则

1. **check 绝不写工作区**：只允许 `fetch`、`rev-list`、`status`、`log`。
2. **不 force、不自动合并分叉**：`diverged` 一律停下，把两侧差异报给用户。
3. **下载前保护本地改动**：有未提交内容时拒绝，除非用户明确 `--stash`；stash 恢复冲突要如实报告。
4. **上传前先看状态**：`diverged` 时禁止 push。
5. **会话目录不纳入同步**：`~/.dsh/sessions` 是运行时数据，两机同时写会损坏；需要留档用 `/export` 导 zip 放进工作区再同步。
6. **凭据红线**：不把令牌、私钥写入仓库或对话；`.gitignore` 已排除 `*.key`、`*.pem`、`.env`、`token*`。
7. **`out/` 不同步**：预览图与试验文档属于中间产物，交付物放 `交付/`。

## 四、跨设备使用

另一台设备：装 Git → 克隆到**相同的工作区路径**（DSH 会话历史按路径编码存储，路径不同则历史不跟随，文件完整）→ 用 DSH 打开该目录 → `check` 确认一致。

## 五、凭据

当前已配置 SSH 密钥（`~/.ssh/id_ed25519`，无口令，对应 GitHub 账户）。若更换设备，需要在新设备生成密钥并把公钥加到 GitHub，或改用 HTTPS + 凭据管理器。
