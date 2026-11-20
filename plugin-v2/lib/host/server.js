// HTTP 服务：令牌校验、JSON、CORS、统一错误包装
import { randomBytes } from "node:crypto";
import http from "node:http";

import { AppError } from "../shared.js";
import { createRoutes } from "./routes.js";

const MAX_BODY = 1024 * 1024;

function sendJson(response, status, payload) {
	const body = JSON.stringify(payload);
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Access-Control-Allow-Origin": "*",
	});
	response.end(body);
}

function readBody(request) {
	return new Promise((resolve) => {
		let size = 0;
		const chunks = [];
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				request.destroy();
				resolve({});
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			try {
				const text = Buffer.concat(chunks).toString("utf8");
				resolve(text ? JSON.parse(text) : {});
			} catch {
				resolve({});
			}
		});
		request.on("error", () => resolve({}));
	});
}

/**
 * 启动本地 HTTP 服务（仅回环地址）。
 * @returns {Promise<{port:number, token:string, server:http.Server, close:()=>Promise<void>}>}
 */
export async function startServer({ repoRoot, port = 8732, workspaceRegistry, directoryPicker } = {}) {
	const token = randomBytes(16).toString("hex");
	const routes = createRoutes({ repoRoot, workspaceRegistry, directoryPicker });

	const server = http.createServer(async (request, response) => {
		const url = new URL(request.url || "/", "http://127.0.0.1");
		const pathname = url.pathname;

		if (request.method === "OPTIONS") return sendJson(response, 200, {});

		// token 与健康检查端点不需要鉴权（客户端探活在取 token 之前）
		if (pathname === "/token" && request.method === "GET") return sendJson(response, 200, { ok: true, token, port });
		if (pathname === "/api/health" && request.method === "GET") {
			try {
				const result = await routes["GET /api/health"]();
				return sendJson(response, 200, { ok: true, ...result });
			} catch (error) {
				return sendJson(response, 500, { ok: false, error: "internal", output: error.message });
			}
		}

		const key = `${request.method} ${pathname}`;
		const handler = routes[key];
		if (!handler) return sendJson(response, 404, { ok: false, error: "not-found", output: `未知接口：${key}` });

		if (url.searchParams.get("token") !== token) return sendJson(response, 401, { ok: false, error: "unauthorized", output: "缺少或错误的访问令牌" });

		let body = {};
		if (request.method === "POST") body = await readBody(request);

		try {
			const result = await handler(body);
			return sendJson(response, 200, result && typeof result === "object" ? { ok: true, ...result } : { ok: true, result });
		} catch (error) {
			if (error instanceof AppError) {
				return sendJson(response, 400, { ok: false, error: error.code, output: error.message, detail: error.detail });
			}
			return sendJson(response, 500, { ok: false, error: "internal", output: error.message || "服务内部错误" });
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : port;

	const close = () =>
		new Promise((resolve) => {
			try {
				server.close(() => resolve());
			} catch {
				resolve();
			}
		});

	return { port: actualPort, token, server, close };
}
