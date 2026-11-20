// 插件入口：启动本地 HTTP 服务；repoRoot 为登记表与 git 仓库所在位置
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "./lib/host/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function apply(ctx, config = {}) {
	const repoRoot = config.workspace ? path.resolve(config.workspace) : path.resolve(here, "..");
	const port = Number(config.port) || 8732;
	const server = await startServer({
		repoRoot,
		port,
		workspaceRegistry: ctx && ctx.workspaceRegistry,
		directoryPicker: ctx && ctx.directoryPicker,
	});

	if (ctx && typeof ctx.effect === "function") {
		ctx.effect(() => {
			server.close();
		});
	}

	return { port: server.port, token: server.token };
}
