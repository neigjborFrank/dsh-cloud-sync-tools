// 可读的工作区镜像：files/ 保存当前完整文件树，manifest.json 记录路径 → 哈希。
//
// 版本历史不再由插件保存：每次上传都会产生一次 git commit，
// 任意历史版本、恢复与对比都交给 GitHub / git 本身。
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const EXCLUDES = [".git", "node_modules", "out", ".venv", "__pycache__", ".dsh", ".work", "dist", "build"];
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

/** 扫描目录生成清单；超过单文件上限或路径过长的单独记录。 */
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
 * 把工作区同步为项目的最新镜像：刷新 files/、large/、manifest.json、large.json。
 * 差异统计只用于报告；历史版本由 git commit 承担。
 */
export async function commitVersion(workspaceDir, sessionDir, options = {}) {
	const filesDir = path.join(sessionDir, "files");
	const manifestPath = path.join(sessionDir, "manifest.json");
	const current = readJson(manifestPath);
	const next = await buildManifest(workspaceDir);

	let changed = 0;
	let added = 0;
	let removed = 0;
	if (current && current.files) {
		for (const [rel, info] of Object.entries(next.files)) {
			const before = current.files[rel];
			if (!before) added++;
			else if (before.hash !== info.hash) changed++;
		}
		for (const rel of Object.keys(current.files)) if (!next.files[rel]) removed++;
	}

	// 刷新正式版文件树
	fs.mkdirSync(filesDir, { recursive: true });
	for (const [rel, info] of Object.entries(next.files)) {
		const src = path.join(workspaceDir, rel);
		const dest = path.join(filesDir, rel);
		try {
			const stat = await fsp.stat(dest).catch(() => null);
			if (!stat || stat.size !== info.size || (await hashFile(dest)) !== info.hash) {
				await fsp.mkdir(path.dirname(dest), { recursive: true });
				await fsp.copyFile(src, dest);
			}
		} catch {}
	}
	const wanted = new Set(Object.keys(next.files));
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

	// 大文件：内容存 large/，由 git-lfs 接管（可跨机恢复）
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

	writeJson(manifestPath, next);
	writeJson(path.join(sessionDir, "large.json"), {
		createdAt: next.createdAt,
		large: largeEntries,
		tooLong: next.tooLong,
	});

	return {
		changed,
		added,
		removed,
		large: (next.large || []).length,
		tooLong: (next.tooLong || []).length,
		files: Object.keys(next.files || {}).length,
	};
}
