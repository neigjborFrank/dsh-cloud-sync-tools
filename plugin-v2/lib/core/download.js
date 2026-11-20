// 下载：把项目工作区镜像到目标目录（逐文件校验、多余文件进回收目录、LFS 恢复）
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { ensureDir, hashFile, timestamp } from "../shared.js";
import { findProject } from "./project.js";
import { isLfsPointer, restoreLargeFiles } from "./lfs.js";

/**
 * @returns {Promise<{project:string,target:string,written:number,largeRestored:number,verified:number,failed:number,trashed:number,trashDir:string|null,pendingLarge:Array,tooLong:Array}>}
 */
export async function downloadWorkspace(repoRoot, target, destDir) {
	const project = findProject(repoRoot, target);
	if (!project) throw new Error(`云端没有项目 ${target}`);
	const manifest = (() => {
		try {
			return JSON.parse(fs.readFileSync(path.join(project.layoutDir, "manifest.json"), "utf8"));
		} catch {
			return null;
		}
	})();
	if (!manifest) throw new Error("该项目没有上传工作区");

	const filesDir = project.storeFiles;
	const wanted = new Set(Object.keys(manifest.files || {}));
	ensureDir(destDir);

	const stamp = timestamp();
	const trashDir = path.join(destDir, `.csp-trash-${stamp}`);
	let trashed = 0;

	const walkExtras = async (dirPath, prefix) => {
		let entries = [];
		try {
			entries = await fsp.readdir(dirPath, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".csp-trash-")) continue;
			if ([".git", "node_modules"].includes(entry.name)) continue;
			const full = path.join(dirPath, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walkExtras(full, rel);
			} else if (!wanted.has(rel)) {
				try {
					const dest = path.join(trashDir, rel);
					ensureDir(path.dirname(dest));
					await fsp.rename(full, dest);
					trashed++;
				} catch {}
			}
		}
	};
	await walkExtras(destDir, "");

	let written = 0;
	let verified = 0;
	let failed = 0;
	for (const [rel, info] of Object.entries(manifest.files || {})) {
		const src = path.join(filesDir, rel);
		const dest = path.join(destDir, rel);
		try {
			ensureDir(path.dirname(dest));
			await fsp.copyFile(src, dest);
			written++;
			if ((await hashFile(dest)) === info.hash) verified++;
			else failed++;
		} catch {
			failed++;
		}
	}

	// 大文件：内容在 store/<项目>/large 下；LFS 未拉取时给出待人工清单
	const largeEntries = (manifest.large || []).filter((entry) => fs.existsSync(path.join(project.storeLarge, entry.path)));
	const missingLarge = (manifest.large || []).filter((entry) => !fs.existsSync(path.join(project.storeLarge, entry.path))).map((entry) => ({ ...entry, reason: "云端缺少大文件内容" }));
	const restored = await restoreLargeFiles({ entries: largeEntries, largeDir: project.storeLarge, destDir });
	const pendingLarge = [...missingLarge, ...restored.pending];
	verified += restored.restored;

	return {
		project: project.name,
		target: destDir,
		written,
		largeRestored: restored.restored,
		verified,
		failed,
		trashed,
		trashDir: trashed ? path.relative(destDir, trashDir) : null,
		pendingLarge,
		tooLong: manifest.tooLong || [],
	};
}

export { isLfsPointer };
