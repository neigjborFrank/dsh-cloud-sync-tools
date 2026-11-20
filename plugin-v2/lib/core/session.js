// 会话归档：本机会话枚举、上传到项目、下载（cwd 改写）、workspace-ref
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { ensureDir, hashBuffer, readJson, timestamp, writeJsonAtomic } from "../shared.js";
import { layoutDir, projectDir, projectKeyOf, projectName } from "./layout.js";
import { ensureProject, findProjectForCwd, listProjects, saveProjectMeta } from "./project.js";

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

/** 改写会话日志首帧的 cwd（其余帧原样保留） */
export function rewriteSessionCwd(buffer, cwd) {
	const at = buffer.indexOf(MAGIC);
	if (at < 0) return buffer;
	const next = buffer.indexOf(MAGIC, at + 4);
	const end = next < 0 ? buffer.length : next;
	let text;
	try {
		text = zstdDecompressSync(buffer.subarray(at, end)).toString("utf8");
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
	const frame = zstdCompressSync(Buffer.from(lines.join("\n"), "utf8"));
	return Buffer.concat([buffer.subarray(0, at), frame, buffer.subarray(end)]);
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
export function listSessions(home = dshHome()) {
	const root = path.join(home, "sessions");
	const out = [];
	const seen = new Set();
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
				projectDir: projectEntry.name,
				file: files[0],
				filePath: file,
				cwd: header.cwd || "",
				createdAt: header.createdAt || 0,
				bytes,
				modified,
				title: readTitle(sessionEntry.name, home),
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

function findSessionFile(dir) {
	try {
		const name = fs.readdirSync(dir).find((entry) => SESSION_FILE.test(entry));
		return name ? path.join(dir, name) : null;
	} catch {
		return null;
	}
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
			out.push({
				id: entry.name,
				project: project.name,
				cwd: meta.cwd || "",
				title: meta.title || "",
				scope: meta.scope || "",
				uploadedAt: meta.uploadedAt || null,
				sessionBytes: meta.sessionBytes || 0,
			});
		}
	}
	return out;
}

function writeProjCache(sessionId, cwd, home, title = "") {
	try {
		const file = path.join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
		let payload = readJson(file);
		if (!payload) {
			payload = {
				version: 7,
				record: {
					identity: { formatVersion: 4, createdAt: Date.now(), cwd, isSeeded: false, inheritedEventCount: 0 },
					rows: title ? { title: { ver: 1, seq: 1, val: title } } : {},
				},
			};
		} else {
			payload.record ||= {};
			payload.record.identity ||= {};
			payload.record.identity.cwd = cwd;
		}
		writeJsonAtomic(file, payload);
	} catch {}
}

/**
 * 上传一个会话到指定项目。
 * @param {{repoRoot:string,id:string,cwd?:string,projectName?:string,scope?:string,home?:string}} options
 */
export async function uploadSession({ repoRoot, id, cwd, projectName: projectOverride, scope = "", home = dshHome() }) {
	const sessionDir = cwd
		? path.join(home, "sessions", projectKeyOf(cwd), id)
		: findSessionDir(id, home);
	const dir = fs.existsSync(sessionDir) ? sessionDir : findSessionDir(id, home);
	if (!dir) return { id, ok: false, error: "本机找不到该会话" };
	const srcFile = findSessionFile(dir);
	if (!srcFile) return { id, ok: false, error: "会话文件缺失" };

	const header = readHeader(srcFile) || {};
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
		title: readTitle(id, home),
		cwd: effectiveCwd,
		project: targetProject,
		scope: scope || "",
		sessionFile: fileName,
		sessionBytes: fs.statSync(srcFile).size,
		uploadedAt: new Date().toISOString(),
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

/**
 * 下载一个会话：targetCwd 存在时改写 cwd 并放到对应 projectKey。
 * @returns {{id, action:"written"|"overwritten"|"skipped"|"kept-local", path?, cwd?, duplicates?}}
 */
export async function downloadSession(repoRoot, id, options = {}) {
	const cloud = listCloudSessions(repoRoot).find((session) => session.id === id);
	if (!cloud) throw new Error(`云端找不到会话 ${id}`);
	const cloudDir = path.join(projectDir(repoRoot, cloud.project), "sessions", id);
	const srcFile = findSessionFile(cloudDir);
	if (!srcFile) throw new Error("云端会话文件缺失");

	const home = options.home || dshHome();
	const targetCwd = String(options.targetCwd || "");
	const effectiveCwd = targetCwd || cloud.cwd;
	const key = effectiveCwd ? projectKeyOf(effectiveCwd) : "_no-cwd";
	const localDir = path.join(home, "sessions", key, id);
	const localFile = path.join(localDir, path.basename(srcFile));
	ensureDir(localDir);

	let payload = fs.readFileSync(srcFile);
	if (targetCwd) payload = rewriteSessionCwd(payload, targetCwd);

	let action = "written";
	if (fs.existsSync(localFile)) {
		if (payload.equals(fs.readFileSync(localFile))) {
			if (targetCwd) writeProjCache(id, targetCwd, home);
			return { id, action: "skipped", path: localFile };
		}
		if (options.overwrite !== false) {
			await fsp.copyFile(localFile, `${localFile}.bak-${timestamp()}`);
			action = "overwritten";
		} else {
			return { id, action: "kept-local", path: localFile };
		}
	}

	await fsp.writeFile(localFile, payload);
	writeProjCache(id, effectiveCwd || "", home, cloud.title);

	const duplicates = [];
	try {
		const root = path.join(home, "sessions");
		for (const projectEntry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!projectEntry.isDirectory()) continue;
			const candidate = path.join(root, projectEntry.name, id);
			if (candidate !== localDir && fs.existsSync(candidate)) duplicates.push(candidate);
		}
	} catch {}

	return { id, action, path: localFile, cwd: effectiveCwd || null, duplicates };
}

/** 会话级：本地工作区 vs 云端清单的差异（供"检查变更"使用） */
export async function listPending(repoRoot, home = dshHome()) {
	const { buildManifest } = await import("./manifest.js");
	const { readManifest } = await import("./manifest.js");
	const results = [];
	for (const session of listSessions(home)) {
		const base = { id: session.id, title: session.title, cwd: session.cwd, bytes: session.bytes };
		if (!session.cwd || !fs.existsSync(session.cwd)) {
			results.push({ ...base, status: "no-workspace" });
			continue;
		}
		const found = findProjectForCwd(repoRoot, session.cwd);
		if (!found) {
			results.push({ ...base, status: "new" });
			continue;
		}
		const indexDir = projectDir(repoRoot, found.project.name);
		const cloud = readManifest(layoutDir(indexDir));
		if (!cloud.files || !Object.keys(cloud.files).length) {
			results.push({ ...base, status: "new" });
			continue;
		}
		const now = await buildManifest(session.cwd);
		let added = 0;
		let changed = 0;
		let removed = 0;
		for (const [rel, info] of Object.entries(now.files)) {
			const before = cloud.files[rel];
			if (!before) added++;
			else if (before.hash !== info.hash) changed++;
		}
		for (const rel of Object.keys(cloud.files)) if (!now.files[rel]) removed++;
		results.push({ ...base, project: found.project.name, scope: found.scope, status: added + changed + removed > 0 ? "dirty" : "clean", detail: { added, changed, removed } });
	}
	return results;
}
