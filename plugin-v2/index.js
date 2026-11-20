// 插件入口：启动本地 HTTP 服务；repoRoot 为登记表与 git 仓库所在位置
//
// 生命周期注意：DSH 要求 apply 同步注册 effect（旧版插件即如此）。
// 若在 await 之后才调用 ctx.effect，上下文可能已失效，导致
// "cannot create effect on inactive context" 并使插件加载失败。
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "./lib/host/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export function apply(ctx, config = {}) {
	const repoRoot = config.workspace ? path.resolve(config.workspace) : path.resolve(here, "..");
	const port = Number(config.port) || 8732;

	let server = null;
	let closed = false;

	// 同步注册 effect：只负责关闭服务，不阻塞插件加载；注册失败也不能影响 DSH 启动
	if (ctx && typeof ctx.effect === "function") {
		try {
			ctx.effect(() => () => {
				closed = true;
				if (server) server.close();
			});
		} catch (error) {
			console.error("[cloud-sync-panel] 注册 effect 失败：", error && error.message ? error.message : error);
		}
	}

	// 异步启动 HTTP 服务；返回的 Promise 供测试/工具等待就绪，DSH 侧会忽略它
	return startServer({
		repoRoot,
		port,
		workspaceRegistry: ctx && ctx.workspaceRegistry,
		directoryPicker: ctx && ctx.directoryPicker,
	})
		.then((started) => {
			server = started;
			if (closed) started.close();
			return { port: started.port, token: started.token };
		})
		.catch((error) => {
			// 服务启动失败（如端口占用）只记录，不向 DSH 抛未处理拒绝，避免影响宿主启动
			console.error("[cloud-sync-panel] 启动同步服务失败：", error && error.message ? error.message : error);
			return null;
		});
}
