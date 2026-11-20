// 上传合并引擎：分析工作区与云端项目的包含关系，按最大工作区合并
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { ensureDir, readJson, timestamp, writeJsonAtomic } from "../shared.js";
import { buildManifest, readManifest } from "./manifest.js";
import { commitWorkspace } from "./mirror.js";
import {
	isAncestor,
	layoutDir,
	projectDir,
	relativeSub,
	samePath,
	storeFilesDir,
	storeLargeDir,
} from "./layout.js";
import { ensureProject, listProjects, mergeAlias, saveProjectMeta } from "./project.js";

/**
 * 分析 cwd 与仓库内已有项目的包含关系。
 * @returns {{type:"same"|"incoming-inside-cloud"|"cloud-inside-incoming"|"new", project?:object, scope?:string, prefix?:string}}
 */
export async function analyzeUpload(repoRoot, cwd) {
	const incoming = await buildManifest(cwd);
	const incomingPaths = new Set(Object.keys(incoming.files));

	let insideCloud = null;
	let containsCloud = null;
	for (const project of listProjects(repoRoot)) {
		if (!project.hasWorkspace) continue;
		const manifest = readManifest(project.layoutDir);
		const cloudPaths = new Set(Object.keys(manifest.files));

		if (samePath(project.cwd, cwd)) return { type: "same", project, scope: "" };

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
	if (containsCloud) return containsCloud;
	if (insideCloud) return insideCloud;
	return { type: "new" };
}

function ensureStore(repoRoot, name) {
	const files = ensureDir(storeFilesDir(repoRoot, name));
	const large = ensureDir(storeLargeDir(repoRoot, name));
	return { files, large };
}

/**
 * 上传（必要时合并）工作区。返回 {projectName, scope, mergedInto?, migrated?, conflicts, files, added, changed, removed, ...}
 */
export async function uploadWorkspace(repoRoot, cwd, options = {}) {
	const analysis = options.analysis || (await analyzeUpload(repoRoot, cwd));

	// 1) 当前工作区是云端项目的子目录 → 合并到父项目对应子路径
	if (analysis.type === "incoming-inside-cloud") {
		const parentDir = projectDir(repoRoot, analysis.project.name);
		const store = ensureStore(repoRoot, analysis.project.name);
		const result = await commitWorkspace(cwd, parentDir, {
			scopePrefix: analysis.scope,
			storeLarge: options.storeLarge,
			filesRoot: store.files,
			largeRoot: store.large,
		});
		const meta = ensureProject(repoRoot, analysis.project.cwd);
		meta.aliases = mergeAlias(meta.aliases, { cwd, scope: analysis.scope });
		meta.workspace = { files: result.files, changed: result.changed, added: result.added, removed: result.removed };
		saveProjectMeta(repoRoot, meta);
		return { ...result, meta, projectName: analysis.project.name, scope: analysis.scope, mergedInto: analysis.project.name };
	}

	// 2) 当前工作区包含云端已有项目 → 旧项目整体迁入新项目（新项目是最大工作区）
	if (analysis.type === "cloud-inside-incoming") {
		const meta = ensureProject(repoRoot, cwd);
		const parentDir = projectDir(repoRoot, meta.name);
		const store = ensureStore(repoRoot, meta.name);
		const migration = await migrateInto(repoRoot, analysis.project, meta, analysis.prefix, parentDir, store.files, store.large);
		const result = await commitWorkspace(cwd, parentDir, {
			storeLarge: options.storeLarge,
			mode: "union",
			filesRoot: store.files,
			largeRoot: store.large,
		});
		meta.aliases = mergeAlias(meta.aliases, { cwd: analysis.project.cwd, scope: analysis.prefix });
		for (const alias of migration.aliases) meta.aliases = mergeAlias(meta.aliases, alias);
		meta.sessions = [...new Set([...(meta.sessions || []), ...migration.sessions])];
		meta.workspace = { files: result.files, changed: result.changed, added: result.added, removed: result.removed };
		saveProjectMeta(repoRoot, meta);
		try {
			fs.rmSync(projectDir(repoRoot, analysis.project.name), { recursive: true, force: true });
		} catch {}
		return { ...result, meta, projectName: meta.name, scope: "", migrated: analysis.project.name, migration };
	}

	// 3) 同一项目或全新项目
	const meta = ensureProject(repoRoot, cwd);
	const dir = projectDir(repoRoot, meta.name);
	const store = ensureStore(repoRoot, meta.name);
	const result = await commitWorkspace(cwd, dir, {
		storeLarge: options.storeLarge,
		filesRoot: store.files,
		largeRoot: store.large,
	});
	meta.workspace = { files: result.files, changed: result.changed, added: result.added, removed: result.removed };
	saveProjectMeta(repoRoot, meta);
	return { ...result, meta, projectName: meta.name, scope: "" };
}

/** 把较小子项目迁入父项目（文件加前缀、会话一起搬、aliases 重算） */
async function migrateInto(repoRoot, childProject, parentMeta, prefix, parentDir, parentStore, parentLarge) {
	const childDir = projectDir(repoRoot, childProject.name);
	const childStore = childProject.storeFiles;
	const childLarge = childProject.storeLarge;
	const childManifest = readJson(path.join(childProject.layoutDir, "manifest.json")) || { files: {}, large: [], tooLong: [] };
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

	const nextFiles = { ...(parentManifest.files || {}) };
	let migrated = 0;
	let conflicts = 0;
	ensureDir(parentStore);
	for (const [rel, info] of Object.entries(childManifest.files || {})) {
		const key = mapped(rel);
		const before = nextFiles[key];
		const src = path.join(childStore, rel);
		if (before && before.hash === info.hash) continue;
		if (before && before.hash !== info.hash) {
			try {
				const dest = path.join(parentDir, "conflicts", timestamp(), key);
				ensureDir(path.dirname(dest));
				await fsp.copyFile(src, dest);
				conflicts++;
			} catch {}
			continue;
		}
		try {
			const dest = path.join(parentStore, key);
			ensureDir(path.dirname(dest));
			await fsp.copyFile(src, dest);
			nextFiles[key] = info;
			migrated++;
		} catch {}
	}

	const nextLarge = [...(parentManifest.large || [])];
	for (const entry of childManifest.large || []) {
		const key = mapped(entry.path);
		try {
			const src = path.join(childLarge, entry.path);
			const dest = path.join(parentLarge, key);
			ensureDir(path.dirname(dest));
			await fsp.copyFile(src, dest);
			nextLarge.push({ ...entry, path: key });
		} catch {}
	}

	writeJsonAtomic(path.join(parentDir, "manifest.json"), {
		schema: 1,
		createdAt: new Date().toISOString(),
		files: nextFiles,
		large: nextLarge,
		tooLong: [...(parentManifest.tooLong || [])],
	});
	writeJsonAtomic(path.join(parentDir, "large.json"), {
		schema: 1,
		createdAt: new Date().toISOString(),
		large: nextLarge,
		tooLong: [],
	});

	// 会话迁移（目录 + meta + workspace-ref 的 project/scope 更新）
	const sessions = [];
	const childSessions = path.join(childDir, "sessions");
	if (fs.existsSync(childSessions)) {
		for (const entry of fs.readdirSync(childSessions, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const src = path.join(childSessions, entry.name);
			const dest = path.join(parentDir, "sessions", entry.name);
			ensureDir(path.dirname(dest));
			await fsp.cp(src, dest, { recursive: true, force: true });
			const metaPath = path.join(dest, "meta.json");
			const sessionMeta = readJson(metaPath);
			let sourceCwd = "";
			if (sessionMeta) {
				sourceCwd = sessionMeta.cwd || "";
				sessionMeta.project = parentMeta.name;
				writeJsonAtomic(metaPath, sessionMeta);
			}
			const refPath = path.join(dest, "workspace-ref.json");
			const ref = readJson(refPath);
			if (ref) {
				ref.project = parentMeta.name;
				ref.scope = scopeForCwd(sourceCwd);
				writeJsonAtomic(refPath, ref);
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
