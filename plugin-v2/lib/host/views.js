// 视图聚合：本地会话 + 多仓库云端项目 → 工作区/会话同步状态
import { listBindings } from "../core/repo.js";
import { listProjects } from "../core/project.js";
import { listCloudSessions, listSessions } from "../core/session.js";
import { projectName } from "../core/layout.js";
import { buildManifest, readManifest } from "../core/manifest.js";
import fs from "node:fs";

const normCwd = (p) => String(p || "").replace(/[\\/]+$/, "").toLowerCase();

function installDirPattern() {
	return "deepseek-harness\\cloud-sync-tools";
}

function isInInstallDir(cwd) {
	return normCwd(cwd).includes(installDirPattern());
}

/** 合并本地会话与多仓库云端数据，生成项目树（供 /api/tree） */
export function buildTree(repos) {
	const bindings = listBindings();
	const local = listSessions();
	const cloudSessions = new Map();
	const cloudProjectMap = new Map();

	for (const repo of repos) {
		if (!repo.ok) continue;
		for (const session of listCloudSessions(repo.path)) {
			if (!cloudSessions.has(session.id)) cloudSessions.set(session.id, { ...session, repoId: repo.id, repoName: repo.name });
		}
		for (const project of listProjects(repo.path)) {
			const boundId = bindings[project.name];
			if (!cloudProjectMap.has(project.name) || (boundId && boundId === repo.id)) {
				cloudProjectMap.set(project.name, { ...project, repoId: repo.id, repoName: repo.name, repoIds: [repo.id], repoNames: [repo.name] });
			} else {
				const entry = cloudProjectMap.get(project.name);
				entry.repoIds.push(repo.id);
				entry.repoNames.push(repo.name);
			}
		}
	}

	// cwd → 云端项目（含合并进来的子目录 alias）
	const cloudByCwd = new Map();
	for (const project of cloudProjectMap.values()) {
		if (project.cwd) cloudByCwd.set(normCwd(project.cwd), { project, scope: "" });
		for (const alias of project.aliases || []) {
			if (alias.cwd) cloudByCwd.set(normCwd(alias.cwd), { project, scope: alias.scope || "" });
		}
	}

	const byName = new Map();
	const ensure = (cwd) => {
		const match = cwd ? cloudByCwd.get(normCwd(cwd)) : null;
		const name = match ? match.project.name : cwd ? projectName(cwd) : "_no-cwd";
		if (!byName.has(name)) {
			byName.set(name, {
				name,
				cwd: match ? match.project.cwd : cwd || "",
				title: match ? match.project.title || name : cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : "(无工作区)",
				cloudProject: null,
				sessions: [],
			});
		}
		return byName.get(name);
	};

	for (const session of local) {
		ensure(session.cwd || "").sessions.push({
			id: session.id,
			title: session.title,
			archived: Boolean(session.archived),
			bytes: session.bytes,
			modified: session.modified,
			cloud: cloudSessions.get(session.id) || null,
		});
	}

	for (const project of cloudProjectMap.values()) ensure(project.cwd).cloudProject = project;

	// 云端会话按"自己的 cwd"归行；即便本地已有同 ID 副本（可能在别的 cwd），
	// 云端项目行也必须列出该会话，否则会出现"云端有会话但工作区下无会话"、无法从云端行下载。
	for (const session of cloudSessions.values()) {
		const row = ensure(session.cwd);
		if (row.sessions.some((item) => item.id === session.id)) continue;
		row.sessions.push({ id: session.id, title: session.title, archived: false, bytes: session.sessionBytes, modified: 0, cloud: session });
	}

	return { suggestedBase: "", bindings, projects: [...byName.values()] };
}

/** 云端与同步视图（单仓库/多仓库合并） */
export async function buildCloudView(repos) {
	const bindings = listBindings();
	const localSessions = listSessions();
	const projects = [];
	const totals = { projects: 0, sessions: 0, pendingWorkspaces: 0, pendingSessions: 0, ignoredInstall: 0 };

	for (const repo of repos) {
		if (!repo.ok) continue;
		const cloudProjects = listProjects(repo.path);
		const cloudSessions = listCloudSessions(repo.path);
		const cloudByName = new Map(cloudProjects.map((project) => [project.name, project]));
		const cloudByCwd = new Map();
		for (const project of cloudProjects) {
			if (project.cwd) cloudByCwd.set(normCwd(project.cwd), project);
			for (const alias of project.aliases || []) if (alias.cwd) cloudByCwd.set(normCwd(alias.cwd), project);
		}

		const localByName = new Map();
		for (const session of localSessions) {
			if (!session.cwd) continue;
			const match = cloudByCwd.get(normCwd(session.cwd));
			const name = match ? match.name : projectName(session.cwd);
			if (!localByName.has(name)) localByName.set(name, { cwd: match ? match.cwd : session.cwd, sessions: [] });
			localByName.get(name).sessions.push(session);
		}

		const ignored = [];
		for (const [name, entry] of [...localByName.entries()]) {
			if (cloudByName.has(name)) continue;
			if (isInInstallDir(entry.cwd)) {
				ignored.push(name);
				localByName.delete(name);
			}
		}
		totals.ignoredInstall += ignored.length;

		const allNames = [...new Set([...cloudByName.keys(), ...localByName.keys()])];
		for (const name of allNames) {
			const cloudProject = cloudByName.get(name) || null;
			const local = localByName.get(name) || null;
			const cwd = (local && local.cwd) || (cloudProject && cloudProject.cwd) || "";

			let workspace = cloudProject
				? { status: "cloud-only", changed: 0, added: 0, removed: 0, files: 0 }
				: { status: "not-uploaded", changed: 0, added: 0, removed: 0, files: 0 };
			if (cloudProject && cwd && fs.existsSync(cwd)) {
				const cloud = readManifest(cloudProject.layoutDir);
				const now = await buildManifest(cwd);
				let added = 0;
				let changed = 0;
				let removed = 0;
				for (const [rel, info] of Object.entries(now.files)) {
					const before = cloud.files[rel];
					if (!before) added++;
					else if (before.hash !== info.hash) changed++;
				}
				for (const rel of Object.keys(cloud.files)) if (!now.files[rel]) removed++;
				workspace = {
					status: added + changed + removed > 0 ? "dirty" : "clean",
					added,
					changed,
					removed,
					files: Object.keys(now.files).length,
				};
				if (workspace.status === "dirty") totals.pendingWorkspaces++;
			}

			const sessionRows = [];
			const cloudSessionsOfProject = cloudSessions.filter((session) => session.project === name);
			const localOfProject = local ? local.sessions : [];
			for (const session of localOfProject) {
				const cloud = cloudSessionsOfProject.find((item) => item.id === session.id);
				sessionRows.push({
					id: session.id,
					title: session.title,
					archived: Boolean(session.archived),
					state: cloud ? "synced" : session.archived ? "archived" : "local-only",
				});
				if (!cloud && !session.archived) totals.pendingSessions++;
			}
			for (const session of cloudSessionsOfProject) {
				if (localOfProject.some((item) => item.id === session.id)) continue;
				sessionRows.push({ id: session.id, title: session.title, archived: false, state: "cloud-only" });
			}

			projects.push({
				name,
				title: (cloudProject && cloudProject.title) || (local && cwd.split(/[\\/]/).filter(Boolean).pop()) || name,
				cwd,
				repoId: repo.id,
				repoName: repo.name,
				boundRepoId: bindings[name] || "",
				workspace,
				sessions: sessionRows,
			});
		}
	}

	totals.projects = projects.length;
	totals.sessions = projects.reduce((sum, project) => sum + project.sessions.length, 0);
	return { repo: repos[0] ? repos[0].name : "", repos: repos.map((repo) => ({ id: repo.id, name: repo.name, ok: repo.ok })), totals, projects };
}
