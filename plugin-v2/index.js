// 插件入口：启动本地 HTTP 服务；repoRoot 为登记表与 git 仓库所在位置
//
// DSH 插件生命周期约束（旧版插件即如此）：
//  1. apply 必须是同步函数、返回 void，并在同步阶段注册 ctx.effect；
//  2. 不能在 await 之后注册 effect（会报 cannot create effect on inactive context，
//     触发 DSH 的"禁用第三方插件"恢复，导致插件被移出 profile）；
//  3. HTTP 服务异步启动；失败只记录日志，不向宿主抛错。
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "./lib/host/server.js";
import { trace } from "./lib/host/trace.js";

const here = path.dirname(fileURLToPath(import.meta.url));

trace(`module loaded (plugin-v2 index.js, pid=${process.pid})`);

let readyPromise = null;

/** 供测试/工具等待服务就绪（DSH 宿主不会调用） */
export function whenReady() {
	return readyPromise || Promise.resolve(null);
}

export function apply(ctx, config = {}) {
	trace(`apply called (repoRoot config=${config.workspace || "(default)"}, port=${config.port || "(default)"})`);
	const repoRoot = config.workspace ? path.resolve(config.workspace) : path.resolve(here, "..");
	const port = Number(config.port) || 8732;

	let server = null;
	let closed = false;

	// 同步注册 effect：只负责关闭服务，不阻塞插件加载
	if (ctx && typeof ctx.effect === "function") {
		try {
			ctx.effect(() => () => {
				closed = true;
				if (server) server.close();
			});
			trace("ctx.effect registered");
		} catch (error) {
			trace(`effect register failed: ${error && error.stack ? error.stack : error}`);
		}
	} else {
		trace("ctx.effect unavailable");
	}

	// 异步启动 HTTP 服务；返回 Promise 供工具等待，不返回给 DSH（apply 保持 void）
	readyPromise = startServer({
		repoRoot,
		port,
		workspaceRegistry: ctx && ctx.workspaceRegistry,
		directoryPicker: ctx && ctx.directoryPicker,
	})
		.then((started) => {
			server = started;
			trace(`http server listening on 127.0.0.1:${started.port}`);
			if (closed) started.close();
			return { port: started.port, token: started.token };
		})
		.catch((error) => {
			trace(`http server start failed: ${error && error.stack ? error.stack : error}`);
			return null;
		});
}
