// 路径与目录布局：store（内容）+ index（指示），并兼容 v1 的 projects/ 布局
import fs from "node:fs";
import path from "node:path";

/** cwd → 路径键（与 DSH 的 projectKey 算法一致） */
export function projectKeyOf(cwd) {
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** cwd → 项目目录名：<目录名>__<路径键去掉首尾 --> */
export function projectName(cwd) {
	const base = path.basename(String(cwd || "")) || "root";
	const key = projectKeyOf(String(cwd || "")).replace(/^--+/, "").replace(/--+$/, "");
	return `${base}__${key}`;
}

/** 指示区根：<repo>/index/projects */
export function indexProjectsRoot(repoRoot) {
	return path.join(repoRoot, "index", "projects");
}

/** v1 布局根：<repo>/projects（只读兼容） */
export function legacyProjectsRoot(repoRoot) {
	return path.join(repoRoot, "projects");
}

const isPathLike = (target) => /[\\/]/.test(String(target)) || /^[A-Za-z]:/.test(String(target));

/** 项目在指示区中的目录（写入时使用） */
export function projectDir(repoRoot, target) {
	const name = isPathLike(target) ? projectName(target) : String(target);
	return path.join(indexProjectsRoot(repoRoot), name);
}

/** 项目在 v1 布局中的目录（只读兼容） */
export function legacyProjectDir(repoRoot, target) {
	const name = isPathLike(target) ? projectName(target) : String(target);
	return path.join(legacyProjectsRoot(repoRoot), name);
}

/**
 * 定位一个项目实际的数据目录：
 * v2 新布局 <项目>/manifest.json → 项目目录本身；
 * v1 旧布局 <项目>/workspace/manifest.json → 该 workspace 子目录；
 * 都没有则返回项目目录本身（新建场景）。
 */
export function layoutDir(projectDirPath) {
	if (fs.existsSync(path.join(projectDirPath, "manifest.json"))) return projectDirPath;
	const legacy = path.join(projectDirPath, "workspace");
	if (fs.existsSync(path.join(legacy, "manifest.json"))) return legacy;
	return projectDirPath;
}

/** 存储区根（写入路径）：<repo>/store/<项目名> */
export function storeRoot(repoRoot, name) {
	return path.join(repoRoot, "store", name);
}

export function storeFilesDir(repoRoot, name) {
	return path.join(storeRoot(repoRoot, name), "files");
}

export function storeLargeDir(repoRoot, name) {
	return path.join(storeRoot(repoRoot, name), "large");
}

/** 读取时的内容目录：优先 store，回退项目目录内的 files/ 与 legacy layout/files */
export function readFilesDir(repoRoot, name, projectDirPath) {
	if (fs.existsSync(storeRoot(repoRoot, name))) return storeFilesDir(repoRoot, name);
	const candidates = [path.join(layoutDir(projectDirPath), "files"), path.join(layoutDir(projectDirPath), "workspace", "files")];
	for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
	return storeFilesDir(repoRoot, name);
}

export function readLargeDir(repoRoot, name, projectDirPath) {
	if (fs.existsSync(storeRoot(repoRoot, name))) return storeLargeDir(repoRoot, name);
	const candidates = [path.join(layoutDir(projectDirPath), "large"), path.join(layoutDir(projectDirPath), "workspace", "large")];
	for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
	return storeLargeDir(repoRoot, name);
}

// ---- 路径关系 ----

export function normPath(p) {
	return path.resolve(String(p || "")).replace(/[\\/]+$/, "").toLowerCase();
}

export function samePath(a, b) {
	return Boolean(a) && Boolean(b) && normPath(a) === normPath(b);
}

/** parent 是否严格包含 child */
export function isAncestor(parent, child) {
	if (!parent || !child) return false;
	const p = normPath(parent);
	const c = normPath(child);
	return c !== p && c.startsWith(p + path.sep);
}

/** child 相对 parent 的子路径（posix 分隔）；不是后代返回 "" */
export function relativeSub(parent, child) {
	if (!isAncestor(parent, child)) return "";
	return path.relative(path.resolve(parent), path.resolve(child)).replace(/\\/g, "/");
}
