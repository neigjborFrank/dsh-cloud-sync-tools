# plugin-v2

云端同步插件 v2（重构中）。旧版仍在 `../plugin/` 运行，v2 完成后才切换，期间互不影响。

## 当前进度

- [x] **M1 骨架与数据层**：`lib/shared.js`、`lib/core/{layout,manifest,project,mirror,lfs}.js` + 单元测试
- [ ] M2 会话与仓库层：`core/{session,repo,registry}.js`
- [ ] M3 Host API：`lib/host/{server,routes/*}`、`core/git.js`
- [ ] M4 前端：`client/*`
- [ ] M5 安装/更新/发布
- [ ] M6 清理与验收

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
