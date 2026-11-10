// 校验 DSH 会话归档 / 已安装会话是否“放对了位置、能被识别”。
//
// 用法：
//   node verify_session.mjs "<归档根目录|单个会话目录|DSH_HOME>"
//
// 退出码：0 全部通过；1 存在问题。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const problems = [];
const notes = [];

/** 从实现还原的 projectKey：决定会话目录名 */
function projectKey(cwd) {
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

function decodeFrames(file) {
	const buf = fs.readFileSync(file);
	const offsets = [];
	for (let i = 0; i < buf.length - 3; i++) {
		if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offsets.push(i);
	}
	let text = "";
	let failed = 0;
	for (let i = 0; i < offsets.length; i++) {
		const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
		try {
			text += zlib.zstdDecompressSync(buf.subarray(offsets[i], end)).toString("utf8");
		} catch {
			failed++;
		}
	}
	return { buf, frames: offsets.length, failed, lines: text.split("\n").filter(Boolean) };
}

function attachmentExists(home, digest) {
	const hex = digest.replace(/^sha256:/, "");
	const candidates = [
		path.join(home, "attachments", "v1", "objects", hex.slice(0, 2), hex),
		path.join(home, "objects", hex.slice(0, 2), hex),
	];
	return candidates.some((p) => fs.existsSync(p));
}

function checkSession(sessionDir, home) {
	const file = fs
		.readdirSync(sessionDir)
		.filter((n) => /^session(\.[A-Za-z0-9]+)*\.jsonl\.zstd$/.test(n))
		.sort()
		.pop();
	if (!file) {
		problems.push(`${sessionDir}: 找不到 session*.jsonl.zstd`);
		return;
	}

	const { frames, failed, lines } = decodeFrames(path.join(sessionDir, file));
	if (failed) problems.push(`${path.join(sessionDir, file)}: ${failed} 个 zstd 帧解压失败`);
	if (!lines.length) {
		problems.push(`${path.join(sessionDir, file)}: 无记录`);
		return;
	}

	let header;
	try {
		header = JSON.parse(lines[0]);
	} catch {
		problems.push(`${path.join(sessionDir, file)}: 首行不是合法 JSON`);
		return;
	}
	if (header.type !== "session") problems.push(`首条记录 type=${header.type}，应为 session`);

	const dirName = path.basename(sessionDir);
	if (header.id && header.id !== dirName) {
		problems.push(`目录名(${dirName}) 与日志 id(${header.id}) 不一致`);
	}

	const versionInName = (file.match(/\.v(\d+)\.jsonl\.zstd$/) || [])[1];
	if (versionInName && header.version !== Number(versionInName)) {
		problems.push(`文件名版本 v${versionInName} 与日志 version=${header.version} 不一致`);
	}

	const projectDir = path.basename(path.dirname(sessionDir));
	if (header.cwd) {
		const expected = projectKey(header.cwd);
		if (projectDir !== expected) {
			problems.push(`所在项目目录(${projectDir}) 与 cwd 推导值(${expected}) 不一致；DSH 会归错项目或忽略`);
		}
	} else if (projectDir !== "_no-cwd") {
		problems.push(`日志无 cwd，但目录不是 _no-cwd（实际 ${projectDir}）`);
	}

	const seqs = [];
	const attachments = new Set();
	for (const line of lines.slice(1)) {
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof obj.seq === "number") seqs.push(obj.seq);
		const raw = line.match(/"attachmentId":"(sha256:[0-9a-f]{64})"/g) || [];
		for (const m of raw) attachments.add(m.slice(16, -1));
	}

	if (seqs.length) {
		const last = seqs[seqs.length - 1];
		if (last < seqs.length - 1) notes.push(`seq 末值(${last}) 小于记录数(${seqs.length})，可能有截断`);
	}

	let missing = 0;
	for (const digest of attachments) {
		if (!attachmentExists(home, digest)) missing++;
	}
	if (missing) problems.push(`${missing} 个附件对象缺失（共引用 ${attachments.size} 个）`);

	notes.push(
		`${dirName}: ${file} · 帧 ${frames} · 记录 ${lines.length} · 附件引用 ${attachments.size} · cwd=${header.cwd || "(无)"}`,
	);
}

/** 递归找出所有“会话目录”（含 session*.jsonl.zstd 的目录） */
function findSessionDirs(root) {
	const found = [];
	const walk = (dir, depth) => {
		if (depth > 4) return;
		let entries = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		if (entries.some((e) => e.isFile() && /^session(\.[A-Za-z0-9]+)*\.jsonl\.zstd$/.test(e.name))) {
			found.push(dir);
			return;
		}
		for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
	};
	walk(root, 0);
	return found;
}

const target = process.argv[2];
if (!target) {
	console.error("用法: node verify_session.mjs <归档根目录|会话目录|DSH_HOME>");
	process.exit(2);
}
if (!fs.existsSync(target)) {
	console.error("路径不存在:", target);
	process.exit(2);
}

const home = target;
const dirs = findSessionDirs(target);
if (!dirs.length) {
	console.error("未找到任何会话日志:", target);
	process.exit(1);
}

for (const dir of dirs) checkSession(dir, home);

console.log("=== 会话检查 ===");
for (const n of notes) console.log("  ✓", n);

if (problems.length) {
	console.log("\n=== 问题 ===");
	for (const p of problems) console.log("  ✗", p);
	console.log(`\n结果：${dirs.length} 个会话，${problems.length} 个问题`);
	process.exit(1);
}
console.log(`\n结果：${dirs.length} 个会话全部通过`);
