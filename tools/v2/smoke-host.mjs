// 真实环境宿主冒烟测试（只读）：用真实 DSH_HOME 启动 v2 的 HTTP 服务，验证能读取真实仓库/项目/会话
// 运行：node tools/v2/smoke-host.mjs [--port 8944] [--dsh-home <path>]
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pluginDir = path.join(root, "plugin-v2");
const arg = (name, fallback) => {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
};
const port = Number(arg("port", "8944"));
const dshHome = arg("dsh-home", process.env.DSH_HOME || "");
if (dshHome) process.env.DSH_HOME = dshHome;

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

const mod = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);
let dispose = null;
const started = await mod.apply({ effect: (fn) => { dispose = fn(); } }, { workspace: root, port });
const base = `http://127.0.0.1:${started.port}`;
const get = async (apiPath, token) => {
	const url = `${base}${apiPath}${token ? (apiPath.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token) : ""}`;
	const response = await fetch(url);
	return { status: response.status, data: await response.json().catch(() => null) };
};

const health = await get("/api/health");
check("H1 健康检查（免鉴权）", health.status === 200 && health.data && health.data.ok === true, JSON.stringify(health.data && { service: health.data.service, version: health.data.version }));

const tokenResponse = await get("/token");
const token = tokenResponse.data && tokenResponse.data.token;
check("H2 取得访问令牌", Boolean(token) && token.length >= 16);

const repos = await get("/api/repos", token);
const repoList = (repos.data && repos.data.repos) || [];
check("H3 读取已登记仓库", repos.status === 200 && repoList.length >= 1, JSON.stringify(repoList.map((repo) => ({ name: repo.name, ok: repo.ok }))));

const tree = await get("/api/tree", token);
const projects = (tree.data && tree.data.projects) || [];
check("H4 读取项目树", tree.status === 200 && Array.isArray(projects), `项目 ${projects.length} 个`);

const sessions = await get("/api/sessions", token);
const sessionList = (sessions.data && sessions.data.sessions) || [];
check("H5 读取本机会话", sessions.status === 200 && Array.isArray(sessionList), `会话 ${sessionList.length} 个`);

const cloudView = await get("/api/cloud-view", token);
const cloudProjects = (cloudView.data && cloudView.data.projects) || [];
check("H6 读取云端视图", cloudView.status === 200 && Array.isArray(cloudProjects), `云端项目 ${cloudProjects.length} 个`);

const picker = await (async () => {
	const response = await fetch(`${base}/api/pick-directory?token=${encodeURIComponent(token)}`, { method: "POST" });
	return { status: response.status, data: await response.json() };
})();
check("H7 目录选择接口可用（无原生能力时 available:false）", picker.status === 200 && picker.data && typeof picker.data.available === "boolean", JSON.stringify(picker.data));

dispose();
await new Promise((resolve) => setTimeout(resolve, 200));
const failed = results.filter((item) => !item.pass);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length ? 1 : 0;
