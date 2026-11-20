// Git / LFS 封装：身份兜底、长路径、LFS 配置、提交与推送
import fs from "node:fs";
import path from "node:path";

import { runGit } from "./repo.js";

/** 仓库级 git 配置：身份、长路径（Windows） */
export async function ensureGitConfig(repoPath) {
	const name = await runGit(repoPath, ["config", "--get", "user.name"], 15000);
	const email = await runGit(repoPath, ["config", "--get", "user.email"], 15000);
	if (!name.out.trim()) await runGit(repoPath, ["config", "user.name", "DSH User"], 15000);
	if (!email.out.trim()) await runGit(repoPath, ["config", "user.email", "dsh@localhost"], 15000);
	if (process.platform === "win32") await runGit(repoPath, ["config", "core.longpaths", "true"], 15000);
}

/** 确保 git-lfs 可用并跟踪 store 下的大文件；返回是否可用 */
export async function ensureLfs(repoPath) {
	const version = await runGit(repoPath, ["lfs", "version"], 30000);
	if (version.code !== 0) return false;
	await runGit(repoPath, ["lfs", "install", "--local"], 60000);

	const attributes = path.join(repoPath, ".gitattributes");
	const pattern = "store/**/large/** filter=lfs";
	try {
		const text = fs.existsSync(attributes) ? fs.readFileSync(attributes, "utf8") : "";
		if (!text.includes(pattern)) {
			await runGit(repoPath, ["lfs", "track", "store/**/large/**"], 60000);
		}
	} catch {}
	return true;
}

/** 确保 data 仓库使用二进制模式保存文件，避免 CRLF 归一化破坏清单哈希 */
export async function ensureAttributes(repoPath) {
	const file = path.join(repoPath, ".gitattributes");
	const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	const lines = existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	// 移除旧的全局 text 归一化规则（会改变文件字节，导致 manifest 哈希不一致）
	const kept = lines.filter((line) => !line.startsWith("* ") && line !== "*" && !line.startsWith("store/**/large/**"));
	const required = ["* -text", "store/**/large/** filter=lfs diff=lfs merge=lfs -text"];
	let changed = false;
	for (const line of required) {
		if (!kept.includes(line)) {
			kept.push(line);
			changed = true;
		}
	}
	if (changed || kept.length !== lines.length) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, kept.join("\n") + "\n", "utf8");
		return true;
	}
	return false;
}

/** 提交全部改动并推送；无变化时不提交 */
export async function commitAndPush(repoPath, message) {
	await runGit(repoPath, ["add", "-A"], 120000);
	const status = await runGit(repoPath, ["status", "--porcelain"], 30000);
	if (!status.out.trim()) return { committed: false, pushed: false, output: "内容无变化，未生成新提交" };

	const commit = await runGit(repoPath, ["commit", "-m", message], 120000);
	if (commit.code !== 0) return { committed: false, pushed: false, error: (commit.err || commit.out).trim() };

	let branch = "main";
	const head = await runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], 15000);
	if (head.code === 0 && head.out.trim() && head.out.trim() !== "HEAD") branch = head.out.trim();

	const push = await runGit(repoPath, ["push", "-u", "origin", branch], 600000);
	if (push.code !== 0) {
		return { committed: true, pushed: false, branch, error: (push.err || push.out).trim() };
	}
	return { committed: true, pushed: true, branch, output: "已提交并推送" };
}

/** 拉取远端（fast-forward） */
export async function pull(repoPath) {
	let branch = "main";
	const head = await runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], 15000);
	if (head.code === 0 && head.out.trim() && head.out.trim() !== "HEAD") branch = head.out.trim();
	return runGit(repoPath, ["pull", "--ff-only", "origin", branch], 600000);
}

export async function isGitRepo(dir) {
	if (!fs.existsSync(path.join(dir, ".git"))) return false;
	const result = await runGit(dir, ["rev-parse", "--git-dir"], 15000);
	return result.code === 0;
}
