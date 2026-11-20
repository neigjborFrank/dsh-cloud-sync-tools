// 单元测试：v2 core 层（layout / manifest / project / mirror / lfs）
// 运行：node --test tests/unit/core.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 先把限制调小，便于测试大文件与超长路径分支
process.env.CSP_MAX_FILE_BYTES = String(1024 * 1024);
process.env.CSP_MAX_REL_PATH = "80";

const layout = await import("../../plugin-v2/lib/core/layout.js");
const manifest = await import("../../plugin-v2/lib/core/manifest.js");
const project = await import("../../plugin-v2/lib/core/project.js");
const mirror = await import("../../plugin-v2/lib/core/mirror.js");
const lfs = await import("../../plugin-v2/lib/core/lfs.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "csp-v2-"));
const write = (root, rel, text) => {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, "utf8");
	return file;
};

test("layout: projectKey / projectName", () => {
	assert.equal(layout.projectKeyOf("D:\\ws\\proj\\sub"), "--D-ws-proj-sub--");
	assert.equal(layout.projectName("D:\\ws\\proj\\sub"), "sub__D-ws-proj-sub");
	assert.equal(layout.projectName("D:\\ws\\proj"), "proj__D-ws-proj");
	assert.ok(layout.projectName("C:\\Users\\u\\a b").includes("~0020"));
});

test("layout: 路径关系判断", () => {
	assert.equal(layout.samePath("D:\\ws\\proj\\", "d:/ws/proj"), true);
	assert.equal(layout.samePath("D:\\ws\\proj", "D:\\ws\\proj2"), false);
	assert.equal(layout.isAncestor("D:\\ws", "D:\\ws\\proj\\sub"), true);
	assert.equal(layout.isAncestor("D:\\ws", "D:\\ws"), false);
	assert.equal(layout.isAncestor("D:\\ws\\proj", "D:\\ws\\other"), false);
	assert.equal(layout.relativeSub("D:\\ws", "D:\\ws\\proj\\sub"), "proj/sub");
});

test("layout: store/index 目录约定", () => {
	const repo = "C:\\tmp\\repo";
	assert.equal(layout.projectDir(repo, "D:\\ws\\proj"), path.join(repo, "index", "projects", "proj__D-ws-proj"));
	assert.equal(layout.storeFilesDir(repo, "p"), path.join(repo, "store", "p", "files"));
	assert.equal(layout.storeLargeDir(repo, "p"), path.join(repo, "store", "p", "large"));
});

test("manifest: 扫描/排除/大文件/超长路径", async () => {
	const ws = tmp();
	write(ws, "a.txt", "A");
	write(ws, "sub/b.md", "B");
	write(ws, "中文/文件 名.txt", "C");
	write(ws, "emoji-😀.txt", "D");
	write(ws, "empty.txt", "");
	write(ws, "node_modules/x.js", "excluded");
	write(ws, "out/y.txt", "excluded");
	write(ws, ".csp-trash-1/z.txt", "excluded");
	// 大文件（>1MB）与超长路径（>80 字符）
	fs.writeFileSync(path.join(ws, "big.bin"), Buffer.alloc(1024 * 1024 + 10, 7));
	write(ws, `${"x".repeat(85)}.txt`, "long");

	const result = await manifest.buildManifest(ws);
	assert.equal(Object.keys(result.files).length, 5);
	assert.ok(result.files["中文/文件 名.txt"]);
	assert.ok(result.files["emoji-😀.txt"]);
	assert.equal(result.large.length, 1);
	assert.equal(result.tooLong.length, 1);
	assert.ok(!Object.keys(result.files).some((rel) => rel.startsWith("node_modules") || rel.startsWith("out") || rel.startsWith(".csp-trash")));
});

test("project: 创建/元数据/alias 查找", () => {
	const repo = tmp();
	const cwd = "C:\\tmp\\workspace\\proj";
	const meta = project.ensureProject(repo, cwd);
	assert.equal(meta.schema, 1);
	assert.equal(meta.name, "proj__C-tmp-workspace-proj");
	assert.deepEqual(meta.aliases, []);

	// 记录子目录 alias
	const saved = project.saveProjectMeta(repo, { ...meta, aliases: [{ cwd: `${cwd}\\sub`, scope: "sub" }] });
	assert.equal(saved.aliases.length, 1);

	const list = project.listProjects(repo);
	assert.equal(list.length, 1);
	const found = project.findProject(repo, cwd);
	assert.equal(found.name, meta.name);
	const byAlias = project.findProjectForCwd(repo, `${cwd}\\sub`);
	assert.equal(byAlias.project.name, meta.name);
	assert.equal(byAlias.scope, "sub");
	// 更深一层没有 alias → 按后代关系给出 scope
	const deeper = project.findProjectForCwd(repo, `${cwd}\\sub\\deep`);
	assert.equal(deeper.scope, "sub/deep");
});

test("project: 兼容 v1 的 projects/<项目>/workspace 布局", () => {
	const repo = tmp();
	const cwd = "C:\\tmp\\legacy\\proj";
	const dir = path.join(repo, "projects", "legacyproj");
	fs.mkdirSync(path.join(dir, "workspace", "files"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "meta.json"),
		JSON.stringify({ name: "legacyproj", cwd, title: "legacy", aliases: [], sessions: [] }),
		"utf8",
	);
	fs.writeFileSync(path.join(dir, "workspace", "manifest.json"), JSON.stringify({ files: { "a.txt": { hash: "h", size: 1 } } }), "utf8");
	fs.writeFileSync(path.join(dir, "workspace", "files", "a.txt"), "A", "utf8");

	const list = project.listProjects(repo);
	assert.equal(list.length, 1);
	assert.equal(list[0].name, "legacyproj");
	assert.equal(list[0].files, 1);
	assert.equal(list[0].layoutDir.toLowerCase().endsWith("workspace"), true);
});

test("mirror: 镜像更新/删除，重复上传不丢清单", async () => {
	const ws = tmp();
	write(ws, "a.txt", "A");
	write(ws, "sub/b.txt", "B");
	const repo = tmp();
	const indexDir = layout.projectDir(repo, "p");
	const filesRoot = layout.storeFilesDir(repo, "p");
	const largeRoot = layout.storeLargeDir(repo, "p");
	const options = { filesRoot, largeRoot };

	const first = await mirror.commitWorkspace(ws, indexDir, options);
	assert.equal(first.files, 2);
	assert.ok(fs.existsSync(path.join(filesRoot, "sub", "b.txt")));

	// 第二次（无变化）也必须保留清单 —— 回归测试：曾经会把清单清空
	const second = await mirror.commitWorkspace(ws, indexDir, options);
	assert.equal(second.files, 2);
	assert.equal(second.added, 0);

	// 删除一个文件 → 清单与存储同步删除
	fs.rmSync(path.join(ws, "sub", "b.txt"));
	const third = await mirror.commitWorkspace(ws, indexDir, options);
	assert.equal(third.files, 1);
	assert.equal(fs.existsSync(path.join(filesRoot, "sub", "b.txt")), false);
});

test("mirror: scope 子路径合并，不影响外部文件", async () => {
	const ws = tmp();
	write(ws, "a.txt", "A");
	const repo = tmp();
	const indexDir = layout.projectDir(repo, "p");
	const options = { filesRoot: layout.storeFilesDir(repo, "p"), largeRoot: layout.storeLargeDir(repo, "p") };
	await mirror.commitWorkspace(ws, indexDir, options);

	// 子工作区（scope=sub）只有 c.md
	const subWs = tmp();
	write(subWs, "c.md", "C");
	const sub = await mirror.commitWorkspace(subWs, indexDir, { ...options, scopePrefix: "sub" });
	assert.equal(sub.scope, "sub");

	const manifestJson = JSON.parse(fs.readFileSync(path.join(indexDir, "manifest.json"), "utf8"));
	assert.ok(manifestJson.files["a.txt"], "外部文件应保留");
	assert.ok(manifestJson.files["sub/c.md"], "子路径文件应写入对应位置");
	assert.ok(fs.existsSync(path.join(options.filesRoot, "sub", "c.md")));
});

test("mirror: 同路径不同内容 → 冲突隔离，保留云端旧版", async () => {
	const ws = tmp();
	write(ws, "a.txt", "OLD");
	const repo = tmp();
	const indexDir = layout.projectDir(repo, "p");
	const options = { filesRoot: layout.storeFilesDir(repo, "p"), largeRoot: layout.storeLargeDir(repo, "p") };
	await mirror.commitWorkspace(ws, indexDir, options);
	const oldHash = JSON.parse(fs.readFileSync(path.join(indexDir, "manifest.json"), "utf8")).files["a.txt"].hash;

	write(ws, "a.txt", "NEW");
	const result = await mirror.commitWorkspace(ws, indexDir, options);
	assert.equal(result.conflicts.length, 1);

	const current = JSON.parse(fs.readFileSync(path.join(indexDir, "manifest.json"), "utf8"));
	assert.equal(current.files["a.txt"].hash, oldHash, "云端应保留旧版");
	assert.equal(fs.readFileSync(path.join(options.filesRoot, "a.txt"), "utf8"), "OLD");
	// 新内容被隔离
	const conflictFile = path.join(indexDir, result.conflicts[0].incoming);
	assert.equal(fs.readFileSync(conflictFile, "utf8"), "NEW");
});

test("lfs: 指针识别与恢复", async () => {
	const ws = tmp();
	const pointer = write(ws, "pointer.bin", "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n");
	assert.equal(lfs.isLfsPointer(pointer), true);

	const largeDir = tmp();
	const destDir = tmp();
	fs.mkdirSync(largeDir, { recursive: true });
	const content = Buffer.from("real content");
	fs.writeFileSync(path.join(largeDir, "real.bin"), content);
	const hash = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");

	const result = await lfs.restoreLargeFiles({
		entries: [
			{ path: "real.bin", size: content.length, hash },
			{ path: "pointer.bin", size: 1, hash: "abc" },
			{ path: "missing.bin", size: 1, hash: "def" },
		],
		largeDir,
		destDir,
	});
	assert.equal(result.restored, 1);
	assert.equal(result.pending.length, 2);
	assert.equal(fs.readFileSync(path.join(destDir, "real.bin")).toString("utf8"), "real content");
});
