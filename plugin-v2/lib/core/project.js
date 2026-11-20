// 项目（工作区）实体的读取与元数据维护
import fs from "node:fs";
import path from "node:path";

import { SCHEMA, readJson, writeJsonAtomic } from "../shared.js";
import {
	indexProjectsRoot,
	isAncestor,
	layoutDir,
	legacyProjectsRoot,
	projectDir,
	projectKeyOf,
	projectName,
	readFilesDir,
	readLargeDir,
	relativeSub,
	samePath,
} from "./layout.js";

function newMeta(cwd, name) {
	const now = new Date().toISOString();
	return {
		schema: SCHEMA.meta,
		name,
		cwd,
		projectKey: projectKeyOf(cwd),
		title: path.basename(cwd) || "root",
		aliases: [],
		sessions: [],
		createdAt: now,
		updatedAt: now,
	};
}

/** 确保项目目录与 meta 存在（只创建空项目，不写内容） */
export function ensureProject(repoRoot, cwd) {
	const name = projectName(cwd);
	const dir = projectDir(repoRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	const metaPath = path.join(dir, "meta.json");
	let meta = readJson(metaPath);
	if (!meta) {
		meta = newMeta(cwd, name);
		writeJsonAtomic(metaPath, meta);
	}
	return meta;
}

export function saveProjectMeta(repoRoot, meta) {
	const file = path.join(projectDir(repoRoot, meta.name), "meta.json");
	meta.updatedAt = new Date().toISOString();
	writeJsonAtomic(file, meta);
	return meta;
}

/** 合并 aliases（cwd → scope） */
export function mergeAlias(aliases, entry) {
	const list = Array.isArray(aliases) ? aliases.slice() : [];
	const hit = list.find((item) => String(item.cwd || "").toLowerCase() === String(entry.cwd || "").toLowerCase());
	if (hit) hit.scope = entry.scope;
	else list.push(entry);
	return list;
}

/**
 * 列出仓库内所有项目（v2 index 优先，v1 projects 只读兼容）。
 * @returns {Array<{name,cwd,projectKey,title,aliases,sessions,files,bytes,large,sessionCount,hasWorkspace,dir,layoutDir,storeFiles,storeLarge}>}
 */
export function listProjects(repoRoot) {
	let root = indexProjectsRoot(repoRoot);
	if (!fs.existsSync(root)) root = legacyProjectsRoot(repoRoot);
	let entries = [];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
	} catch {
		return [];
	}

	return entries.map((entry) => {
		const dir = path.join(root, entry.name);
		const meta = readJson(path.join(dir, "meta.json")) || { name: entry.name, aliases: [], sessions: [] };
		const layout = layoutDir(dir);
		const manifest = readJson(path.join(layout, "manifest.json")) || { files: {}, large: [] };
		const largeJson = readJson(path.join(layout, "large.json")) || { large: manifest.large || [] };
		const files = Object.keys(manifest.files || {});
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
			hasWorkspace: files.length > 0,
			files: files.length,
			bytes: Object.values(manifest.files || {}).reduce((sum, file) => sum + (file.size || 0), 0),
			large: (largeJson.large || []).length,
			sessionCount,
			dir,
			layoutDir: layout,
			storeFiles: readFilesDir(repoRoot, entry.name, dir),
			storeLarge: readLargeDir(repoRoot, entry.name, dir),
		};
	});
}

/** 按项目名或 cwd 查找项目 */
export function findProject(repoRoot, target) {
	const name = /[\\/]/.test(String(target)) || /^[A-Za-z]:/.test(String(target)) ? projectName(target) : String(target);
	const projects = listProjects(repoRoot);
	return projects.find((project) => project.name === name) || projects.find((project) => project.cwd === target) || null;
}

/** 按 cwd 找到它归属的项目（自身 / 子目录 alias / 父项目） */
export function findProjectForCwd(repoRoot, cwd) {
	const projects = listProjects(repoRoot);
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
