// 可读的工作区版本库：files/ 为正式版完整树，backups/<ts>/files/ 只存“有变化”的旧文件。
//
// 结构：
//   <sessionDir>/manifest.json                  正式版清单 {files:{path:{hash,size}}}
//   <sessionDir>/files/<path>                   正式版文件实体（可读、可直接从仓库下载）
//   <sessionDir>/backups/<ts>/manifest.json     旧版完整清单（未变文件标 from:"files"）
//   <sessionDir>/backups/<ts>/files/<path>      旧版中“删除/修改前”的内容
//
// 规则：1 份正式版 + 3 份备份；备份 7 天过期；单文件超过 100 MB 记为 skipped（GitHub 限制）。
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const EXCLUDES = [".git", "node_modules", "out", ".venv", "__pycache__", ".dsh", ".work", "dist", "build"];
export const KEEP_DAYS = 7;
export const KEEP_BACKUPS = 3;
export const MAX_FILE_BYTES = Number(process.env.CSP_MAX_FILE_BYTES) || 95 * 1024 * 1024; // 默认留余量（GitHub 单文件 100MB）；可用环境变量覆盖
export const MAX_REL_PATH = 220; // 仓库内相对路径上限，避免 Windows 260 字符限制

// .csp-trash-<ts> 是下载镜像时移出的本地多余文件，不应再上传
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

/** 扫描目录生成清单；超过单文件上限或路径过长的记为 skipped。 */
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
						const hash = await hashFile(full);
						large.push({ path: rel, size: stat.size, hash });
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

/**
 * 把一个工作区同步成“新的正式版”：先归档旧版的差异文件，再刷新 files/ 与清单。
 * @returns {{ archived: string|null, changed: number, added: number, removed: number, skipped: number, pruned: string[] }}
 */
export async function commitVersion(workspaceDir, sessionDir, options = {}) {
	const filesDir = path.join(sessionDir, "files");
	const currentManifestPath = path.join(sessionDir, "manifest.json");
	const currentManifest = readJson(currentManifestPath);
	const next = await buildManifest(workspaceDir);

	let archived = null;
	let changed = 0;
	let added = 0;
	let removed = 0;

	if (currentManifest && currentManifest.files) {
		const oldFiles = currentManifest.files;
		const changedPaths = [];
		for (const [rel, info] of Object.entries(oldFiles)) {
			const now = next.files[rel];
			if (!now) {
				changedPaths.push(rel); // 被删除
				removed++;
			} else if (now.hash !== info.hash) {
				changedPaths.push(rel); // 被修改
				changed++;
			}
		}
		for (const rel of Object.keys(next.files)) if (!oldFiles[rel]) added++;

		// 只归档“有变化”的旧文件，未变文件继续留在 files/ 里被引用
		const stamp = uniqueStamp(path.join(sessionDir, "backups"));
		const backupDir = path.join(sessionDir, "backups", stamp);
		const backupFiles = path.join(backupDir, "files");
		fs.mkdirSync(backupFiles, { recursive: true });

		for (const rel of changedPaths) {
			const src = path.join(filesDir, rel);
			const dest = path.join(backupFiles, rel);
			try {
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				await fsp.copyFile(src, dest);
			} catch {}
		}

		// 备份清单：完整路径集合，未变文件标 from=files，变化文件标 from=backup
		const stored = new Set(changedPaths);
		const manifest = { createdAt: currentManifest.createdAt || null, files: {} };
		for (const [rel, info] of Object.entries(oldFiles)) {
			manifest.files[rel] = { ...info, from: stored.has(rel) ? "backup" : "files" };
		}
		writeJson(path.join(backupDir, "manifest.json"), manifest);
		writeJson(path.join(backupDir, "large.json"), {
			createdAt: currentManifest.createdAt || null,
			large: currentManifest.large || [],
			tooLong: currentManifest.tooLong || [],
		});
		archived = stamp;
	}

	// 刷新正式版 files/：写入/更新，删除清单外文件
	fs.mkdirSync(filesDir, { recursive: true });
	const wanted = new Set(Object.keys(next.files));
	for (const rel of Object.keys(next.files)) {
		const src = path.join(workspaceDir, rel);
		const dest = path.join(filesDir, rel);
		try {
			const stat = await fsp.stat(dest).catch(() => null);
			if (!stat || stat.size !== next.files[rel].size) {
				await fsp.mkdir(path.dirname(dest), { recursive: true });
				await fsp.copyFile(src, dest);
			} else if ((await hashFile(dest)) !== next.files[rel].hash) {
				await fsp.copyFile(src, dest);
			}
		} catch {}
	}
	// 删除正式版里不该再存在的文件
	const walkDel = async (dir, prefix) => {
		let entries = [];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walkDel(full, rel);
			else if (!wanted.has(rel)) await fsp.rm(full, { force: true }).catch(() => {});
		}
	};
	await walkDel(filesDir, "");

	// 大文件：内容单独放到 <实体>/large/ 下，由 git-lfs 接管（可跨机恢复）
	const largeDir = path.join(sessionDir, "large");
	const largeEntries = [];
	for (const entry of next.large || []) {
		if (!options.storeLarge) {
			largeEntries.push({ ...entry, stored: "skipped" });
			continue;
		}
		const src = path.join(workspaceDir, entry.path);
		const dest = path.join(largeDir, entry.path);
		let stored = false;
		try {
			await fsp.mkdir(path.dirname(dest), { recursive: true });
			await fsp.copyFile(src, dest);
			stored = true;
		} catch {}
		largeEntries.push({ ...entry, stored: stored ? "lfs" : "failed" });
	}
	// 清理不再是大文件的旧 large/ 内容
	const keepLarge = new Set((next.large || []).map((e) => e.path));
	const walkLarge = async (dir, prefix) => {
		let entries = [];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walkLarge(full, rel);
			else if (!keepLarge.has(rel)) await fsp.rm(full, { force: true }).catch(() => {});
		}
	};
	if (fs.existsSync(largeDir)) await walkLarge(largeDir, "");

	writeJson(currentManifestPath, next);
	writeJson(path.join(sessionDir, "large.json"), {
		createdAt: next.createdAt,
		large: largeEntries,
		tooLong: next.tooLong,
	});

	const pruned = pruneBackups(sessionDir);
	return {
		archived,
		changed,
		added,
		removed,
		large: (next.large || []).length,
		tooLong: (next.tooLong || []).length,
		files: Object.keys(next.files || {}).length,
		pruned,
	};
}

function uniqueStamp(backupsDir) {
	const now = new Date();
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	const base =
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
	let name = base;
	let seq = 1;
	while (fs.existsSync(path.join(backupsDir || ".", name))) name = `${base}-${seq++}`;
	return name;
}

/** 列出备份版本（含文件数、时间）。 */
export function listBackups(sessionDir) {
	const dir = path.join(sessionDir, "backups");
	let names = [];
	try {
		names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
	return names.sort().reverse().map((name) => {
		const manifest = readJson(path.join(dir, name, "manifest.json")) || { files: {} };
		const storedCount = Object.values(manifest.files || {}).filter((f) => f.from === "backup").length;
		return { version: name, files: Object.keys(manifest.files || {}).length, stored: storedCount, createdAt: manifest.createdAt };
	});
}

/** 保留策略：最多 keepCount 份备份；超过 keepDays 删除。 */
export function pruneBackups(sessionDir, keepDays = KEEP_DAYS, keepCount = KEEP_BACKUPS) {
	const dir = path.join(sessionDir, "backups");
	const removed = [];
	let names = [];
	try {
		names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
	} catch {
		return removed;
	}
	const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
	const kept = [];
	for (const name of names) {
		const full = path.join(dir, name);
		let mtime = 0;
		try {
			mtime = fs.statSync(full).mtimeMs;
		} catch {}
		if (mtime && mtime < cutoff) {
			fs.rmSync(full, { recursive: true, force: true });
			removed.push(name);
		} else kept.push(name);
	}
	while (kept.length > keepCount) {
		const oldest = kept.shift();
		fs.rmSync(path.join(dir, oldest), { recursive: true, force: true });
		removed.push(oldest);
	}
	return removed;
}

/**
 * 把指定版本物化到目标目录；version=null 表示正式版。
 * 组合规则：manifest 里 from=files 的取 files/，from=backup 的取 backups/<ts>/files/。
 */
export async function materialize(sessionDir, version, targetDir) {
	const manifestPath = version
		? path.join(sessionDir, "backups", version, "manifest.json")
		: path.join(sessionDir, "manifest.json");
	const manifest = readJson(manifestPath);
	if (!manifest) throw new Error(`找不到清单：${manifestPath}`);

	const filesDir = path.join(sessionDir, "files");
	const backupFiles = version ? path.join(sessionDir, "backups", version, "files") : null;
	const wanted = new Set(Object.keys(manifest.files || {}));

	let written = 0;
	let deleted = 0;

	if (fs.existsSync(targetDir)) {
		const walkDel = async (dir, prefix) => {
			for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
				if (excluded(entry.name)) continue;
				const full = path.join(dir, entry.name);
				const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) await walkDel(full, rel);
				else if (!wanted.has(rel)) {
					await fsp.rm(full, { force: true }).catch(() => {});
					deleted++;
				}
			}
		};
		await walkDel(targetDir, "");
	}

	for (const [rel, info] of Object.entries(manifest.files || {})) {
		const src = info.from === "backup" && backupFiles ? path.join(backupFiles, rel) : path.join(filesDir, rel);
		const dest = path.join(targetDir, rel);
		try {
			await fsp.mkdir(path.dirname(dest), { recursive: true });
			await fsp.copyFile(src, dest);
			written++;
		} catch {}
	}
	return { written, deleted };
}

/** 云端回滚：把指定备份的清单/文件换回正式版位（旧正式版另存为新的备份）。 */
export async function rollback(sessionDir, version) {
	const backupDir = path.join(sessionDir, "backups", version);
	const backupManifest = readJson(path.join(backupDir, "manifest.json"));
	if (!backupManifest) throw new Error(`备份 ${version} 不存在`);

	// 1) 把当前正式版整体存成新备份（只在需要时保留变化文件）
	const filesDir = path.join(sessionDir, "files");
	const currentManifest = readJson(path.join(sessionDir, "manifest.json")) || { files: {} };
	const stamp = uniqueStamp(path.join(sessionDir, "backups"));
	const newBackup = path.join(sessionDir, "backups", stamp);
	fs.mkdirSync(path.join(newBackup, "files"), { recursive: true });
	for (const [rel, info] of Object.entries(currentManifest.files || {})) {
		const target = backupManifest.files[rel];
		if (!target || target.from === "backup" || target.hash !== info.hash) {
			const src = path.join(filesDir, rel);
			const dest = path.join(newBackup, "files", rel);
			try {
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				await fsp.copyFile(src, dest);
			} catch {}
		}
	}
	writeJson(path.join(newBackup, "manifest.json"), {
		createdAt: currentManifest.createdAt || null,
		files: Object.fromEntries(
			Object.entries(currentManifest.files || {}).map(([rel, info]) => {
				const target = backupManifest.files[rel];
				const same = target && target.hash === info.hash;
				return [rel, { ...info, from: same ? target.from : "backup" }];
			}),
		),
	});

	// 2) 用备份内容重建 files/
	for (const [rel, info] of Object.entries(backupManifest.files || {})) {
		const src = info.from === "backup" ? path.join(backupDir, "files", rel) : path.join(filesDir, rel);
		const dest = path.join(filesDir, rel);
		try {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			if (src !== dest) await fsp.copyFile(src, dest);
		} catch {}
	}
	// 3) 删除正式版里备份清单之外的文件
	const wanted = new Set(Object.keys(backupManifest.files || {}));
	const walkDel = async (dir, prefix) => {
		for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walkDel(full, rel);
			else if (!wanted.has(rel)) await fsp.rm(full, { force: true }).catch(() => {});
		}
	};
	if (fs.existsSync(filesDir)) await walkDel(filesDir, "");

	// 4) 清单切换
	writeJson(path.join(sessionDir, "manifest.json"), {
		createdAt: backupManifest.createdAt,
		files: Object.fromEntries(Object.entries(backupManifest.files || {}).map(([rel, info]) => [rel, { hash: info.hash, size: info.size }])),
		large: backupManifest.large || [],
		tooLong: backupManifest.tooLong || [],
	});

	// 5) 保留策略
	const pruned = pruneBackups(sessionDir);
	return { rolledBackTo: version, previousSavedAs: stamp, pruned };
}
