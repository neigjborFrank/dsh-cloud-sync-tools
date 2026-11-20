// 真实环境安装前置检查（只读，不修改任何配置）
// 用途：在把 v2 装进真实 DSH 之前，确认 profile/运行时/git/仓库配置是否就绪。
// 运行：node tools/v2/preflight.mjs [--dsh-home <path>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argHome = process.argv.indexOf("--dsh-home") >= 0 ? process.argv[process.argv.indexOf("--dsh-home") + 1] : "";
const dshHome = argHome || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const pluginDir = path.join(root, "plugin-v2");
const results = [];
const check = (name, pass, detail, level = "FAIL") => {
	results.push({ name, pass, level });
	console.log(`${pass ? "PASS" : level === "WARN" ? "WARN" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};
const run = (command, args, cwd) => {
	try {
		return { code: 0, out: execFileSync(command, args, { cwd, encoding: "utf8", timeout: 20000, windowsHide: true }).trim() };
	} catch (error) {
		return { code: error.status || 1, out: String(error.stderr || error.message || "").trim() };
	}
};

// 1) 工具仓库与 v2 代码
check("工具仓库存在 .git", fs.existsSync(path.join(root, ".git")), root);
check("plugin-v2 代码完整", fs.existsSync(path.join(pluginDir, "index.js")) && fs.existsSync(path.join(pluginDir, "client.js")));
let version = "?";
try {
	version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
	const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
	check("VERSION 与 plugin-v2 版本一致", version === pkg.version, `${version} / ${pkg.version}`);
} catch {
	check("VERSION / package.json 可读", false);
}

// 2) DSH profile
const profilesRoot = path.join(dshHome, "profiles");
check("DSH_HOME 存在", fs.existsSync(dshHome), dshHome);
let profileDir = path.join(profilesRoot, "desktop");
if (!fs.existsSync(profileDir)) {
	const first = fs.existsSync(profilesRoot) ? fs.readdirSync(profilesRoot, { withFileTypes: true }).find((entry) => entry.isDirectory()) : null;
	profileDir = first ? path.join(profilesRoot, first.name) : profileDir;
}
const packageFile = path.join(profileDir, "package.json");
const profileExists = fs.existsSync(packageFile);
check("profile/package.json 存在", profileExists, packageFile);
let currentLink = "";
if (profileExists) {
	try {
		const json = JSON.parse(fs.readFileSync(packageFile, "utf8").replace(/^\uFEFF/, ""));
		currentLink = (json.dependencies && json.dependencies["dsh-plugin-cloud-sync-panel"]) || "";
		const bundles = (json.dsh && json.dsh.profile && json.dsh.profile.bundles) || [];
		console.log(`INFO  当前插件依赖：${currentLink || "(未安装)"}`);
		console.log(`INFO  profile bundles：${bundles.join(", ") || "(空)"}`);
		if (bundles.filter((item) => item === "dsh-plugin-cloud-sync-panel").length > 1) check("bundles 无重复项", false);
	} catch (error) {
		check("profile/package.json 可解析", false, error.message);
	}
}

// 3) 运行时（node / pnpm / git / lfs）
check("node 可用", Boolean(process.execPath), process.version);
const pnpmCandidates = [
	path.join(dshHome, "dsh-runtimes", "dsh-primary-runtime", "dependencies", "pnpm", "bin", "pnpm.cjs"),
	path.join(process.env.USERPROFILE || "", "AppData", "Roaming", "npm", "pnpm.cmd"),
];
const pnpm = pnpmCandidates.find((candidate) => fs.existsSync(candidate)) || "";
check("pnpm 可用（安装依赖需要）", Boolean(pnpm), pnpm || "未找到（安装时可能跳过依赖）", "WARN");
const gitVersion = run("git", ["--version"]);
check("git 可用", gitVersion.code === 0, gitVersion.out);
const lfsVersion = run("git", ["lfs", "version"]);
check("git-lfs 可用（大文件需要）", lfsVersion.code === 0, lfsVersion.out || "未安装（>95MB 大文件只记清单）", "WARN");

// 4) 仓库登记表
const reposFile = path.join(dshHome, "cloud-sync", "repos.json");
if (fs.existsSync(reposFile)) {
	try {
		const json = JSON.parse(fs.readFileSync(reposFile, "utf8"));
		const repos = Array.isArray(json.repos) ? json.repos : [];
		console.log(`INFO  已登记仓库：${repos.length} 个`);
		for (const repo of repos) {
			const alive = repo.path && fs.existsSync(path.join(repo.path, ".git"));
			console.log(`INFO    - ${repo.name || repo.id}：${repo.url || "(无地址)"} → ${alive ? "本地可用" : "本地缺失"}`);
		}
		const missing = repos.filter((repo) => !repo.path || !fs.existsSync(path.join(repo.path, ".git")));
		check("已登记仓库的本地路径可用", missing.length === 0, missing.map((repo) => repo.name).join(", ") || "OK", "WARN");
	} catch (error) {
		check("repos.json 可解析", false, error.message);
	}
} else {
	console.log("INFO  还没有登记同步仓库（首次安装后在「仓库管理…」登记即可）");
}

// 5) 结论
const failed = results.filter((item) => !item.pass && item.level === "FAIL");
const warned = results.filter((item) => !item.pass && item.level === "WARN");
console.log("");
console.log(`前置检查：${results.length - failed.length - warned.length} 项通过，${warned.length} 项提醒，${failed.length} 项失败`);
if (failed.length) {
	console.log("存在失败项，请先处理再安装。");
	process.exitCode = 1;
} else {
	console.log("环境就绪，可以执行真实安装（安装脚本会自动备份 profile）。");
}
