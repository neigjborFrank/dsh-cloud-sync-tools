// 工作区版本库：内容寻址对象库 + 每版本清单（manifest）。
//
// 为什么不是“上传时做文件对比”：上传那一刻磁盘上只有新版，被删除/被修改的旧内容
// 已经不存在，无法临时备份。因此改为：每个版本保存完整清单（路径 → 哈希），文件内容
// 存入按哈希去重的对象库。效果与需求一致：
//   - 相同文件：对象库只存一份，新旧清单共用；
//   - 减少/修改的旧文件：旧清单仍引用原对象，内容得以保留；
//   - 新增文件：新清单多一条路径，对象库新增一份内容。
// 回滚 = 把某个旧清单切换为正式清单，再按清单物化文件。
//
// 目录：
//   <sessionDir>/manifest.json           当前正式版清单
//   <sessionDir>/objects/<xx>/<sha256>   内容寻址对象
//   <sessionDir>/versions/<ts>/manifest.json 历史版本清单（保留 3 份 / 7 天）
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const EXCLUDES = [".git", "node_modules", "out", ".venv", "__pycache__", ".dsh", ".work", "dist", "build"];
export const KEEP_DAYS = 7;
export const KEEP_VERSIONS = 3;

const isExcluded = (name) => EXCLUDES.includes(name);

function hashFile(file) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = fs.createReadStream(file);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

/** 扫描工作区，生成清单：相对路径 → { hash, size }。 */
export async function buildManifest(rootDir) {
	const files = {};
	const walk = async (dir, prefix) => {
		let entries = [];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (isExcluded(entry.name)) continue;
			const full = path.join(dir, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(full, rel);
			} else if (entry.isFile()) {
				try {
					const stat = await fsp.stat(full);
					files[rel] = { hash: await hashFile(full), size: stat.size };
				} catch {}
			}
		}
	};
	await walk(rootDir, "");
	return { createdAt: new Date().toISOString(), root: rootDir, files };
}

/** 把清单引用的文件内容写入对象库（已存在则跳过）。返回新增对象数。 */
export async function storeObjects(rootDir, manifest, objectsDir) {
	let added = 0;
	for (const [rel, info] of Object.entries(manifest.files)) {
		const dest = path.join(objectsDir, info.hash.slice(0, 2), info.hash);
		if (fs.existsSync(dest)) continue;
		try {
			await fsp.mkdir(path.dirname(dest), { recursive: true });
			await fsp.copyFile(path.join(rootDir, rel), dest);
			added++;
		} catch {}
	}
	return added;
}

/** 按清单物化到目标目录；deleteExtra=true 时删除目标里清单之外的文件。 */
export async function materialize(manifest, objectsDir, targetDir, deleteExtra = true) {
	let written = 0;
	let deleted = 0;
	const wanted = new Set(Object.keys(manifest.files));

	if (deleteExtra && fs.existsSync(targetDir)) {
		const walk = async (dir, prefix) => {
			let entries = [];
			try {
				entries = await fsp.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (isExcluded(entry.name)) continue;
				const full = path.join(dir, entry.name);
				const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.isDirectory()) await walk(full, rel);
				else if (!wanted.has(rel)) {
					await fsp.rm(full, { force: true }).catch(() => {});
					deleted++;
				}
			}
		};
		await walk(targetDir, "");
	}

	for (const [rel, info] of Object.entries(manifest.files)) {
		const src = path.join(objectsDir, info.hash.slice(0, 2), info.hash);
		const dest = path.join(targetDir, rel);
		try {
			await fsp.mkdir(path.dirname(dest), { recursive: true });
			await fsp.copyFile(src, dest);
			written++;
		} catch {}
	}
	return { written, deleted };
}

/** 把当前正式清单挪进历史版本（返回版本名）。版本名精确到毫秒并去重，避免同秒覆盖。 */
export async function archiveCurrentManifest(sessionDir) {
	const current = path.join(sessionDir, "manifest.json");
	if (!fs.existsSync(current)) return null;

	const now = new Date();
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	const stamp =
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;

	const versionsDir = path.join(sessionDir, "versions");
	await fsp.mkdir(versionsDir, { recursive: true });

	let name = stamp;
	let seq = 1;
	while (fs.existsSync(path.join(versionsDir, name))) {
		name = `${stamp}-${seq++}`;
	}

	const dir = path.join(versionsDir, name);
	await fsp.mkdir(dir, { recursive: true });
	await fsp.rename(current, path.join(dir, "manifest.json"));
	return name;
}

/** 读取历史版本清单列表。 */
export function listManifestVersions(sessionDir) {
	const dir = path.join(sessionDir, "versions");
	let names = [];
	try {
		names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
	return names.sort().reverse().map((name) => {
		let counts = null;
		try {
			const m = JSON.parse(fs.readFileSync(path.join(dir, name, "manifest.json"), "utf8"));
			counts = { files: Object.keys(m.files).length, createdAt: m.createdAt };
		} catch {}
		return { version: name, ...counts };
	});
}

/** 回滚：把指定历史清单切回正式位。返回被替换下来的清单（另存为新的历史版本）。 */
export async function rollbackTo(sessionDir, version) {
	const src = path.join(sessionDir, "versions", version, "manifest.json");
	if (!fs.existsSync(src)) throw new Error(`版本 ${version} 不存在`);
	const current = path.join(sessionDir, "manifest.json");
	if (fs.existsSync(current)) {
		await archiveCurrentManifest(sessionDir);
	}
	await fsp.copyFile(src, current);
	return true;
}

/** 保留策略 + 对象回收：最多 3 份历史版本、7 天过期。 */
export function pruneVersions(sessionDir, keepDays = KEEP_DAYS, keepCount = KEEP_VERSIONS) {
	const versionsDir = path.join(sessionDir, "versions");
	const removed = [];
	let names = [];
	try {
		names = fs
			.readdirSync(versionsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
	} catch {
		return { removed, gc: 0 };
	}

	const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
	const kept = [];
	for (const name of names) {
		const full = path.join(versionsDir, name);
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
		fs.rmSync(path.join(versionsDir, oldest), { recursive: true, force: true });
		removed.push(oldest);
	}

	// 回收未被任何清单引用的对象
	const referenced = new Set();
	const collect = (manifestFile) => {
		try {
			const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
			for (const info of Object.values(m.files)) referenced.add(info.hash);
		} catch {}
	};
	collect(path.join(sessionDir, "manifest.json"));
	for (const name of fs.readdirSync(versionsDir, { withFileTypes: true })) {
		if (name.isDirectory()) collect(path.join(versionsDir, name.name, "manifest.json"));
	}

	let gc = 0;
	const objectsDir = path.join(sessionDir, "objects");
	const walk = (dir) => {
		let entries = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (!referenced.has(entry.name)) {
				fs.rmSync(full, { force: true });
				gc++;
			}
		}
	};
	if (fs.existsSync(objectsDir)) walk(objectsDir);

	return { removed, gc };
}
