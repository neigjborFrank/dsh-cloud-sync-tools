// 共享常量、错误类型与基础文件工具（无业务逻辑）
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 各 JSON 文件的结构版本（读时校验、写时声明） */
export const SCHEMA = {
	repos: 2,
	meta: 1,
	manifest: 1,
	sessionMeta: 1,
	workspaceRef: 1,
};

/** 扫描时忽略的目录/文件名（以 .csp-trash- 开头的也忽略） */
export const EXCLUDES = [".git", "node_modules", "out", ".venv", "__pycache__", ".dsh", ".work", "dist", "build"];

export const isExcluded = (name) => EXCLUDES.includes(name) || name.startsWith(".csp-trash-");

/** 限制（可用环境变量覆盖，测试用） */
export const LIMITS = {
	maxFileBytes: Number(process.env.CSP_MAX_FILE_BYTES) || 95 * 1024 * 1024,
	maxRelPath: Number(process.env.CSP_MAX_REL_PATH) || 220,
};

/** 带错误码的业务错误 */
export class AppError extends Error {
	constructor(code, message, detail = undefined) {
		super(message);
		this.name = "AppError";
		this.code = code;
		this.detail = detail;
	}
}

export function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** 原子写入：先写临时文件再 rename，避免中断产生半文件 */
export function writeJsonAtomic(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
	fs.renameSync(tmp, file);
}

export function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function hashFile(file) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = fs.createReadStream(file);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

export function hashBuffer(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

/** 时间戳：20261120183000（用于 conflicts/ 目录名） */
export function timestamp() {
	return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** 稳定的安全删除（忽略错误） */
export async function removeQuiet(file) {
	try {
		await fs.promises.rm(file, { force: true });
	} catch {}
}
