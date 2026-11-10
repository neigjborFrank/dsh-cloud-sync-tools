# DeepSeek Harness 工作区故障 Debug 报告

> 主题：`workspaceController` 服务不可用（新建/打开工作区失败）
> 报告日期：2026-11-08
> 报告人：用户（经 WorkBuddy 协助排查）

---

## 一、问题概述

- **问题类型**：工作区创建失败 / `workspaceController` 服务不可用
- **影响版本**：`0.2.2-rc.1`（desktop）
- **严重程度**：高（工作区功能完全不可用，但 UI 其余部分正常）

---

## 二、环境信息

| 项目 | 值 |
|---|---|
| 产品 | DeepSeek Harness 桌面版 |
| 版本（desktopVersion） | `0.2.2-rc.1` |
| Electron | `44.7.0` |
| Node | `24.21.0` |
| pnpm | `11.28.5` |
| 操作系统 | Windows（win32, x64） |
| 安装路径 | `D:\deepseek` |
| Profile | `~/.dsh/profiles/desktop` |
| 数据目录 | `C:\Users\<user>\.dsh` |

---

## 三、症状

**报错信息：**

```
workspace create failed: gateway/service-unavailable: typert gateway: workspace/create: active Service "workspaceController" is unavailable
```

**现象：**

- UI 其余部分正常加载，仅「新建 / 打开工作区」失败。
- 触发操作：点击「添加工作区」→ 选择文件夹 `D:\deepseek\dsh-workspace` → 确认后报错。
- 重装、回退版本、新建 profile 均无效（坏数据仍留在原 storage 文件中）。

---

## 四、根因分析

### 4.1 直接原因

`~/.dsh/storages/workspace.json` 中存在「**同一个 session 被两个 workspace 重复登记**」的不一致数据：

| workspaceId | path | sessionIds |
|---|---|---|
| `4d348ab9-420e-4851-abe7-ebcf3eb0aed1` | `D:\deepseek\workspace\test` | `session-22c42740-…`、`session-3c01ca8e-…` |
| `ed10f461ac0648e010c3701ab19db8ef` | `C:\Users\<user>\Documents\deepseek-harness\default-workspace\out\_dl_target` | `session-3c01ca8e-…` ← **重复** |

其中 `session-3c01ca8e-7ec9-4c3b-ad06-6db719e9fd8c` 的 `cwd`（见 `session_projcache`）为 `D:\deepseek\workspace\test`，应归属**第一个**工作区；**第二个**工作区对它的登记是错误/残留的。

### 4.2 故障链路

1. `@deepseek-ai/dsh-workspace` 的 `WorkspaceRegistry` 在 `[Service.init]()` 中调用 `validateStoredState(state)` 做一致性校验；
2. 该方法检测到「session 被两个 workspace 同时声明」并抛出异常；
3. 异常导致 workspace 域加载失败 → `workspaceRegistry` 服务无法激活；
4. `@deepseek-ai/dsh-api-workspace-controller` 依赖 `workspaceRegistry`，因此 `workspaceController` 服务也无法激活；
5. Typert 网关收到 `workspace/create` 请求时找不到活跃的 `workspaceController` 服务，返回 503 `gateway/service-unavailable`。

### 4.3 关键代码位置

**① 一致性校验（抛错点）** — `packages/workspace/workspace`（包 `@deepseek-ai/dsh-workspace@0.2.2-rc.1`）`lib/index.js`：

```js
validateStoredState(state) {
    const table = this.requireTable();
    const order = new Set();
    for (const id of state.workspaceIds) {
        if (order.has(id)) throw new Error(`... registry order repeats workspace '${id}'`);
        if (table.get(id) === void 0) throw new Error(`... registry order references missing workspace '${id}'`);
        order.add(id);
    }
    if (state.initialized && order.size !== table.size) {
        const orphan = [...table.keys()].find((id) => !order.has(id));
        throw new Error(`workspace domain is inconsistent: workspace '${orphan}' is absent from registry order`);
    }
    const paths = new Map();
    const accounted = new Map();
    for (const [id, record] of table.entries()) {
        const pathHolder = paths.get(record.path);
        if (pathHolder !== void 0) throw new Error(`workspace domain is inconsistent: path '${record.path}' is claimed by both workspace ...`);
        paths.set(record.path, id);
        for (const sessionId of record.sessionIds) {
            const holder = accounted.get(sessionId);
            if (holder !== void 0)
                throw new Error(`workspace domain is inconsistent: session '${sessionId}' is accounted by both workspace '${holder}' and workspace '${id}'`);
            accounted.set(sessionId, id);
        }
    }
}
```

调用位置：`WorkspaceRegistry` 的 `[Service.init]()` 中，`this.validateStoredState(this.state)` 与 `this.validateStoredState(this.requireState())` 两处。

**② 网关报错点** — Typert gateway：

```js
if (!isObject(receiver))
    throw new TypertGatewayError("gateway/service-unavailable", endpoint, `active Service ${JSON.stringify(descriptor.service)} is unavailable`);
```

---

## 五、修复方法

1. 备份 `workspace.json`；
2. 从 `ed10f461ac0648e010c3701ab19db8ef` 的 `sessionIds` 中移除重复的 `session-3c01ca8e-7ec9-4c3b-ad06-6db719e9fd8c`；
3. 完全退出并重启 DSH。

**修复后 diff：**

```diff
  "ed10f461ac0648e010c3701ab19db8ef": {
    ...
-   "sessionIds": [
-     "session-3c01ca8e-7ec9-4c3b-ad06-6db719e9fd8c"
-   ],
+   "sessionIds": [],
    ...
  }
```

---

## 六、给团队的建议

1. **错误可见性**：domain 一致性校验失败时，宿主只向上抛泛化的 `service-unavailable`，真实原因（具体哪个 session 被哪个 workspace 重复登记）只出现在宿主 stderr 里，UI 看不到。建议把这类校验失败的具体记录 id / 原因暴露给 UI 或持久化日志。
2. **数据一致性约束**：同一个 session 被两个 workspace 登记，说明在「工作区路径变更 / 重新选择文件夹」等流程中，session 归属没有从旧工作区解绑。建议在写入 `sessionIds` 时做唯一性约束或自动去重。
3. **降级处理**：建议参考 `session-projection-cache` 的 `invalidRecords: 'backup-and-skip'` 做法，对这类「可恢复的一致性冲突」做降级（备份并跳过 / 自动修复 + 告警），而不是让整个 workspace 服务瘫痪。

---

## 七、其他观察（供参考，非本次故障原因）

- 两个 workspace 记录的 `path` 在磁盘上均已不存在（`D:\deepseek\workspace\test` 与 `C:\…\default-workspace\out\_dl_target`），可能与此前的目录移动/删除操作有关，或为重复登记的诱因。
- `global.defaultWorkspaceId` 指向一个已删除的 workspace（`69bbc02d-…`），属于 schema 允许的「first-use identity, retained after its registration is deleted」，**非**本次故障原因。
- 相关社区同类报告：#9984（storage-domain disabled 回归）、#10908（workspace.json 字段校验）。
