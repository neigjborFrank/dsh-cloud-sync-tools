// 多说仓库登记：%DSH_HOME%\cloud-sync\repos.json
//
// 设计：
//   - 每个登记项 = 一个私有仓库的本地克隆（path）+ 仓库地址（url）+ 名称；
//   - 只有登记了同一仓库地址的设备才能互相同步（地址即同步命名空间）；
//   - 多个仓库在逻辑上视为同一个云端：视图合并、上传时选择目标仓库；
//   - 未登记时自动把当前插件所在仓库（origin 地址 + 路径）登记为第一个仓库。
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GIT_CANDIDATES = ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files (x86)\\Git\\cmd\\git.exe"];

function findGit() {
	for (const candidate of GIT_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
	return "git";
}

const GIT = findGit();

export function dshHome() {
	return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function reposFile() {
	return path.join(dshHome(), "cloud-sync", "repos.json");
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

export function runGit(cwd, args, timeout = 120000) {
	return new Promise((resolve) => {
		execFile(GIT, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
			resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: stdout || "", err: stderr || "" });
		});
	});
}

/** 读取某仓库目录的 origin 地址（没有则返回空串）。 */
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
	return String(value || "repo")
		.replace(/^.*[\\/:]/, "")
		.replace(/\.git$/i, "")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40) || "repo";
}

/** 读取登记表；不存在返回 null。 */
export function readRegistry() {
	const json = readJson(reposFile());
	if (!json || !Array.isArray(json.repos)) return null;
	return json;
}

export function saveRegistry(registry) {
	writeJson(reposFile(), registry);
	return registry;
}

/** 列出仓库（附 ok 标记：本地克隆是否存在）。 */
export function listRepos() {
	const registry = readRegistry();
	if (!registry) return [];
	return registry.repos.map((repo) => ({ ...repo, ok: Boolean(repo.path && fs.existsSync(path.join(repo.path, ".git"))) }));
}

export function findRepo(id) {
	return listRepos().find((repo) => repo.id === id) || null;
}

export function defaultRepo() {
	const repos = listRepos();
	return repos[0] || null;
}

/**
 * 确保登记表文件存在。**不会自动登记任何仓库**：
 * 工具所在仓库不一定是使用者的同步仓库，自动登记会把使用者带到分发者的私人仓库。
 * 使用者必须通过「仓库管理…」显式登记自己的私有仓库。
 */
export function ensureRegistryFile() {
	const existing = readRegistry();
	if (existing && Array.isArray(existing.repos)) return existing;
	const registry = { version: 1, repos: [] };
	saveRegistry(registry);
	return registry;
}

/**
 * 显式登记当前仓库（仅在使用者主动触发时调用：仓库管理界面 / 安装器 -RegisterRepo）。
 * @param {string} repoRoot 仓库根目录
 * @param {{name?: string}} options
 */
export async function registerCurrentRepo(repoRoot, options = {}) {
	const registry = ensureRegistryFile();
	const existing = registry.repos.find((repo) => path.resolve(repo.path) === path.resolve(repoRoot));
	if (existing) return existing;
	const url = await originUrl(repoRoot);
	const record = {
		id: newId(),
		name: String(options.name || "").trim() || "主仓库",
		url,
		path: repoRoot,
		branch: "main",
		addedAt: new Date().toISOString(),
	};
	registry.repos.push(record);
	saveRegistry(registry);
	return record;
}

/**
 * 登记一个仓库：默认从 url 克隆到 %DSH_HOME%\cloud-sync\repos\<slug>。
 * 同一个 url 不允许重复登记。
 */
export async function addRepo({ url, name, path: existingPath, branch = "main" }) {
	const registry = readRegistry() || { version: 1, repos: [] };
	const cleanUrl = String(url || "").trim();
	const cleanPath = String(existingPath || "").trim();

	if (cleanUrl && registry.repos.some((repo) => String(repo.url || "").toLowerCase() === cleanUrl.toLowerCase())) {
		throw new Error("该仓库地址已登记");
	}
	if (cleanPath && registry.repos.some((repo) => path.resolve(repo.path) === path.resolve(cleanPath))) {
		throw new Error("该本地路径已登记");
	}
	if (!cleanUrl && !cleanPath) throw new Error("需要提供仓库地址或本地路径");

	let repoPath = cleanPath;
	let repoUrl = cleanUrl;

	if (!repoPath) {
		repoPath = path.join(dshHome(), "cloud-sync", "repos", slugify(cleanUrl));
		if (!fs.existsSync(path.join(repoPath, ".git"))) {
			fs.mkdirSync(path.dirname(repoPath), { recursive: true });
			const clone = await runGit(path.dirname(repoPath), ["clone", cleanUrl, repoPath], 600000);
			if (clone.code !== 0) throw new Error("克隆失败：" + (clone.err || clone.out).trim());
		}
	} else if (!fs.existsSync(path.join(repoPath, ".git"))) {
		throw new Error("本地路径不是 git 仓库：" + repoPath);
	}

	// 统一到 main 分支，避免空仓库克隆后处于 master/未出生分支导致 push 失败
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
	saveRegistry(registry);
	return record;
}

/** 取消登记（不删除本地克隆目录）。 */
export function removeRepo(id) {
	const registry = readRegistry();
	if (!registry) throw new Error("还没有登记任何仓库");
	const before = registry.repos.length;
	registry.repos = registry.repos.filter((repo) => repo.id !== id);
	if (!registry.repos.length) throw new Error("至少保留一个仓库");
	if (registry.repos.length === before) throw new Error("找不到该仓库");
	saveRegistry(registry);
	return registry;
}

/** 仓库列表（给 API 输出，隐藏内部字段）。 */
export function publicRepos() {
	return listRepos().map((repo) => ({
		id: repo.id,
		name: repo.name,
		url: repo.url,
		path: repo.path,
		ok: repo.ok,
	}));
}
