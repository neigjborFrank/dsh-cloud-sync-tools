// 会话归档：本机会话枚举、上传到项目、下载（cwd 改写）、workspace-ref
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { ensureDir, hashBuffer, readJson, timestamp, writeJsonAtomic } from "../shared.js";
import { layoutDir, projectDir, projectKeyOf, projectName, samePath } from "./layout.js";
import { readSessionLogInfo } from "./session-cache.js";
import { ensureProject, listProjects, saveProjectMeta } from "./project.js";

const SESSION_FILE = /^session(\.[A-Za-z0-9]+)*\.jsonl\.zstd$/;
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function dshHome() {
	return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** 解压会话日志首帧，读取 session 头 */
export function readHeader(file) {
	try {
		const buf = fs.readFileSync(file);
		const at = buf.indexOf(MAGIC);
		if (at < 0) return null;
		const next = buf.indexOf(MAGIC, at + 4);
		const text = zstdDecompressSync(buf.subarray(at, next < 0 ? buf.length : next)).toString("utf8");
		const line = text.split("\n").find(Boolean);
		return line ? JSON.parse(line) : null;
	} catch {
		return null;
	}
}

function readTitle(sessionId, home) {
	try {
		const file = path.join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
		const json = readJson(file);
		const val = json?.record?.rows?.title?.val;
		return typeof val === "string" ? val : "";
	} catch {
		return "";
	}
}

/** 列出本机会话（跨所有 projectKey 目录，按 id 去重） */
function loadArchivedIds(home) {
	try {
		const json = readJson(path.join(home, "storages", "workspace.json"));
		return new Set((json && json.global && json.global.archivedSessionIds) || []);
	} catch {
		return new Set();
	}
}

export function listSessions(home = dshHome()) {
	const root = path.join(home, "sessions");
	const out = [];
	const seen = new Set();
	const archivedIds = loadArchivedIds(home);
	let projects = [];
	try {
		projects = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
	} catch {
		return out;
	}
	for (const projectEntry of projects) {
		let dirs = [];
		try {
			dirs = fs.readdirSync(path.join(root, projectEntry.name), { withFileTypes: true }).filter((e) => e.isDirectory());
		} catch {
			continue;
		}
		for (const sessionEntry of dirs) {
			if (seen.has(sessionEntry.name)) continue;
			const dir = path.join(root, projectEntry.name, sessionEntry.name);
			let files = [];
			try {
				files = fs.readdirSync(dir).filter((name) => SESSION_FILE.test(name));
			} catch {
				continue;
			}
			if (!files.length) continue;
			seen.add(sessionEntry.name);
			const file = path.join(dir, files[0]);
			let bytes = 0;
			let modified = 0;
			try {
				const stat = fs.statSync(file);
				bytes = stat.size;
				modified = stat.mtimeMs;
			} catch {}
			const header = readHeader(file) || {};
			out.push({
				id: sessionEntry.name,
				archived: archivedIds.has(sessionEntry.name),
				projectDir: projectEntry.name,
				file: files[0],
				filePath: file,
				cwd: header.cwd || "",
				createdAt: header.createdAt || 0,
				bytes,
				modified,
				title: readTitle(sessionEntry.name, home),
				origin: header.origin || "",
				parentSession: header.parentSession || "",
				delegationDepth: Number(header.delegationDepth || 0) || 0,
				isSubagent: header.origin === "subagent",
			});
		}
	}
	out.sort((a, b) => b.modified - a.modified);
	return out;
}

export function findSessionDir(id, home = dshHome()) {
	const root = path.join(home, "sessions");
	let projects = [];
	try {
		projects = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const projectEntry of projects) {
		if (!projectEntry.isDirectory()) continue;
		const dir = path.join(root, projectEntry.name, id);
		if (fs.existsSync(dir)) return dir;
	}
	return null;
}

/** 优先选择"会话头 cwd 与期望 cwd 一致"的副本，避免多副本时上传错版本 */
export function findSessionDirForCwd(id, cwd, home = dshHome()) {
	const preferred = path.join(home, "sessions", projectKeyOf(cwd), id);
	if (fs.existsSync(preferred)) return preferred;
	const root = path.join(home, "sessions");
	let projects = [];
	try {
		projects = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	let first = null;
	for (const projectEntry of projects) {
		if (!projectEntry.isDirectory()) continue;
		const dir = path.join(root, projectEntry.name, id);
		if (!fs.existsSync(dir)) continue;
		if (!first) first = dir;
		const file = findSessionFile(dir);
		const header = file ? readHeader(file) : null;
		if (header && header.cwd && samePath(header.cwd, cwd)) return dir;
	}
	return first;
}

export function findSessionFile(dir) {
	try {
		const name = fs.readdirSync(dir).find((entry) => SESSION_FILE.test(entry));
		return name ? path.join(dir, name) : null;
	} catch {
		return null;
	}
}

/** 读取云端会话目录里的 header（用于识别子会话 lineage） */
function readCloudSessionHeader(dir, meta) {
	try {
		const file = meta && meta.sessionFile ? path.join(dir, meta.sessionFile) : findSessionFile(dir);
		return file ? readHeader(file) : null;
	} catch {
		return null;
	}
}

/**
 * 展开会话血缘：把本机存在的父会话（祖先链）一起返回，确保主对话不会被漏传。
 * @returns {{ids:string[], added:string[], missingParents:Array<{id:string,parentSession:string}>}}
 */
export function collectSessionLineage(ids = [], home = dshHome()) {
	const map = new Map(listSessions(home).map((session) => [session.id, session]));
	const ordered = [];
	const seen = new Set();
	const added = [];
	const missingParents = [];
	for (const id of ids) {
		const chain = [];
		let cursor = id;
		let depth = 0;
		while (cursor && depth < 32 && !chain.includes(cursor)) {
			const session = map.get(cursor);
			if (!session) break;
			chain.unshift(cursor);
			cursor = session.parentSession || "";
			depth++;
		}
		for (const member of chain) {
			if (seen.has(member)) continue;
			seen.add(member);
			ordered.push(member);
			if (member !== id) added.push(member);
		}
		const session = map.get(id);
		if (session && session.parentSession && !map.has(session.parentSession)) {
			missingParents.push({ id, parentSession: session.parentSession });
		}
	}
	return { ids: ordered.length ? ordered : [...ids], added, missingParents };
}

/** 列出云端会话（扫描 index 项目 sessions/，兼容 v1） */
export function listCloudSessions(repoRoot) {
	const out = [];
	for (const project of listProjects(repoRoot)) {
		let dirs = [];
		try {
			dirs = fs.readdirSync(path.join(project.dir, "sessions"), { withFileTypes: true }).filter((e) => e.isDirectory());
		} catch {
			continue;
		}
		for (const entry of dirs) {
			const dir = path.join(project.dir, "sessions", entry.name);
			const meta = readJson(path.join(dir, "meta.json"));
			if (!meta) continue;
			const header = readCloudSessionHeader(dir, meta) || {};
			const origin = header.origin || meta.origin || "";
			out.push({
				id: entry.name,
				project: project.name,
				cwd: meta.cwd || header.cwd || "",
				title: meta.title || "",
				scope: meta.scope || "",
				uploadedAt: meta.uploadedAt || null,
				sessionBytes: meta.sessionBytes || 0,
				origin,
				parentSession: header.parentSession || meta.parentSession || "",
				delegationDepth: Number(header.delegationDepth ?? meta.delegationDepth ?? 0) || 0,
				isSubagent: origin === "subagent",
			});
		}
	}
	return out;
}

export async function uploadSession({ repoRoot, id, cwd, projectName: projectOverride, scope = "", home = dshHome() }) {
	const dir = cwd ? findSessionDirForCwd(id, cwd, home) : findSessionDir(id, home);
	if (!dir) return { id, ok: false, error: "本机找不到该会话" };
	const srcFile = findSessionFile(dir);
	if (!srcFile) return { id, ok: false, error: "会话文件缺失" };

	const header = readHeader(srcFile) || {};
	const logInfo = readSessionLogInfo(srcFile);
	const effectiveCwd = header.cwd || cwd || "";
	if (!effectiveCwd) return { id, ok: false, error: "会话没有工作区路径" };

	if (!projectOverride) ensureProject(repoRoot, effectiveCwd);
	const targetProject = projectOverride || projectNameOf(effectiveCwd);
	const destDir = path.join(projectDir(repoRoot, targetProject), "sessions", id);
	await fsp.mkdir(destDir, { recursive: true });
	const fileName = path.basename(srcFile);
	await fsp.copyFile(srcFile, path.join(destDir, fileName));

	const sessionMeta = {
		schema: 1,
		id,
		title: readTitle(id, home) || (logInfo && logInfo.title) || "",
		cwd: effectiveCwd,
		project: targetProject,
		scope: scope || "",
		sessionFile: fileName,
		sessionBytes: fs.statSync(srcFile).size,
		uploadedAt: new Date().toISOString(),
		origin: header.origin || "",
		parentSession: header.parentSession || "",
		delegationDepth: Number(header.delegationDepth || 0) || 0,
	};
	writeJsonAtomic(path.join(destDir, "meta.json"), sessionMeta);

	// workspace-ref：该会话对应的结构快照引用（只记录引用，不复制内容）
	try {
		const indexDir = projectDir(repoRoot, targetProject);
		const layout = layoutDir(indexDir);
		const manifestBuf = fs.readFileSync(path.join(layout, "manifest.json"));
		const manifest = JSON.parse(manifestBuf.toString("utf8"));
		writeJsonAtomic(path.join(destDir, "workspace-ref.json"), {
			schema: 1,
			project: targetProject,
			scope: scope || "",
			manifestHash: hashBuffer(manifestBuf),
			files: Object.keys(manifest.files || {}).length,
			capturedAt: new Date().toISOString(),
		});
	} catch {
		/* 项目还没有清单时（只传会话）不写 ref */
	}

	// 更新项目 meta 的 session 列表
	try {
		const metaPath = path.join(projectDir(repoRoot, targetProject), "meta.json");
		const meta = readJson(metaPath);
		if (meta) {
			meta.sessions = [...new Set([...(meta.sessions || []), id])];
			saveProjectMeta(repoRoot, meta);
		}
	} catch {}

	return { id, ok: true, project: targetProject, dest: destDir, sessionFile: fileName };
}

function projectNameOf(cwd) {
	return String(cwd || "").length ? projectName(cwd) : "_no-cwd";
}
