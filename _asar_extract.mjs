// 按精确路径从 app.asar 提取关键文件（只读，快速：只读 asar 头 + 目标文件区间）
import fs from "node:fs";
import path from "node:path";

const asar = "D:\\deepseek\\resources\\app.asar";
const outDir = "C:\\Users\\28726\\Documents\\deepseek-harness\\default-workspace\\out\\_asar";
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const fd = fs.openSync(asar, "r");
const head = Buffer.alloc(8);
fs.readSync(fd, head, 0, 8, 0);
const headerSize = head.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 8);
const header = JSON.parse(headerBuf.toString("utf8"));
const dataStart = 8 + headerSize;

const map = new Map();
function walk(node, prefix) {
	if (!node.files) return;
	for (const [name, child] of Object.entries(node.files)) {
		const p = prefix ? prefix + "/" + name : name;
		if (child.files) walk(child, p);
		else if (child.offset !== undefined) map.set(p, { offset: dataStart + Number(child.offset), size: Number(child.size) });
	}
}
walk(header, "");
console.log("asar files:", map.size);

const targets = [
	"lib/main.js",
	"lib/preload.js",
	"package.json",
	"dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js",
];
for (const [p, info] of map) {
	if (p.includes("dsh-desktop-host") && /package\.json|lib\/index\.js$/.test(p)) targets.push(p);
	if (/profile/i.test(p) && p.endsWith(".js") && info.size < 400 * 1024) targets.push(p);
}

const unique = [...new Set(targets)];
for (const target of unique) {
	const info = map.get(target);
	if (!info) continue;
	const data = Buffer.alloc(info.size);
	fs.readSync(fd, data, 0, info.size, info.offset);
	const dest = path.join(outDir, target.replace(/[\\/:]/g, "__"));
	fs.writeFileSync(dest, data);
	console.log("extracted", target, info.size, "->", dest);
}
fs.closeSync(fd);

// 候选路径清单（帮助定位 profile 管理代码）
console.log("\nprofile 相关文件：");
let count = 0;
for (const [p, info] of map) {
	if (/profile/i.test(p) && /\.(js|mjs|cjs|json)$/.test(p)) {
		console.log(" ", p, info.size);
		if (++count >= 40) break;
	}
}
