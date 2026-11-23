// 会话下载与迁移：把云端会话落到目标 cwd 对应的 projectKey，并清理旧位置副本
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { ensureDir, timestamp } from "../shared.js";
import { projectKeyOf } from "./layout.js";
import { dshHome, findSessionFile, listCloudSessions, readHeader, rewriteSessionCwd, writeProjCache } from "./session.js";
import { projectDir } from "./layout.js";

/** 同一会话 id 在其它 projectKey 目录下的副本 */
function collectSessionDuplicates(home, id, localDir) {
	const duplicates = [];
	try {
		const root = path.join(home, "sessions");
		for (const projectEntry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!projectEntry.isDirectory()) continue;
			const candidate = path.join(root, projectEntry.name, id);
			if (candidate !== localDir && fs.existsSync(candidate)) duplicates.push(candidate);
		}
	} catch {}
	return duplicates;
}

/**
 * 迁移后清理旧位置副本：移动到 <DSH_HOME>/cloud-sync/session-trash/<ts>/<projectKey>/<id>，
 * 不直接删除，避免误丢会话历史；DSH 不会扫描 sessions/ 以外的目录，因此不会重复显示。
 */
async function migrateSessionDuplicates(home, duplicates) {
	const cleaned = [];
	if (!duplicates.length) return cleaned;
	const trashRoot = path.join(home, "cloud-sync", "session-trash", timestamp());
	for (const dir of duplicates) {
		const dest = path.join(trashRoot, path.basename(path.dirname(dir)), path.basename(dir));
		try {
			ensureDir(path.dirname(dest));
			await fsp.rename(dir, dest);
			cleaned.push({ from: dir, to: dest });
		} catch {
			try {
				await fsp.cp(dir, dest, { recursive: true, force: true });
				await fsp.rm(dir, { recursive: true, force: true });
				cleaned.push({ from: dir, to: dest });
			} catch {}
		}
	}
	return cleaned;
}

/**
 * 下载一个会话：targetCwd 存在时改写 cwd 并放到对应 projectKey。
 * 默认 migrate=true：迁移到新位置后把旧 projectKey 下的同 id 副本移到 session-trash
 * （DSH 侧边栏按会话 cwd 分组，两份副本会导致重复/归属混乱）。
 * @returns {{id, action:"written"|"overwritten"|"skipped"|"kept-local", path?, cwd?, duplicates?, cleaned?}}
 */
export async function downloadSession(repoRoot, id, options = {}) {
	const cloud = listCloudSessions(repoRoot).find((session) => session.id === id);
	if (!cloud) throw new Error(`云端找不到会话 ${id}`);
	const cloudDir = path.join(projectDir(repoRoot, cloud.project), "sessions", id);
	const srcFile = findSessionFile(cloudDir);
	if (!srcFile) throw new Error("云端会话文件缺失");

	const home = options.home || dshHome();
	const targetCwd = String(options.targetCwd || "");
	const effectiveCwd = targetCwd || cloud.cwd;
	const key = effectiveCwd ? projectKeyOf(effectiveCwd) : "_no-cwd";
	const localDir = path.join(home, "sessions", key, id);
	const localFile = path.join(localDir, path.basename(srcFile));
	ensureDir(localDir);
	const migrate = options.migrate !== false && Boolean(targetCwd);
	const duplicatesIn = collectSessionDuplicates(home, id, localDir);
	const finish = async (result) => {
		if (!migrate || !duplicatesIn.length) return { ...result, duplicates: duplicatesIn };
		const cleaned = await migrateSessionDuplicates(home, duplicatesIn);
		const cleanedFrom = new Set(cleaned.map((item) => item.from));
		return { ...result, cleaned, duplicates: duplicatesIn.filter((dir) => !cleanedFrom.has(dir)) };
	};

	let payload = fs.readFileSync(srcFile);
	if (targetCwd) payload = rewriteSessionCwd(payload, targetCwd);

	let action = "written";
	if (fs.existsSync(localFile)) {
		if (payload.equals(fs.readFileSync(localFile))) {
			if (targetCwd) writeProjCache(id, targetCwd, home);
			return finish({ id, action: "skipped", path: localFile, cwd: effectiveCwd || null });
		}
		if (options.overwrite !== false) {
			await fsp.copyFile(localFile, `${localFile}.bak-${timestamp()}`);
			action = "overwritten";
		} else {
			return finish({ id, action: "kept-local", path: localFile, cwd: effectiveCwd || null });
		}
	}

	await fsp.writeFile(localFile, payload);
	writeProjCache(id, effectiveCwd || "", home, cloud.title);
	return finish({ id, action, path: localFile, cwd: effectiveCwd || null });
}
