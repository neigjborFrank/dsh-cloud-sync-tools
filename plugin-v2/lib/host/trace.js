// 启动诊断日志：写入 %DSH_HOME%/cloud-sync/plugin-startup.log
// 用于定位 DSH 重启后插件"未导入 / 未 apply / 服务启动失败"这类静默问题。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function trace(message) {
	try {
		const dir = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "cloud-sync");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "plugin-startup.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
	} catch {
		/* 诊断日志失败不影响插件 */
	}
}
