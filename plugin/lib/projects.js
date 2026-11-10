// 项目实体：云端 projects/<项目名>/，一个项目 = 一个工作区（含其子目录工作区）+ 会话。
//
// projects/
//   <名称>__<路径键>/
//     meta.json              { name, cwd, projectKey, title, sessions[], aliases[{cwd,scope}], createdAt, updatedAt }
//     files/                 工作区镜像（保持原始目录结构，人工可定位）
//     manifest.json          结构清单：路径 → 哈希
//     large.json / large/    大文件（git-lfs）
//     conflicts/<ts>/        合并时同路径不同内容的旧版隔离
//     sessions/<会话id>/     会话文件（session.v4.jsonl.zstd + meta.json + workspace-ref.json）
//
// 合并规则（上传时自动分析）：
//   - 若新工作区是已有项目的子目录（包含关系），按父项目视角把文件合并到对应子路径；
//   - 若新工作区包含已有项目（新工作区更大），把旧项目整体迁入新项目，旧的被移除；
//   - 同路径不同内容：保留云端旧版，新内容进 conflicts/，不静默覆盖。
// 版本历史由 git commit 承担。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { buildManifest, commitVersion, hashFile } from "./store.js";

export const PROJECTS_DIR = "projects";

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

export function projectName(cwd) {
	const base = path.basename(cwd) || "root";
	const key = projectKeyOf(cwd).replace(/^--+/, "").replace(/--+$/, "");
	return `${base}__${key}`;
}

export function projectsRoot(repoRoot) {
	return path.join(repoRoot, PROJECTS_DIR);
}

export function projectDir(repoRoot, target) {
	if (/[\\/]/.test(target) || /^[A-Za-z]:/.test(target)) return path.join(projectsRoot(repoRoot), projectName(target));
	return path.join(projectsRoot(repoRoot), target);
}

/** 兼容旧布局：项目数据可能在 <项目>/ 或 <项目>/workspace/ 下。 */
export function layoutDir(dir) {
	if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
	if (fs.existsSync(path.join(dir, "workspace", "manifest.json"))) return path.join(dir, "workspace");
	return dir;
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

function normPath(p) {
	return path.resolve(String(p || "")).replace(/[\\/]+$/, "").toLowerCase();
}

export function samePath(a, b) {
	return Boolean(a) && Boolean(b) && normPath(a) === normPath(b);
}

/** parent 是否严格包含 child。 */
export function isAncestor(parent, child) {
	if (!parent || !child) return false;
	const p = normPath(parent);
	const c = normPath(child);
	return c !== p && c.startsWith(p + path.sep);
}

/** child 相对 parent 的子路径（posix 分隔）；不相关返回 ""。 */
export function relativeSub(parent, child) {
	if (!isAncestor(parent, child)) return "";
	return path.relative(path.resolve(parent), path.resolve(child)).replace(/\\/g, "/");
}

function mergeAlias(aliases, entry) {
	const list = Array.isArray(aliases) ? aliases.slice() : [];
	const hit = list.find((item) => samePath(item.cwd, entry.cwd));
	if (hit) hit.scope = entry.scope;
	else list.push(entry);
	return list;
}

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
			aliases: [],
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

/** 列出云端所有项目（含 aliases：被合并进来的子目录工作区）。 */
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
		const layout = layoutDir(dir);
		const manifest = readJson(path.join(layout, "manifest.json")) || { files: {} };
		const large = readJson(path.join(layout, "large.json")) || { large: [] };
		let sessionCount = 0;
		try {
			sessionCount = fs.readdirSync(path.join(dir, "sessions"), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
		} catch {}
		return {
			name: entry.name,
			cwd: meta.cwd || "",
			projectKey: meta.projectKey || "",
			title: meta.title || entry.name,
			aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
			sessions: Array.isArray(meta.sessions) ? meta.sessions : [],
			hasWorkspace: fs.existsSync(path.join(layout, "manifest.json")),
			files: Object.keys(manifest.files || {}).length,
			bytes: Object.values(manifest.files || {}).reduce((s, f) => s + (f.size || 0), 0),
			large: (large.large || []).length,
			largeStored: (large.large || []).filter((x) => x.stored === "lfs").length,
			sessionCount,
			layout: path.relative(dir, layout) || "",
		};
	});
}

export function findCloudProject(repoRoot, target) {
	const name = /[\\/]/.test(target) || /^[A-Za-z]:/.test(target) ? projectName(target) : target;
	const all = listCloudProjects(repoRoot);
	return all.find((p) => p.name === name) || all.find((p) => p.cwd === target) || null;
}

/** 根据 cwd 找它应归属的云端项目（自身、子目录 alias、或父项目）。 */
export function findProjectForCwd(repoRoot, cwd) {
	const projects = listCloudProjects(repoRoot);
	for (const project of projects) {
		if (samePath(project.cwd, cwd)) return { project, scope: "" };
		for (const alias of project.aliases) {
			if (samePath(alias.cwd, cwd)) return { project, scope: alias.scope || "" };
		}
	}
	for (const project of projects) {
		if (isAncestor(project.cwd, cwd)) return { project, scope: relativeSub(project.cwd, cwd) };
	}
	return null;
}

/**
 * 上传前分析当前工作区与云端已存项目的包含关系。
 * @returns {{type:"same"|"incoming-inside-cloud"|"cloud-inside-incoming"|"new", project?:object, scope?:string, prefix?:string}}
 */
export async function analyzeUpload(repoRoot, cwd) {
	const incoming = await buildManifest(cwd);
	const incomingPaths = new Set(Object.keys(incoming.files));

	let insideCloud = null;
	let containsCloud = null;
	for (const project of listCloudProjects(repoRoot)) {
		if (!project.hasWorkspace) continue;
		const layout = layoutDir(projectDir(repoRoot, project.name));
		const manifest = readJson(path.join(layout, "manifest.json"));
		if (!manifest || !manifest.files) continue;
		const cloudPaths = new Set(Object.keys(manifest.files));

		if (samePath(project.cwd, cwd)) {
			return { type: "same", project, scope: "" };
		}
		if (isAncestor(project.cwd, cwd)) {
			const scope = relativeSub(project.cwd, cwd);
			const mapped = [...incomingPaths].map((rel) => `${scope}/${rel}`);
			if (mapped.length && mapped.every((key) => cloudPaths.has(key))) {
				if (!insideCloud || project.files > insideCloud.project.files) insideCloud = { type: "incoming-inside-cloud", project, scope };
			}
		}
		if (isAncestor(cwd, project.cwd)) {
			const prefix = relativeSub(cwd, project.cwd);
			const mapped = [...cloudPaths].map((rel) => `${prefix}/${rel}`);
			if (mapped.length && mapped.every((key) => incomingPaths.has(key))) {
				if (!containsCloud || project.files > containsCloud.project.files) containsCloud = { type: "cloud-inside-incoming", project, prefix };
			}
		}
	}
	// 按最大的工作区合并：优先把已有（较小的）项目并入当前（更大的）工作区
	if (containsCloud) return containsCloud;
	if (insideCloud) return insideCloud;
	return { type: "new" };
}

/**
 * 上传（或智能合并）工作区。返回 { projectName, scope, mergedInto?, migrated?, conflicts[] ... }
 */
export async function uploadProjectWorkspace(repoRoot, cwd, options = {}) {
	const analysis = options.analysis || (await analyzeUpload(repoRoot, cwd));

	// 1) 当前工作区是某个云端项目的子目录 → 合并到父项目对应子路径
	if (analysis.type === "incoming-inside-cloud") {
		const parentDir = layoutDir(projectDir(repoRoot, analysis.project.name));
		const result = await commitVersion(cwd, parentDir, { scopePrefix: analysis.scope, storeLarge: options.storeLarge });
		const meta = ensureProject(repoRoot, analysis.project.cwd);
		meta.aliases = mergeAlias(meta.aliases, { cwd, scope: analysis.scope });
		meta.workspace = { files: result.files, changed: result.changed, added: result.added, removed: result.removed };
		saveProjectMeta(repoRoot, meta);
		return { meta, projectName: analysis.project.name, scope: analysis.scope, mergedInto: analysis.project.name, ...result };
	}

	// 2) 当前工作区包含云端已有项目 → 旧项目整体迁入新项目（新项目是最大的工作区）
	if (analysis.type === "cloud-inside-incoming") {
		const meta = ensureProject(repoRoot, cwd);
		const parentDir = layoutDir(projectDir(repoRoot, meta.name));
		const migration = await migrateInto(repoRoot, analysis.project, meta, analysis.prefix, parentDir);
		const result = await commitVersion(cwd, parentDir, { storeLarge: options.storeLarge, mode: "union" });
		meta.aliases = mergeAlias(meta.aliases, { cwd: analysis.project.cwd, scope: analysis.prefix });
		for (const alias of migration.aliases || []) meta.aliases = mergeAlias(meta.aliases, alias);
		meta.sessions = [...new Set([...(meta.sessions || []), ...migration.sessions])];
		meta.workspace = { files: result.files, changed: result.changed, added: result.added, removed: result.removed };
		saveProjectMeta(repoRoot, meta);
		try {
			fs.rmSync(projectDir(repoRoot, analysis.project.name), { recursive: true, force: true });
		} catch {}
		return { meta, projectName: meta.name, scope: "", migrated: analysis.project.name, migration, ...result };
	}

	// 3) 同一项目或全新项目
	const meta = ensureProject(repoRoot, cwd);
	const dir = layoutDir(projectDir(repoRoot, meta.name));
	const result = await commitVersion(cwd, dir, { storeLarge: options.storeLarge });
	meta.workspace = { files: result.files, changed: result.changed, added: result.added, removed: result.removed };
	saveProjectMeta(repoRoot, meta);
	return { meta, projectName: meta.name, scope: "", analysisType: analysis.type, ...result };
}

/** 把一个较小子项目迁移进父项目（文件加 prefix，会话一起搬），返回统计。 */
async function migrateInto(repoRoot, childProject, parentMeta, prefix, parentDir) {
	const childDir = projectDir(repoRoot, childProject.name);
	const childLayout = layoutDir(childDir);
	const childManifest = readJson(path.join(childLayout, "manifest.json")) || { files: {}, large: [], tooLong: [] };
	const parentManifest = readJson(path.join(parentDir, "manifest.json")) || { files: {}, large: [], tooLong: [] };
	const p = String(prefix || "").replace(/^\/+|\/+$/g, "");
	const mapped = (rel) => (p ? `${p}/${rel}` : rel);
	const childAliases = Array.isArray(childProject.aliases) ? childProject.aliases : [];
	const scopeForCwd = (cwd) => {
		if (!cwd) return p;
		if (samePath(cwd, childProject.cwd)) return p;
		const hit = childAliases.find((alias) => samePath(alias.cwd, cwd));
		if (!hit) return p;
		const sub = String(hit.scope || "").replace(/^\/+|\/+$/g, "");
		return p ? (sub ? `${p}/${sub}` : p) : sub;
	};
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

	const nextFiles = { ...(parentManifest.files || {}) };
	let migrated = 0;
	let conflicts = 0;
	fs.mkdirSync(path.join(parentDir, "files"), { recursive: true });
	for (const [rel, info] of Object.entries(childManifest.files || {})) {
		const key = mapped(rel);
		const before = nextFiles[key];
		const src = path.join(childLayout, "files", rel);
		if (before && before.hash === info.hash) continue;
		if (before && before.hash !== info.hash) {
			const dest = path.join(parentDir, "conflicts", stamp, key);
			try {
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				await fsp.copyFile(src, dest);
				conflicts++;
			} catch {}
			continue;
		}
		try {
			const dest = path.join(parentDir, "files", key);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			await fsp.copyFile(src, dest);
			nextFiles[key] = info;
			migrated++;
		} catch {}
	}
	// 大文件
	const nextLarge = [...(parentManifest.large || [])];
	for (const entry of childManifest.large || []) {
		const key = mapped(entry.path);
		try {
			const src = path.join(childLayout, "large", entry.path);
			const dest = path.join(parentDir, "large", key);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			await fsp.copyFile(src, dest);
			nextLarge.push({ ...entry, path: key });
		} catch {}
	}
	writeJson(path.join(parentDir, "manifest.json"), { createdAt: new Date().toISOString(), files: nextFiles, large: nextLarge, tooLong: [...(parentManifest.tooLong || [])] });
	writeJson(path.join(parentDir, "large.json"), { createdAt: new Date().toISOString(), large: nextLarge, tooLong: [] });

	// 会话迁移
	const sessions = [];
	const childSessions = path.join(childDir, "sessions");
	if (fs.existsSync(childSessions)) {
		for (const entry of fs.readdirSync(childSessions, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const src = path.join(childSessions, entry.name);
			const dest = path.join(parentDir, "sessions", entry.name);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			await fsp.cp(src, dest, { recursive: true, force: true });
			const sessionMetaPath = path.join(dest, "meta.json");
			const sessionMeta = readJson(sessionMetaPath);
			let sourceCwd = "";
			if (sessionMeta) {
				sourceCwd = sessionMeta.cwd || "";
				sessionMeta.project = parentMeta.name;
				writeJson(sessionMetaPath, sessionMeta);
			}
			const refPath = path.join(dest, "workspace-ref.json");
			const ref = readJson(refPath);
			if (ref) {
				ref.project = parentMeta.name;
				ref.scope = scopeForCwd(sourceCwd);
				writeJson(refPath, ref);
			}
			sessions.push(entry.name);
		}
	}
	const aliases = [
		{ cwd: childProject.cwd, scope: p },
		...childAliases.map((alias) => ({ cwd: alias.cwd, scope: scopeForCwd(alias.cwd) })),
	];
	return { migrated, conflicts, sessions, aliases };
}

/** 下载项目工作区：镜像到目标目录，多余文件进 .csp-trash-<ts>/。 */
export async function downloadProjectWorkspace(repoRoot, target, destDir) {
	const project = findCloudProject(repoRoot, target);
	if (!project) throw new Error(`云端没有项目 ${target}`);
	const dir = layoutDir(projectDir(repoRoot, project.name));
	const manifest = readJson(path.join(dir, "manifest.json"));
	if (!manifest) throw new Error("该项目没有上传工作区");

	const filesDir = path.join(dir, "files");
	const wanted = new Set(Object.keys(manifest.files || {}));

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
		const src = path.join(filesDir, rel);
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

	const largeJson = readJson(path.join(dir, "large.json"));
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
