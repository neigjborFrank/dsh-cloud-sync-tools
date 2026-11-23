// 多仓库登记与绑定：%DSH_HOME%\cloud-sync\repos.json（schema=2）
// 不自动登记任何仓库；同一 URL 只能登记一次。
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppError, SCHEMA, readJson, writeJsonAtomic } from "../shared.js";

const GIT_CANDIDATES = ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files (x86)\\Git\\cmd\\git.exe"];

function findGit() {
	for (const candidate of GIT_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
	return "git";
}

const GIT = findGit();

export function dshHome() {
	return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function reposPath() {
	return path.join(dshHome(), "cloud-sync", "repos.json");
}

export function runGit(cwd, args, timeout = 120000) {
	return new Promise((resolve) => {
		execFile(GIT, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
			resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: stdout || "", err: stderr || "" });
		});
	});
}

export async function originUrl(repoPath) {
	try {
		const result = await runGit(repoPath, ["config", "--get", "remote.origin.url"], 15000);
		return result.code === 0 ? result.out.trim() : "";
	} catch {
		return "";
	}
}

function newId() {
	return "repo-" + randomBytes(4).toString("hex");
}

function slugify(value) {
	return (
		String(value || "repo")
			.replace(/^.*[\\/:]/, "")
			.replace(/\.git$/i, "")
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "repo"
	);
}

export function readRegistry(file = reposPath()) {
	const json = readJson(file);
	if (!json || !Array.isArray(json.repos)) return null;
	return json;
}

function save(registry, file) {
	writeJsonAtomic(file, registry);
	return registry;
}

/** 确保登记表存在（空表，不登记任何仓库） */
export function ensureRegistryFile(file = reposPath()) {
	const existing = readRegistry(file);
	if (existing) return existing;
	return save({ schema: SCHEMA.repos, repos: [], bindings: {} }, file);
}

export function listRepos(file = reposPath()) {
	const registry = readRegistry(file);
	if (!registry) return [];
	return registry.repos.map((repo) => ({ ...repo, ok: Boolean(repo.path && fs.existsSync(path.join(repo.path, ".git"))) }));
}

export function findRepo(id, file = reposPath()) {
	return listRepos(file).find((repo) => repo.id === id) || null;
}

export function defaultRepo(file = reposPath()) {
	return listRepos(file)[0] || null;
}

export function listBindings(file = reposPath()) {
	return readRegistry(file)?.bindings || {};
}

export function getBinding(projectNameValue, file = reposPath()) {
	return listBindings(file)[projectNameValue] || "";
}

export function setBinding(projectNameValue, repoId, file = reposPath()) {
	if (!projectNameValue || !repoId) return null;
	const registry = ensureRegistryFile(file);
	registry.bindings = registry.bindings || {};
	registry.bindings[projectNameValue] = repoId;
	return save(registry, file);
}

export function publicRepos(file = reposPath()) {
	return listRepos(file).map((repo) => ({ id: repo.id, name: repo.name, url: repo.url, path: repo.path, ok: repo.ok }));
}

/**
 * 登记一个仓库。
 * - 给了 path：直接登记本机已有 git 仓库；
 * - 只给 url：克隆到 %DSH_HOME%\cloud-sync\repos\<slug> 后登记。
 */
export async function addRepo({ url, name, path: existingPath, branch = "main" }, file = reposPath()) {
	const registry = ensureRegistryFile(file);
	const cleanUrl = String(url || "").trim();
	const cleanPath = String(existingPath || "").trim();

	if (cleanUrl && registry.repos.some((repo) => String(repo.url || "").toLowerCase() === cleanUrl.toLowerCase())) {
		throw new AppError("duplicate-repo", "该仓库地址已登记");
	}
	if (cleanPath && registry.repos.some((repo) => path.resolve(repo.path) === path.resolve(cleanPath))) {
		throw new AppError("duplicate-repo", "该本地路径已登记");
	}
	if (!cleanUrl && !cleanPath) throw new AppError("bad-request", "需要提供仓库地址或本地路径");

	let repoPath = cleanPath;
	let repoUrl = cleanUrl;

	if (!repoPath) {
		repoPath = path.join(dshHome(), "cloud-sync", "repos", slugify(cleanUrl));
		if (!fs.existsSync(path.join(repoPath, ".git"))) {
			fs.mkdirSync(path.dirname(repoPath), { recursive: true });
			// -c core.longpaths=true：数据仓库可能包含 Windows 长路径，否则 checkout 会失败
			const clone = await runGit(path.dirname(repoPath), ["-c", "core.longpaths=true", "clone", cleanUrl, repoPath], 600000);
			if (clone.code !== 0) throw new AppError("clone-failed", "克隆失败：" + (clone.err || clone.out).trim());
		}
		await runGit(repoPath, ["config", "core.longpaths", "true"], 15000);
	} else if (!fs.existsSync(path.join(repoPath, ".git"))) {
		throw new AppError("not-a-repo", "本地路径不是 git 仓库：" + repoPath);
	}

	// 统一到 main 分支，避免空仓库克隆后处于未出生分支导致 push 失败
	try {
		const head = await runGit(repoPath, ["symbolic-ref", "--short", "HEAD"], 15000);
		if (head.code === 0 && head.out.trim() && head.out.trim() !== "main") {
			await runGit(repoPath, ["checkout", "-B", "main"], 30000);
		}
	} catch {}

	if (!repoUrl) repoUrl = await originUrl(repoPath);

	const record = {
		id: newId(),
		name: String(name || "").trim() || slugify(repoUrl || repoPath),
		url: repoUrl,
		path: repoPath,
		branch,
		addedAt: new Date().toISOString(),
	};
	registry.repos.push(record);
	registry.bindings = registry.bindings || {};
	save(registry, file);
	return record;
}

/** 取消登记（不删除本地克隆），同时清理指向它的绑定；允许移除最后一个仓库（空注册表合法） */
export function removeRepo(id, file = reposPath()) {
	const registry = readRegistry(file);
	if (!registry) throw new AppError("no-registry", "还没有登记任何仓库");
	const before = registry.repos.length;
	registry.repos = registry.repos.filter((repo) => repo.id !== id);
	if (registry.repos.length === before) throw new AppError("not-found-repo", "找不到该仓库");
	for (const [projectNameValue, bound] of Object.entries(registry.bindings || {})) {
		if (bound === id) delete registry.bindings[projectNameValue];
	}
	save(registry, file);
	return registry;
}
