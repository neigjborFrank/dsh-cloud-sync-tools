// 插件入口契约测试：模拟 DSH 生命周期，防止再次出现 "apply async / effect 注册时机错误"
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginDir = path.join(root, "plugin-v2");
const mod = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);

const listen = (server, port = 0) => new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(port, "127.0.0.1", () => resolve(server.address().port));
});

test("入口契约：apply 同步返回 void，并在同步阶段注册 effect", async () => {
	const effects = [];
	const ctx = {
		effect: (fn) => {
			effects.push(fn);
		},
	};

	// port 0 会被入口回退为默认端口，这里用固定高位端口
	const port = 8956;
	const returned = mod.apply(ctx, { workspace: root, port });
	assert.equal(returned, undefined, "apply 必须返回 void（不能返回 Promise）");
	assert.equal(effects.length, 1, "apply 必须在返回前同步注册 ctx.effect");

	const started = await mod.whenReady();
	assert.ok(started && started.port === port, JSON.stringify(started));
	const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
	assert.equal(health.service, "cloud-sync");
	assert.equal(health.ok, true);

	// 清理：effect 回调返回 disposer，调用后服务应关闭
	const dispose = effects[0]();
	assert.equal(typeof dispose, "function");
	dispose();
	await new Promise((resolve) => setTimeout(resolve, 150));
	await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/health`));
});

test("入口契约：服务启动失败时不向宿主抛错", async () => {
	const port = 8957;
	const blocker = http.createServer();
	const blockedPort = await listen(blocker, port);
	assert.equal(blockedPort, port);

	const ctx = { effect: () => {} };
	assert.doesNotThrow(() => mod.apply(ctx, { workspace: root, port }));
	const started = await mod.whenReady();
	assert.equal(started, null, "端口占用时应记录日志并返回 null，而不是抛出");
	await new Promise((resolve) => blocker.close(resolve));
});
