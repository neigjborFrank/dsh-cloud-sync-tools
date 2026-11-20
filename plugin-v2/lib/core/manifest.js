// 工作区扫描 → 清单（路径 / 大小 / sha256），大文件与超长路径单独记录
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { LIMITS, hashFile, isExcluded } from "../shared.js";

/**
 * 扫描目录生成清单。
 * @returns {Promise<{createdAt:string, files:Record<string,{hash:string,size:number}>, large:Array<{path:string,size:number,hash:string}>, tooLong:Array<{path:string,size:number}>}>}
 */
export async function buildManifest(rootDir, limits = LIMITS) {
	const files = {};
	const large = [];
	const tooLong = [];

	const walk = async (dir, prefix) => {
		let entries = [];
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (isExcluded(entry.name)) continue;
			const full = path.join(dir, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(full, rel);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				const stat = await fsp.stat(full);
				if (stat.size > limits.maxFileBytes) {
					large.push({ path: rel, size: stat.size, hash: await hashFile(full) });
					continue;
				}
				if (rel.length > limits.maxRelPath) {
					tooLong.push({ path: rel, size: stat.size });
					continue;
				}
				files[rel] = { hash: await hashFile(full), size: stat.size };
			} catch {
				/* 单个文件读取失败不影响整体清单 */
			}
		}
	};

	await walk(rootDir, "");
	return { createdAt: new Date().toISOString(), files, large, tooLong };
}

/** 读取清单文件（不存在返回空清单） */
export function readManifest(indexDir) {
	try {
		const json = JSON.parse(fs.readFileSync(path.join(indexDir, "manifest.json"), "utf8"));
		return { files: json.files || {}, large: json.large || [], tooLong: json.tooLong || [] };
	} catch {
		return { files: {}, large: [], tooLong: [] };
	}
}
