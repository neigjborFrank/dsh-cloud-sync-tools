// 多仓库联调：默认不自动登记、显式登记后才可同步、上传到指定仓库、合并视图、下载
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const [pluginDir, base, portArg] = process.argv.slice(2);
const port = Number(portArg || 8820);
const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

const git = (cwd, args) => execFileSync("git", args, { cwd, stdio: "ignore" });
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, "home");
const repoA = path.join(base, "repoA");
const repoB = path.join(base, "repoB");
const remoteA = path.join(base, "remoteA.git");
const remoteB = path.join(base, "remoteB.git");
const workspace = path.join(base, "workspace");
process.env.DSH_HOME = home;

fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "hello.md"), "# hi\n", "utf8");
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
const sessionId = "session-99999999-9999-4999-8999-999999999999";
const sessionDir = path.join(home, "sessions", projectKeyOf(workspace), sessionId);
fs.mkdirSync(sessionDir, { recursive: true });
const header = JSON.stringify({ type: "session", version: 4, id: sessionId, createdAt: Date.now(), cwd: workspace });
fs.writeFileSync(path.join(sessionDir, "session.v4.jsonl.zstd"), zlib.zstdCompressSync(Buffer.from(header + "\n", "utf8")));
fs.mkdirSync(path.join(home, "storages"), { recursive: true });
fs.writeFileSync(
	path.join(home, "storages", "workspace.json"),
	JSON.stringify({ unit: { name: "workspace", version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [] }, tables: { workspaces: {} } }),
);

for (const [repo, remote] of [
	[repoA, remoteA],
	[repoB, remoteB],
]) {
	fs.mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
	git(repo, ["init", "-b", "main"]);
	git(repo, ["config", "user.name", "T"]);
	git(repo, ["config", "user.email", "t@local"]);
	git(repo, ["remote", "add", "origin", remote]);
	fs.writeFileSync(path.join(repo, ".gitignore"), "out/\n", "utf8");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-m", "init"]);
}

const mod = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);
let dispose = null;
mod.apply({ effect: (fn) => { dispose = fn(); } }, { workspace: repoA, port });
await new Promise((r) => setTimeout(r, 1200));
const baseUrl = `http://127.0.0.1:${port}`;
const token = (await fetch(baseUrl + "/token").then((r) => r.json())).token;
const call = (p, init) => fetch(`${baseUrl}${p}${p.includes("?") ? "&" : "?"}token=${token}`, init).then((r) => r.json());
const post = (p, body) => call(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// S1: 默认不自动登记
let repos = (await call("/api/repos")).repos;
check("S1 启动不自动登记任何仓库", repos.length === 0, JSON.stringify(repos.map((r) => r.name)));

// S2: 空登记时上传应被拒绝
const upEmpty = await post("/api/upload-project", { cwd: workspace, sessionIds: [sessionId] });
check("S2 未登记仓库时上传被拒绝", upEmpty.ok === false && upEmpty.error === "no-repo", upEmpty.output || "");

// S3: 显式登记本机仓库
const regA = await post("/api/repos", { path: repoA, name: "主仓库" });
check("S3 显式登记本机仓库", regA.ok === true && (regA.repos || []).length === 1, JSON.stringify((regA.repos || []).map((r) => r.name)));
const repoAId = (regA.repos || [])[0].id;

// S4: 添加第二仓库（克隆）
const added = await post("/api/repos", { url: remoteB, name: "备份仓库" });
check("S4 添加第二仓库并克隆", added.ok === true && (added.repos || []).length === 2, JSON.stringify((added.repos || []).map((r) => r.name)));
const repoBId = (added.repos || []).find((r) => r.name === "备份仓库").id;

// S5: 上传到两个仓库
const upA = await post("/api/upload-project", { cwd: workspace, sessionIds: [sessionId], repoId: repoAId });
check("S5 上传到主仓库", upA.ok === true, (upA.output || "").split("\n")[0]);
const upB = await post("/api/upload-project", { cwd: workspace, sessionIds: [sessionId], repoId: repoBId });
check("S6 上传到第二仓库", upB.ok === true, (upB.output || "").split("\n")[0]);

// S7: 合并视图
const view = await call("/api/cloud-view");
const project = (view.projects || []).find((p) => (p.repoNames || []).length === 2);
check("S7 两仓库项目合并为一项", Boolean(project), JSON.stringify((view.projects || []).map((p) => [p.title, p.repoNames])));
check("S7b 合并后会话去重", Boolean(project && project.sessions.filter((s) => s.id === sessionId).length === 1));

// S8: 从第二仓库下载
const target = path.join(base, "downloaded");
const dl = await post("/api/download-project", { repoId: repoBId, name: project.name, targetDir: target, sessionIds: [sessionId], withWorkspace: true });
check("S8 从第二仓库下载成功", dl.ok === true && fs.existsSync(path.join(target, "hello.md")), (dl.output || "").split("\n")[0]);
check("S8b 下载会话 cwd 指向新目录", fs.existsSync(path.join(home, "sessions", projectKeyOf(target), sessionId, "session.v4.jsonl.zstd")));

// S9: 移除仓库 B
const rm = await post("/api/repos/remove", { id: repoBId });
check("S9 移除第二仓库", rm.ok === true && (rm.repos || []).length === 1);
const view2 = await call("/api/cloud-view");
check("S9b 移除后视图只剩一个仓库", (view2.repos || []).filter((r) => r.ok).length === 1);

dispose();
const failed = results.filter((r) => !r.pass);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log("失败：", failed.map((r) => r.name).join("；"));
process.exitCode = failed.length ? 1 : 0;
