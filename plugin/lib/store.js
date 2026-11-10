// 可读的工作区镜像：files/ 保存当前完整文件树，manifest.json 记录路径 → 哈希。
// 支持「按子路径并入」（scopePrefix）：把某个子目录工作区合并进父项目，只更新该子路径下的文件。
// 版本历史由 git commit 承担。
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const EXCLUDES = [".git", "node_modules", "out", ".venv", "__pycache__", ".dsh", ".work", "dist", "build"];
export const MAX_FILE_BYTES = Number(process.env.CSP_MAX_FILE_BYTES) || 95 * 1024 * 1024;
export const MAX_REL_PATH = 220;

export const excluded = (name) => EXCLUDES.includes(name) || name.startsWith(".csp-trash-");

function hashFile(file) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = fs.createReadStream(file);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

export { hashFile };

/** 扫描目录生成清单。 */
export async function buildManifest(rootDir, maxRelPath = MAX_REL_PATH) {
	const files = {};
	const large = [];
	const tooLong = [];
	const walk = async (dir, prefix) => {
		let entries = [];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (excluded(entry.name)) continue;
			const full = path.join(dir, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(full, rel);
			} else if (entry.isFile()) {
				try {
					const stat = await fsp.stat(full);
					if (stat.size > MAX_FILE_BYTES) {
						large.push({ path: rel, size: stat.size, hash: await hashFile(full) });
						continue;
					}
					if (rel.length > maxRelPath) {
						tooLong.push({ path: rel, size: stat.size });
						continue;
					}
					files[rel] = { hash: await hashFile(full), size: stat.size };
				} catch {}
			}
		}
	};
	await walk(rootDir, "");
	return { createdAt: new Date().toISOString(), files, large, tooLong };
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function writeJson(file, obj) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

function normalizeScope(scope) {
	return String(scope || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function scoped(prefix, rel) {
	const p = normalizeScope(prefix);
	return p ? `${p}/${rel}` : rel;
}

function underScope(key, scope) {
	const p = normalizeScope(scope);
	return p === "" || key === p || key.startsWith(p + "/");
}

/**
 * 把工作区同步进项目镜像。
 * options.scopePrefix：非空表示"该工作区是项目里的一个子目录"，只更新该子路径下的文件；
 * options.storeLarge：是否把大文件内容写入 large/（git-lfs）。
 * 同路径不同内容：保留云端旧版，新内容写入 conflicts/<ts>/<路径>，并在返回值里列出。
 */
export async function commitVersion(workspaceDir, indexDir, options = {}) {
	const scope = normalizeScope(options.scopePrefix);
	const mode = options.mode === "union" ? "union" : "mirror";
	const filesDir = options.filesRoot || path.join(indexDir, "files");
	const largeDir = options.largeRoot || path.join(indexDir, "large");
	const manifestPath = path.join(indexDir, "manifest.json");
	const current = readJson(manifestPath) || { files: {}, large: [], tooLong: [] };
	const incoming = await buildManifest(workspaceDir);
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const conflictsDir = path.join(indexDir, "conflicts", stamp);
	const conflicts = [];

	const nextFiles = mode === "mirror" && scope === "" ? {} : { ...(current.files || {}) };
	for (const key of Object.keys(nextFiles)) {
		if (scope && underScope(key, scope) && key !== scope) delete nextFiles[key];
	}
	let added = 0;
	let changed = 0;
	let removed = 0;
	const toWrite = [];

	for (const [rel, info] of Object.entries(incoming.files)) {
		const key = scoped(scope, rel);
		const before = (current.files || {})[key];
		if (!before) {
			added++;
			nextFiles[key] = info;
			toWrite.push([rel, key, info]);
		} else if (before.hash !== info.hash) {
			// 冲突：云端旧版保留，本地新内容进 conflicts/
			changed++;
			const dest = path.join(conflictsDir, key);
			try {
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				await fsp.copyFile(path.join(workspaceDir, rel), dest);
				conflicts.push({ path: key, kept: "cloud", incoming: path.relative(indexDir, dest) });
			} catch {}
		} else {
			// 内容未变：镜像模式也要把条目写入新清单（否则第二次上传会清空清单）
			nextFiles[key] = info;
			toWrite.push([rel, key, info]);
		}
	}
	if (scope) {
		const incomingKeys = new Set(Object.keys(incoming.files).map((rel) => scoped(scope, rel)));
		for (const key of Object.keys(current.files || {})) {
			if (underScope(key, scope) && key !== scope && !incomingKeys.has(key)) removed++;
		}
	} else {
		for (const key of Object.keys(current.files || {})) if (!incoming.files[key]) removed++;
	}

	// 写入文件
	fs.mkdirSync(filesDir, { recursive: true });
	for (const [rel, key, info] of toWrite) {
		const src = path.join(workspaceDir, rel);
		const dest = path.join(filesDir, key);
		try {
			const stat = await fsp.stat(dest).catch(() => null);
			if (!stat || stat.size !== info.size || (await hashFile(dest)) !== info.hash) {
				await fsp.mkdir(path.dirname(dest), { recursive: true });
				await fsp.copyFile(src, dest);
			}
		} catch {}
	}
	// 删除本作用域内多余文件
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
			else if (!nextFiles[key]) await fsp.rm(full, { force: true }).catch(() => {});
		}
	};
	if (!(mode === "union" && scope === "")) await walkDel(filesDir, "");

	// 大文件（按作用域合并清单）

	const currentLarge = (current.large || []).filter((entry) => !scope || !underScope(entry.path, scope));
	const largeEntries = [...currentLarge];
	for (const entry of incoming.large || []) {
		const key = scoped(scope, entry.path);
		let stored = "skipped";
		if (options.storeLarge) {
			const src = path.join(workspaceDir, entry.path);
			const dest = path.join(largeDir, key);
			try {
				await fsp.mkdir(path.dirname(dest), { recursive: true });
				await fsp.copyFile(src, dest);
				stored = "lfs";
			} catch {
				stored = "failed";
			}
		}
		largeEntries.push({ ...entry, path: key, stored });
	}
	const keepLarge = new Set(largeEntries.map((e) => e.path));
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
			else if (!keepLarge.has(key)) await fsp.rm(full, { force: true }).catch(() => {});
		}
	};
	if (fs.existsSync(largeDir)) await walkLarge(largeDir, "");

	const nextTooLong = [
		...(current.tooLong || []).filter((entry) => !scope || !underScope(entry.path, scope)),
		...(incoming.tooLong || []).map((entry) => ({ ...entry, path: scoped(scope, entry.path) })),
	];
	writeJson(manifestPath, { createdAt: new Date().toISOString(), files: nextFiles, large: largeEntries, tooLong: nextTooLong });
	writeJson(path.join(indexDir, "large.json"), { createdAt: new Date().toISOString(), large: largeEntries, tooLong: nextTooLong });

	return {
		changed,
		added,
		removed,
		conflicts,
		scope,
		large: (incoming.large || []).length,
		files: Object.keys(nextFiles).length,
		projectFiles: Object.keys(incoming.files).length,
	};
}
