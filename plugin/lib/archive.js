/**
 * 会话归档：枚举本机会话、按项目上传/下载会话文件。
 *
 * 云端结构见 projects.js：
 *   projects/<项目名>/workspace/           工作区（全量镜像 + 备份）
 *   projects/<项目名>/sessions/<会话id>/   会话文件
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
	ensureProject,
	findCloudProject,
	projectDir,
	projectKeyOf,
	saveProjectMeta,
	sessionsDir,
} from "./projects.js";
import { buildManifest } from "./store.js";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function dshHome() {
	return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function configPath() {
	return path.join(dshHome(), "cloud-sync", "config.json");
}

/** 用户文档目录（Windows 上优先 USERPROFILE\Documents）。 */
export function documentsDirectory() {
	const home = process.env.USERPROFILE || os.homedir();
	const docs = path.join(home, "Documents");
	return fs.existsSync(docs) ? docs : home;
}

/** 推荐的默认工作区根目录：<Documents>\deepseek-harness\workspaces（与 DSH 官方默认目录一致，且在安装目录之外）。 */
export function defaultWorkspaceBase() {
	return path.join(documentsDirectory(), "deepseek-harness", "workspaces");
}

/**
 * 若路径位于 DSH 安装目录内，返回该安装目录；否则返回 null。
 * 判定依据：祖先目录中存在 resources\app.asar 或卸载程序（安装器会在更新/卸载时清理安装目录）。
 */
export function installDirOf(target) {
	if (!target) return null;
	let dir = path.resolve(target);
	for (let i = 0; i < 16; i++) {
		try {
			if (
				fs.existsSync(path.join(dir, "resources", "app.asar")) ||
				fs.existsSync(path.join(dir, "Uninstall DeepSeek Harness.exe")) ||
				fs.existsSync(path.join(dir, "DeepSeek Harness.exe"))
			) {
				return dir;
			}
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

export function isInInstallDir(target) {
	return Boolean(installDirOf(target));
}

export function loadConfig() {
	try {
		const json = JSON.parse(fs.readFileSync(configPath(), "utf8"));
		if (!json || typeof json.workspaceBase !== "string" || !json.workspaceBase) {
			return { workspaceBase: defaultWorkspaceBase() };
		}
		return json;
	} catch {
		return { workspaceBase: defaultWorkspaceBase() };
	}
}

export function saveConfig(patch) {
	const merged = { ...loadConfig(), ...patch };
	fs.mkdirSync(path.dirname(configPath()), { recursive: true });
	fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), "utf8");
	return merged;
}

export function readHeader(file) {
	const buf = fs.readFileSync(file);
	const at = buf.indexOf(MAGIC);
	if (at < 0) return null;
	const next = buf.indexOf(MAGIC, at + 4);
	const end = next < 0 ? buf.length : next;
	try {
		const text = zlib.zstdDecompressSync(buf.subarray(at, end)).toString("utf8");
		const line = text.split("\n").find(Boolean);
		return line ? JSON.parse(line) : null;
	} catch {
		return null;
	}
}

/** 归档会话 id 集合（来自 storages/workspace.json）。 */
export function readArchivedIds() {
	try {
		const file = path.join(dshHome(), "storages", "workspace.json");
		const json = JSON.parse(fs.readFileSync(file, "utf8"));
		const ids = json?.global?.archivedSessionIds;
		return new Set(Array.isArray(ids) ? ids : []);
	} catch {
		return new Set();
	}
}

/** 列出本机会话；同一 id 只出现一次。 */
export function listSessions() {
	const root = path.join(dshHome(), "sessions");
	const out = [];
	const seen = new Set();
	const archivedIds = readArchivedIds();
	let projects = [];
	try {
		projects = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
	} catch {
		return out;
	}

	for (const project of projects) {
		const projectDirPath = path.join(root, project.name);
		let sessions = [];
		try {
			sessions = fs.readdirSync(projectDirPath, { withFileTypes: true }).filter((e) => e.isDirectory());
		} catch {
			continue;
		}
		for (const session of sessions) {
			if (seen.has(session.name)) continue;
			const dir = path.join(projectDirPath, session.name);
			let files = [];
			try {
				files = fs.readdirSync(dir).filter((n) => /^session(\.[A-Za-z0-9]+)*\.jsonl\.zstd$/.test(n));
			} catch {
				continue;
			}
			if (!files.length) continue;
			seen.add(session.name);

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
				id: session.name,
				projectDir: project.name,
				file: files[0],
				cwd: header.cwd || "",
				createdAt: header.createdAt || 0,
				bytes,
				modified,
				title: readTitle(session.name),
				archived: archivedIds.has(session.name),
			});
		}
	}

	out.sort((a, b) => b.modified - a.modified);
	return out;
}

function readTitle(sessionId) {
	try {
		const file = path.join(dshHome(), "storages", "session_projcache", "sessions", `${sessionId}.json`);
		const json = JSON.parse(fs.readFileSync(file, "utf8"));
		const val = json?.record?.rows?.title?.val;
		return typeof val === "string" ? val : "";
	} catch {
		return "";
	}
}

export function findSessionDir(id) {
	const root = path.join(dshHome(), "sessions");
	let projects = [];
	try {
		projects = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const dir = path.join(root, project.name, id);
		if (fs.existsSync(dir)) return dir;
	}
	return null;
}

/** 上传单个会话到所属项目：projects/<项目>/sessions/<id>/。 */
export async function uploadSession({ repoRoot, id, cwd: expectedCwd }) {
	// 同一会话可能因“下载到新位置”在本机存在多个副本；指定 cwd 时优先用该项目目录下的副本
	let sessionDir = null;
	if (expectedCwd) {
		const preferred = path.join(dshHome(), "sessions", projectKeyOf(expectedCwd), id);
		if (fs.existsSync(preferred)) sessionDir = preferred;
	}
	if (!sessionDir) sessionDir = findSessionDir(id);
	if (!sessionDir) return { id, ok: false, error: "本机找不到该会话" };

	const files = fs.readdirSync(sessionDir).filter((n) => /^session(\.[A-Za-z0-9]+)*\.jsonl\.zstd$/.test(n));
	if (!files.length) return { id, ok: false, error: "会话文件缺失" };
	const fileName = files[0];
	const srcFile = path.join(sessionDir, fileName);
	const header = readHeader(srcFile) || {};
	const cwd = header.cwd || "";
	if (!cwd) return { id, ok: false, error: "会话没有工作区路径" };

	const meta = ensureProject(repoRoot, cwd);
	const destDir = path.join(sessionsDir(repoRoot, meta.name), id);
	await fsp.mkdir(destDir, { recursive: true });
	await fsp.copyFile(srcFile, path.join(destDir, fileName));

	const sessionMetaPath = path.join(destDir, "meta.json");
	let previous = {};
	try {
		previous = JSON.parse(fs.readFileSync(sessionMetaPath, "utf8"));
	} catch {}
	const sessionMeta = {
		id,
		title: readTitle(id),
		cwd,
		projectKey: projectKeyOf(cwd),
		project: meta.name,
		sessionFile: fileName,
		sessionBytes: fs.statSync(srcFile).size,
		createdAt: header.createdAt || 0,
		uploadedAt: new Date().toISOString(),
		version: header.version || null,
		uploads: (previous.uploads || 0) + 1,
	};
	await fsp.writeFile(sessionMetaPath, JSON.stringify(sessionMeta, null, 2), "utf8");

	meta.sessions = [...new Set([...(meta.sessions || []), id])];
	saveProjectMeta(repoRoot, meta);

	return { id, ok: true, dest: path.relative(repoRoot, destDir) };
}

/** 列出云端已有会话。 */
export function listCloudSessions(repoRoot) {
	const out = [];
	const projectsRoot = path.join(repoRoot, "projects");
	let projects = [];
	try {
		projects = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
	} catch {
		return out;
	}
	for (const project of projects) {
		const dir = path.join(projectsRoot, project.name, "sessions");
		let sessions = [];
		try {
			sessions = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
		} catch {
			continue;
		}
		for (const session of sessions) {
			const sessionDir = path.join(dir, session.name);
			let meta = null;
			try {
				meta = JSON.parse(fs.readFileSync(path.join(sessionDir, "meta.json"), "utf8"));
			} catch {}
			if (!meta) continue;
			out.push({
				id: session.name,
				project: project.name,
				cwd: meta.cwd || "",
				title: meta.title || "",
				uploadedAt: meta.uploadedAt || null,
				sessionBytes: meta.sessionBytes || 0,
			});
		}
	}
	return out;
}

/**
 * 改写会话日志首帧里的 cwd（其余帧原样保留）。
 * 用于跨机/换目录恢复：DSH 按「会话 cwd == 工作区路径」归属会话，必须把 cwd 指到新目录。
 */
export function rewriteSessionCwd(buffer, cwd) {
	const at = buffer.indexOf(MAGIC);
	if (at < 0) return buffer;
	const next = buffer.indexOf(MAGIC, at + 4);
	const end = next < 0 ? buffer.length : next;
	let text;
	try {
		text = zlib.zstdDecompressSync(buffer.subarray(at, end)).toString("utf8");
	} catch {
		return buffer;
	}
	const lines = text.split("\n");
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].trim()) continue;
		try {
			const obj = JSON.parse(lines[i]);
			if (obj && obj.type === "session") {
				obj.cwd = cwd;
				lines[i] = JSON.stringify(obj);
				changed = true;
			}
			break;
		} catch {
			continue;
		}
	}
	if (!changed) return buffer;
	const frame = zlib.zstdCompressSync(Buffer.from(lines.join("\n"), "utf8"));
	return Buffer.concat([buffer.subarray(0, at), frame, buffer.subarray(end)]);
}

/** 更新（或补建）会话 projcache 的 identity.cwd。 */
function updateProjCacheCwd(id, cwd, cloudSessionDir) {
	try {
		const cache = path.join(dshHome(), "storages", "session_projcache", "sessions", `${id}.json`);
		let payload = null;
		if (fs.existsSync(cache)) {
			try {
				payload = JSON.parse(fs.readFileSync(cache, "utf8"));
			} catch {}
		}
		if (!payload) {
			writeProjCacheIfMissing(id, cloudSessionDir);
			payload = JSON.parse(fs.readFileSync(cache, "utf8"));
		}
		payload.record ||= {};
		payload.record.identity ||= {};
		payload.record.identity.cwd = cwd;
		fs.mkdirSync(path.dirname(cache), { recursive: true });
		fs.writeFileSync(cache, JSON.stringify(payload, null, 2), "utf8");
	} catch {}
}

/**
 * 下载单个会话：本机已有则备份后覆盖；内容一致则跳过。
 * opts.targetCwd 存在时把会话 cwd 改写到该目录，并放到对应 projectKey 目录下。
 */
export async function downloadSession(repoRoot, id, opts = {}) {
	const cloud = listCloudSessions(repoRoot).find((s) => s.id === id);
	if (!cloud) throw new Error(`云端找不到会话 ${id}`);

	const dir = path.join(sessionsDir(repoRoot, cloud.project), id);
	const fileName = fs.readdirSync(dir).find((n) => /^session(\.[A-Za-z0-9]+)*\.jsonl\.zstd$/.test(n));
	if (!fileName) throw new Error("云端会话文件缺失");

	const src = path.join(dir, fileName);
	const targetCwd = typeof opts.targetCwd === "string" && opts.targetCwd ? opts.targetCwd : "";
	const effectiveCwd = targetCwd || cloud.cwd;
	const key = effectiveCwd ? projectKeyOf(effectiveCwd) : "_no-cwd";
	const localDir = path.join(dshHome(), "sessions", key, id);
	const localFile = path.join(localDir, fileName);
	await fsp.mkdir(localDir, { recursive: true });

	let payload = fs.readFileSync(src);
	if (targetCwd) payload = rewriteSessionCwd(payload, targetCwd);

	let action = "written";
	if (fs.existsSync(localFile)) {
		if (payload.equals(fs.readFileSync(localFile))) {
			if (targetCwd) updateProjCacheCwd(id, targetCwd, dir);
			return { id, action: "skipped", path: localFile };
		}
		if (opts.overwrite !== false) {
			const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
			await fsp.copyFile(localFile, `${localFile}.bak-${stamp}`);
			action = "overwritten";
		} else {
			return { id, action: "kept-local", path: localFile };
		}
	}

	await fsp.writeFile(localFile, payload);
	if (targetCwd) updateProjCacheCwd(id, targetCwd, dir);
	else writeProjCacheIfMissing(id, dir);

	// 同一会话在其它 cwd 目录下可能还有副本，返回给调用方提示
	const duplicates = [];
	try {
		const root = path.join(dshHome(), "sessions");
		for (const project of fs.readdirSync(root, { withFileTypes: true })) {
			if (!project.isDirectory()) continue;
			const candidate = path.join(root, project.name, id);
			if (candidate === localDir) continue;
			if (fs.existsSync(candidate)) duplicates.push(candidate);
		}
	} catch {}

	return { id, action, path: localFile, cwd: effectiveCwd || null, duplicates };
}

function writeProjCacheIfMissing(id, cloudSessionDir) {
	try {
		const cache = path.join(dshHome(), "storages", "session_projcache", "sessions", `${id}.json`);
		if (fs.existsSync(cache)) return;
		let meta = {};
		try {
			meta = JSON.parse(fs.readFileSync(path.join(cloudSessionDir, "meta.json"), "utf8"));
		} catch {}
		const payload = {
			version: 7,
			record: {
				identity: { formatVersion: 4, createdAt: meta.createdAt || Date.now(), cwd: meta.cwd || "", isSeeded: false, inheritedEventCount: 0 },
				rows: meta.title ? { title: { ver: 1, seq: 1, val: meta.title } } : {},
			},
		};
		fs.mkdirSync(path.dirname(cache), { recursive: true });
		fs.writeFileSync(cache, JSON.stringify(payload, null, 2), "utf8");
	} catch {}
}

/** 会话级“检查变更”：把每个未归档会话的当前工作区，与云端项目清单对比。 */
export async function listPending(repoRoot) {
	const sessions = listSessions().filter((s) => !s.archived);
	const results = [];

	for (const session of sessions) {
		const base = { id: session.id, title: session.title, cwd: session.cwd, bytes: session.bytes };
		if (!session.cwd || !fs.existsSync(session.cwd)) {
			results.push({ ...base, status: "no-workspace" });
			continue;
		}

		const project = findCloudProject(repoRoot, session.cwd);
		const manifestPath = project ? path.join(projectDir(repoRoot, project.name), "workspace", "manifest.json") : null;
		if (!manifestPath || !fs.existsSync(manifestPath)) {
			results.push({ ...base, status: "new" });
			continue;
		}

		let cloud = null;
		try {
			cloud = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		} catch {
			results.push({ ...base, status: "unknown" });
			continue;
		}

		const now = await buildManifest(session.cwd);
		let added = 0;
		let changed = 0;
		let removed = 0;
		for (const [rel, info] of Object.entries(now.files)) {
			const before = cloud.files?.[rel];
			if (!before) added++;
			else if (before.hash !== info.hash) changed++;
		}
		for (const rel of Object.keys(cloud.files || {})) if (!now.files[rel]) removed++;

		results.push({
			...base,
			status: added + changed + removed > 0 ? "dirty" : "clean",
			detail: { added, changed, removed, files: Object.keys(now.files).length, large: (now.large || []).length },
		});
	}

	return results;
}

export { projectKeyOf };
