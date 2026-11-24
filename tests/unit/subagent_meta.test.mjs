// 回归：子会话（origin=subagent）识别与上传元数据记录 lineage
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

const sessionModule = await import("../../plugin-v2/lib/core/session.js");
const sessionDownload = await import("../../plugin-v2/lib/core/session-download.js");
const layoutModule = await import("../../plugin-v2/lib/core/layout.js");
const projectKeyOf = layoutModule.projectKeyOf;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-csp-subagent-"));
const home = path.join(tempRoot, "home");
const repoRoot = path.join(tempRoot, "repo");
fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
fs.mkdirSync(repoRoot, { recursive: true });
process.env.DSH_HOME = home;

const cwd = path.join(tempRoot, "workspace");
fs.mkdirSync(cwd, { recursive: true });

function writeSession(sessionId, header) {
	const dir = path.join(home, "sessions", projectKeyOf(cwd), sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const payload = zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, "utf8"));
	fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), payload);
	return dir;
}

test("listCloudSessions 识别子会话并读取父会话", () => {
	const projectDir = path.join(repoRoot, "index", "projects", "proj");
	const sessionId = "session-child-1";
	const dir = path.join(projectDir, "sessions", sessionId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "meta.json"),
		JSON.stringify({ schema: 1, id: sessionId, title: "child", cwd, project: "proj", sessionFile: "session.v4.jsonl.zstd", sessionBytes: 10 }),
	);
	fs.writeFileSync(
		path.join(dir, "session.v4.jsonl.zstd"),
		zstdCompressSync(
			Buffer.from(
				`${JSON.stringify({ type: "session", version: 4, id: sessionId, cwd, origin: "subagent", parentSession: "session-parent-1", delegationDepth: 1 })}\n`,
				"utf8",
			),
		),
	);
	const sessions = sessionModule.listCloudSessions(repoRoot);
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].isSubagent, true);
	assert.equal(sessions[0].parentSession, "session-parent-1");
	assert.equal(sessions[0].delegationDepth, 1);
});

test("uploadSession 把 origin/parentSession 写入云端 meta", async () => {
	const sessionId = "session-child-2";
	const dir = writeSession(sessionId, {
		type: "session",
		version: 4,
		id: sessionId,
		cwd,
		origin: "subagent",
		parentSession: "session-parent-2",
		delegationDepth: 1,
	});
	// 清空上一个测试留下的 index，避免项目名冲突
	fs.rmSync(path.join(repoRoot, "index"), { recursive: true, force: true });
	const result = await sessionModule.uploadSession({ repoRoot, id: sessionId, cwd, home });
	assert.equal(result.ok, true, result.error);
	const cloudSession = sessionModule.listCloudSessions(repoRoot).find((item) => item.id === sessionId);
	assert.ok(cloudSession, "云端应出现会话");
	assert.equal(cloudSession.isSubagent, true);
	assert.equal(cloudSession.parentSession, "session-parent-2");
	const meta = JSON.parse(fs.readFileSync(path.join(repoRoot, "index", "projects", result.project, "sessions", sessionId, "meta.json"), "utf8"));
	assert.equal(meta.origin, "subagent");
	assert.equal(meta.parentSession, "session-parent-2");
	assert.equal(meta.delegationDepth, 1);
});

function writeCloudSession(project, sessionId, header) {
	const dir = path.join(repoRoot, "index", "projects", project, "sessions", sessionId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "meta.json"),
		JSON.stringify({ schema: 1, id: sessionId, title: "cloud", cwd, project, sessionFile: "session.v4.jsonl.zstd", sessionBytes: 10 }),
	);
	fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, "utf8")));
}

test("downloadSession 孤儿子会话自动转普通会话（侧边栏可见）", async () => {
	fs.rmSync(path.join(repoRoot, "index"), { recursive: true, force: true });
	const sessionId = "session-orphan";
	writeCloudSession("proj-dl", sessionId, {
		type: "session",
		version: 4,
		id: sessionId,
		cwd,
		origin: "subagent",
		parentSession: "session-missing-parent",
		delegationDepth: 1,
	});
	const target = path.join(tempRoot, "dl-workspace");
	fs.mkdirSync(target, { recursive: true });
	const result = await sessionDownload.downloadSession(repoRoot, sessionId, { targetCwd: target, home, convertSubagent: true });
	assert.equal(result.converted, true, "父会话不存在时应转换");
	const header = sessionModule.readHeader(result.path);
	assert.equal(header.origin, undefined);
	assert.equal(header.parentSession, undefined);
	assert.equal(header.cwd, target);
});

test("downloadSession 父会话存在时保留子会话血缘", async () => {
	fs.rmSync(path.join(repoRoot, "index"), { recursive: true, force: true });
	const parentId = "session-parent";
	const childId = "session-child-keep";
	writeCloudSession("proj-dl2", parentId, { type: "session", version: 4, id: parentId, cwd });
	writeCloudSession("proj-dl2", childId, {
		type: "session",
		version: 4,
		id: childId,
		cwd,
		origin: "subagent",
		parentSession: parentId,
		delegationDepth: 1,
	});
	const target = path.join(tempRoot, "dl-workspace2");
	fs.mkdirSync(target, { recursive: true });
	const result = await sessionDownload.downloadSession(repoRoot, childId, { targetCwd: target, home, convertSubagent: true });
	assert.equal(result.converted, false);
	const header = sessionModule.readHeader(result.path);
	assert.equal(header.origin, "subagent");
	assert.equal(header.parentSession, parentId);
});

test.after(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});