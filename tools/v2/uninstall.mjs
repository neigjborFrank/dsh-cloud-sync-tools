// 从 DSH profile 卸载云端同步插件（默认保留用户配置 repos.json，可 --purge-data）
// 运行：node tools/v2/uninstall.mjs [--dsh-home <path>] [--profile desktop] [--purge-data]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (name, fallback) => {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
};
const dshHome = arg("dsh-home", process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
const profileName = arg("profile", "desktop");
const profileDir = path.join(dshHome, "profiles", profileName);
const packageFile = path.join(profileDir, "package.json");
const purgeData = process.argv.includes("--purge-data");
const PLUGIN = "dsh-plugin-cloud-sync-panel";

if (!fs.existsSync(packageFile)) {
	console.error(`[x] 找不到 profile：${packageFile}`);
	process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const manifest = JSON.parse(fs.readFileSync(packageFile, "utf8").replace(/^\uFEFF/, ""));
const before = {
	dependency: (manifest.dependencies || {})[PLUGIN] || "",
	bundles: ((manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []).filter((name) => name === PLUGIN).length,
};

fs.copyFileSync(packageFile, `${packageFile}.bak-uninstall-${timestamp}`);
if (manifest.dependencies) delete manifest.dependencies[PLUGIN];
if (manifest.dsh && manifest.dsh.profile) {
	manifest.dsh.profile.bundles = (manifest.dsh.profile.bundles || []).filter((name) => name !== PLUGIN);
}
fs.writeFileSync(packageFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`[ok] 已从 profile 移除插件条目（备份 package.json.bak-uninstall-${timestamp}）`);
console.log(`     卸载前：dependency=${before.dependency || "(无)"}，bundle 条目=${before.bundles}`);

// 用 DSH 自带 pnpm 清理依赖链接
const pnpm = path.join(dshHome, "dsh-runtimes", "dsh-primary-runtime", "dependencies", "pnpm", "bin", "pnpm.cjs");
const node = process.execPath;
if (fs.existsSync(pnpm)) {
	try {
		execFileSync(node, [pnpm, "install"], { cwd: profileDir, stdio: "pipe", timeout: 600000 });
		console.log("[ok] profile 依赖已清理（pnpm install）");
	} catch (error) {
		console.warn("[!] pnpm install 失败：" + String(error.stderr || error.message).slice(0, 300));
	}
} else {
	console.warn("[!] 未找到 DSH 自带 pnpm，跳过依赖清理");
}

// 清理 node_modules 中的链接/目录（pnpm 通常已处理）
const modulePath = path.join(profileDir, "node_modules", PLUGIN);
try {
	if (fs.existsSync(modulePath) || fs.lstatSync(modulePath, { throwIfNoEntry: false })) {
		fs.rmSync(modulePath, { recursive: true, force: true });
		console.log("[ok] 已清理 node_modules 中的插件目录");
	}
} catch {}

if (purgeData) {
	const reposFile = path.join(dshHome, "cloud-sync", "repos.json");
	if (fs.existsSync(reposFile)) {
		fs.rmSync(reposFile, { force: true });
		console.log("[ok] 已按 --purge-data 删除仓库登记 repos.json");
	}
} else {
	console.log("[i] 保留用户配置 %DSH_HOME%\\cloud-sync\\repos.json（私有仓库登记）");
}

// 最终校验
const after = JSON.parse(fs.readFileSync(packageFile, "utf8").replace(/^\uFEFF/, ""));
const stillDependency = (after.dependencies || {})[PLUGIN] || "";
const stillBundle = ((after.dsh && after.dsh.profile && after.dsh.profile.bundles) || []).includes(PLUGIN);
console.log(`[i] 校验：dependency=${stillDependency || "(已移除)"}；bundles 含插件=${stillBundle}`);
process.exitCode = stillDependency || stillBundle ? 1 : 0;
