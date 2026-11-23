// 回归：官方 workspaceRegistry.resolveByPath 是 async，必须 await 后再决定是否 create
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const routesModule = await import("../../plugin-v2/lib/host/routes-extra.js");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-csp-register-"));

function makeCtx(registry) {
	return {
		repoRoot: tempDir,
		resolveService: (name) => (name === "workspaceRegistry" ? registry : undefined),
	};
}

test("register 会对 resolveByPath 做 await，未命中时调用 create", async () => {
	const calls = { resolve: 0, create: 0 };
	const registry = {
		resolveByPath: async (target) => {
			calls.resolve++;
			assert.equal(target, tempDir);
			return undefined;
		},
		create: async (target, title) => {
			calls.create++;
			return { id: "ws-1", title, path: target };
		},
	};
	const routes = routesModule.createExtraRoutes(makeCtx(registry));
	const result = await routes["POST /api/workspaces/register"]({ path: tempDir, title: "测试工作区" });
	assert.equal(calls.resolve, 1);
	assert.equal(calls.create, 1, "未命中时必须 create");
	assert.equal(result.ok, true);
	assert.equal(result.mode, "official");
	assert.equal(result.workspace.id, "ws-1");
});

test("register 命中已有工作区时不重复 create", async () => {
	let created = 0;
	const registry = {
		resolveByPath: async () => ({ id: "ws-existing", title: "已有", path: tempDir }),
		create: async () => {
			created++;
			return { id: "ws-new", title: "", path: tempDir };
		},
	};
	const routes = routesModule.createExtraRoutes(makeCtx(registry));
	const result = await routes["POST /api/workspaces/register"]({ path: tempDir, title: "已有" });
	assert.equal(created, 0);
	assert.equal(result.existing, true);
	assert.equal(result.workspace.id, "ws-existing");
});
