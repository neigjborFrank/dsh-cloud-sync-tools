// 真实私有仓库只读兼容测试：用 v2 core 读取现有 store/index 数据并下载还原
// 运行：node tests/integration/compat.test.mjs <私有仓库路径或克隆> <临时目录>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const [repoRoot, baseArg] = process.argv.slice(2);
if (!repoRoot) {
	console.error("用法：node tests/integration/compat.test.mjs <私有仓库> [临时目录]");
	process.exit(2);
}

const pluginDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../../plugin-v2");
const toUrl = (p) => pathToFileURL(p).href;
const layout = await import(toUrl(path.join(pluginDir, "lib/core/layout.js")));
const project = await import(toUrl(path.join(pluginDir, "lib/core/project.js")));
const session = await import(toUrl(path.join(pluginDir, "lib/core/session.js")));
const download = await import(toUrl(path.join(pluginDir, "lib/core/download.js")));
const manifest = await import(toUrl(path.join(pluginDir, "lib/core/manifest.js")));

const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

const base = baseArg || fs.mkdtempSync(path.join(os.tmpdir(), "csp-compat-"));
fs.mkdirSync(base, { recursive: true });
const cloud = path.join(base, "cloud");

// 1) 准备克隆（若传入的是工作区路径则先只读克隆，避免触碰原仓库）
if (!fs.existsSync(path.join(repoRoot, ".git"))) {
	console.log("仓库路径无效：" + repoRoot);
	process.exit(2);
}
fs.rmSync(cloud, { recursive: true, force: true });
const { execFileSync } = await import("node:child_process");
execFileSync("git", ["clone", "--quiet", repoRoot, cloud], { stdio: "ignore" });
const layoutNow = fs.existsSync(path.join(cloud, "index"))
	? "v2 (store/index)"
	: fs.existsSync(path.join(cloud, "projects"))
		? "v1 (projects/)"
		: "empty";
check("C1 克隆成功且布局可识别", layoutNow !== "empty", layoutNow);

// 2) 项目清单
const projects = project.listProjects(cloud);
check("C2 能列出项目", projects.length >= 1, JSON.stringify(projects.map((p) => ({ name: p.name, files: p.files, sessions: p.sessionCount }))));

let totalFiles = 0;
let mismatch = 0;
for (const proj of projects) {
	const manifestPath = path.join(proj.layoutDir, "manifest.json");
	if (!fs.existsSync(manifestPath)) continue;
	const json = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	for (const [rel, info] of Object.entries(json.files || {})) {
		totalFiles++;
		const file = path.join(proj.storeFiles, rel);
		if (!fs.existsSync(file) || sha(file) !== info.hash) mismatch++;
	}
}
check("C3 清单中的每个文件都在存储区且哈希一致", mismatch === 0, `${totalFiles} 个文件，${mismatch} 个不一致`);

// 3) 会话
const cloudSessions = session.listCloudSessions(cloud);
check("C4 能列出云端会话", cloudSessions.length >= 1, JSON.stringify(cloudSessions.map((s) => ({ id: s.id.slice(0, 20), project: s.project }))));

// 4) workspace-ref 与 manifest 一致性
let refChecked = 0;
let refBad = 0;
for (const proj of projects) {
	const sessionsDir = path.join(proj.dir, "sessions");
	let entries = [];
	try {
		entries = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
	} catch {
		continue;
	}
	for (const entry of entries) {
		const refPath = path.join(sessionsDir, entry.name, "workspace-ref.json");
		if (!fs.existsSync(refPath)) continue;
		refChecked++;
		try {
			const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));
			const buf = fs.readFileSync(path.join(proj.layoutDir, "manifest.json"));
			if (ref.manifestHash && createHash("sha256").update(buf).digest("hex") !== ref.manifestHash) refBad++;
		} catch {
			refBad++;
		}
	}
}
check("C5 workspace-ref 与当前清单哈希一致", refBad === 0, `${refChecked} 个会话快照，${refBad} 个不一致`);

// 5) 只读下载还原（写入临时目录，不回写仓库）
if (projects.length) {
	const target = path.join(base, "download");
	const result = await download.downloadWorkspace(cloud, projects[0].name, target);
	check("C6 下载还原成功", result.written === totalFiles || result.written >= 1, `written=${result.written} verified=${result.verified} failed=${result.failed}`);
	// 抽样比对下载内容与存储区
	let sampleBad = 0;
	const sample = Object.keys(JSON.parse(fs.readFileSync(path.join(projects[0].layoutDir, "manifest.json"), "utf8")).files || {}).slice(0, 5);
	for (const rel of sample) {
		const downloaded = path.join(target, rel);
		const stored = path.join(projects[0].storeFiles, rel);
		if (!fs.existsSync(downloaded) || sha(downloaded) !== sha(stored)) sampleBad++;
	}
	check("C7 下载内容与存储区一致（抽样）", sampleBad === 0, `${sample.length} 个抽样，${sampleBad} 个不一致`);
}

const failed = results.filter((item) => !item.pass);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
if (baseArg === undefined) fs.rmSync(base, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
