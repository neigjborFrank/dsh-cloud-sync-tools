// 单元测试：v2 core 层（repo / registry / session）
// 运行：node --test tests/unit/session_repo.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";

const layout = await import("../../plugin-v2/lib/core/layout.js");
const mirror = await import("../../plugin-v2/lib/core/mirror.js");
const project = await import("../../plugin-v2/lib/core/project.js");
const repo = await import("../../plugin-v2/lib/core/repo.js");
const registry = await import("../../plugin-v2/lib/core/registry.js");
const session = await import("../../plugin-v2/lib/core/session.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "csp-v2-sr-"));
const setHome = () => {
	const home = tmp();
	process.env.DSH_HOME = home;
	return home;
};
const fakeGitRepo = () => {
	const dir = tmp();
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	return dir;
};
const write = (root, rel, text) => {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, "utf8");
	return file;
};

test("repo: 登记/去重/绑定/移除", async () => {
	setHome();
	const file = repo.reposPath();
	const empty = repo.ensureRegistryFile(file);
	assert.equal(empty.schema, 2);
	assert.equal(empty.repos.length, 0);

	const first = await repo.addRepo({ path: fakeGitRepo(), name: "主仓库" }, file);
	assert.ok(first.id.startsWith("repo-"));
	assert.equal(repo.listRepos(file).length, 1);
	assert.equal(repo.listRepos(file)[0].ok, true);

	await assert.rejects(() => repo.addRepo({ path: first.path }, file));

	const second = await repo.addRepo({ path: fakeGitRepo(), url: "git@example.com:me/data.git", name: "备份" }, file);
	assert.equal(repo.listRepos(file).length, 2);
	await assert.rejects(() => repo.addRepo({ path: fakeGitRepo(), url: "git@example.com:me/data.git" }, file), /已登记/);

	repo.setBinding("proj", first.id, file);
	assert.equal(repo.getBinding("proj", file), first.id);
	repo.removeRepo(first.id, file);
	assert.equal(repo.getBinding("proj", file), "");
	assert.equal(repo.listRepos(file).length, 1);
	// 允许移除最后一个仓库：空注册表是合法初始状态（避免死记录无法清理）
	repo.removeRepo(second.id, file);
	assert.equal(repo.listRepos(file).length, 0);
	assert.throws(
		() => repo.removeRepo("repo-missing", file),
		(error) => Boolean(error && error.code === "not-found-repo"),
		"找不到仓库时应返回带错误码的业务错误",
	);
});

test("registry: 校验/修复重复登记，并保留正确归属", () => {
	const home = setHome();
	const file = path.join(home, "storages", "workspace.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });

	const wsPath = "C:\\tmp\\workspace\\ws";
	const sid = "session-11111111-1111-4111-8111-111111111111";
	write(home, path.join("sessions", "--C-tmp-workspace-ws--", sid, "session.v4.jsonl.zstd"), "");
	const log = zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", version: 4, id: sid, createdAt: 1, cwd: wsPath }) + "\n", "utf8"));
	fs.writeFileSync(path.join(home, "sessions", "--C-tmp-workspace-ws--", sid, "session.v4.jsonl.zstd"), log);

	const json = {
		unit: { name: "workspace", version: 2 },
		global: { initialized: true, workspaceIds: ["a", "b"], defaultWorkspaceId: "a" },
		tables: {
			workspaces: {
				a: { path: wsPath, title: "ws", sessionIds: [sid], createdAt: 1, updatedAt: 1 },
				b: { path: "C:\\tmp\\other", title: "other", sessionIds: [sid], createdAt: 1, updatedAt: 1 },
			},
		},
	};
	fs.writeFileSync(file, JSON.stringify(json), "utf8");

	assert.equal(registry.validateRegistry(json).ok, false);
	const repaired = registry.repairRegistry(file);
	assert.equal(repaired.ok, true);
	assert.equal(repaired.changed, true);
	const after = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.deepEqual(after.tables.workspaces.a.sessionIds, [sid], "cwd 匹配的 workspace 保留会话");
	assert.deepEqual(after.tables.workspaces.b.sessionIds, [], "重复登记被移除");
	assert.equal(registry.validateRegistry(after).ok, true);
	assert.ok(repaired.backup && fs.existsSync(path.join(home, "storages", repaired.backup)));

	const registered = registry.registerWorkspace("C:\\tmp\\new", "new", ["session-22222222-2222-4222-8222-222222222222"], file);
	assert.equal(registered.ok, true);
	assert.equal(registry.validateRegistry(JSON.parse(fs.readFileSync(file, "utf8"))).ok, true);
});

test("session: 本机枚举 / 上传（含 workspace-ref）/ 云端列表 / 下载并改写 cwd", async () => {
	const home = setHome();
	const repoRoot = tmp();
	const ws = tmp();
	write(ws, "a.txt", "A");
	write(ws, "sub/b.txt", "B");

	const indexDir = layout.projectDir(repoRoot, ws);
	const options = { filesRoot: layout.storeFilesDir(repoRoot, layout.projectName(ws)), largeRoot: layout.storeLargeDir(repoRoot, layout.projectName(ws)) };
	await mirror.commitWorkspace(ws, indexDir, options);
	project.ensureProject(repoRoot, ws);

	const id = "session-33333333-3333-4333-8333-333333333333";
	const projectKey = layout.projectKeyOf(ws);
	const sessionBinary = zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", version: 4, id, createdAt: 1, cwd: ws }) + "\n", "utf8"));
	const sessionDir = path.join(home, "sessions", projectKey, id);
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(path.join(sessionDir, "session.v4.jsonl.zstd"), sessionBinary);

	const local = session.listSessions(home);
	assert.equal(local.length, 1);
	assert.equal(local[0].id, id);
	assert.equal(local[0].cwd, ws);

	const uploaded = await session.uploadSession({ repoRoot, id, cwd: ws, home });
	assert.equal(uploaded.ok, true);
	assert.equal(uploaded.project, layout.projectName(ws));

	const projectMeta = JSON.parse(fs.readFileSync(path.join(indexDir, "meta.json"), "utf8"));
	assert.ok(projectMeta.sessions.includes(id));
	const ref = JSON.parse(fs.readFileSync(path.join(indexDir, "sessions", id, "workspace-ref.json"), "utf8"));
	assert.equal(ref.schema, 1);
	assert.equal(ref.project, layout.projectName(ws));
	assert.match(ref.manifestHash, /^[0-9a-f]{64}$/);
	assert.equal(ref.files, 2);
	assert.equal(
		ref.manifestHash,
		createHash("sha256").update(fs.readFileSync(path.join(indexDir, "manifest.json"))).digest("hex"),
	);

	const cloud = session.listCloudSessions(repoRoot);
	assert.equal(cloud.length, 1);
	assert.equal(cloud[0].id, id);

	// 下载到新路径：cwd 被改写，文件落到对应 projectKey
	const newCwd = "C:\\tmp\\downloaded\\workspace";
	const downloaded = await session.downloadSession(repoRoot, id, { targetCwd: newCwd, home });
	assert.equal(downloaded.action, "written");
	assert.equal(downloaded.cwd, newCwd);
	const newFile = path.join(home, "sessions", layout.projectKeyOf(newCwd), id, "session.v4.jsonl.zstd");
	assert.ok(fs.existsSync(newFile));
	assert.equal(session.readHeader(newFile).cwd, newCwd);

	const again = await session.downloadSession(repoRoot, id, { targetCwd: newCwd, home });
	assert.equal(again.action, "skipped");
});
