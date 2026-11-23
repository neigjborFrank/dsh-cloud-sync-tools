// v2 璐ㄩ噺闂ㄧ锛氭枃浠惰妯°€佷緷璧栨柟鍚戙€佸墠绔帴鍙ｃ€佺増鏈竴鑷存€?// 杩愯锛歯ode tools/v2/check.mjs
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

// 1) 鏂囦欢瑙勬ā
const LIMITS = { "client.js": 850, "index.js": 100, default: 350 };
const oversized = [];
for (const file of walk(pluginRoot)) {
	const name = rel(file);
	const limit = LIMITS[name] || LIMITS.default;
	const count = lines(file);
	if (count > limit) oversized.push({ name, count, limit });
}
check("鏂囦欢瑙勬ā涓嶈秴杩囩害瀹氫笂闄?, oversized.length === 0, oversized.length ? JSON.stringify(oversized) : "OK");

// 2) 渚濊禆鏂瑰悜
const coreFiles = walk(path.join(pluginRoot, "lib", "core"));
const hostFiles = walk(path.join(pluginRoot, "lib", "host"));
const violations = [];
for (const file of coreFiles) {
	const text = fs.readFileSync(file, "utf8");
	if (text.includes("../host/") || text.includes("client.js")) violations.push(`${rel(file)} 寮曠敤浜?host/client`);
}
for (const file of hostFiles) {
	const text = fs.readFileSync(file, "utf8");
	if (text.includes("../client") || text.includes('"../../client.js"')) violations.push(`${rel(file)} 寮曠敤浜?client`);
}
check("妯″潡渚濊禆鏂瑰悜姝ｇ‘锛坈ore 涓嶄緷璧?host/client锛?, violations.length === 0, violations.length ? violations.join("; ") : "OK");

// 3) 鍓嶇鍙敤 v2 鎺ュ彛
const client = fs.readFileSync(path.join(pluginRoot, "client.js"), "utf8");
const requiredEndpoints = ["/api/health", "/token", "/api/tree", "/api/repos", "/api/repos/remove", "/api/upload-project", "/api/download-project", "/api/pick-directory", "/api/cloud-view"];
const missing = requiredEndpoints.filter((endpoint) => !client.includes(endpoint));
const removedEndpoints = ["/api/check", "/api/diff", "/api/upload-sessions", "/api/github-status", "/api/repos/create"];
const stale = removedEndpoints.filter((endpoint) => client.includes(endpoint));
check("鍓嶇鍙娇鐢?v2 鎺ュ彛", missing.length === 0 && stale.length === 0, JSON.stringify({ missing, stale }));
check("鍓嶇淇濈暀 __ModuleLoader__ 鍔犺浇", client.includes("__ModuleLoader__") && client.includes("_footerActions"));

// 4) 鐗堟湰涓€鑷存€?const version = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim();
const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
check("VERSION 涓?package.json 鐗堟湰涓€鑷?, version === pkg.version, `${version} / ${pkg.version}`);

// 5) 鍏ュ彛瀵煎嚭
const entry = fs.readFileSync(path.join(pluginRoot, "index.js"), "utf8");
check("index.js 瀵煎嚭 apply", entry.includes("export async function apply") || entry.includes("export function apply"));
check("apply 蹇呴』鏄悓姝ュ嚱鏁帮紙DSH 鐢熷懡鍛ㄦ湡濂戠害锛?, !entry.includes("export async function apply") && entry.includes("export function apply"));
const entryCode = entry.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("apply 鎵€鍦ㄥ叆鍙ｄ笉鍑虹幇 await锛堟敞鍐?effect 蹇呴』鍚屾锛?, !/\bawait\b/.test(entryCode));

const failed = results.filter((item) => !item.pass);
console.log(`\n璐ㄩ噺闂ㄧ锛?{results.length - failed.length}/${results.length} 閫氳繃`);
process.exitCode = failed.length ? 1 : 0;
