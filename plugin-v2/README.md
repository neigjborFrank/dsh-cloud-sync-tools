# plugin-v2

云端同步插件 v2（重构中）。旧版仍在 `../plugin/` 运行，v2 完成后才切换，期间互不影响。

## 当前进度

- [x] **M1 骨架与数据层**：`lib/shared.js`、`lib/core/{layout,manifest,project,mirror,lfs}.js` + 单元测试
- [x] **M2 会话与仓库层**：`core/{session,repo,registry}.js` + 单元测试（会话枚举/上传/下载/cwd 改写、多仓库登记绑定、注册表自愈）
- [x] **M3 Host API**：`lib/host/{server,routes,views}.js`、`core/{git,merge,download}.js` + 集成测试（21/21）
- [x] **M4 前端**：`client.js`（DSH 脚本加载，单文件分区组织：API/项目树/上传/下载/仓库管理/云端与同步）
- [x] **M5 安装/更新/发布**：install/update 已切到 v2；干净克隆 + 临时 DSH_HOME 安装验证通过（默认不登记仓库）
- [ ] M6 清理与验收（归档副本/全量回归/全新环境端到端已完成；质量门禁 6/6；待真实设备 GUI 安装验证）

> 架构细节见 `docs/架构说明-v2.md`（每个里程碑同步更新）。

## 模块约定

| 模块 | 职责 |
|---|---|
| `lib/shared.js` | 常量（忽略目录/限制/schema 版本）、`AppError`、原子读写、哈希、时间戳 |
| `lib/core/layout.js` | store/index 布局、projectKey/projectName、路径关系、v1 只读兼容 |
| `lib/core/manifest.js` | 工作区扫描 → 清单（路径/大小/哈希；大文件/超长路径单独记录） |
| `lib/core/project.js` | 项目元数据、列表/查找、alias 归并、v1 兼容读取 |
| `lib/core/mirror.js` | 内容写入镜像：mirror/union、scope 子路径、冲突隔离、LFS 大文件落盘 |
| `lib/core/lfs.js` | LFS 指针识别与大文件恢复 |

依赖方向：`shared ← core`，core 内 `layout/manifest` 为底座，`project/mirror/lfs` 依赖它们；core 不感知 HTTP/前端。

## 运行单元测试

```powershell
cd <仓库根>
node --test tests/unit/core.test.mjs
```
