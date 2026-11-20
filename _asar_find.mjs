// 在 DSH app.asar 中查找 profile / bundle 管理逻辑（只读）
import fs from "node:fs";

const asar = "D:\\deepseek\\resources\\app.asar";
const buf = fs.readFileSync(asar);
const headerSize = buf.readUInt32LE(4);
const header = JSON.parse(buf.subarray(8, 8 + headerSize).toString("utf8"));
const dataStart = 8 + headerSize;
const files = [];
function walk(node, prefix) {
	if (!node.files) return;
	for (const [name, child] of Object.entries(node.files)) {
		const p = prefix ? prefix + "/" + name : name;
		if (child.files) walk(child, p);
		else if (child.size !== undefined) files.push({ path: p, offset: dataStart + Number(child.offset), size: Number(child.size) });
	}
}
walk(header, "");
console.log("files:", files.length);
const needles = ["managed exclusively by the Electron application", "dsh.profile.bundles", "profile/bundles", "bundles.push", "dsh.profile"];
const hits = [];
for (const f of files) {
	if (f.size > 3 * 1024 * 1024) continue;
	if (!/\.(js|mjs|cjs|json|yml|yaml|md)$/.test(f.path)) continue;
	const data = buf.subarray(f.offset, f.offset + f.size);
	for (const needle of needles) {
		const idx = data.indexOf(needle);
		if (idx >= 0) {
			hits.push({ path: f.path, needle, size: f.size, offset: f.offset, context: data.subarray(Math.max(0, idx - 300), idx + 600).toString("utf8") });
			break;
		}
	}
	if (hits.length >= 12) break;
}
for (const hit of hits) {
	console.log("\n=====", hit.needle, "->", hit.path, "size", hit.size, "offset", hit.offset);
	console.log(hit.context.replace(/\r/g, "").slice(0, 900));
}
