// 端到端：模拟新用户从零开始
//   1) 空的私有仓库（bare remote，模拟 GitHub 私密仓库）
//   2) 通过 API 配置"私有仓库地址"（URL 克隆登记）
//   3) 上传工作区 + 会话
//   4) 校验远端结构、.gitattributes、推送结果
//   5) 模拟"另一台设备"：全新克隆 → 读取清单/会话/下载还原
// 运行：node tests/integration/clean_setup.test.mjs <pluginDir> <base> <port>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const [pluginDir, base, portArg] = process.argv.slice(2);
const port = Number(portArg || 8930);
const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const home = path.join(base, "home");
const workspace = path.join(base, "workspace", "我的项目");
const bare = path.join(base, "private-cloud.git");
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
fs.writeFileSync(path.join(workspace, "readme.md"), "# 我的项目\n", "utf8");
fs.writeFileSync(path.join(workspace, "docs", "说明 文档.md"), "中文内容\n", "utf8");
fs.writeFileSync(path.join(workspace, "docs", "data.csv"), "id,值\r\n1,甲\r\n", "utf8");
fs.mkdirSync(path.join(home, "storages"), { recursive: true });
fs.writeFileSync(
	path.join(home, "storages", "workspace.json"),
	JSON.stringify({ unit: { name: "workspace", version: 2 }, global: { initialized: true, workspaceIds: [], defaultWorkspaceId: null }, tables: { workspaces: {} } }),
	"utf8",
);
process.env.DSH_HOME = home;

const projectKeyOf = (p) => {
	let out = "";
	let sep = false;
	for (const ch of p) {
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!sep) out += "-";
			sep = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			out += ch;
			sep = false;
		} else {
			out += "~" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
			sep = false;
		}
	}
	return `--${out.replace(/^-+/, "") || "root"}--`;
};
const sid = "session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionDir = path.join(home, "sessions", projectKeyOf(workspace), sid);
fs.mkdirSync(sessionDir, { recursive: true });
const sessionBuf = zstdCompressSync(
	Buffer.from(JSON.stringify({ type: "session", version: 4, id: sid, createdAt: 1, cwd: workspace }) + "\n", "utf8"),
);
fs.writeFileSync(path.join(sessionDir, "session.v4.jsonl.zstd"), sessionBuf);

const git = (args, cwd = base) => execFileSync("git", args, { cwd, encoding: "utf8" });
execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
// 空 bare 仓库默认 HEAD 是 master；把默认分支指到 main，模拟 GitHub 新建仓库的默认分支
execFileSync("git", ["-C", bare, "symbolic-ref", "HEAD", "refs/heads/main"], { stdio: "ignore" });

// ---------- 启动插件（模拟 DSH 宿主） ----------
const toolRoot = path.resolve(pluginDir, "..");
const mod = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);
let dispose = null;
mod.apply({ effect: (fn) => { dispose = fn(); } }, { workspace: toolRoot, port });
const started = await mod.whenReady();
const baseUrl = `http://127.0.0.1:${started.port}`;
const token = (await fetch(`${baseUrl}/token`).then((response) => response.json())).token;
const call = (apiPath, init) => fetch(`${baseUrl}${apiPath}${apiPath.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`, init).then((response) => response.json());
const post = (apiPath, body) => call(apiPath, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// 1) 配置私有仓库地址（URL 克隆登记）
let response = await post("/api/repos", { url: bare, name: "deepseek_cloud" });
const repoPath = response && response.added ? response.added.path : "";
check("E1 通过“私有仓库地址”登记并自动克隆", response.ok === true && fs.existsSync(path.join(repoPath, ".git")), repoPath);
check("E2 空仓库也能识别（origin 正确）", git(["config", "--get", "remote.origin.url"], repoPath).trim() === bare);
const repoId = response.added.id;

// 2) 上传工作区 + 会话
response = await post("/api/upload-project", { cwd: workspace, sessionIds: [sid], repoId });
check("E3 首次上传成功", response.ok === true, String(response.output || "").split("\n").slice(0, 2).join(" / "));

// 3) 远端校验
const remoteBranches = git(["branch", "--list", "main"], bare).trim();
check("E4 已推送到远端 main", Boolean(remoteBranches), remoteBranches);
const remoteTree = git(["ls-tree", "-r", "--name-only", "main"], bare);
check("E5 远端包含 store/ 与 index/", remoteTree.includes("store/") && remoteTree.includes("index/projects/"));
const attributes = git(["show", "main:.gitattributes"], bare);
check("E6 远端 .gitattributes 含 * -text（防行尾破坏）", attributes.includes("* -text") && attributes.includes("store/**/large/**"));
check("E7 工作区干净（提交后）", git(["status", "--porcelain"], repoPath).trim() === "");

// 4) 模拟另一台设备：全新克隆
const device2 = path.join(base, "device2");
execFileSync("git", ["-c", "core.longpaths=true", "clone", "--quiet", bare, device2], { stdio: "ignore" });
const toUrl = (relative) => pathToFileURL(path.join(pluginDir, relative)).href;
const layout = await import(toUrl("lib/core/layout.js"));
const project = await import(toUrl("lib/core/project.js"));
const session = await import(toUrl("lib/core/session.js"));
const download = await import(toUrl("lib/core/download.js"));

const projects = project.listProjects(device2);
check("E8 新设备识别项目与布局", projects.length === 1 && projects[0].files === 3, JSON.stringify(projects.map((p) => ({ name: p.name, files: p.files }))));

const manifest = readJson(path.join(projects[0].layoutDir, "manifest.json"));
let bad = 0;
for (const [rel, info] of Object.entries(manifest.files)) {
	const file = path.join(projects[0].storeFiles, rel);
	if (!fs.existsSync(file) || sha(file) !== info.hash) bad++;
}
check("E9 新设备清单哈希全部一致（行尾兼容）", bad === 0, `${Object.keys(manifest.files).length} 个文件，${bad} 个不一致`);

const cloudSessions = session.listCloudSessions(device2);
check("E10 新设备能看到云端会话", cloudSessions.length === 1 && cloudSessions[0].id === sid);
const ref = readJson(path.join(projects[0].dir, "sessions", sid, "workspace-ref.json"));
const manifestHash = createHash("sha256").update(fs.readFileSync(path.join(projects[0].layoutDir, "manifest.json"))).digest("hex");
check("E11 workspace-ref 与清单一致", ref.manifestHash === manifestHash);

const target = path.join(base, "downloaded");
const restored = await download.downloadWorkspace(device2, projects[0].name, target);
check("E12 新设备下载还原 + 校验", restored.written === 3 && restored.failed === 0 && restored.verified === 3, JSON.stringify({ written: restored.written, verified: restored.verified, failed: restored.failed }));
check("E13 中文文件名内容一致", fs.readFileSync(path.join(target, "docs", "说明 文档.md"), "utf8") === "中文内容\n");

// 5) 模拟第二设备下载会话（cwd 改写）
const home2 = path.join(base, "home2");
const downloadedSession = await session.downloadSession(device2, sid, { targetCwd: target, home: home2 });
const localFile = path.join(home2, "sessions", layout.projectKeyOf(target), sid, "session.v4.jsonl.zstd");
const header = (() => {
	const buf = fs.readFileSync(localFile);
	const at = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
	const next = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), at + 4);
	return JSON.parse(zstdDecompressSync(buf.subarray(at, next < 0 ? buf.length : next)).toString("utf8").split("\n").find(Boolean));
})();
check("E14 第二设备会话下载且 cwd 改写", downloadedSession.action === "written" && header.cwd === target);

dispose();
await new Promise((resolve) => setTimeout(resolve, 200));
const failedChecks = results.filter((item) => !item.pass);
console.log(`\n汇总：${results.length - failedChecks.length}/${results.length} 通过`);
if (failedChecks.length) console.log("失败：", failedChecks.map((item) => item.name).join("；"));
process.exitCode = failedChecks.length ? 1 : 0;
