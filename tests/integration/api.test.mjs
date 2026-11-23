// 集成测试：v2 Host API 全流程（多仓库登记 / 上传合并 / 下载 / 会话 cwd 改写 / 推送）
// 运行：node tests/integration/api.test.mjs <pluginDir> <base> <port>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const [pluginDir, base, portArg] = process.argv.slice(2);
const port = Number(portArg || 8891);
const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

const home = path.join(base, "home");
const repo = path.join(base, "toolrepo");
const remote = path.join(base, "remote.git");
const tree = path.join(base, "tree");
const proj = path.join(tree, "proj");
const sub = path.join(proj, "sub");
const downloadRoot = path.join(base, "download-check");

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
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const readHeader = (file) => {
	const buf = fs.readFileSync(file);
	const at = buf.indexOf(MAGIC);
	const next = buf.indexOf(MAGIC, at + 4);
	return JSON.parse(zstdDecompressSync(buf.subarray(at, next < 0 ? buf.length : next)).toString("utf8").split("\n").find(Boolean));
};
const makeSession = (cwd, id) => {
	const dir = path.join(home, "sessions", projectKeyOf(cwd), id);
	fs.mkdirSync(dir, { recursive: true });
	const header = JSON.stringify({ type: "session", version: 4, id, createdAt: 1, cwd });
	fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(header + "\n", "utf8")));
};

fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(sub, { recursive: true });
fs.mkdirSync(path.join(home, "storages"), { recursive: true });
fs.writeFileSync(
	path.join(home, "storages", "workspace.json"),
	JSON.stringify({ unit: { name: "workspace", version: 2 }, global: { initialized: true, workspaceIds: [], defaultWorkspaceId: null }, tables: { workspaces: {} } }),
	"utf8",
);
fs.writeFileSync(path.join(proj, "a.txt"), "A1\n", "utf8");
fs.writeFileSync(path.join(sub, "b.txt"), "B1\n", "utf8");

const sidProj = "session-11111111-1111-4111-8111-111111111111";
const sidSub = "session-22222222-2222-4222-8222-222222222222";
const sidTree = "session-33333333-3333-4333-8333-333333333333";
makeSession(proj, sidProj);
makeSession(sub, sidSub);
makeSession(tree, sidTree);
process.env.DSH_HOME = home;

const git = (args, cwd = repo) => execFileSync("git", args, { cwd, stdio: "ignore" });
fs.mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
git(["init", "-b", "main"]);
git(["config", "user.name", "T"]);
git(["config", "user.email", "t@local"]);
git(["remote", "add", "origin", remote]);
fs.writeFileSync(path.join(repo, ".gitignore"), "out/\n", "utf8");
git(["add", "-A"]);
git(["commit", "-m", "init"]);

const mod = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);
let dispose = null;
mod.apply({ effect: (fn) => { dispose = fn(); } }, { workspace: repo, port, downloadBase: path.join(base, "default-downloads") });
const started = await mod.whenReady();
const baseUrl = `http://127.0.0.1:${started.port}`;
const token = (await fetch(baseUrl + "/token").then((r) => r.json())).token;
const call = (p, init) => fetch(`${baseUrl}${p}${p.includes("?") ? "&" : "?"}token=${token}`, init).then((r) => r.json());
const post = (p, body) => call(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const projectsRoot = path.join(repo, "index", "projects");
const storeRoot = path.join(repo, "store");

// CORS 预检回归（浏览器页面端口 != 8732，POST 带 content-type 会触发预检）
const preflight = await fetch(`${baseUrl}/api/repos`, {
	method: "OPTIONS",
	headers: {
		Origin: "http://127.0.0.1:19387",
		"Access-Control-Request-Method": "POST",
		"Access-Control-Request-Headers": "content-type",
	},
});
check(
	"X1 预检返回 Allow-Headers（content-type）",
	/content-type/i.test(preflight.headers.get("access-control-allow-headers") || ""),
	preflight.headers.get("access-control-allow-headers") || "(缺失)",
);
check(
	"X2 预检返回 Allow-Methods（POST）",
	/POST/i.test(preflight.headers.get("access-control-allow-methods") || ""),
	preflight.headers.get("access-control-allow-methods") || "(缺失)",
);
const healthResponse = await fetch(`${baseUrl}/api/health`);
check("X3 正常响应带 Allow-Origin", healthResponse.headers.get("access-control-allow-origin") === "*", healthResponse.headers.get("access-control-allow-origin") || "(缺失)");

// 目录选择能力（probe 只探测，不打开系统弹窗）
const pickerProbe = await post("/api/pick-directory", { probe: true });
check(
	"Y1 目录选择能力可用（probe 不弹框）",
	pickerProbe.available === true && ["windows", "native", "legacy"].includes(pickerProbe.kind),
	JSON.stringify(pickerProbe),
);

// 登记仓库
let response = await post("/api/repos", { path: repo, name: "主仓库" });
check("R1 登记本机仓库", response.ok === true && response.repos.length === 1, JSON.stringify(response.repos));
const repoId = response.repos[0].id;

// 通过 URL 克隆登记（对应"配置私有仓库地址"：git@... 或本机 bare 路径）
const remote2 = path.join(base, "remote2.git");
execFileSync("git", ["init", "--bare", remote2], { stdio: "ignore" });
response = await post("/api/repos", { url: remote2, name: "URL 仓库" });
const clonedDir = path.join(home, "cloud-sync", "repos", "remote2");
check("R2 通过 URL 克隆登记私有仓库", response.ok === true && response.repos.length === 2 && fs.existsSync(path.join(clonedDir, ".git")), JSON.stringify(response.repos.map((r) => r.name)));
response = await post("/api/repos/remove", { id: response.repos[1].id });
check("R3 移除 URL 仓库后只剩主仓库", response.ok === true && response.repos.length === 1);


// 首次上传
response = await post("/api/upload-project", { cwd: proj, sessionIds: [sidProj], repoId });
check("U1 首次上传成功", response.ok === true);
const projName = fs.readdirSync(projectsRoot)[0];
check("U2 store/index 分离且文件保持结构", fs.existsSync(path.join(storeRoot, projName, "files", "sub", "b.txt")) && fs.existsSync(path.join(projectsRoot, projName, "manifest.json")));

// 子目录工作区 → 并入父项目
response = await post("/api/upload-project", { cwd: sub, sessionIds: [sidSub], repoId });
check("U3 子目录合并（不新建项目）", response.ok === true && fs.readdirSync(projectsRoot).length === 1 && response.projectName === projName);
const projMeta = readJson(path.join(projectsRoot, projName, "meta.json"));
check("U4 记录子目录 alias", (projMeta.aliases || []).some((alias) => alias.scope === "sub"));
check("U5 子目录会话存到父项目", fs.existsSync(path.join(projectsRoot, projName, "sessions", sidSub, "session.v4.jsonl.zstd")));
const ref = readJson(path.join(projectsRoot, projName, "sessions", sidSub, "workspace-ref.json"));
check("U6 会话带 workspace-ref", ref.project === projName && ref.scope === "sub" && /^[0-9a-f]{64}$/.test(ref.manifestHash));

// 父工作区包含旧项目 → 旧项目迁入新项目
fs.writeFileSync(path.join(proj, "a.txt"), "A2\n", "utf8");
response = await post("/api/upload-project", { cwd: tree, sessionIds: [sidTree], repoId });
const treeName = fs.readdirSync(projectsRoot)[0];
check("U7 父工作区合并后只保留一个项目", response.ok === true && fs.readdirSync(projectsRoot).length === 1, JSON.stringify(fs.readdirSync(projectsRoot)));
check("U8 旧项目文件迁入新 store", fs.existsSync(path.join(storeRoot, treeName, "files", "proj", "sub", "b.txt")));
check("U9 冲突文件被隔离", fs.existsSync(path.join(projectsRoot, treeName, "conflicts")));
check("U10 旧项目会话被迁移", fs.existsSync(path.join(projectsRoot, treeName, "sessions", sidProj, "session.v4.jsonl.zstd")));
const treeMeta = readJson(path.join(projectsRoot, treeName, "meta.json"));
check("U11 父项目记录嵌套 alias", (treeMeta.aliases || []).some((alias) => alias.scope === "proj") && (treeMeta.aliases || []).some((alias) => alias.scope === "proj/sub"));

// 视图
const treeView = await call("/api/tree");
check("V1 项目树只有一个工作区行", (treeView.projects || []).length === 1, JSON.stringify((treeView.projects || []).map((p) => p.name)));
const cloudView = await call("/api/cloud-view");
check("V2 云端视图聚合", cloudView.ok === true && (cloudView.projects || []).length === 1);

// 下载（工作区 + 会话）
response = await post("/api/download-project", { repoId, name: treeName, targetDir: downloadRoot, sessionIds: [sidSub], withWorkspace: true });
check("D1 下载成功", response.ok === true);
check("D2 工作区文件还原", fs.existsSync(path.join(downloadRoot, "proj", "sub", "b.txt")) && fs.existsSync(path.join(downloadRoot, "proj", "a.txt")));
check("D3 下载校验通过", response.workspace && response.workspace.verified === response.workspace.written, JSON.stringify({ written: response.workspace?.written, verified: response.workspace?.verified, failed: response.workspace?.failed }));
const dlSession = path.join(home, "sessions", projectKeyOf(downloadRoot), sidSub, "session.v4.jsonl.zstd");
check("D4 会话下载并改写 cwd", fs.existsSync(dlSession) && readHeader(dlSession).cwd === downloadRoot);
check("D5 工作区登记", response.registration && response.registration.ok === true, JSON.stringify(response.registration));

// 默认下载目录：未指定 targetDir 时自动在默认根目录下创建项目文件夹
const treeWithBase = await call("/api/tree");
check(
	"Z1 提供默认下载根目录",
	treeWithBase.suggestedBase === path.join(base, "default-downloads"),
	JSON.stringify(treeWithBase.suggestedBase),
);
response = await post("/api/download-project", { repoId, name: treeName, targetDir: "", sessionIds: [], withWorkspace: true });
const autoTarget = response.targetDir || "";
check(
	"Z2 未指定目录时自动创建文件夹并下载",
	response.ok === true && autoTarget.startsWith(path.join(base, "default-downloads")) && fs.existsSync(path.join(autoTarget, "proj", "sub", "b.txt")),
	JSON.stringify({ ok: response.ok, targetDir: autoTarget }),
);

// 工作区列表 / 删除（官方服务不可用时走文件兜底）
const workspacesBefore = await call("/api/workspaces");
const workspaceList = workspacesBefore.workspaces || [];
const targetWorkspace = workspaceList.find((workspace) => workspace.path === autoTarget);
check("Z3 工作区列表可读取", workspacesBefore.ok === true && Array.isArray(workspaceList) && Boolean(targetWorkspace), JSON.stringify({ mode: workspacesBefore.mode, count: workspaceList.length }));
if (targetWorkspace) {
	const removeResult = await post("/api/workspaces/remove", { ids: [targetWorkspace.id] });
	const workspacesAfter = await call("/api/workspaces");
	check(
		"Z4 工作区可删除（兜底模式）",
		removeResult.ok === true && !(workspacesAfter.workspaces || []).some((workspace) => workspace.id === targetWorkspace.id),
		JSON.stringify({ mode: removeResult.mode, output: removeResult.output }),
	);
}

// 推送与历史
const remoteLog = execFileSync("git", ["log", "--oneline", "-1", "main"], { cwd: remote, encoding: "utf8" }).trim();
check("G1 已推送到远端", remoteLog.length > 0, remoteLog);
const headTree = execFileSync("git", ["ls-tree", "-r", "--name-only", "main"], { cwd: remote, encoding: "utf8" });
check("G2 远端提交包含 store/index", headTree.includes("store/") && headTree.includes("index/projects/"));

// 多设备：另一台设备把新项目/会话推送到远端 → 本机拉取后应可见并可下载
const deviceB = path.join(base, "deviceB");
execFileSync("git", ["-c", "core.longpaths=true", "clone", "--quiet", "--branch", "main", remote, deviceB], { stdio: ["ignore", "ignore", "ignore"] });
const remoteProject = "remote-project";
const remoteSid = "session-99999999-9999-4999-8999-999999999999";
const remoteWorkspace = path.join(base, "remote-workspace");
fs.mkdirSync(remoteWorkspace, { recursive: true });
const remoteFile = path.join(remoteWorkspace, "hello.txt");
fs.writeFileSync(remoteFile, "remote hello\n", "utf8");
const remoteHash = createHash("sha256").update(fs.readFileSync(remoteFile)).digest("hex");
const remoteIndex = path.join(deviceB, "index", "projects", remoteProject);
const remoteStore = path.join(deviceB, "store", remoteProject, "files");
fs.mkdirSync(path.join(remoteIndex, "sessions", remoteSid), { recursive: true });
fs.mkdirSync(remoteStore, { recursive: true });
fs.copyFileSync(remoteFile, path.join(remoteStore, "hello.txt"));
fs.writeFileSync(path.join(remoteIndex, "manifest.json"), JSON.stringify({ schema: 1, files: { "hello.txt": { hash: remoteHash, size: 13 } }, large: [], tooLong: [] }));
fs.writeFileSync(path.join(remoteIndex, "large.json"), JSON.stringify({ schema: 1, large: [], tooLong: [] }));
fs.writeFileSync(path.join(remoteIndex, "meta.json"), JSON.stringify({ schema: 1, name: remoteProject, cwd: remoteWorkspace, title: "remote", aliases: [], sessions: [remoteSid] }));
fs.writeFileSync(path.join(remoteIndex, "sessions", remoteSid, "meta.json"), JSON.stringify({ schema: 1, id: remoteSid, title: "远端会话", cwd: remoteWorkspace, project: remoteProject, scope: "", sessionFile: "session.v4.jsonl.zstd", sessionBytes: 80 }));
const remoteSessionBin = zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", version: 4, id: remoteSid, createdAt: 1, cwd: remoteWorkspace }) + "\n", "utf8"));
fs.writeFileSync(path.join(remoteIndex, "sessions", remoteSid, "session.v4.jsonl.zstd"), remoteSessionBin);
fs.writeFileSync(
	path.join(remoteIndex, "sessions", remoteSid, "workspace-ref.json"),
	JSON.stringify({ schema: 1, project: remoteProject, scope: "", manifestHash: createHash("sha256").update(fs.readFileSync(path.join(remoteIndex, "manifest.json"))).digest("hex"), files: 1 }),
);
execFileSync("git", ["config", "user.name", "B"], { cwd: deviceB });
execFileSync("git", ["config", "user.email", "b@local"], { cwd: deviceB });
execFileSync("git", ["add", "-A"], { cwd: deviceB });
execFileSync("git", ["commit", "-m", "deviceB: remote session"], { cwd: deviceB, stdio: "ignore" });
execFileSync("git", ["push", "origin", "main"], { cwd: deviceB, stdio: "ignore" });

response = await post("/api/repos/pull", {});
check("M1 多设备：拉取远端成功", response.ok === true && response.changed === true, String(response.output || "").split("\n")[0]);
const cloudAfterPull = await call("/api/cloud-view");
const remoteRow = (cloudAfterPull.projects || []).find((project) => project.name === remoteProject);
check("M2 拉取后云端视图出现远端项目", Boolean(remoteRow), JSON.stringify((cloudAfterPull.projects || []).map((p) => p.name).slice(-4)));
check("M3 远端会话可见", Boolean(remoteRow && remoteRow.sessions.some((session) => session.id === remoteSid)));

const remoteDownload = path.join(base, "remote-download");
response = await post("/api/download-project", { repoId, name: remoteProject, targetDir: remoteDownload, sessionIds: [remoteSid], withWorkspace: true });
check(
	"M4 拉取后可下载远端项目与会话",
	response.ok === true && fs.existsSync(path.join(remoteDownload, "hello.txt")) && fs.existsSync(path.join(home, "sessions", projectKeyOf(remoteDownload), remoteSid, "session.v4.jsonl.zstd")),
	String(response.output || "").split("\n").slice(0, 2).join(" / "),
);

// 仓库移除：允许移除最后一个（空注册表合法）
response = await post("/api/repos/remove", { id: repoId });
check("X4 允许移除最后一个仓库", response.ok === true && Array.isArray(response.repos) && response.repos.length === 0, JSON.stringify(response.repos));

dispose();
await new Promise((resolve) => setTimeout(resolve, 200));
const failed = results.filter((item) => !item.pass);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log("失败：", failed.map((item) => item.name).join("；"));
process.exitCode = failed.length ? 1 : 0;
