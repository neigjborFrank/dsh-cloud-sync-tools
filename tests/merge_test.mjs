// 测试：包含关系智能合并（子目录并入父项目 / 上传父目录时并入已有子项目 / 冲突隔离）
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const [pluginDir, base, portArg] = process.argv.slice(2);
const port = Number(portArg || 8851);
const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, "home");
const repo = path.join(base, "toolrepo");
const remote = path.join(base, "remote.git");
const tree = path.join(base, "tree");
const proj = path.join(tree, "proj");
const sub = path.join(proj, "sub");
process.env.DSH_HOME = home;

fs.mkdirSync(sub, { recursive: true });
fs.mkdirSync(tree, { recursive: true });
fs.writeFileSync(path.join(proj, "a.txt"), "A1\n", "utf8");
fs.writeFileSync(path.join(sub, "b.txt"), "B1\n", "utf8");

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
const makeSession = (cwd, id) => {
	const dir = path.join(home, "sessions", projectKeyOf(cwd), id);
	fs.mkdirSync(dir, { recursive: true });
	const header = JSON.stringify({ type: "session", version: 4, id, createdAt: Date.now(), cwd });
	fs.writeFileSync(path.join(dir, "session.v4.jsonl.zstd"), zlib.zstdCompressSync(Buffer.from(header + "\n", "utf8")));
};
const sidProj = "session-11111111-1111-4111-8111-111111111111";
const sidSub = "session-22222222-2222-4222-8222-222222222222";
const sidTree = "session-33333333-3333-4333-8333-333333333333";
makeSession(proj, sidProj);
makeSession(sub, sidSub);
makeSession(tree, sidTree);
fs.mkdirSync(path.join(home, "storages"), { recursive: true });
fs.writeFileSync(
	path.join(home, "storages", "workspace.json"),
	JSON.stringify({ unit: { name: "workspace", version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [] }, tables: { workspaces: {} } }),
);

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
mod.apply({ effect: (fn) => { dispose = fn(); } }, { workspace: repo, port });
await new Promise((r) => setTimeout(r, 1200));
const baseUrl = `http://127.0.0.1:${port}`;
const token = (await fetch(baseUrl + "/token").then((r) => r.json())).token;
const call = (p, init) => fetch(`${baseUrl}${p}${p.includes("?") ? "&" : "?"}token=${token}`, init).then((r) => r.json());
const post = (p, body) => call(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const projectsRoot = path.join(repo, "index", "projects");
const storeRoot = path.join(repo, "store");

// 注册仓库（显式，本机路径）
const reg = await post("/api/repos", { path: repo, name: "主仓库" });
const repoId = reg.repos[0].id;

// 1) 首次上传 proj 工作区
let r = await post("/api/upload-project", { cwd: proj, sessionIds: [sidProj], repoId });
const projName = fs.readdirSync(projectsRoot)[0];
check("S1 首次上传建立项目", r.ok === true && fs.existsSync(path.join(projectsRoot, projName, "manifest.json")), projName);
check("S1b 文件保存到存储区且保持原始目录结构", fs.existsSync(path.join(storeRoot, projName, "files", "sub", "b.txt")));

// 2) 上传子目录工作区会话 → 应合并进父项目
r = await post("/api/upload-project", { cwd: sub, sessionIds: [sidSub], repoId });
const projectDirs = fs.readdirSync(projectsRoot);
check("S2 子目录工作区没有新建项目（合并进父项目）", projectDirs.length === 1, JSON.stringify(projectDirs));
const merged = readJson(path.join(projectsRoot, projName, "meta.json"));
check("S2b 父项目记录了子目录 alias", (merged.aliases || []).some((a) => a.scope === "sub" && a.cwd.toLowerCase() === sub.toLowerCase()), JSON.stringify(merged.aliases));
check("S2c 子目录会话存到父项目下", fs.existsSync(path.join(projectsRoot, projName, "sessions", sidSub, "session.v4.jsonl.zstd")));
const ref = readJson(path.join(projectsRoot, projName, "sessions", sidSub, "workspace-ref.json"));
check("S2d 会话带工作区结构快照引用", ref.project === projName && ref.scope === "sub" && /^[0-9a-f]{64}$/.test(ref.manifestHash), JSON.stringify({ project: ref.project, scope: ref.scope, files: ref.files }));

// 3) 上传父目录工作区 → 应把已有子项目迁入父项目
fs.writeFileSync(path.join(proj, "a.txt"), "A2\n", "utf8"); // 制造同路径不同内容冲突
r = await post("/api/upload-project", { cwd: tree, sessionIds: [sidTree], repoId });
console.log("S3 upload output:", JSON.stringify(r.output || r.error || null));
console.log("S3 projects:", JSON.stringify(fs.readdirSync(projectsRoot)));
const treeName = fs.readdirSync(projectsRoot)[0];
check("S3 父工作区合并后只保留一个项目", fs.readdirSync(projectsRoot).length === 1, JSON.stringify(fs.readdirSync(projectsRoot)));
check("S3b 存储区按最大工作区保存（父项目树含原子项目文件）", fs.existsSync(path.join(storeRoot, treeName, "files", "proj", "sub", "b.txt")));
check("S3c 冲突文件被隔离", fs.existsSync(path.join(projectsRoot, treeName, "conflicts")));
check("S3d 旧子项目会话被迁移", fs.existsSync(path.join(projectsRoot, treeName, "sessions", sidProj, "session.v4.jsonl.zstd")));
const treeMeta = readJson(path.join(projectsRoot, treeName, "meta.json"));
check("S3e 父项目记录旧项目 alias", (treeMeta.aliases || []).some((a) => a.scope === "proj"), JSON.stringify(treeMeta.aliases));
check("S3f 会话含工作区快照引用", fs.existsSync(path.join(projectsRoot, treeName, "sessions", sidTree, "workspace-ref.json")));

// 4) 视图：只显示一个工作区行，两个会话
const treeView = await call("/api/tree");
check("S4 项目树中只有一个工作区行", (treeView.projects || []).length === 1, JSON.stringify((treeView.projects || []).map((p) => p.name)));

dispose();
const failed = results.filter((r) => !r.pass);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log("失败：", failed.map((r) => r.name).join("；"));
process.exitCode = failed.length ? 1 : 0;
