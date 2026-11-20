// DSH workspace 注册表（storages/workspace.json）的安全读写与自愈
//
// DSH 启动时校验：workspaceIds 与表一致、path 唯一、session 不被两个 workspace 同时登记。
// 任一不满足会导致 workspaceController 不可用。本模块只做安全的读/校验/修复。
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { writeJsonAtomic } from "../shared.js";

export function dshHome() {
	return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function registryPath() {
	return path.join(dshHome(), "storages", "workspace.json");
}

const norm = (p) => String(p || "").replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();

/** 按 DSH 启动规则校验注册表（与 @deepseek-ai/dsh-workspace 对齐） */
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
		if (paths.has(key)) problems.push(`path '${record.path}' 同时被 ${paths.get(key)} 与 ${id} 使用`);
		paths.set(key, id);
		for (const sessionId of record.sessionIds || []) {
			if (accounted.has(sessionId)) problems.push(`session '${sessionId}' 同时被 ${accounted.get(sessionId)} 与 ${id} 登记`);
			accounted.set(sessionId, id);
		}
	}
	return { ok: problems.length === 0, problems };
}

export function readRegistry(file = registryPath()) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function backup(file) {
	try {
		const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
		fs.copyFileSync(file, `${file}.bak-${stamp}`);
		return `${path.basename(file)}.bak-${stamp}`;
	} catch {
		return null;
	}
}

/** 会话的 cwd：projcache → 会话首帧 → "" */
export function sessionCwd(sessionId, home = dshHome()) {
	try {
		const cache = path.join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
		const identity = JSON.parse(fs.readFileSync(cache, "utf8"))?.record?.identity;
		if (identity?.cwd) return identity.cwd;
	} catch {}

	try {
		const root = path.join(home, "sessions");
		for (const project of fs.readdirSync(root, { withFileTypes: true })) {
			if (!project.isDirectory()) continue;
			const dir = path.join(root, project.name, sessionId);
			if (!fs.existsSync(dir)) continue;
			const file = fs.readdirSync(dir).find((n) => /^session(\.[A-Za-z0-9]+)*\.jsonl\.zstd$/.test(n));
			if (!file) continue;
			const buf = fs.readFileSync(path.join(dir, file));
			const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
			const at = buf.indexOf(magic);
			if (at < 0) continue;
			const next = buf.indexOf(magic, at + 4);
			const text = zstdDecompressSync(buf.subarray(at, next < 0 ? buf.length : next)).toString("utf8");
			const header = JSON.parse(text.split("\n").find(Boolean));
			if (header.cwd) return header.cwd;
		}
	} catch {}
	return "";
}

/** 修复历史遗留的重复登记：session 按 cwd 判定归属，保留在路径匹配的 workspace */
export function repairRegistry(file = registryPath()) {
	const json = readRegistry(file);
	if (!json) return { ok: false, error: "找不到 workspace.json" };
	const before = validateRegistry(json);
	if (before.ok) return { ok: true, changed: false, problems: [] };

	const table = (json.tables && json.tables.workspaces) || {};
	const now = new Date().toISOString();

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
	const backupFile = backup(file);
	if (after.ok) writeJsonAtomic(file, json);
	return { ok: after.ok, changed: moved.length > 0, moved, before: before.problems, after: after.problems, backup: backupFile };
}

/**
 * 回退路径：直接登记一个工作区（DSH 官方服务不可用时使用）。
 * 保证：同路径复用、会话从其它 workspace 解绑、写后校验、失败回滚。
 */
export function registerWorkspace(cwd, title, sessionIds = [], file = registryPath()) {
	if (!fs.existsSync(file)) return { ok: false, error: "找不到 workspace.json" };
	const json = readRegistry(file);
	if (!json) return { ok: false, error: "workspace.json 无法解析" };

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
		table[workspaceId] = { path: cwd, title: title || path.basename(cwd) || "workspace", sessionIds: [], createdAt: now, updatedAt: now };
		created = true;
	}

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
	target.sessionIds = [...new Set([...(target.sessionIds || []), ...ids])];
	target.updatedAt = now;

	const ordered = [];
	for (const id of json.global.workspaceIds || []) if (table[id] && !ordered.includes(id)) ordered.push(id);
	for (const id of Object.keys(table)) if (!ordered.includes(id)) ordered.push(id);
	json.global.workspaceIds = ordered;
	json.global.initialized = true;
	if (!json.global.defaultWorkspaceId || !table[json.global.defaultWorkspaceId]) json.global.defaultWorkspaceId = workspaceId;

	const check = validateRegistry(json);
	if (!check.ok) return { ok: false, error: "登记后校验失败，已放弃写入", problems: check.problems };
	const backupFile = backup(file);
	writeJsonAtomic(file, json);
	return { ok: true, workspaceId, created, updated: !created, movedFrom, backup: backupFile };
}
