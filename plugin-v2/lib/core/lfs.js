// Git LFS：指针识别与大文件恢复
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { ensureDir, hashFile } from "../shared.js";

const LFS_PREFIX = "version https://git-lfs";

/** 判断文件是否为未拉取的 LFS 指针文件 */
export function isLfsPointer(file) {
	try {
		const buf = Buffer.alloc(128);
		const fd = fs.openSync(file, "r");
		const n = fs.readSync(fd, buf, 0, 128, 0);
		fs.closeSync(fd);
		return buf.subarray(0, n).toString("utf8").startsWith(LFS_PREFIX);
	} catch {
		return false;
	}
}

/**
 * 从存储区恢复大文件到下载目录，逐文件校验哈希。
 * @returns {Promise<{restored:number, pending:Array<{path:string,size:number,reason:string}>}>}
 */
export async function restoreLargeFiles({ entries = [], largeDir, destDir }) {
	const pending = [];
	let restored = 0;

	for (const entry of entries) {
		const src = path.join(largeDir, entry.path);
		const dest = path.join(destDir, entry.path);
		if (!fs.existsSync(src)) {
			pending.push({ ...entry, reason: "云端缺少大文件内容" });
			continue;
		}
		if (isLfsPointer(src)) {
			pending.push({ ...entry, reason: "云端是 LFS 指针，需先执行 git lfs pull" });
			continue;
		}
		try {
			ensureDir(path.dirname(dest));
			await fsp.copyFile(src, dest);
			if ((await hashFile(dest)) === entry.hash) restored++;
			else pending.push({ ...entry, reason: "内容不一致" });
		} catch {
			pending.push({ ...entry, reason: "读取失败" });
		}
	}

	return { restored, pending };
}
