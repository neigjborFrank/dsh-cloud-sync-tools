// 修复工具：为数据仓库写入 `* -text` 属性，并把 manifest/workspace-ref 的哈希
// 对齐到当前工作区字节，避免 git 行尾归一化造成"克隆后校验失败"。
//
// 运行：node tools/v2/repair-manifest.mjs <数据仓库路径> [--no-push]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..", "..", "plugin-v2");
const toUrl = (relative) => new URL(relative, `file:///${pluginRoot.replace(/\\/g, "/")}/`).href;

const repoPath = process.argv[2];
if (!repoPath) {
	console.error("用法：node tools/v2/repair-manifest.mjs <数据仓库路径> [--no-push]");
	process.exit(2);
}
const noPush = process.argv.includes("--no-push");

const { ensureAttributes } = await import(toUrl("lib/core/git.js"));
const { commitAndPush } = await import(toUrl("lib/core/git.js"));
const { listProjects } = await import(toUrl("lib/core/project.js"));
const { hashFile, hashBuffer, readJson, writeJsonAtomic } = await import(toUrl("lib/shared.js"));

const summary = { attributes: false, files: 0, large: 0, refs: 0, projects: 0 };

summary.attributes = await ensureAttributes(repoPath);
console.log(summary.attributes ? "已更新 .gitattributes（* -text + LFS）" : ".gitattributes 已符合要求");

for (const project of listProjects(repoPath)) {
	const layout = project.layoutDir;
	const manifestPath = path.join(layout, "manifest.json");
	if (!fs.existsSync(manifestPath)) continue;
	summary.projects++;
	const manifest = readJson(manifestPath);
	let touched = false;

	for (const [rel, info] of Object.entries(manifest.files || {})) {
		const file = path.join(project.storeFiles, rel);
		if (!fs.existsSync(file)) continue;
		const hash = await hashFile(file);
		const size = fs.statSync(file).size;
		if (hash !== info.hash || size !== info.size) {
			manifest.files[rel] = { hash, size };
			summary.files++;
			touched = true;
		}
	}
	if (manifest.large) {
		for (const entry of manifest.large) {
			const file = path.join(project.storeLarge, entry.path);
			if (!fs.existsSync(file)) continue;
			const hash = await hashFile(file);
			const size = fs.statSync(file).size;
			if (hash !== entry.hash || size !== entry.size) {
				entry.hash = hash;
				entry.size = size;
				summary.large++;
				touched = true;
			}
		}
	}
	if (touched) {
		manifest.createdAt = new Date().toISOString();
		writeJsonAtomic(manifestPath, manifest);
	}

	// workspace-ref 对齐到最新 manifest
	const manifestBuf = fs.readFileSync(manifestPath);
	const manifestHash = hashBuffer(manifestBuf);
	const files = Object.keys(manifest.files || {}).length;
	const sessionsDir = path.join(project.dir, "sessions");
	let sessionDirs = [];
	try {
		sessionDirs = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
	} catch {}
	for (const entry of sessionDirs) {
		const refPath = path.join(sessionsDir, entry.name, "workspace-ref.json");
		const ref = readJson(refPath);
		if (!ref) continue;
		if (ref.manifestHash !== manifestHash || ref.files !== files) {
			ref.manifestHash = manifestHash;
			ref.files = files;
			writeJsonAtomic(refPath, ref);
			summary.refs++;
		}
	}
}

console.log(`项目 ${summary.projects} 个；修正文件哈希 ${summary.files} 个；大文件 ${summary.large} 个；会话快照 ${summary.refs} 个`);

const { runGit } = await import(toUrl("lib/core/repo.js"));

// 关键：让 git 按新属性（* -text）重新写入 blob，确保克隆出来的字节与 manifest 一致。
// 即使工作区没有改动也要执行（旧 blob 可能已被行尾归一化）。
const renormalize = await runGit(repoPath, ["add", "--renormalize", "."], 600000);
if (renormalize.code !== 0) {
	console.error("git add --renormalize 失败：" + (renormalize.err || renormalize.out));
	process.exit(1);
}

const status = await runGit(repoPath, ["status", "--porcelain"], 30000);
if (!status.out.trim()) {
	console.log("没有需要提交的改动");
	process.exit(0);
}

if (noPush) {
	console.log("已有改动（--no-push，未提交）：");
	console.log(status.out.trim().split("\n").slice(0, 20).join("\n"));
	process.exit(0);
}

const commit = await commitAndPush(repoPath, "repair: .gitattributes(* -text) 与 manifest 哈希对齐工作区字节");
if (commit.error) {
	console.error("提交/推送失败：" + commit.error);
	process.exit(1);
}
console.log(commit.output || "已提交并推送");
