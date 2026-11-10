/**
 * Host half of `dsh-plugin-cloud-sync-panel` (v0.5.0)
 *
 * 在 DSH 宿主进程内直接提供同步 API（不启动任何子进程）：
 *   - 随 DSH 启动而监听 127.0.0.1:<port>，随 DSH 退出而关闭；
 *   - 全部字符串以 UTF-8 处理，避免子进程控制台编码导致的乱码；
 *   - 没有子进程，因此不可能弹出 cmd 窗口。
 *
 * 所有 git 操作通过 execFile 调用本机 git.exe，工作目录取 config.workspace。
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import {
	defaultWorkspaceBase,
	downloadSession,
	findSessionDir,
	installDirOf,
	isInInstallDir,
	listCloudSessions,
	listSessions,
	uploadSession,
} from "./lib/archive.js";
import { repairRegistry, registerWorkspace, validateRegistry } from "./lib/registry.js";
import { addRepo, defaultRepo, ensureRegistryFile, findRepo, listRepos, publicRepos, removeRepo, runGit } from "./lib/repos.js";
import {
	downloadProjectWorkspace,
	findCloudProject,
	listCloudProjects,
	projectName,
	uploadProjectWorkspace,
} from "./lib/projects.js";
import { buildManifest } from "./lib/store.js";

export const name = "cloud-sync-panel";

const GIT_CANDIDATES = [
	"C:\\Program Files\\Git\\cmd\\git.exe",
	"C:\\Program Files (x86)\\Git\\cmd\\git.exe",
];

const TOKEN = randomBytes(18).toString("base64url");

function findGit() {
	for (const candidate of GIT_CANDIDATES) if (existsSync(candidate)) return candidate;
	return "git";
}

const GIT = findGit();

/** 执行 git，返回 { code, out, err }；不抛异常。 */
function git(cwd, args, timeout = 120000) {
	return new Promise((resolve) => {
		execFile(
			GIT,
			args,
			{ cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				resolve({
					code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
					out: stdout || "",
					err: stderr || "",
				});
			},
		);
	});
}

/** 本地与云端的关系状态（只读）。 */
async function readState(cwd) {
	const upstream = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	const dirtyRaw = await git(cwd, ["status", "--porcelain"]);
	const dirtyFiles = dirtyRaw.out.split("\n").map((s) => s.trimEnd()).filter(Boolean);

	const localHead = (await git(cwd, ["rev-parse", "--short", "HEAD"])).out.trim();
	const localTime = (await git(cwd, ["log", "-1", "--format=%ci"])).out.trim();

	if (upstream.code !== 0) {
		return {
			state: "unbound",
			message: "未绑定云端仓库",
			dirty: dirtyFiles.length,
			dirty_files: dirtyFiles.slice(0, 20),
			local_head: localHead,
			local_time: localTime,
		};
	}
	const up = upstream.out.trim();

	const fetched = await git(cwd, ["fetch", "origin", "--prune"], 60000);
	if (fetched.code !== 0) {
		return { state: "offline", message: "无法连接云端（fetch 失败）", dirty: dirtyFiles.length };
	}

	let ahead = 0;
	let behind = 0;
	const counts = await git(cwd, ["rev-list", "--left-right", "--count", `HEAD...${up}`]);
	if (counts.code === 0) {
		const [a, b] = counts.out.trim().split(/\s+/);
		ahead = Number(a) || 0;
		behind = Number(b) || 0;
	}

	let state;
	let message;
	if (ahead === 0 && behind === 0) {
		state = dirtyFiles.length ? "dirty" : "in-sync";
		message = dirtyFiles.length ? "有未提交改动" : "与云端一致";
	} else if (behind && !ahead) {
		state = "behind";
		message = `落后云端 ${behind} 个提交`;
	} else if (ahead && !behind) {
		state = "ahead";
		message = `本地领先云端 ${ahead} 个提交`;
	} else {
		state = "diverged";
		message = `已分叉（本地 ${ahead} / 云端 ${behind}）`;
	}

	return {
		state,
		message,
		ahead,
		behind,
		dirty: dirtyFiles.length,
		dirty_files: dirtyFiles.slice(0, 20),
		local_head: localHead,
		local_time: localTime,
		cloud_head: (await git(cwd, ["rev-parse", "--short", up])).out.trim(),
		cloud_time: (await git(cwd, ["log", "-1", "--format=%ci", up])).out.trim(),
		branch: up,
	};
}

/** 归档路径可能超过 Windows 260 字符，仓库级开启长路径支持（幂等）。 */
const longPathRepos = new Set();
async function ensureLongPaths(cwd) {
	if (!cwd || longPathRepos.has(cwd)) return;
	await git(cwd, ["config", "core.longpaths", "true"]);
	longPathRepos.add(cwd);
}

function sendJson(response, obj, code = 200) {	const body = JSON.stringify(obj);
	response.writeHead(code, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
	});
	response.end(body);
}

function readBody(request) {
	return new Promise((resolve) => {
		let raw = "";
		request.on("data", (chunk) => (raw += chunk));
		request.on("end", () => {
			try {
				resolve(raw ? JSON.parse(raw) : {});
			} catch {
				resolve({});
			}
		});
	});
}

async function doDownload(cwd, stash) {
	const before = await readState(cwd);
	if (before.state === "diverged") return { ok: false, output: "本地与云端已分叉，需人工处理" };
	if (before.state === "unbound") return { ok: false, output: "未绑定云端仓库" };

	let stashed = false;
	if (before.dirty > 0) {
		if (!stash) return { ok: false, output: `本地有 ${before.dirty} 个未提交改动，请先上传或允许暂存` };
		const st = await git(cwd, ["stash", "push", "-u", "-m", "cloud-sync auto stash"]);
		if (st.code !== 0) return { ok: false, output: `暂存失败：${st.err.trim()}` };
		stashed = true;
	}

	const pull = await git(cwd, ["pull", "--rebase", "origin", "main"], 180000);
	let output = pull.out || pull.err;
	if (stashed) {
		const pop = await git(cwd, ["stash", "pop"]);
		if (pop.code !== 0) output += "\n注意：暂存恢复有冲突，请手动处理";
	}
	return { ok: pull.code === 0, output: output.trim() || "已从云端下载" };
}

async function doUpload(cwd, message) {
	const before = await readState(cwd);
	if (before.state === "diverged") return { ok: false, output: "本地与云端已分叉，需人工处理" };

	await git(cwd, ["add", "-A"]);
	const status = await git(cwd, ["status", "--porcelain"]);
	let output = "";
	if (status.out.trim()) {
		const msg = message || "sync: 更新工作区";
		const commit = await git(cwd, ["commit", "-m", msg]);
		if (commit.code !== 0) return { ok: false, output: `提交失败：${commit.err.trim()}` };
		output += `已提交：${msg}\n`;
	} else {
		output += "无新改动\n";
	}

	const push = await git(cwd, ["push", "-u", "origin", "main"], 180000);
	output += (push.out || push.err || "已上传").trim();
	return { ok: push.code === 0, output };
}

/** 计算本地文件 sha256（读失败返回 null）。 */
function hashFileSha256(file) {
	return new Promise((resolve) => {
		try {
			const hash = createHash("sha256");
			const stream = fs.createReadStream(file);
			stream.on("data", (chunk) => hash.update(chunk));
			stream.on("error", () => resolve(null));
			stream.on("end", () => resolve(hash.digest("hex")));
		} catch {
			resolve(null);
		}
	});
}

/**
 * 云端与同步情况视图：按「项目（工作区）→ 会话」层级组织，只展示名称与同步状态。
 * 只读，不修改本地或云端任何状态。
 */
async function buildRepoView(repo) {
	const repoRoot = repo.path;
	const localSessions = listSessions();
	const cloudSessions = listCloudSessions(repoRoot);
	const cloudProjects = listCloudProjects(repoRoot);

	const localByName = new Map();
	for (const session of localSessions) {
		if (!session.cwd) continue;
		const name = projectName(session.cwd);
		if (!localByName.has(name)) localByName.set(name, { cwd: session.cwd, sessions: [] });
		localByName.get(name).sessions.push(session);
	}

	const cloudByName = new Map(cloudProjects.map((project) => [project.name, project]));

	// 仅本地、且位于 DSH 安装目录内的工作区不参与同步（安装目录会被更新器清理，也不该上传）
	const ignoredInstall = [];
	for (const [name, entry] of [...localByName.entries()]) {
		if (cloudByName.has(name)) continue;
		if (isInInstallDir(entry.cwd)) {
			ignoredInstall.push(name);
			localByName.delete(name);
		}
	}

	const allNames = [...new Set([...cloudByName.keys(), ...localByName.keys()])];

	const projects = [];
	let pendingSessions = 0;
	let pendingWorkspaces = 0;

	for (const name of allNames) {
		const cloudProject = cloudByName.get(name) || null;
		const local = localByName.get(name) || null;
		const cwd = (cloudProject && cloudProject.cwd) || (local && local.cwd) || "";
		const projectDir = cloudProject ? path.join(repoRoot, "projects", name) : null;

		// ---- 工作区同步状态 ----
		let workspace = { status: "not-uploaded", changed: 0, added: 0, removed: 0, files: 0, bytes: 0, large: 0 };
		if (cloudProject) {
			const meta = (() => {
				try {
					return JSON.parse(fs.readFileSync(path.join(projectDir, "meta.json"), "utf8"));
				} catch {
					return {};
				}
			})();
			const manifest = (() => {
				try {
					return JSON.parse(fs.readFileSync(path.join(projectDir, "workspace", "manifest.json"), "utf8"));
				} catch {
					return { files: {} };
				}
			})();
			const cloudFiles = manifest.files || {};
			workspace = {
				status: "clean",
				changed: 0,
				added: 0,
				removed: 0,
				files: Object.keys(cloudFiles).length,
				bytes: Object.values(cloudFiles).reduce((sum, file) => sum + (file.size || 0), 0),
				large: cloudProject.large || 0,
				uploadedAt: meta.updatedAt || null,
			};
			if (!cwd || !existsSync(cwd)) {
				workspace.status = "missing-local";
			} else {
				try {
					const now = await buildManifest(cwd);
					let changed = 0;
					let added = 0;
					let removed = 0;
					for (const [rel, info] of Object.entries(now.files)) {
						const before = cloudFiles[rel];
						if (!before) added++;
						else if (before.hash !== info.hash) changed++;
					}
					for (const rel of Object.keys(cloudFiles)) if (!now.files[rel]) removed++;
					Object.assign(workspace, { changed, added, removed });
					if (changed + added + removed > 0) workspace.status = "dirty";
					const missingLarge = (now.large || []).filter((file) => !workspace.large);
					workspace.untrackedLarge = missingLarge.length;
				} catch {
					workspace.status = "unknown";
				}
			}
		}

		if (workspace.status === "dirty" || workspace.status === "not-uploaded") pendingWorkspaces++;

		// ---- 会话同步状态 ----
		const cloudBySession = new Map(cloudSessions.filter((s) => s.project === name).map((s) => [s.id, s]));
		const localBySession = new Map((local ? local.sessions : []).map((s) => [s.id, s]));
		const sessionIds = [...new Set([...cloudBySession.keys(), ...localBySession.keys()])];

		const sessions = [];
		for (const id of sessionIds) {
			const cloudSession = cloudBySession.get(id) || null;
			const localSession = localBySession.get(id) || null;
			let state = "same";
			if (cloudSession && !localSession) state = "cloud-only";
			else if (!cloudSession && localSession) state = "local-only";
			else {
				try {
					const cloudFile = (() => {
						const dir = path.join(projectDir, "sessions", id);
						const file = fs.readdirSync(dir).find((n) => n.endsWith(".jsonl.zstd"));
						return file ? path.join(dir, file) : null;
					})();
					const localDir = findSessionDir(id);
					const localFile = localDir ? (() => {
						const file = fs.readdirSync(localDir).find((n) => n.endsWith(".jsonl.zstd"));
						return file ? path.join(localDir, file) : null;
					})() : null;
					if (cloudFile && localFile) {
						const [cloudHash, localHash] = await Promise.all([hashFileSha256(cloudFile), hashFileSha256(localFile)]);
						state = cloudHash && localHash && cloudHash === localHash ? "same" : "diff";
					} else {
						state = "diff";
					}
				} catch {
					state = "diff";
				}
			}
			if (localSession && localSession.archived) state = state === "local-only" ? "archived-local-only" : "archived";
			if (state === "local-only" || state === "diff" || state === "archived-local-only") pendingSessions++;

			sessions.push({
				id,
				title: (cloudSession && cloudSession.title) || (localSession && localSession.title) || "",
				bytes: (cloudSession && cloudSession.sessionBytes) || (localSession && localSession.bytes) || 0,
				uploadedAt: cloudSession ? cloudSession.uploadedAt : null,
				localModified: localSession ? localSession.modified : null,
				state,
			});
		}
		sessions.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));

		projects.push({
			name,
			repoId: repo.id,
			repoName: repo.name,
			title: (cloudProject && cloudProject.title) || (cwd ? path.basename(cwd) : name),
			cwd,
			localWorkspace: Boolean(cwd && existsSync(cwd)),
			uploadedAt: workspace.uploadedAt || null,
			workspace,
			sessions,
		});
	}

	projects.sort((a, b) => {
		if (Boolean(cloudByName.get(a.name)) !== Boolean(cloudByName.get(b.name))) return cloudByName.get(a.name) ? -1 : 1;
		return String(a.title).localeCompare(String(b.title));
	});

	const repoInfo = { branch: "", head: "", date: "", message: "", ahead: 0, behind: 0 };
	const log = await git(repoRoot, ["log", "-1", "--format=%h%x09%ad%x09%s", "--date=format:%m-%d %H:%M"]);
	if (log.code === 0 && log.out.trim()) {
		const [head, date, ...rest] = log.out.trim().split("\t");
		repoInfo.head = head || "";
		repoInfo.date = date || "";
		repoInfo.message = rest.join("\t");
	}
	const branch = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch.code === 0) repoInfo.branch = branch.out.trim();
	const counts = await git(repoRoot, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
	if (counts.code === 0 && counts.out.trim()) {
		const [ahead, behind] = counts.out.trim().split(/\s+/).map(Number);
		repoInfo.ahead = Number.isFinite(ahead) ? ahead : 0;
		repoInfo.behind = Number.isFinite(behind) ? behind : 0;
	}

	return {
		repo: repoInfo,
		totals: {
			projects: projects.length,
			sessions: projects.reduce((n, project) => n + project.sessions.length, 0),
			pendingWorkspaces,
			pendingSessions,
			ignoredInstall: ignoredInstall.length,
		},
		projects,
	};
}

/** 多仓库合并视图：把多个仓库的逻辑项目按名字合并，会话按 id 去重。 */
async function buildCloudView(repos) {
	const merged = new Map();
	const repoSummaries = [];
	let ignoredInstall = 0;

	for (const repo of repos) {
		if (!repo.ok) {
			repoSummaries.push({ id: repo.id, name: repo.name, ok: false, projects: 0, sessions: 0 });
			continue;
		}
		const view = await buildRepoView(repo);
		ignoredInstall += (view.totals && view.totals.ignoredInstall) || 0;
		repoSummaries.push({
			id: repo.id,
			name: repo.name,
			ok: true,
			projects: view.projects.length,
			sessions: view.totals.sessions,
			git: view.repo,
		});

		for (const project of view.projects) {
			const existing = merged.get(project.name);
			if (!existing) {
				merged.set(project.name, {
					...project,
					repoIds: [repo.id],
					repoNames: [repo.name],
					sessions: project.sessions.map((s) => ({ ...s, repoNames: [repo.name] })),
				});
				continue;
			}
			existing.repoIds.push(repo.id);
			existing.repoNames.push(repo.name);
			const rank = { "missing-local": 0, unknown: 1, "not-uploaded": 2, dirty: 3, clean: 4 };
			if ((rank[project.workspace.status] || 0) > (rank[existing.workspace.status] || 0)) existing.workspace = { ...project.workspace };
			for (const session of project.sessions) {
				const hit = existing.sessions.find((s) => s.id === session.id);
				if (hit) {
					hit.repoNames = [...new Set([...hit.repoNames, repo.name])];
					const stateRank = { "cloud-only": 1, same: 2, diff: 3 };
					if ((stateRank[session.state] || 0) > (stateRank[hit.state] || 0)) hit.state = session.state;
				} else {
					existing.sessions.push({ ...session, repoNames: [repo.name] });
				}
			}
		}
	}

	const projects = [...merged.values()];
	let pendingWorkspaces = 0;
	let pendingSessions = 0;
	for (const project of projects) {
		if (["dirty", "not-uploaded"].includes(project.workspace.status)) pendingWorkspaces++;
		for (const session of project.sessions) {
			if (["diff", "local-only", "archived-local-only"].includes(session.state)) pendingSessions++;
		}
	}

	const primary = repoSummaries.find((repo) => repo.ok && repo.git) || { git: {} };
	return {
		repo: primary.git || {},
		repos: repoSummaries,
		totals: {
			projects: projects.length,
			sessions: projects.reduce((sum, project) => sum + project.sessions.length, 0),
			pendingWorkspaces,
			pendingSessions,
			ignoredInstall,
		},
		projects,
	};
}
/** 合并本地与多个云端仓库的项目视图：项目 = 工作区 + 会话。 */
function buildTree(repos) {
	const local = listSessions();
	const cloudSessions = new Map();
	const cloudProjectMap = new Map();
	for (const repo of repos) {
		if (!repo.ok) continue;
		for (const session of listCloudSessions(repo.path)) {
			if (!cloudSessions.has(session.id)) cloudSessions.set(session.id, { ...session, repoId: repo.id, repoName: repo.name });
		}
		for (const project of listCloudProjects(repo.path)) {
			if (!cloudProjectMap.has(project.name)) {
				cloudProjectMap.set(project.name, {
					...project,
					repoId: repo.id,
					repoName: repo.name,
					repoIds: [repo.id],
					repoNames: [repo.name],
				});
			} else {
				const entry = cloudProjectMap.get(project.name);
				entry.repoIds.push(repo.id);
				entry.repoNames.push(repo.name);
			}
		}
	}

	const byName = new Map();
	const ensure = (cwd) => {
		const name = cwd ? projectName(cwd) : "_no-cwd";
		if (!byName.has(name)) {
			byName.set(name, {
				name,
				cwd: cwd || "",
				title: cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : "(无工作区)",
				cloudProject: null,
				sessions: [],
			});
		}
		return byName.get(name);
	};

	for (const session of local) {
		const project = ensure(session.cwd || "");
		project.sessions.push({
			id: session.id,
			title: session.title,
			archived: Boolean(session.archived),
			bytes: session.bytes,
			modified: session.modified,
			cloud: cloudSessions.get(session.id) || null,
		});
	}

	for (const project of cloudProjectMap.values()) {
		ensure(project.cwd).cloudProject = project;
	}

	const localIds = new Set(local.map((session) => session.id));
	for (const session of cloudSessions.values()) {
		if (localIds.has(session.id)) continue;
		const project = ensure(session.cwd || "");
		project.sessions.push({ id: session.id, title: session.title, archived: false, bytes: session.sessionBytes, modified: 0, cloud: session });
	}

	return {
		suggestedBase: defaultWorkspaceBase(),
		repos: repos.map((repo) => ({ id: repo.id, name: repo.name, ok: repo.ok, url: repo.url })),
		projects: [...byName.values()],
	};
}
/** 插件所在仓库根目录。公开工具仓库布局：<toolrepo>/plugin；旧布局：<repo>/_repo/tools/panel/plugin。 */
function resolveRepoRoot(config) {
	if (config && config.workspace) return config.workspace;
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const candidates = [path.resolve(here, ".."), path.resolve(here, "..", "..", "..", "..")];
		for (const candidate of candidates) {
			if (existsSync(path.join(candidate, ".git"))) return candidate;
		}
	} catch {}
	return process.cwd();
}

/** 取仓库（按 id；缺省用第一个）。 */
function pickRepo(id) {
	if (id) return findRepo(String(id)) || null;
	return defaultRepo() || null;
}

/** 当前活动仓库路径（默认第一个仓库，没有则回退）。 */
function activeRepoPath(fallback) {
	const repo = defaultRepo();
	return repo && repo.ok ? repo.path : fallback;
}
/** 取 DSH 官方服务（cordis ctx.get），不可用时返回 undefined。 */
function getService(ctx, name) {
	try {
		return typeof ctx.get === "function" ? ctx.get(name) : undefined;
	} catch {
		return undefined;
	}
}

/** 确保仓库启用 git-lfs：写 .gitattributes 并本地安装 hook。返回是否可用。 */
async function ensureLfs(repoRoot) {
	try {
		const version = await git(repoRoot, ["lfs", "version"], 15000);
		if (version.code !== 0) return false;
		const attr = path.join(repoRoot, ".gitattributes");
		const existing = existsSync(attr) ? fs.readFileSync(attr, "utf8") : "";
		if (!existing.includes("workspace/large/**")) {
			const line = "projects/**/workspace/large/** filter=lfs diff=lfs merge=lfs -text";
			fs.writeFileSync(attr, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + line + "\n", "utf8");
		}
		await git(repoRoot, ["lfs", "install", "--local"], 15000);
		return true;
	} catch {
		return false;
	}
}

/** 保证仓库有提交身份（新设备可能没配 git 全局身份）。 */
async function ensureGitIdentity(repoPath) {
	try {
		const name = await git(repoPath, ["config", "--get", "user.name"], 10000);
		if (name.code !== 0 || !name.out.trim()) await git(repoPath, ["config", "user.name", "DSH User"], 10000);
		const email = await git(repoPath, ["config", "--get", "user.email"], 10000);
		if (email.code !== 0 || !email.out.trim()) await git(repoPath, ["config", "user.email", "dsh@localhost"], 10000);
	} catch {}
}
/** 登记工作区：优先用 DSH 官方 ctx.workspaceRegistry（内存状态同步，会话按 cwd 自动归属）。 */
async function registerWorkspaceOfficial(ctx, repoRoot, dir, title, sessionIds) {
	const service = getService(ctx, "workspaceRegistry");
	if (service && typeof service.create === "function") {
		try {
			const entity = await service.create(dir, title);
			return { ok: true, via: "service", workspaceId: entity && entity.id ? entity.id : null };
		} catch (error) {
			return { ok: false, via: "service", error: String(error && error.message ? error.message : error) };
		}
	}
	const fallback = registerWorkspace(dir, title, sessionIds);
	return { ...fallback, via: "json" };
}
export function apply(ctx, config = {}) {
	const workspace = resolveRepoRoot(config);
	const port = Number(config.port) || 8732;
	ensureRegistryFile();

	// 启动自检：修复历史遗留的 workspace 注册表重复登记（不修改则不动）
	try {
		const repair = repairRegistry();
		if (repair.ok && repair.changed) {
			console.info("[cloud-sync-panel] 已修复 workspace 注册表重复登记", JSON.stringify(repair.moved || []));
		} else if (!repair.ok) {
			console.warn("[cloud-sync-panel] workspace 注册表存在无法自动修复的问题", repair.error || repair.after || repair.problems);
		}
	} catch (error) {
		console.warn("[cloud-sync-panel] workspace 注册表自检失败（已忽略）", error);
	}

	// 初始化 git-lfs（大文件可跨机恢复）
	void ensureLfs(workspace);

	ctx.effect(() => {
		const server = http.createServer(async (request, response) => {
			try {
				const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
				const pathname = url.pathname;

				if (request.method === "OPTIONS") {
					response.writeHead(204, {
						"Access-Control-Allow-Origin": "*",
						"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
						"Access-Control-Allow-Headers": "Content-Type",
						"Content-Length": "0",
					});
					response.end();
					return;
				}

				if (pathname === "/health") {
					return sendJson(response, { ok: true, service: "cloud-sync-panel", host: "dsh" });
				}
				if (pathname === "/token") return sendJson(response, { token: TOKEN });

				if (url.searchParams.get("token") !== TOKEN) return sendJson(response, { error: "forbidden" }, 403);

				/** 没有登记任何同步仓库时拒绝执行（避免误把工具仓库推到分发者的私人仓库）。 */
				const rejectNoRepo = () => sendJson(response, { ok: false, error: "no-repo", output: "还没有登记同步仓库：请先在「仓库管理…」登记你的私有仓库" }, 400);
				if (pathname === "/api/check") {
					if (!defaultRepo()) return rejectNoRepo();
					return sendJson(response, await readState(activeRepoPath(workspace)));
				}

				// ---- 归档相关 ----
				if (pathname === "/api/registry-status") {
					const json = (() => {
						try {
							return JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME || "", "storages", "workspace.json"), "utf8"));
						} catch {
							return null;
						}
					})();
					if (!json) return sendJson(response, { ok: false, error: "找不到 workspace.json" });
					return sendJson(response, { ok: true, ...validateRegistry(json) });
				}

				if (pathname === "/api/registry-repair" && request.method === "POST") {
					const result = repairRegistry();
					return sendJson(response, { ok: Boolean(result.ok), output: JSON.stringify(result, null, 2), result });
				}

				if (pathname === "/api/repos") {
					if (request.method === "POST") {
						const body = await readBody(request);
						try {
							const added = await addRepo({ url: body.url, name: body.name, path: body.path });
							return sendJson(response, { ok: true, repo: added, repos: publicRepos(), defaultRepoId: (defaultRepo() || {}).id || null });
						} catch (error) {
							return sendJson(response, { ok: false, output: String(error && error.message ? error.message : error) }, 400);
						}
					}
					ensureRegistryFile();
					return sendJson(response, { repos: publicRepos(), defaultRepoId: (defaultRepo() || {}).id || null });
				}

				if (pathname === "/api/repos/remove" && request.method === "POST") {
					const body = await readBody(request);
					try {
						removeRepo(String(body.id || ""));
						return sendJson(response, { ok: true, repos: publicRepos() });
					} catch (error) {
						return sendJson(response, { ok: false, output: String(error && error.message ? error.message : error) }, 400);
					}
				}
				if (pathname === "/api/sessions") {
					return sendJson(response, { suggestedBase: defaultWorkspaceBase(), sessions: listSessions() });
				}


				if (pathname === "/api/cloud-view") {
					ensureRegistryFile();
					return sendJson(response, await buildCloudView(listRepos()));
				}

				if (pathname === "/api/tree") {
					ensureRegistryFile();
					return sendJson(response, buildTree(listRepos()));
				}

				if (pathname === "/api/upload-project" && request.method === "POST") {
					const body = await readBody(request);
					const cwd = typeof body.cwd === "string" ? body.cwd : "";
					const ids = Array.isArray(body.sessionIds) ? [...new Set(body.sessionIds)] : [];
					const targetRepo = pickRepo(body.repoId);
					if (!targetRepo || !targetRepo.ok) return sendJson(response, { ok: false, error: "no-repo", output: "还没有登记同步仓库：请先在「仓库管理…」登记你的私有仓库" }, 400);
					const repoPath = targetRepo.path;
					if (!cwd) return sendJson(response, { ok: false, output: "缺少工作区路径" }, 400);

					const lines = [`目标仓库：${targetRepo.name}`];
					const lfsReady = await ensureLfs(repoPath);
					const wsResult = await uploadProjectWorkspace(repoPath, cwd, { storeLarge: lfsReady });
					if (!lfsReady && (wsResult.large ?? 0) > 0) lines.push(`⚠ git-lfs 不可用，${wsResult.large} 个大文件只记录清单`);
					lines.push(`项目 ${wsResult.meta.name}：文件 ${wsResult.files ?? 0}，变更 ${wsResult.changed ?? 0} / 增 ${wsResult.added ?? 0} / 删 ${wsResult.removed ?? 0}${wsResult.large ? `，大文件 ${wsResult.large}` : ""}`);

					for (const id of ids) {
						try {
							const r = await uploadSession({ repoRoot: repoPath, id, cwd });
							lines.push(r.ok ? `✓ 会话 ${id}` : `✗ 会话 ${id}: ${r.error}`);
						} catch (error) {
							lines.push(`✗ 会话 ${id}: ${error.message || error}`);
						}
					}

					await ensureGitIdentity(repoPath);
					await ensureLongPaths(repoPath);
					await git(repoPath, ["add", "-A"]);
					const status = await git(repoPath, ["status", "--porcelain"]);
					if (status.out.trim()) {
						const msg = body.message || `archive: 上传工作区与 ${ids.length} 个会话`;
						const commit = await git(repoPath, ["commit", "-m", msg]);
						if (commit.code !== 0) return sendJson(response, { ok: false, output: lines.join("\n") + "\n提交失败：" + commit.err.trim() });
						lines.push(`已提交：${msg}`);
					} else {
						lines.push("内容无变化，未产生新提交");
					}
					const push = await git(repoPath, ["push", "-u", "origin", "main"], 180000);
					lines.push((push.out || push.err || "已推送").trim());
					return sendJson(response, { ok: push.code === 0, output: lines.join("\n") });
				}

				if (pathname === "/api/pick-directory" && request.method === "POST") {
					const picker = getService(ctx, "directoryPicker");
					let capability = null;
					try {
						capability = picker && typeof picker.capability === "function" ? picker.capability() : null;
					} catch {}
					if (!capability || capability.kind !== "native" || typeof capability.pick !== "function") {
						return sendJson(response, { ok: false, available: false, hint: "当前环境没有系统文件夹选择框，请手动输入路径" });
					}
					try {
						const chosen = await capability.pick(new AbortController().signal);
						if (!chosen) return sendJson(response, { ok: false, available: true, canceled: true });
						return sendJson(response, { ok: true, available: true, path: chosen });
					} catch (error) {
						return sendJson(response, { ok: false, available: true, error: String(error && error.message ? error.message : error) });
					}
				}

				if (pathname === "/api/download-project" && request.method === "POST") {
					const body = await readBody(request);
					const name = typeof body.name === "string" && body.name ? body.name : typeof body.key === "string" ? body.key : "";
					const ids = Array.isArray(body.sessionIds) ? [...new Set(body.sessionIds)] : [];
					const withWorkspace = body.withWorkspace !== false;
					const targetRepo = pickRepo(body.repoId);
					if (!targetRepo || !targetRepo.ok) return sendJson(response, { ok: false, error: "no-repo", output: "还没有登记同步仓库：请先在「仓库管理…」登记你的私有仓库" }, 400);
					const repoPath = targetRepo.path;
					const cloudProject = findCloudProject(repoPath, name);
					if (!cloudProject) return sendJson(response, { ok: false, output: `仓库 ${targetRepo.name} 中没有项目 ${name}` }, 404);

					const target = typeof body.targetDir === "string" && body.targetDir ? path.resolve(body.targetDir) : "";
					if (!target) return sendJson(response, { ok: false, output: "缺少目标目录" }, 400);
					if (!path.isAbsolute(target)) return sendJson(response, { ok: false, output: "目标目录必须是绝对路径" }, 400);

					const lines = [];
					let wsResult = null;
					try {
						if (withWorkspace) {
							fs.mkdirSync(target, { recursive: true });
							if ((cloudProject.largeStored || 0) > 0) {
								await ensureLfs(repoPath);
								await git(repoPath, ["lfs", "pull"], 300000);
							}
							wsResult = await downloadProjectWorkspace(repoPath, cloudProject.name, target);
							lines.push(`工作区 → ${target}：写入 ${wsResult.written}（大文件恢复 ${wsResult.largeRestored}），校验通过 ${wsResult.verified}，失败 ${wsResult.failed}，移入回收 ${wsResult.trashed}`);
						} else {
							lines.push("仅下载会话（不下载工作区）");
						}
					} catch (error) {
						return sendJson(response, { ok: false, output: "下载工作区失败：" + (error.message || error) });
					}

					for (const id of ids) {
						try {
							const result = await downloadSession(repoPath, id, { overwrite: true, targetCwd: withWorkspace ? target : "" });
							lines.push(`会话 ${id}：${result.action}${result.cwd ? `（cwd → ${result.cwd}）` : ""}`);
							if (result.duplicates && result.duplicates.length) lines.push(`  ⚠ 该会话在其它目录还有副本：${result.duplicates.map((p) => path.relative(process.env.DSH_HOME || "", p)).join("；")}`);
						} catch (error) {
							lines.push(`✗ 会话 ${id}: ${error.message || error}`);
						}
					}

					let registration = null;
					if (withWorkspace) {
						if (isInInstallDir(target)) lines.push(`⚠ ${target} 位于 DSH 安装目录内，更新/卸载时可能被清理`);
						registration = await registerWorkspaceOfficial(ctx, repoPath, target, cloudProject.title || cloudProject.name, ids);
						lines.push(registration.ok ? `已登记为新工作区（${registration.via === "service" ? "DSH 官方接口" : "注册表文件"}）` : `工作区登记失败：${registration.error || ""}`);
					}

					return sendJson(response, {
						ok: wsResult ? wsResult.failed === 0 : true,
						output: lines.join("\n"),
						repo: { id: targetRepo.id, name: targetRepo.name },
						pendingLarge: wsResult ? wsResult.pendingLarge : [],
						workspace: wsResult,
						registration,
					});
				}
				if (pathname === "/api/upload-sessions" && request.method === "POST") {
					if (!defaultRepo()) return rejectNoRepo();
					const body = await readBody(request);
					const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((x) => typeof x === "string"))] : [];
					if (!ids.length) return sendJson(response, { ok: false, output: "未选择会话" }, 400);

					const results = [];
					for (const id of ids) {
						try {
							results.push(await uploadSession({ repoRoot: workspace, id }));
						} catch (error) {
							results.push({ id, ok: false, error: String(error && error.message ? error.message : error) });
						}
					}

					const failed = results.filter((r) => !r.ok);
					let output = results
						.map((r) => (r.ok ? `✓ ${r.id} → ${r.dest}${r.archived ? `（旧版 ${r.archived}）` : ""}` : `✗ ${r.id}: ${r.error}`))
						.join("\n");

					if (results.some((r) => r.ok)) {
						await ensureGitIdentity(rollbackRepo.path);
						await ensureLongPaths(rollbackRepo.path);
						await git(rollbackRepo.path, ["add", "-A"]);
						const status = await git(activeRepoPath(workspace), ["status", "--porcelain"]);
						if (status.out.trim()) {
							const msg = body.message || `archive: 上传 ${results.filter((r) => r.ok).length} 个会话`;
							const commit = await git(rollbackRepo.path, ["commit", "-m", msg]);
							if (commit.code !== 0) {
								return sendJson(response, { ok: false, output: `${output}\n提交失败：${commit.err.trim()}`, results });
							}
							output += `\n已提交：${msg}`;
						} else {
							output += "\n内容无变化，未产生新提交";
						}
						const push = await git(repoPath, ["push", "-u", "origin", "main"], 180000);
						output += "\n" + (push.out || push.err || "已推送").trim();
						if (push.code !== 0) return sendJson(response, { ok: false, output, results });
					}

					return sendJson(response, { ok: failed.length === 0, output, results });
				}

				if (pathname === "/api/diff") {
					if (!defaultRepo()) return rejectNoRepo();
					const up = (await git(activeRepoPath(workspace), ["rev-parse", "--abbrev-ref", "@{u}"])).out.trim();
					const a = await git(activeRepoPath(workspace), ["diff", "--stat", `${up}..HEAD`]);
					const b = await git(activeRepoPath(workspace), ["diff", "--stat", `HEAD..${up}`]);
					return sendJson(response, {
						output: `本地领先云端：\n${a.out || "(无)"}\n云端领先本地：\n${b.out || "(无)"}`,
					});
				}

				if (pathname === "/api/download" && request.method === "POST") {
					if (!defaultRepo()) return rejectNoRepo();
					const body = await readBody(request);
					return sendJson(response, await doDownload(workspace, Boolean(body.stash)));
				}

				if (pathname === "/api/upload" && request.method === "POST") {
					if (!defaultRepo()) return rejectNoRepo();
					const body = await readBody(request);
					return sendJson(response, await doUpload(workspace, body.message));
				}

				return sendJson(response, { error: "not found" }, 404);
			} catch (error) {
				return sendJson(response, { error: String(error && error.message ? error.message : error) }, 500);
			}
		});

		server.on("error", (error) => {
			console.warn(`[cloud-sync-panel] 监听 ${port} 失败（可能端口被占用）`, error);
		});

		void ensureLongPaths(workspace);
		server.listen(port, "127.0.0.1", () => {
			console.info(`[cloud-sync-panel] 同步服务已就绪 http://127.0.0.1:${port}/ (workspace=${workspace})`);
		});

		return () => {
			try {
				server.close();
			} catch (error) {
				console.warn("[cloud-sync-panel] 关闭服务失败（已忽略）", error);
			}
		};
	}, "cloud-sync-panel: http server");
}
