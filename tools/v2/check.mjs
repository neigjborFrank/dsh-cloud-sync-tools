// v2 质量门禁：文件规模、依赖方向、前端接口、版本一致性
// 运行：node tools/v2/check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pluginRoot = path.join(root, "plugin-v2");
const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};
const walk = (dir, out = []) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.name.endsWith(".js")) out.push(full);
	}
	return out;
};
const rel = (file) => path.relative(pluginRoot, file).replace(/\\/g, "/");
const lines = (file) => fs.readFileSync(file, "utf8").split("\n").length;

// 1) 文件规模
const LIMITS = { "client.js": 800, "index.js": 60, default: 350 };
const oversized = [];
for (const file of walk(pluginRoot)) {
	const name = rel(file);
	const limit = LIMITS[name] || LIMITS.default;
	const count = lines(file);
	if (count > limit) oversized.push({ name, count, limit });
}
check("文件规模不超过约定上限", oversized.length === 0, oversized.length ? JSON.stringify(oversized) : "OK");

// 2) 依赖方向
const coreFiles = walk(path.join(pluginRoot, "lib", "core"));
const hostFiles = walk(path.join(pluginRoot, "lib", "host"));
const violations = [];
for (const file of coreFiles) {
	const text = fs.readFileSync(file, "utf8");
	if (text.includes("../host/") || text.includes("client.js")) violations.push(`${rel(file)} 引用了 host/client`);
}
for (const file of hostFiles) {
	const text = fs.readFileSync(file, "utf8");
	if (text.includes("../client") || text.includes('"../../client.js"')) violations.push(`${rel(file)} 引用了 client`);
}
check("模块依赖方向正确（core 不依赖 host/client）", violations.length === 0, violations.length ? violations.join("; ") : "OK");

// 3) 前端只用 v2 接口
const client = fs.readFileSync(path.join(pluginRoot, "client.js"), "utf8");
const requiredEndpoints = ["/api/health", "/token", "/api/tree", "/api/repos", "/api/repos/remove", "/api/upload-project", "/api/download-project", "/api/pick-directory", "/api/cloud-view"];
const missing = requiredEndpoints.filter((endpoint) => !client.includes(endpoint));
const removedEndpoints = ["/api/check", "/api/diff", "/api/upload-sessions", "/api/github-status", "/api/repos/create"];
const stale = removedEndpoints.filter((endpoint) => client.includes(endpoint));
check("前端只使用 v2 接口", missing.length === 0 && stale.length === 0, JSON.stringify({ missing, stale }));
check("前端保留 __ModuleLoader__ 加载", client.includes("__ModuleLoader__") && client.includes("_footerActions"));

// 4) 版本一致性
const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
check("VERSION 与 package.json 版本一致", version === pkg.version, `${version} / ${pkg.version}`);

// 5) 入口导出
const entry = fs.readFileSync(path.join(pluginRoot, "index.js"), "utf8");
check("index.js 导出 apply", entry.includes("export async function apply") || entry.includes("export function apply"));

const failed = results.filter((item) => !item.pass);
console.log(`\n质量门禁：${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length ? 1 : 0;
