// 复杂文件结构保存测试：上传 test 工作区到真实云端仓库，核对 store/index 结构与内容
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [pluginDir, repoRoot, workspace, base, portArg] = process.argv.slice(2);
const port = Number(portArg || 8860);
const result = [];
const check = (name, pass, detail) => {
	result.push({ name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });

const EXCLUDED = ["node_modules", "out", ".csp-trash-test"];
const sessionId = "session-22c42740-ca37-4f54-b4ae-2ae0eb72280f";

const mod = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);
let dispose = null;
mod.apply({ effect: (fn) => { dispose = fn(); } }, { workspace: repoRoot, port });
await new Promise((r) => setTimeout(r, 1200));
const baseUrl = `http://127.0.0.1:${port}`;
const token = (await fetch(baseUrl + "/token").then((r) => r.json())).token;
const call = (p, init) => fetch(`${baseUrl}${p}${p.includes("?") ? "&" : "?"}token=${token}`, init).then((r) => r.json());
const post = (p, body) => call(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// 上传
const repos = (await call("/api/repos")).repos;
const repoId = repos[0].id;
const up = await post("/api/upload-project", { cwd: workspace, sessionIds: [sessionId], repoId });
console.log("上传结果:\n" + up.output);
check("U1 上传成功", up.ok === true);

const projectName = fs.readdirSync(path.join(repoRoot, "index", "projects"))[0];
const indexDir = path.join(repoRoot, "index", "projects", projectName);
const storeDir = path.join(repoRoot, "store", projectName);
const manifest = JSON.parse(fs.readFileSync(path.join(indexDir, "manifest.json"), "utf8"));
const manifestPaths = Object.keys(manifest.files).sort();

// 期望的文件集合（相对工作区，排除 EXCLUDED）
const walk = (dir, prefix = "") =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (EXCLUDED.includes(e.name)) return [];
		const rel = prefix ? `${prefix}/${e.name}` : e.name;
		return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel];
	});
const expected = walk(workspace).sort();
check("S1 清单文件数 = 期望文件数", manifestPaths.length === expected.length, `${manifestPaths.length} / ${expected.length}`);
check("S1b 清单与期望路径完全一致", JSON.stringify(manifestPaths) === JSON.stringify(expected), JSON.stringify(manifestPaths.filter((p) => !expected.includes(p))));
check("S2 排除目录未入库", !manifestPaths.some((p) => p.startsWith("node_modules/") || p.startsWith("out/") || p.startsWith(".csp-trash-test/")));
check("S2b store 里同样没有排除目录", !fs.existsSync(path.join(storeDir, "files", "node_modules")) && !fs.existsSync(path.join(storeDir, "files", "out")));
check("S3 中文目录/文件名保留", fs.existsSync(path.join(storeDir, "files", "中文资料", "第一章", "说明 文档.md")));
check("S4 空文件被保存", fs.existsSync(path.join(storeDir, "files", "empty", "empty.txt")) && fs.statSync(path.join(storeDir, "files", "empty", "empty.txt")).size === 0);
check("S5 深层目录被保存", fs.existsSync(path.join(storeDir, "files", "deep", "a", "b", "c", "d", "e", "f", "g", "deep.txt")));
check("S6 文件名含空格/符号被保存", fs.existsSync(path.join(storeDir, "files", "spaces and glyphs", "file (1).txt")) && fs.existsSync(path.join(storeDir, "files", "spaces and glyphs", "符号#&@+=,.txt")));
check("S7 emoji 文件名被保存", fs.existsSync(path.join(storeDir, "files", "emoji-😀-文件.txt")));
check("S8 超长文件名被保存", manifestPaths.some((p) => p.includes("long-xxxx")));

// 内容校验
let mismatch = 0;
for (const rel of manifestPaths) {
	const storeFile = path.join(storeDir, "files", rel);
	const sourceFile = path.join(workspace, rel);
	if (!fs.existsSync(storeFile) || sha(storeFile) !== sha(sourceFile)) mismatch++;
}
check("S9 每个文件内容与源文件一致（sha256）", mismatch === 0, `${mismatch} 个不一致`);

// 二进制文件大小
const binSize = fs.statSync(path.join(storeDir, "files", "binary", "blob.bin")).size;
check("S10 二进制文件完整保存", binSize === 1536 * 1024, `${binSize} bytes`);

// 重复内容 → git 同一个 blob（去重）
const dupTree = git(["ls-tree", "-r", "HEAD", `store/${projectName}/files/duplicates`]);
const dupBlobs = dupTree.trim().split("\n").map((l) => l.split(/\s+/)[2]);
check("S11 相同内容的文件在 git 中只存一个 blob", dupBlobs.length === 2 && dupBlobs[0] === dupBlobs[1], JSON.stringify(dupBlobs));

// 会话与 workspace-ref
const sessionDir = path.join(indexDir, "sessions", sessionId);
check("S12 会话保存在指示区", fs.existsSync(path.join(sessionDir, "session.v4.jsonl.zstd")));
const ref = JSON.parse(fs.readFileSync(path.join(sessionDir, "workspace-ref.json"), "utf8"));
check("S13 会话带工作区结构快照", ref.project === projectName && /^[0-9a-f]{64}$/.test(ref.manifestHash) && ref.files === expected.length, JSON.stringify(ref));

// 下载还原并比对
const downloadRoot = path.join(base, "download-check");
const dl = await post("/api/download-project", { repoId, name: projectName, targetDir: downloadRoot, sessionIds: [], withWorkspace: true });
let dlMismatch = 0;
for (const rel of manifestPaths) {
	const target = path.join(downloadRoot, rel);
	if (!fs.existsSync(target) || sha(target) !== sha(path.join(workspace, rel))) dlMismatch++;
}
check("D1 下载后文件数与源一致", (dl.workspace && dl.workspace.written) === expected.length, `written=${dl.workspace && dl.workspace.written}`);
check("D2 下载后每个文件内容一致", dlMismatch === 0, `${dlMismatch} 个不一致`);
check("D3 下载目录不含被排除内容", !fs.existsSync(path.join(downloadRoot, "node_modules")) && !fs.existsSync(path.join(downloadRoot, "out")));

// git 状态
const status = git(["status", "--porcelain"]);
check("G1 已提交（工作区干净）", status.trim() === "", status.trim().slice(0, 200));
const log = git(["log", "--oneline", "-1"]).trim();
console.log("\n云端结构:");
const tree = git(["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n");
console.log(tree.slice(0, 40).join("\n"));
console.log(`\n最近提交: ${log}`);
console.log(`项目: ${projectName} | 文件: ${manifestPaths.length} | 会话: 1`);

dispose();
const failed = result.filter((x) => !x.pass);
console.log(`\n汇总：${result.length - failed.length}/${result.length} 通过`);
if (failed.length) console.log("失败：", failed.map((x) => x.name).join("；"));
process.exitCode = failed.length ? 1 : 0;
