// 项目实体：云端 projects/<项目名>/，一个项目 = 工作区 + 会话，全部收敛在同一目录。
//
// projects/
//   <名称>__<路径键>/
//     meta.json              { name, cwd, projectKey, title, sessions[], createdAt, updatedAt }
//     workspace/             工作区镜像（files/、manifest.json、large.json、backups/）
//     sessions/<会话id>/     会话文件（session.v4.jsonl.zstd + meta.json）
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { commitVersion, listBackups, rollback as rollbackEntity } from "./store.js";

export const PROJECTS_DIR = "projects";

/** cwd → 路径键（与 DSH 的 projectKey 算法一致）。 */
export function projectKeyOf(cwd) {
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** cwd → 项目目录名：<目录名>__<路径键去掉首尾 --> */
export function projectName(cwd) {
	const base = path.basename(cwd) || "root";
	const key = projectKeyOf(cwd).replace(/^--+/, "").replace(/--+$/, "");
	return `${base}__${key}`;
}

export function projectsRoot(repoRoot) {
	return path.join(repoRoot, PROJECTS_DIR);
}

export function projectDir(repoRoot, target) {
	// target 可以是 cwd 或项目名
	if (/[\\/]/.test(target) || /^[A-Za-z]:/.test(target)) return path.join(projectsRoot(repoRoot), projectName(target));
	return path.join(projectsRoot(repoRoot), target);
}

export function workspaceDir(repoRoot, target) {
	return path.join(projectDir(repoRoot, target), "workspace");
}

export function sessionsDir(repoRoot, target) {
	return path.join(projectDir(repoRoot, target), "sessions");
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

/** 确保项目目录存在并返回其 meta（缺失则创建）。 */
export function ensureProject(repoRoot, cwd) {
	const name = projectName(cwd);
	const dir = projectDir(repoRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	const metaPath = path.join(dir, "meta.json");
	const now = new Date().toISOString();
	let meta = readJson(metaPath);
	if (!meta) {
		meta = {
			name,
			cwd,
			projectKey: projectKeyOf(cwd),
			title: path.basename(cwd) || "root",
			sessions: [],
			createdAt: now,
			updatedAt: now,
		};
		writeJson(metaPath, meta);
	}
	return meta;
}

export function saveProjectMeta(repoRoot, meta) {
	const file = path.join(projectDir(repoRoot, meta.name), "meta.json");
	meta.updatedAt = new Date().toISOString();
	writeJson(file, meta);
	return meta;
}

/** 列出云端所有项目。 */
export function listCloudProjects(repoRoot) {
	const root = projectsRoot(repoRoot);
	let dirs = [];
	try {
		dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
	} catch {
		return [];
	}
	return dirs.map((entry) => {
		const dir = path.join(root, entry.name);
		const meta = readJson(path.join(dir, "meta.json")) || { name: entry.name };
		const wsDir = path.join(dir, "workspace");
		const manifest = readJson(path.join(wsDir, "manifest.json")) || { files: {} };
		const large = readJson(path.join(wsDir, "large.json")) || { large: [] };
		let sessionCount = 0;
		try {
			sessionCount = fs.readdirSync(path.join(dir, "sessions"), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
		} catch {}
		return {
			name: entry.name,
			cwd: meta.cwd || "",
			projectKey: meta.projectKey || "",
			title: meta.title || entry.name,
			sessions: Array.isArray(meta.sessions) ? meta.sessions : [],
			hasWorkspace: fs.existsSync(path.join(wsDir, "manifest.json")),
			files: Object.keys(manifest.files || {}).length,
			bytes: Object.values(manifest.files || {}).reduce((s, f) => s + (f.size || 0), 0),
			large: (large.large || []).length,
		largeStored: (large.large || []).filter((x) => x.stored === "lfs").length,
			backups: listBackups(wsDir).length,
			sessionCount,
		};
	});
}

export function findCloudProject(repoRoot, target) {
	const name = /[\\/]/.test(target) || /^[A-Za-z]:/.test(target) ? projectName(target) : target;
	const all = listCloudProjects(repoRoot);
	return all.find((p) => p.name === name) || all.find((p) => p.cwd === target) || null;
}

/** 上传（或更新）项目工作区：全量镜像写入 projects/<名>/workspace/。 */
export async function uploadProjectWorkspace(repoRoot, cwd, options = {}) {
	const meta = ensureProject(repoRoot, cwd);
	const dir = path.join(projectDir(repoRoot, meta.name), "workspace");
	await fsp.mkdir(dir, { recursive: true });
	const result = await commitVersion(cwd, dir, options);
	meta.workspace = {
		files: result.files,
		changed: result.changed,
		added: result.added,
		removed: result.removed,
		large: result.large,
		tooLong: result.tooLong,
	};
	saveProjectMeta(repoRoot, meta);
	return { meta, dir, ...result };
}

/** 下载项目工作区：镜像到目标目录，多余文件进 .csp-trash-<ts>/。 */
export async function downloadProjectWorkspace(repoRoot, target, destDir, version = null) {
	const project = findCloudProject(repoRoot, target);
	if (!project) throw new Error(`云端没有项目 ${target}`);
	const dir = path.join(projectDir(repoRoot, project.name), "workspace");
	if (!fs.existsSync(path.join(dir, "manifest.json"))) throw new Error("该项目没有上传工作区");

	const manifestPath = version ? path.join(dir, "backups", version, "manifest.json") : path.join(dir, "manifest.json");
	const manifest = readJson(manifestPath);
	if (!manifest) throw new Error(`找不到清单：${manifestPath}`);

	const filesDir = path.join(dir, "files");
	const backupFiles = version ? path.join(dir, "backups", version, "files") : null;
	const wanted = new Set(Object.keys(manifest.files || {}));

	const { createHash } = await import("node:crypto");
	const hashFile = (file) =>
		new Promise((resolve, reject) => {
			const hash = createHash("sha256");
			const stream = fs.createReadStream(file);
			stream.on("data", (c) => hash.update(c));
			stream.on("error", reject);
			stream.on("end", () => resolve(hash.digest("hex")));
		});

	await fsp.mkdir(destDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const trashDir = path.join(destDir, `.csp-trash-${stamp}`);

	let trashed = 0;
	let written = 0;
	let verified = 0;
	let failed = 0;

	const walkExtras = async (dirPath, prefix) => {
		let entries = [];
		try {
			entries = await fsp.readdir(dirPath, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".csp-trash-")) continue;
			if ([".git", "node_modules"].includes(entry.name)) continue;
			const full = path.join(dirPath, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walkExtras(full, rel);
			} else if (!wanted.has(rel)) {
				const dest = path.join(trashDir, rel);
				try {
					await fsp.mkdir(path.dirname(dest), { recursive: true });
					await fsp.rename(full, dest);
					trashed++;
				} catch {}
			}
		}
	};
	await walkExtras(destDir, "");

	for (const [rel, info] of Object.entries(manifest.files || {})) {
		const src = info.from === "backup" && backupFiles ? path.join(backupFiles, rel) : path.join(filesDir, rel);
		const dest = path.join(destDir, rel);
		try {
			await fsp.mkdir(path.dirname(dest), { recursive: true });
			await fsp.copyFile(src, dest);
			written++;
			if ((await hashFile(dest)) === info.hash) verified++;
			else failed++;
		} catch {
			failed++;
		}
	}

	const largeJson = version ? readJson(path.join(dir, "backups", version, "large.json")) : readJson(path.join(dir, "large.json"));
	const pendingLarge = [];
	let largeRestored = 0;
	const isLfsPointer = (file) => {
		try {
			const buf = Buffer.alloc(128);
			const fd = fs.openSync(file, "r");
			const n = fs.readSync(fd, buf, 0, 128, 0);
			fs.closeSync(fd);
			return buf.subarray(0, n).toString("utf8").startsWith("version https://git-lfs");
		} catch {
			return false;
		}
	};
	for (const entry of (largeJson && largeJson.large) || []) {
		const src = path.join(dir, "large", entry.path);
		const dest = path.join(destDir, entry.path);
		if (!fs.existsSync(src)) {
			pendingLarge.push({ ...entry, reason: "云端缺少大文件内容" });
			continue;
		}
		if (isLfsPointer(src)) {
			pendingLarge.push({ ...entry, reason: "云端是 LFS 指针，需先执行 git lfs pull" });
			continue;
		}
		try {
			await fsp.mkdir(path.dirname(dest), { recursive: true });
			await fsp.copyFile(src, dest);
			if ((await hashFile(dest)) === entry.hash) {
				verified++;
				largeRestored++;
			} else {
				pendingLarge.push({ ...entry, reason: "内容不一致" });
			}
		} catch {
			pendingLarge.push({ ...entry, reason: "读取失败" });
		}
	}

	return {
		project: project.name,
		target: destDir,
		written,
		largeRestored,
		verified,
		failed,
		trashed,
		trashDir: trashed ? path.relative(destDir, trashDir) : null,
		pendingLarge,
		tooLong: (largeJson && largeJson.tooLong) || [],
	};
}

export function listWorkspaceVersions(repoRoot, target) {
	const project = findCloudProject(repoRoot, target);
	if (!project) return [];
	const ws = path.join(projectDir(repoRoot, project.name), "workspace");
	return listBackups(ws).map((v) => ({ ...v, project: project.name }));
}

export async function rollbackWorkspace(repoRoot, target, version) {
	const project = findCloudProject(repoRoot, target);
	if (!project) throw new Error("云端找不到该项目");
	const ws = path.join(projectDir(repoRoot, project.name), "workspace");
	const result = await rollbackEntity(ws, version);
	return { project: project.name, ...result };
}
