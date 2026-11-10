/**
 * DSH workspace 注册表（storages/workspace.json）的安全读写。
 *
 * 背景：DSH 的 WorkspaceRegistry 在启动时校验：
 *   - global.workspaceIds 不能重复、不能引用不存在的 workspace；
 *   - 同一 path 不能属于两个 workspace；
 *   - 同一个 sessionId 不能被两个 workspace 同时登记。
 * 任一条不满足 → workspace 域加载失败 → workspaceController 不可用（新建/打开工作区 503）。
 *
 * 本模块的写入保证：
 *   1) 登记会话前，先把它从其它所有 workspace 中移除（避免重复登记）；
 *   2) 按路径（Windows 下忽略大小写）复用已有 workspace，不重复建 path；
 *   3) 写前备份，写后按 DSH 规则自校验，校验失败立即回滚；
 *   4) 原子写入（临时文件 + rename）；
 *   5) 提供 repairRegistry()：修复历史遗留的重复登记。
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function dshHome() {
	return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function registryPath() {
	return path.join(dshHome(), "storages", "workspace.json");
}

const norm = (p) => String(p || "").replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();

/** DSH 启动时的校验规则（与 @deepseek-ai/dsh-workspace validateStoredState 对齐）。 */
export function validateRegistry(json) {
	const problems = [];
	const global = json && json.global;
	const tableJson = json && json.tables && json.tables.workspaces;
	if (!global || !tableJson) return { ok: false, problems: ["缺少 global 或 tables.workspaces"] };

	const table = new Map(Object.entries(tableJson));
	const order = new Set();
	for (const id of global.workspaceIds || []) {
		if (order.has(id)) problems.push(`workspaceIds 重复：${id}`);
		if (!table.has(id)) problems.push(`workspaceIds 引用了不存在的 workspace：${id}`);
		order.add(id);
	}
	if (global.initialized && order.size !== table.size) {
		const orphan = [...table.keys()].find((id) => !order.has(id));
		if (orphan) problems.push(`workspace '${orphan}' 不在 workspaceIds 中`);
	}
	const paths = new Map();
	const accounted = new Map();
	for (const [id, record] of table) {
		const key = norm(record.path);
		const holder = paths.get(key);
		if (holder !== undefined) problems.push(`path '${record.path}' 同时被 ${holder} 与 ${id} 使用`);
		paths.set(key, id);
		for (const sessionId of record.sessionIds || []) {
			const owner = accounted.get(sessionId);
			if (owner !== undefined) problems.push(`session '${sessionId}' 同时被 ${owner} 与 ${id} 登记`);
			accounted.set(sessionId, id);
		}
	}
	return { ok: problems.length === 0, problems };
}

function backupFile(file) {
	try {
		const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
		fs.copyFileSync(file, `${file}.bak-${stamp}`);
		return `${path.basename(file)}.bak-${stamp}`;
	} catch {
		return null;
	}
}

function writeAtomic(file, json) {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(json, null, 2), "utf8");
	fs.renameSync(tmp, file);
}

/** 读取注册表（不做修复）。 */
export function readRegistry() {
	try {
		return JSON.parse(fs.readFileSync(registryPath(), "utf8"));
	} catch {
		return null;
	}
}

/** 会话的 cwd：先读 projcache，再解压会话首帧，都失败返回 ""。 */
export function sessionCwd(sessionId) {
	try {
		const cache = path.join(dshHome(), "storages", "session_projcache", "sessions", `${sessionId}.json`);
		const identity = JSON.parse(fs.readFileSync(cache, "utf8"))?.record?.identity;
		if (identity && typeof identity.cwd === "string" && identity.cwd) return identity.cwd;
	} catch {}

	try {
		const root = path.join(dshHome(), "sessions");
		for (const project of fs.readdirSync(root, { withFileTypes: true })) {
			if (!project.isDirectory()) continue;
			const dir = path.join(root, project.name, sessionId);
			if (!fs.existsSync(dir)) continue;
			const file = fs.readdirSync(dir).find((n) => /^session(\.[A-Za-z0-9]+)*\.jsonl\.zstd$/.test(n));
			if (!file) continue;
			const buf = fs.readFileSync(path.join(dir, file));
			const at = buf.indexOf(MAGIC);
			if (at < 0) continue;
			const next = buf.indexOf(MAGIC, at + 4);
			const text = zlib.zstdDecompressSync(buf.subarray(at, next < 0 ? buf.length : next)).toString("utf8");
			const header = JSON.parse(text.split("\n").find(Boolean));
			if (typeof header.cwd === "string" && header.cwd) return header.cwd;
		}
	} catch {}
	return "";
}

/**
 * 把项目登记进注册表：复用同路径 workspace、去重会话、校验后原子写入。
 * @returns {{ok:boolean, workspaceId?:string, created?:boolean, updated?:boolean, movedFrom?:string[], problems?:string[], backup?:string, error?:string}}
 */
export function registerWorkspace(cwd, title, sessionIds = []) {
	const file = registryPath();
	if (!fs.existsSync(file)) return { ok: false, error: "找不到 workspace.json" };

	let json;
	try {
		json = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		return { ok: false, error: "workspace.json 无法解析：" + (error.message || error) };
	}

	json.global ||= {};
	json.tables ||= {};
	json.tables.workspaces ||= {};
	const table = json.tables.workspaces;
	const ids = [...new Set(sessionIds.filter((x) => typeof x === "string"))];
	const now = new Date().toISOString();

	let workspaceId = Object.keys(table).find((id) => norm(table[id].path) === norm(cwd));
	let created = false;
	if (!workspaceId) {
		workspaceId = randomBytes(16).toString("hex");
		table[workspaceId] = {
			path: cwd,
			title: title || path.basename(cwd) || "workspace",
			sessionIds: [],
			createdAt: now,
			updatedAt: now,
		};
		created = true;
	}

	// 关键修复：先从其它所有 workspace 解绑这些会话
	const movedFrom = [];
	for (const [id, record] of Object.entries(table)) {
		if (id === workspaceId) continue;
		const before = Array.isArray(record.sessionIds) ? record.sessionIds : [];
		const after = before.filter((sid) => !ids.includes(sid));
		if (after.length !== before.length) {
			record.sessionIds = after;
			record.updatedAt = now;
			movedFrom.push(id);
		}
	}

	const target = table[workspaceId];
	target.path = cwd;
	if (title) target.title = title;
	target.sessionIds = [...new Set([...(Array.isArray(target.sessionIds) ? target.sessionIds : []), ...ids])];
	target.updatedAt = now;

	// workspaceIds 顺序表与表内容对齐（去重 + 补全 + 去掉引用不存在的项）
	const ordered = [];
	for (const id of json.global.workspaceIds || []) {
		if (table[id] && !ordered.includes(id)) ordered.push(id);
	}
	for (const id of Object.keys(table)) if (!ordered.includes(id)) ordered.push(id);
	json.global.workspaceIds = ordered;
	json.global.initialized = true;
	if (!json.global.defaultWorkspaceId || !table[json.global.defaultWorkspaceId]) {
		json.global.defaultWorkspaceId = workspaceId;
	}

	const check = validateRegistry(json);
	if (!check.ok) {
		return { ok: false, error: "登记后校验失败，已放弃写入", problems: check.problems };
	}

	const backup = backupFile(file);
	try {
		writeAtomic(file, json);
	} catch (error) {
		return { ok: false, error: "写入失败：" + (error.message || error) };
	}
	return { ok: true, workspaceId, created, updated: !created, movedFrom, backup };
}

/**
 * 修复历史遗留的重复登记：同一 session 被多个 workspace 声明时，
 * 按该 session 的 cwd 判定归属，保留在路径匹配的 workspace，其余解绑。
 */
export function repairRegistry() {
	const file = registryPath();
	if (!fs.existsSync(file)) return { ok: false, error: "找不到 workspace.json" };

	let json;
	try {
		json = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		return { ok: false, error: "workspace.json 无法解析：" + (error.message || error) };
	}

	const before = validateRegistry(json);
	if (before.ok) return { ok: true, changed: false, problems: [] };

	const table = (json.tables && json.tables.workspaces) || {};
	const now = new Date().toISOString();

	// 1) 会话重复：按 cwd 匹配的 workspace 归属
	const claims = new Map();
	for (const [id, record] of Object.entries(table)) {
		for (const sid of record.sessionIds || []) {
			if (!claims.has(sid)) claims.set(sid, []);
			claims.get(sid).push(id);
		}
	}
	const moved = [];
	for (const [sid, owners] of claims) {
		if (owners.length < 2) continue;
		const cwd = sessionCwd(sid);
		const keep = owners.find((id) => cwd && norm(table[id].path) === norm(cwd)) || owners[0];
		for (const id of owners) {
			if (id === keep) continue;
			table[id].sessionIds = (table[id].sessionIds || []).filter((x) => x !== sid);
			table[id].updatedAt = now;
			moved.push({ sessionId: sid, removedFrom: id, keptIn: keep });
		}
	}

	// 2) path 重复：保留最早创建的一个，另一个改标题标记（不删数据）
	const byPath = new Map();
	const duplicatePaths = [];
	for (const [id, record] of Object.entries(table)) {
		const key = norm(record.path);
		if (byPath.has(key)) {
			duplicatePaths.push({ path: record.path, keep: byPath.get(key), duplicate: id });
			record.path = `${record.path} (重名-${id.slice(0, 6)})`;
			record.updatedAt = now;
		} else byPath.set(key, id);
	}

	// 3) workspaceIds 与表对齐
	const ordered = [];
	for (const id of (json.global && json.global.workspaceIds) || []) {
		if (table[id] && !ordered.includes(id)) ordered.push(id);
	}
	for (const id of Object.keys(table)) if (!ordered.includes(id)) ordered.push(id);
	json.global ||= {};
	json.global.workspaceIds = ordered;
	if (!json.global.defaultWorkspaceId || !table[json.global.defaultWorkspaceId]) {
		json.global.defaultWorkspaceId = ordered[0];
	}

	const after = validateRegistry(json);
	const backup = backupFile(file);
	if (after.ok) writeAtomic(file, json);
	return {
		ok: after.ok,
		changed: moved.length > 0 || duplicatePaths.length > 0 || !after.ok === false,
		moved,
		duplicatePaths,
		before: before.problems,
		after: after.problems,
		backup,
	};
}
