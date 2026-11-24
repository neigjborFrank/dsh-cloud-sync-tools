// 会话下载与迁移：把云端会话落到目标 cwd 对应的 projectKey，并清理旧位置副本
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { ensureDir, timestamp } from "../shared.js";
import { projectKeyOf } from "./layout.js";
import { readSessionLogInfo, writeProjCache } from "./session-cache.js";
import { dshHome, findSessionFile, listCloudSessions, readHeader } from "./session.js";
import { projectDir } from "./layout.js";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 改写会话日志首帧 header（其余帧原样保留） */
export function rewriteSessionHeader(buffer, mutate) {
	const at = buffer.indexOf(MAGIC);
	if (at < 0) return buffer;
	const next = buffer.indexOf(MAGIC, at + 4);
	const end = next < 0 ? buffer.length : next;
	let text;
	try {
		text = zstdDecompressSync(buffer.subarray(at, end)).toString("utf8");
	} catch {
		return buffer;
	}
	const lines = text.split("\n");
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].trim()) continue;
		try {
			const obj = JSON.parse(lines[i]);
			if (obj && obj.type === "session") {
				if (mutate(obj) !== false) {
					lines[i] = JSON.stringify(obj);
					changed = true;
				}
			}
			break;
		} catch {
			continue;
		}
	}
	if (!changed) return buffer;
	const frame = zstdCompressSync(Buffer.from(lines.join("\n"), "utf8"));
	return Buffer.concat([buffer.subarray(0, at), frame, buffer.subarray(end)]);
}

/** 改写会话日志首帧的 cwd（其余帧原样保留） */
export function rewriteSessionCwd(buffer, cwd) {
	return rewriteSessionHeader(buffer, (header) => {
		header.cwd = cwd;
		return true;
	});
}

/**
 * 子会话转普通会话：去掉 origin/parentSession/delegationDepth 血缘标记。
 * 用于父会话不存在（本地与云端都找不到）的孤儿子会话，否则 DSH 侧边栏永远不显示。
 */
export function normalizeSubagentHeader(buffer) {
	return rewriteSessionHeader(buffer, (header) => {
		delete header.origin;
		delete header.parentSession;
		header.delegationDepth = 0;
		return true;
	});
}

/** 父会话是否在本机或云端存在 */
function parentSessionAvailable(repoRoot, home, parentId) {
	if (!parentId) return false;
	if (listCloudSessions(repoRoot).some((session) => session.id === parentId)) return true;
	try {
		const root = path.join(home, "sessions");
		for (const projectEntry of fs.readdirSync(root, { withFileTypes: true })) {
			if (!projectEntry.isDirectory()) continue;
			if (fs.existsSync(path.join(root, projectEntry.name, parentId))) return true;
		}
	} catch {}
	return false;
}

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
		const base = { ...result, converted: convertSubagent };
		if (!migrate || !duplicatesIn.length) return { ...base, duplicates: duplicatesIn };
		const cleaned = await migrateSessionDuplicates(home, duplicatesIn);
		const cleanedFrom = new Set(cleaned.map((item) => item.from));
		return { ...base, cleaned, duplicates: duplicatesIn.filter((dir) => !cleanedFrom.has(dir)) };
	};

	// 血缘保护：重新下载不能把本地"普通会话"降级为隐藏的子会话；
	// 孤儿子会话（父会话本地/云端都不存在）默认转为普通会话，否则侧边栏永远不显示。
	const cloudHeader = readHeader(srcFile) || {};
	const localHeader = fs.existsSync(localFile) ? readHeader(localFile) : null;
	let convertSubagent = false;
	if (cloudHeader.origin === "subagent" && options.convertSubagent !== false) {
		if (localHeader && localHeader.origin !== "subagent") convertSubagent = true;
		else if (!parentSessionAvailable(repoRoot, home, cloudHeader.parentSession)) convertSubagent = true;
	}

	let payload = fs.readFileSync(srcFile);
	if (targetCwd) payload = rewriteSessionCwd(payload, targetCwd);
	if (convertSubagent) payload = normalizeSubagentHeader(payload);

	let action = "written";
	if (fs.existsSync(localFile)) {
		if (payload.equals(fs.readFileSync(localFile))) {
			if (targetCwd) {
				const info = readSessionLogInfo(localFile);
				const title = cloud.title || (info && info.title) || "";
				writeProjCache(id, { home, cwd: effectiveCwd || "", title, header: info?.header, lastSeq: info?.lastSeq });
			}
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
	const logInfo = readSessionLogInfo(localFile);
	const title = cloud.title || (logInfo && logInfo.title) || "";
	writeProjCache(id, { home, cwd: effectiveCwd || "", title, header: logInfo?.header, lastSeq: logInfo?.lastSeq });
	return finish({ id, action, path: localFile, cwd: effectiveCwd || null });
}
