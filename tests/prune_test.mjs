// 备份保留策略测试：7 天过期 + 最多 3 份
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [storePath, base] = process.argv.slice(2);
const store = await import(pathToFileURL(storePath).href);

fs.rmSync(base, { recursive: true, force: true });
const entity = path.join(base, "entity");
fs.mkdirSync(entity, { recursive: true });
fs.writeFileSync(path.join(entity, "manifest.json"), JSON.stringify({ files: {} }));

const makeBackup = (name, ageDays) => {
	const dir = path.join(entity, "backups", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ files: {} }));
	const when = new Date(Date.now() - ageDays * 24 * 3600 * 1000);
	fs.utimesSync(dir, when, when);
	return dir;
};

// 1 个 10 天前的（应过期）+ 4 个新的（应只保留 3 个最新的）
const old = makeBackup("20260101000000000", 10);
const fresh = ["20261108000000001", "20261108000000002", "20261108000000003", "20261108000000004"].map((n) => makeBackup(n, 0));

const removed = store.pruneBackups(entity, 7, 3);
const left = fs.existsSync(path.join(entity, "backups")) ? fs.readdirSync(path.join(entity, "backups")).sort() : [];

const pass =
	!fs.existsSync(old) &&
	left.length === 3 &&
	left.includes("20261108000000004") &&
	left.includes("20261108000000003") &&
	left.includes("20261108000000002") &&
	!left.includes("20261108000000001");

console.log(JSON.stringify({ pass, removed, left }, null, 2));
process.exitCode = pass ? 0 : 1;
