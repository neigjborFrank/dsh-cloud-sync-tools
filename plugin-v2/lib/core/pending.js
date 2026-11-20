// 会话级变更检查：本地工作区 vs 云端清单（供"检查变更"与云端视图使用）
import fs from "node:fs";

import { buildManifest, readManifest } from "./manifest.js";
import { layoutDir, projectDir } from "./layout.js";
import { findProjectForCwd } from "./project.js";
import { dshHome, listSessions } from "./session.js";

/**
 * 逐会话比较本地工作区与云端清单。
 * @returns {Promise<Array<{id,title,cwd,bytes,status:"clean"|"dirty"|"new"|"no-workspace",project?,scope?,detail?}>>}
 */
export async function listPending(repoRoot, home = dshHome()) {
	const results = [];
	for (const session of listSessions(home)) {
		const base = { id: session.id, title: session.title, cwd: session.cwd, bytes: session.bytes };
		if (!session.cwd || !fs.existsSync(session.cwd)) {
			results.push({ ...base, status: "no-workspace" });
			continue;
		}
		const found = findProjectForCwd(repoRoot, session.cwd);
		if (!found) {
			results.push({ ...base, status: "new" });
			continue;
		}
		const indexDir = projectDir(repoRoot, found.project.name);
		const cloud = readManifest(layoutDir(indexDir));
		if (!cloud.files || !Object.keys(cloud.files).length) {
			results.push({ ...base, status: "new" });
			continue;
		}
		const now = await buildManifest(session.cwd);
		let added = 0;
		let changed = 0;
		let removed = 0;
		for (const [rel, info] of Object.entries(now.files)) {
			const before = cloud.files[rel];
			if (!before) added++;
			else if (before.hash !== info.hash) changed++;
		}
		for (const rel of Object.keys(cloud.files)) if (!now.files[rel]) removed++;
		results.push({ ...base, project: found.project.name, scope: found.scope, status: added + changed + removed > 0 ? "dirty" : "clean", detail: { added, changed, removed } });
	}
	return results;
}
