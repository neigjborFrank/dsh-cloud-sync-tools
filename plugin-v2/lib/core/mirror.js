// 工作区内容写入镜像：mirror（全量镜像）/ union（合并保留）两种模式，支持 scope 子路径与冲突隔离
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { ensureDir, hashFile, removeQuiet, timestamp, writeJsonAtomic } from "../shared.js";
import { readManifest } from "./manifest.js";
import { buildManifest } from "./manifest.js";

function normalizeScope(scope) {
	return String(scope || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function scoped(prefix, rel) {
	return prefix ? `${prefix}/${rel}` : rel;
}

function underScope(key, scope) {
	return scope === "" || key === scope || key.startsWith(`${scope}/`);
}

/**
 * 把工作区内容写入项目镜像。
 * @param {string} workspaceDir 源工作区
 * @param {string} indexDir 指示区项目目录（manifest.json 位置）
 * @param {{filesRoot:string, largeRoot:string, scopePrefix?:string, mode?:"mirror"|"union", storeLarge?:boolean}} options
 * @returns {Promise<{changed:number, added:number, removed:number, conflicts:Array, files:number, large:number, tooLong:number, scope:string}>}
 */
export async function commitWorkspace(workspaceDir, indexDir, options = {}) {
	const scope = normalizeScope(options.scopePrefix);
	const mode = options.mode === "union" ? "union" : "mirror";
	const filesRoot = options.filesRoot || path.join(indexDir, "files");
	const largeRoot = options.largeRoot || path.join(indexDir, "large");
	const manifestPath = path.join(indexDir, "manifest.json");
	const current = readManifest(indexDir);
	const incoming = await buildManifest(workspaceDir);
	const conflictsDir = path.join(indexDir, "conflicts", timestamp());
	const conflicts = [];

	// 新清单基础：mirror 根作用域 = 空；其余 = 当前清单（再替换 scope 部分）
	const nextFiles = mode === "mirror" && scope === "" ? {} : { ...current.files };
	if (scope) {
		for (const key of Object.keys(nextFiles)) {
			if (underScope(key, scope) && key !== scope) delete nextFiles[key];
		}
	}

	let added = 0;
	let changed = 0;
	let removed = 0;
	const toWrite = [];

	for (const [rel, info] of Object.entries(incoming.files)) {
		const key = scoped(scope, rel);
		const before = current.files[key];
		if (!before) {
			added++;
			nextFiles[key] = info;
			toWrite.push([rel, key, info]);
		} else if (before.hash !== info.hash) {
			changed++;
			// 冲突：云端旧版保留（清单也要保留该条目），新内容进 conflicts/
			nextFiles[key] = before;
			const dest = path.join(conflictsDir, key);
			try {
				ensureDir(path.dirname(dest));
				await fsp.copyFile(path.join(workspaceDir, rel), dest);
				conflicts.push({ path: key, kept: "cloud", incoming: path.relative(indexDir, dest) });
			} catch {}
		} else {
			// 内容未变：镜像模式也必须写回清单，否则下一次上传会清空清单
			nextFiles[key] = info;
			toWrite.push([rel, key, info]);
		}
	}

	// 删除统计
	if (scope) {
		const incomingKeys = new Set(Object.keys(incoming.files).map((rel) => scoped(scope, rel)));
		for (const key of Object.keys(current.files)) {
			if (underScope(key, scope) && key !== scope && !incomingKeys.has(key)) removed++;
		}
	} else {
		for (const key of Object.keys(current.files)) if (!incoming.files[key]) removed++;
	}

	// 写文件
	ensureDir(filesRoot);
	for (const [rel, key, info] of toWrite) {
		const src = path.join(workspaceDir, rel);
		const dest = path.join(filesRoot, key);
		try {
			const stat = await fsp.stat(dest).catch(() => null);
			if (!stat || stat.size !== info.size || (await hashFile(dest)) !== info.hash) {
				ensureDir(path.dirname(dest));
				await fsp.copyFile(src, dest);
			}
		} catch {}
	}

	// 删除作用域内多余文件（union 根作用域不删）
	const walkDel = async (dir, prefix) => {
		let entries = [];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			const key = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walkDel(full, key);
			else if (!nextFiles[key]) await removeQuiet(full);
		}
	};
	if (!(mode === "union" && scope === "")) await walkDel(filesRoot, "");

	// 大文件：内容进 largeRoot，清单合并
	const currentLarge = (current.large || []).filter((entry) => !scope || !underScope(entry.path, scope));
	const largeEntries = [...currentLarge];
	for (const entry of incoming.large) {
		const key = scoped(scope, entry.path);
		let stored = "skipped";
		if (options.storeLarge) {
			try {
				const src = path.join(workspaceDir, entry.path);
				const dest = path.join(largeRoot, key);
				ensureDir(path.dirname(dest));
				await fsp.copyFile(src, dest);
				stored = "lfs";
			} catch {
				stored = "failed";
			}
		}
		largeEntries.push({ ...entry, path: key, stored });
	}
	const keepLarge = new Set(largeEntries.map((entry) => entry.path));
	const walkLarge = async (dir, prefix) => {
		let entries = [];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			const key = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walkLarge(full, key);
			else if (!keepLarge.has(key)) await removeQuiet(full);
		}
	};
	if (fs.existsSync(largeRoot)) await walkLarge(largeRoot, "");

	const nextTooLong = [
		...(current.tooLong || []).filter((entry) => !scope || !underScope(entry.path, scope)),
		...incoming.tooLong.map((entry) => ({ ...entry, path: scoped(scope, entry.path) })),
	];

	const manifest = {
		schema: 1,
		createdAt: new Date().toISOString(),
		files: nextFiles,
		large: largeEntries,
		tooLong: nextTooLong,
	};
	writeJsonAtomic(manifestPath, manifest);
	writeJsonAtomic(path.join(indexDir, "large.json"), {
		schema: 1,
		createdAt: manifest.createdAt,
		large: largeEntries,
		tooLong: nextTooLong,
	});

	return {
		changed,
		added,
		removed,
		conflicts,
		scope,
		files: Object.keys(nextFiles).length,
		large: incoming.large.length,
		tooLong: incoming.tooLong.length,
	};
}
