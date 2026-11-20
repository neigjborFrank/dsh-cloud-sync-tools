// 重启后的运行时验证：检查真实 DSH 里 v2 是否已加载并读取真实数据（只读）
// 运行：node tools/v2/verify-runtime.mjs [--port 8732]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
};
const port = Number(arg("port", "8732"));
const base = `http://127.0.0.1:${port}`;
const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};
const get = async (apiPath, token) => {
	try {
		const separator = apiPath.includes("?") ? "&" : "?";
		const url = `${base}${apiPath}${token ? `${separator}token=${encodeURIComponent(token)}` : ""}`;
		const response = await fetch(url);
		const text = await response.text();
		let data = null;
		try {
			data = JSON.parse(text);
		} catch {}
		return { status: response.status, data, text };
	} catch (error) {
		return { status: 0, error: error.message };
	}
};

// 0) profile 状态：插件依赖与 bundles 是否被 DSH 回收（重启失败的常见原因）
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const profileFile = path.join(dshHome, "profiles", "desktop", "package.json");
try {
	const manifest = JSON.parse(fs.readFileSync(profileFile, "utf8").replace(/^\uFEFF/, ""));
	const dependency = (manifest.dependencies || {})["dsh-plugin-cloud-sync-panel"] || "";
	const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [];
	check("P1 profile 依赖指向插件", Boolean(dependency), dependency || "(未安装)");
	check("P2 profile bundles 含插件（未被 DSH 回收）", bundles.includes("dsh-plugin-cloud-sync-panel"), bundles.join(", "));
} catch (error) {
	check("P0 profile 可读取", false, error.message);
}

// 1) 健康检查：v2 返回 service=cloud-sync
const health = await get("/api/health");
const loaded = health.status === 200 && health.data && health.data.service === "cloud-sync";
if (!loaded) {
	console.log(`FAIL  真实 DSH 尚未加载 v2（${port} 返回 ${health.status || health.error}）`);
	console.log("请完全退出 DSH（含托盘）并重新启动后再运行本脚本。");
	console.log("若 P2 失败，说明 DSH 的\"禁用第三方插件\"恢复机制回收了 bundles，需重新安装并检查启动崩溃日志。");
	process.exit(2);
}
check("R1 v2 已加载（/api/health）", true, `version=${health.data.version}`);

// 2) 鉴权 + 真实数据
const tokenResponse = await get("/token");
const token = tokenResponse.data && tokenResponse.data.token;
check("R2 取得访问令牌", Boolean(token));

const repos = await get("/api/repos", token);
const repoList = (repos.data && repos.data.repos) || [];
check("R3 已登记仓库", repos.status === 200 && repoList.length >= 1, JSON.stringify(repoList.map((repo) => ({ name: repo.name, ok: repo.ok }))));

const tree = await get("/api/tree", token);
const projects = (tree.data && tree.data.projects) || [];
check("R4 项目树", tree.status === 200 && Array.isArray(projects), `项目 ${projects.length} 个`);

const sessions = await get("/api/sessions", token);
const sessionList = (sessions.data && sessions.data.sessions) || [];
check("R5 本机会话", sessions.status === 200 && Array.isArray(sessionList), `会话 ${sessionList.length} 个`);

const cloudView = await get("/api/cloud-view", token);
const cloudProjects = (cloudView.data && cloudView.data.projects) || [];
check("R6 云端视图", cloudView.status === 200 && Array.isArray(cloudProjects), `云端项目行 ${cloudProjects.length} 个`);

const registry = await get("/api/registry-status", token);
check("R7 注册表校验可用", registry.status === 200 && registry.data && typeof registry.data.valid === "boolean", `valid=${registry.data && registry.data.valid}`);

const failed = results.filter((item) => !item.pass);
console.log(`\n运行时验证：${results.length - failed.length}/${results.length} 通过`);
console.log("界面验证：侧边栏底部「同步」→ 四个菜单（上传会话…/下载会话…/云端与同步…/仓库管理…）");
process.exitCode = failed.length ? 1 : 0;
