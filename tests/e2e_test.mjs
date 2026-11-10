// test 工作区端到端测试 v2：上传/增量/删除/LFS 大文件/带位置下载/cwd 改写/注册表/回滚
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const [repoDir, pluginDir, workspaceCwd, base, portArg] = process.argv.slice(2);
const port = Number(portArg || 8801);
const REAL_HOME = process.env.DSH_HOME;

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

// ---------- 隔离环境 ----------
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, "home");
const copyDir = (from, to) => fs.cpSync(from, to, { recursive: true });
const projKey = "--D-deepseek-workspace-test--";
fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
copyDir(path.join(REAL_HOME, "sessions", projKey), path.join(home, "sessions", projKey));
fs.mkdirSync(path.join(home, "storages", "session_projcache", "sessions"), { recursive: true });
for (const name of fs.readdirSync(path.join(REAL_HOME, "storages", "session_projcache", "sessions"))) {
	if (!name.startsWith("session-")) continue;
	fs.copyFileSync(path.join(REAL_HOME, "storages", "session_projcache", "sessions", name), path.join(home, "storages", "session_projcache", "sessions", name));
}
process.env.DSH_HOME = home;
process.env.CSP_MAX_FILE_BYTES = "524288"; // 512KB，测试用阈值（真实默认 95MB）

const WS_ID = "11111111111111111111111111111111";
const registryFile = path.join(home, "storages", "workspace.json");
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2), "utf8");
writeJson(registryFile, {
	unit: { name: "workspace", version: 2 },
	global: { initialized: true, defaultWorkspaceId: WS_ID, workspaceIds: [WS_ID], archivedSessionIds: [], pinnedSessionIds: [] },
	tables: {
		workspaces: { [WS_ID]: { path: workspaceCwd, title: "test", sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } },
	},
});

const registry = await import(pathToFileURL(path.join(pluginDir, "lib", "registry.js")).href);
const storeMod = await import(pathToFileURL(path.join(pluginDir, "lib", "store.js")).href);
const sessionIds = fs
	.readdirSync(path.join(home, "sessions", projKey), { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name);
console.log("测试会话:", sessionIds.join(", "));

// ---------- 服务 mock（真实 DSH 中由 ctx 提供） ----------
const serviceCalls = { create: [], pick: 0 };
const fakeRegistryService = {
	async create(dir, title) {
		serviceCalls.create.push({ dir, title });
		return { id: "fake-workspace-id" };
	},
};
const fakePicker = {
	capability: () => ({
		kind: "native",
		async pick() {
			serviceCalls.pick += 1;
			return path.join(base, "picked-by-dialog");
		},
	}),
};
const ctx = {
	effect: (fn) => {
		disposeFn = fn();
	},
	get: (name) => (name === "workspaceRegistry" ? fakeRegistryService : name === "directoryPicker" ? fakePicker : undefined),
};
let disposeFn = null;

const mod = await import(pathToFileURL(path.join(pluginDir, "index.js")).href);
mod.apply(ctx, { workspace: repoDir, port });
await new Promise((r) => setTimeout(r, 900));
const baseUrl = `http://127.0.0.1:${port}`;
const token = (await fetch(baseUrl + "/token").then((r) => r.json())).token;
const call = (p, init) => fetch(`${baseUrl}${p}${p.includes("?") ? "&" : "?"}token=${token}`, init).then((r) => r.json());
const post = (p, body) => call(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const regStatus = () => registry.validateRegistry(registry.readRegistry());
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const readHeaderCwd = (file) => {
	const buf = fs.readFileSync(file);
	const at = buf.indexOf(MAGIC);
	const next = buf.indexOf(MAGIC, at + 4);
	const text = zlib.zstdDecompressSync(buf.subarray(at, next < 0 ? buf.length : next)).toString("utf8");
	return JSON.parse(text.split("\n").find(Boolean)).cwd;
};
/** 与插件一致的 projectKey 算法（用于断言会话目录） */
const projectKeyOf = (cwd) => {
	let out = "";
	let sep = false;
	for (const ch of cwd) {
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

// 测试前清理云端旧的项目目录，保证从空状态开始
if (fs.existsSync(path.join(repoDir, "projects"))) {
	for (const d of fs.readdirSync(path.join(repoDir, "projects"))) {
		fs.rmSync(path.join(repoDir, "projects", d), { recursive: true, force: true });
	}
}

const findProjectDir = () => {
	const dirs = fs.existsSync(path.join(repoDir, "projects")) ? fs.readdirSync(path.join(repoDir, "projects")) : [];
	return dirs.length ? path.join(repoDir, "projects", dirs[0]) : null;
};
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const listFiles = (dir, prefix = "") =>
	!fs.existsSync(dir)
		? []
		: fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((e) => !e.name.startsWith(".csp-trash-"))
				.flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
const upload = (ids) => post("/api/upload-project", { cwd: workspaceCwd, sessionIds: ids, message: "test: e2e 上传" });
const download = (name, targetDir, ids, withWorkspace) =>
	post("/api/download-project", { name, targetDir, sessionIds: ids, withWorkspace });

// ================= S1 首次上传 =================
let r = await upload(sessionIds);
check("S1.1 上传成功", r.ok === true, (r.output || "").split("\n")[0]);
const projDir = findProjectDir();
check("S1.2 云端项目目录存在", Boolean(projDir && fs.existsSync(path.join(projDir, "workspace", "manifest.json"))));
const cloudSessions = fs.existsSync(path.join(projDir, "sessions")) ? fs.readdirSync(path.join(projDir, "sessions"), { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0;
check("S1.3 会话数 = 本地会话数", cloudSessions === sessionIds.length, `云端 ${cloudSessions} / 本地 ${sessionIds.length}`);
const wsSessionLeak = fs.existsSync(path.join(projDir, "sessions"))
	? fs.readdirSync(path.join(projDir, "sessions"), { withFileTypes: true }).some((e) => fs.existsSync(path.join(projDir, "sessions", e.name, "files")))
	: false;
check("S1.4 会话目录不含工作区副本", wsSessionLeak === false);
const helloV1 = fs.readFileSync(path.join(workspaceCwd, "notes", "2025", "hello-dsh.md"), "utf8");
const localInv = await storeMod.buildManifest(workspaceCwd);
check("S1.5 云端清单文件数与本地一致", Object.keys(readJson(path.join(projDir, "workspace", "manifest.json")).files).length === Object.keys(localInv.files).length, `云端 ${Object.keys(readJson(path.join(projDir, "workspace", "manifest.json")).files).length} / 本地 ${Object.keys(localInv.files).length}（大文件 ${(localInv.large || []).length}）`);

// ================= S2 增量上传 =================
fs.writeFileSync(path.join(workspaceCwd, "docs-readme.md"), "# 新增文件\n", "utf8");
fs.mkdirSync(path.join(workspaceCwd, "tmp"), { recursive: true });
fs.writeFileSync(path.join(workspaceCwd, "tmp", "delete-me.txt"), "will be deleted\n", "utf8");
fs.appendFileSync(path.join(workspaceCwd, "notes", "2025", "hello-dsh.md"), "\n\n追加一行（测试增量）\n", "utf8");
r = await upload(sessionIds);
const backupsDir = path.join(projDir, "workspace", "backups");
const backupNames = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [];
check("S2.1 增量上传产生备份", backupNames.length === 1, `版本 ${backupNames[0]}`);
const backupManifest = backupNames.length ? readJson(path.join(backupsDir, backupNames[0], "manifest.json")) : { files: {} };
const currentManifest = readJson(path.join(projDir, "workspace", "manifest.json"));
const changedCount = Object.entries(currentManifest.files).filter(([rel, info]) => backupManifest.files[rel] && backupManifest.files[rel].hash !== info.hash).length;
const storedCount = Object.values(backupManifest.files || {}).filter((f) => f.from === "backup").length;
check("S2.2 备份只存变化文件", storedCount === changedCount && storedCount >= 1, `stored=${storedCount} changed=${changedCount}`);
check("S2.3 正式版包含新增文件", Boolean(currentManifest.files["docs-readme.md"] && currentManifest.files["tmp/delete-me.txt"]));

// ================= S3 删除文件 =================
fs.rmSync(path.join(workspaceCwd, "tmp", "delete-me.txt"));
r = await upload(sessionIds);
const newestBackup = fs.readdirSync(backupsDir).sort().at(-1);
const back = readJson(path.join(backupsDir, newestBackup, "manifest.json"));
check("S3.1 被删文件内容进备份", Boolean(back.files["tmp/delete-me.txt"]) && fs.existsSync(path.join(backupsDir, newestBackup, "files", "tmp", "delete-me.txt")));
check("S3.2 正式版移除被删文件", !readJson(path.join(projDir, "workspace", "manifest.json")).files["tmp/delete-me.txt"]);
check("S3.3 版本数量 ≤ 3", fs.readdirSync(backupsDir).length <= 3, `当前 ${fs.readdirSync(backupsDir).length}`);

// ================= S4 大文件（LFS） =================
const bigPath = path.join(workspaceCwd, "big-test.bin");
fs.writeFileSync(bigPath, Buffer.alloc(2 * 1024 * 1024, 7)); // 2MB > 测试阈值 512KB
r = await upload(sessionIds);
const largeJson = readJson(path.join(projDir, "workspace", "large.json"));
const bigEntry = (largeJson.large || [])[0];
check("S4.1 大文件记录在 large.json", Boolean(bigEntry && bigEntry.path === "big-test.bin"), JSON.stringify((largeJson.large || []).map((x) => x.path)));
check("S4.2 大文件内容进入 large/（git-lfs）", Boolean(bigEntry && bigEntry.stored === "lfs") && fs.existsSync(path.join(projDir, "workspace", "large", "big-test.bin")), `stored=${bigEntry && bigEntry.stored}`);
check("S4.3 大文件不在正式版清单", !readJson(path.join(projDir, "workspace", "manifest.json")).files["big-test.bin"]);
const gitAttr = fs.existsSync(path.join(repoDir, ".gitattributes")) ? fs.readFileSync(path.join(repoDir, ".gitattributes"), "utf8") : "";
check("S4.4 仓库已配置 LFS 跟踪规则", gitAttr.includes("workspace/large/**"));

// ================= S5 带位置下载（模拟另一台机器）+ cwd 改写 =================
serviceCalls.create.length = 0;
const dlA = path.join(base, "machineA", "test");
r = await download(path.basename(projDir), dlA, sessionIds, true);
check("S5.1 下载成功", r.ok === true, (r.output || "").split("\n")[0]);
check("S5.2 工作区镜像文件数匹配", listFiles(dlA).length === Object.keys(readJson(path.join(projDir, "workspace", "manifest.json")).files).length + 1, `${listFiles(dlA).length} 个（含大文件）`);
check("S5.3 大文件已从 LFS 恢复", fs.existsSync(path.join(dlA, "big-test.bin")) && fs.statSync(path.join(dlA, "big-test.bin")).size === 2 * 1024 * 1024, `恢复 ${r.workspace && r.workspace.largeRestored}`);
check("S5.4 无大文件待人工清单", (r.pendingLarge || []).length === 0);
check("S5.5 通过 DSH 官方接口登记工作区", r.registration && r.registration.via === "service" && serviceCalls.create.some((c) => c.dir === dlA), JSON.stringify(serviceCalls.create.map((c) => c.dir)));
const newKey = projectKeyOf(dlA);
const newSessionFile = path.join(home, "sessions", newKey, sessionIds[0], "session.v4.jsonl.zstd");
check("S5.6 会话 cwd 已改写到新位置", fs.existsSync(newSessionFile) && readHeaderCwd(newSessionFile) === dlA, fs.existsSync(newSessionFile) ? readHeaderCwd(newSessionFile) : "缺失");
const regA = regStatus();
check("S5.7 注册表（回退路径）仍校验通过", regA.ok === true, JSON.stringify(regA.problems));

// ================= S6 再下载到另一位置 =================
const dlB = path.join(base, "machineB", "test");
r = await download(path.basename(projDir), dlB, sessionIds, true);
check("S6.1 第二次下载成功且再次登记", r.ok === true && serviceCalls.create.some((c) => c.dir === dlB));
const keyB = projectKeyOf(dlB);
check("S6.2 B 位置会话 cwd 正确", readHeaderCwd(path.join(home, "sessions", keyB, sessionIds[0], "session.v4.jsonl.zstd")) === dlB);
check("S6.3 注册表校验通过", regStatus().ok === true);

// ================= S7 镜像语义 =================
fs.writeFileSync(path.join(dlA, "extra-local.txt"), "local only\n", "utf8");
fs.rmSync(path.join(dlA, "notes", "2025", "hello-dsh.md"));
r = await download(path.basename(projDir), dlA, [], true);
const trashDirs = fs.readdirSync(dlA).filter((n) => n.startsWith(".csp-trash-"));
check("S7.1 多余文件移入回收目录", trashDirs.length > 0 && fs.existsSync(path.join(dlA, trashDirs[0], "extra-local.txt")));
check("S7.2 缺失文件被恢复", fs.existsSync(path.join(dlA, "notes", "2025", "hello-dsh.md")));
check("S7.3 回收目录不进入上传清单", !Object.keys((await storeMod.buildManifest(dlA)).files).some((k) => k.startsWith(".csp-trash-")));

// ================= S8 仅下载会话（不下载工作区） =================
const sessionOnlyTarget = path.join(base, "sessionOnly");
const victim = sessionIds[0];
fs.rmSync(path.join(home, "sessions", projKey, victim), { recursive: true, force: true });
r = await download(path.basename(projDir), sessionOnlyTarget, [victim], false);
const restoredOriginal = path.join(home, "sessions", projKey, victim, "session.v4.jsonl.zstd");
check("S8.1 仅会话下载不创建工作区目录", !fs.existsSync(sessionOnlyTarget) || fs.readdirSync(sessionOnlyTarget).length === 0);
check("S8.2 会话恢复到原 cwd", fs.existsSync(restoredOriginal) && readHeaderCwd(restoredOriginal) === workspaceCwd, fs.existsSync(restoredOriginal) ? readHeaderCwd(restoredOriginal) : "缺失");

// ================= S9 位置选择接口（mock 原生选择框） =================
const picked = await post("/api/pick-directory", {});
check("S9.1 原生选择框接口可用", picked.ok === true && picked.path === path.join(base, "picked-by-dialog") && serviceCalls.pick > 0);

// ================= S10 版本回滚 =================
const versions = (await call(`/api/versions?project=${encodeURIComponent(path.basename(projDir))}`)).versions || [];
check("S10.1 能列出历史版本", versions.length >= 1, JSON.stringify(versions.map((v) => v.version)));
if (versions.length) {
	const oldest = versions[versions.length - 1].version;
	r = await post("/api/rollback-version", { project: path.basename(projDir), version: oldest });
	const afterRollback = fs.readFileSync(path.join(projDir, "workspace", "files", "notes", "2025", "hello-dsh.md"), "utf8");
	check("S10.2 回滚成功且注册表正常", r.ok === true && regStatus().ok === true);
	check("S10.3 回滚后内容回到旧版本", afterRollback === helloV1, `回滚后 ${afterRollback.length} / v1 ${helloV1.length}`);
}

// ================= S11 删除大文件 =================
fs.rmSync(bigPath, { force: true });
r = await upload(sessionIds);
const largeAfter = readJson(path.join(projDir, "workspace", "large.json"));
check("S11.1 删除大文件后 large.json 清空", (largeAfter.large || []).length === 0);
check("S11.2 云端 large/ 目录已清理", !fs.existsSync(path.join(projDir, "workspace", "large", "big-test.bin")));

// ================= S12 云端项目隔离 =================
const cloudProjects = fs.existsSync(path.join(repoDir, "projects")) ? fs.readdirSync(path.join(repoDir, "projects")) : [];
check("S12.1 云端只有一个测试项目（会话未串到新位置项目）", cloudProjects.length === 1 && cloudProjects[0] === path.basename(projDir), JSON.stringify(cloudProjects));
// ---------- 汇总 ----------
disposeFn();
const failed = results.filter((x) => !x.pass);
console.log("\n===== 汇总 =====");
console.log(`通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length) console.log("失败项:", failed.map((x) => x.name).join("；"));
fs.writeFileSync(path.join(base, "e2e-result.json"), JSON.stringify(results, null, 2), "utf8");
process.exitCode = failed.length ? 1 : 0;
