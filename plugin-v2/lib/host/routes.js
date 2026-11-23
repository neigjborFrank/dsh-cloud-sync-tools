// HTTP 路由：所有业务接口（v2）。handler 返回对象，由 server 统一 JSON 输出。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppError } from "../shared.js";
import { downloadWorkspace } from "../core/download.js";
import { commitAndPush, ensureAttributes, ensureGitConfig, ensureLfs, pullFastForward } from "../core/git.js";
import { uploadWorkspace } from "../core/merge.js";
import { findProject, listProjects } from "../core/project.js";
import { addRepo, defaultRepo, findRepo, listBindings, listRepos, publicRepos, removeRepo, setBinding } from "../core/repo.js";
import { registerWorkspace, repairRegistry, validateRegistry, readRegistry } from "../core/registry.js";
import { downloadSession, listCloudSessions, listSessions, uploadSession } from "../core/session.js";
import { createExtraRoutes } from "./routes-extra.js";
import { getService } from "./services.js";
import { buildCloudView, buildTree } from "./views.js";



const requireRepo = (ctx, repoId) => {	const repo = repoId ? findRepo(repoId) : defaultRepo();
	if (!repo) throw new AppError("no-repo", "还没有登记同步仓库：请先在「仓库管理…」登记你的私有仓库");
	if (!repo.ok) throw new AppError("repo-missing", `仓库路径不可用：${repo.path}`);
	return repo;
};

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** 把 pullFastForward 的结果转成一行可读输出 */
const pullMessage = (result) => {
	if (!result) return "未拉取远端";
	if (result.ok) return result.updated ? `已拉取远端新提交（${result.before} → ${result.after}）` : "远端无新提交";
	const reason = (result.error || result.output || "未知错误").split("\n").filter(Boolean)[0] || "未知错误";
	return `⚠ 拉取远端失败（继续使用本地数据）：${reason}`;
};

/** 默认下载根目录：用户未指定时，工作区自动创建在 <Documents>/deepseek-harness/workspaces 下 */
const DEFAULT_DOWNLOAD_BASE = path.join(os.homedir(), "Documents", "deepseek-harness", "workspaces");

const sanitizeFolderName = (value) => {
	const cleaned = String(value || "")
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
		.replace(/[.\s]+$/g, "")
		.trim();
	return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned.slice(0, 80) : "workspace";
};

const resolveDownloadBase = (ctxValue) => {
	const configured = ctxValue && ctxValue.downloadBase;
	return configured ? path.resolve(configured) : DEFAULT_DOWNLOAD_BASE;
};

/** 云端项目名形如 `标题__路径键`，取标题作为默认文件夹名 */
const friendlyProjectTitle = (projectNameValue) => sanitizeFolderName(String(projectNameValue || "").split("__")[0]);



export function createRoutes(ctx) {
	return {
		...createExtraRoutes(ctx),
		"GET /api/repos": () => ({
			repos: publicRepos(),
			bindings: listBindings(),
			defaultRepoId: (defaultRepo() || {}).id || "",
		}),

		"POST /api/repos": async (body) => {
			const url = typeof body.url === "string" ? body.url.trim() : "";
			const localPath = typeof body.path === "string" ? body.path.trim() : "";
			const name = typeof body.name === "string" ? body.name.trim() : "";
			if (!url && !localPath) throw new AppError("bad-request", "请填写仓库地址或本地路径");
			if (localPath && !fs.existsSync(path.join(localPath, ".git"))) {
				throw new AppError("not-a-repo", "该本地路径不是 git 仓库");
			}
			const record = await addRepo({ url, path: localPath, name });
			return { ok: true, added: record, repos: publicRepos() };
		},

		"POST /api/repos/remove": (body) => {
			if (!body.id) throw new AppError("bad-request", "缺少仓库 id");
			removeRepo(String(body.id));
			return { ok: true, repos: publicRepos() };
		},

		"POST /api/repos/pull": async (body) => {
			const repos = body.repoId
				? [findRepo(String(body.repoId))].filter(Boolean)
				: listRepos().filter((repo) => repo.ok);
			if (!repos.length) throw new AppError("no-repo", "没有可用仓库");
			const lines = [];
			const results = [];
			for (const repo of repos) {
				await ensureGitConfig(repo.path);
				const result = await pullFastForward(repo.path);
				results.push({ repoId: repo.id, name: repo.name, ...result });
				lines.push(`${repo.name}：${pullMessage(result)}`);
			}
			const changed = results.some((result) => result.updated);
			return { ok: true, changed, output: lines.join("\n"), results };
		},

		"GET /api/tree": () => {
			const repos = listRepos();
			return { ...buildTree(repos), repos: publicRepos(), suggestedBase: resolveDownloadBase(ctx) };
		},

		"GET /api/cloud-view": async () => buildCloudView(listRepos()),

		"GET /api/sessions": () => ({ ok: true, sessions: listSessions() }),

		"POST /api/upload-project": async (body) => {
			const cwd = typeof body.cwd === "string" ? body.cwd : "";
			const ids = Array.isArray(body.sessionIds) ? [...new Set(body.sessionIds)] : [];
			if (!cwd) throw new AppError("bad-request", "缺少工作区路径");
			if (!fs.existsSync(cwd)) throw new AppError("no-workspace", `工作区目录不存在：${cwd}`);
			const repo = requireRepo(ctx, body.repoId);
			const lines = [`目标仓库：${repo.name}`];

			const lfsReady = await ensureLfs(repo.path);
			await ensureAttributes(repo.path);
			await ensureGitConfig(repo.path);
			lines.push(pullMessage(await pullFastForward(repo.path)));
			const result = await uploadWorkspace(repo.path, cwd, { storeLarge: lfsReady });
			setBinding(result.projectName, repo.id);

			if (result.mergedInto) lines.push(`检测到子目录工作区：已按父项目视角合并到「${result.mergedInto}」（子路径 ${result.scope || "根"}）`);
			if (result.migrated) lines.push(`检测到包含关系：已将旧项目「${result.migrated}」并入当前更大的工作区`);
			if (result.conflicts && result.conflicts.length) lines.push(`⚠ ${result.conflicts.length} 个文件同路径但内容不同：云端旧版保留，新内容已存入 conflicts/`);
			if (!lfsReady && num(result.large) > 0) lines.push(`⚠ git-lfs 不可用，${result.large} 个大文件只记录清单`);
			lines.push(`项目 ${result.projectName}：文件 ${num(result.files)}，变更 ${num(result.changed)} / 增 ${num(result.added)} / 删 ${num(result.removed)}${num(result.large) ? `，大文件 ${result.large}` : ""}`);

			for (const id of ids) {
				try {
					const uploaded = await uploadSession({
						repoRoot: repo.path,
						id,
						cwd,
						projectName: result.projectName,
						scope: result.scope || "",
					});
					lines.push(uploaded.ok ? `✓ 会话 ${id}` : `✗ 会话 ${id}: ${uploaded.error}`);
				} catch (error) {
					lines.push(`✗ 会话 ${id}: ${error.message}`);
				}
			}

			const commit = await commitAndPush(repo.path, `archive: 上传工作区与 ${ids.length} 个会话`);
			if (commit.error) lines.push(`⚠ 提交/推送失败：${commit.error}`);
			else if (commit.output) lines.push(commit.output);

			return {
				ok: true,
				output: lines.join("\n"),
				projectName: result.projectName,
				scope: result.scope || "",
				mergedInto: result.mergedInto || null,
				migrated: result.migrated || null,
				conflicts: result.conflicts || [],
				files: num(result.files),
			};
		},

		"POST /api/download-project": async (body) => {
			const repo = requireRepo(ctx, body.repoId);
			const projectNameValue = typeof body.name === "string" ? body.name : "";
			const targetDirRaw = typeof body.targetDir === "string" ? body.targetDir.trim() : "";
			if (!projectNameValue) throw new AppError("bad-request", "缺少项目名称");
			const base = resolveDownloadBase(ctx);
			let targetDir;
			if (!targetDirRaw) {
				// 未指定目录：自动在默认目录下创建以项目命名的文件夹
				targetDir = path.join(base, friendlyProjectTitle(projectNameValue));
			} else if (path.isAbsolute(targetDirRaw)) {
				targetDir = path.resolve(targetDirRaw);
			} else {
				// 相对路径：相对默认下载目录解析
				targetDir = path.resolve(base, targetDirRaw);
			}
			fs.mkdirSync(targetDir, { recursive: true });
			const withWorkspace = body.withWorkspace !== false;
			const ids = Array.isArray(body.sessionIds) ? [...new Set(body.sessionIds)] : [];

			if (!withWorkspace && !ids.length) throw new AppError("bad-request", "没有选择要下载的内容");

			await ensureLfs(repo.path);
			await ensureGitConfig(repo.path);
			const lines = [`目标仓库：${repo.name}`];
			let workspace = null;
			let pendingLarge = [];
			// 多设备：下载前默认 fast-forward 拉取远端（可传 pull:false 跳过）
			if (body.pull !== false) lines.push(pullMessage(await pullFastForward(repo.path)));

			if (withWorkspace) {
				workspace = await downloadWorkspace(repo.path, projectNameValue, targetDir);
				pendingLarge = workspace.pendingLarge;
				lines.push(
					`工作区 → ${targetDir}：写入 ${workspace.written}（大文件恢复 ${workspace.largeRestored}），校验通过 ${workspace.verified}，失败 ${workspace.failed}，移入回收 ${workspace.trashed}`,
				);
			}

			const downloaded = [];
			for (const id of ids) {
				try {
					const result = await downloadSession(repo.path, id, { targetCwd: targetDir });
					downloaded.push(result);
					lines.push(result.action === "skipped" ? `- 会话 ${id}：本地已一致` : `✓ 会话 ${id}（${result.action}）`);
				} catch (error) {
					lines.push(`✗ 会话 ${id}: ${error.message}`);
				}
			}

			let registration = null;
			if (withWorkspace || downloaded.length) {
				const projectInfo = findProject(repo.path, projectNameValue);
				const title = (projectInfo && projectInfo.title) || friendlyProjectTitle(projectNameValue);
				try {
					const workspaceRegistry = getService(ctx, "workspaceRegistry");
					let workspaceRecord = null;
					if (workspaceRegistry && typeof workspaceRegistry.resolveByPath === "function") {
						workspaceRecord = workspaceRegistry.resolveByPath(targetDir) || null;
					}
					if (!workspaceRecord && workspaceRegistry && typeof workspaceRegistry.create === "function") {
						workspaceRecord = await workspaceRegistry.create(targetDir, title);
					}
					if (workspaceRecord) {
						registration = { mode: "official", ok: true, workspaceId: workspaceRecord.id || null, title };
						lines.push(`已通过 DSH 官方服务登记工作区：${title}`);
					} else {
						const fallback = registerWorkspace(targetDir, title, downloaded.map((item) => item.id));
						registration = { mode: "file", ...fallback, title };
						lines.push(
							fallback.ok
								? `已写入工作区注册表（当前 DSH 会话中可能需刷新/重启后可见）：${title}`
								: `⚠ 工作区登记失败：${fallback.error || "未知错误"}`,
						);
					}
				} catch (error) {
					registration = { mode: "failed", ok: false, error: error.message };
					lines.push(`⚠ 工作区登记失败（可手动登记）：${error.message}`);
				}
			}

			return {
				ok: true,
				output: lines.join("\n"),
				workspace,
				pendingLarge,
				sessions: downloaded,
				registration,
				targetDir,
				project: projectNameValue,
			};
		},

		"GET /api/registry-status": () => {
			const json = readRegistry();
			if (!json) return { ok: false, available: false, error: "找不到 workspace 注册表" };
			const check = validateRegistry(json);
			return { ok: true, available: true, valid: check.ok, problems: check.problems };
		},

		"POST /api/registry-repair": () => repairRegistry(),

		"GET /api/projects": () => {
			const repos = listRepos().filter((repo) => repo.ok);
			const projects = [];
			for (const repo of repos) {
				for (const project of listProjects(repo.path)) projects.push({ ...project, repoId: repo.id, repoName: repo.name });
			}
			return { ok: true, projects };
		},
	};
}

export { readRegistry };
