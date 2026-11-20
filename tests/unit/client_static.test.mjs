// 前端静态检查：确保 client.js 只使用 v2 接口、保留 ModuleLoader 加载方式与关键 UI 区域
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const client = fs.readFileSync(path.join(root, "plugin-v2", "client.js"), "utf8");

test("client: 使用 __ModuleLoader__ 注册且 id 正确", () => {
	assert.match(client, /window\.__ModuleLoader__\.load\(\{/);
	assert.match(client, /id: PLUGIN/);
	assert.match(client, /const PLUGIN = "dsh-plugin-cloud-sync-panel"/);
	assert.match(client, /return \{ apply \}/);
});

test("client: 只调用 v2 接口", () => {
	const required = [
		"/api/health",
		"/token",
		"/api/tree",
		"/api/repos",
		"/api/repos/remove",
		"/api/upload-project",
		"/api/download-project",
		"/api/pick-directory",
		"/api/cloud-view",
	];
	for (const endpoint of required) assert.ok(client.includes(`"${endpoint}"`) || client.includes(`'${endpoint}'`) || client.includes(endpoint), `缺少接口调用：${endpoint}`);
	const removed = ["/api/check", "/api/diff", "/api/upload-sessions", '/api/upload"', '/api/download"', "/api/github-status", "/api/repos/create"];
	for (const endpoint of removed) assert.ok(!client.includes(endpoint), `不应再使用 v1 接口：${endpoint}`);
});

test("client: 保留四个菜单入口与挂载逻辑", () => {
	for (const action of ['data-act="upload"', 'data-act="download"', 'data-act="cloud"', 'data-act="repos"']) {
		assert.ok(client.includes(action), `缺少菜单入口：${action}`);
	}
	assert.ok(client.includes("_footerActions"), "缺少侧边栏底部挂载点");
	assert.ok(client.includes("MutationObserver"), "缺少动态挂载回退");
	assert.ok(client.includes("__ModuleLoader__"), "缺少模块加载器");
});
