// Host 层共享：插件版本与 DSH 服务惰性解析
import fs from "node:fs";

export const PLUGIN_VERSION = (() => {
	try {
		return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version || "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

/**
 * 惰性解析 DSH 服务（workspaceRegistry / directoryPicker 可能晚于插件加载）。
 * 未声明 inject 时不能直接读属性；优先使用入口注入的 resolveService。
 */
export function getService(ctxValue, name) {
	try {
		if (ctxValue && typeof ctxValue.resolveService === "function") return ctxValue.resolveService(name) || undefined;
	} catch {
		/* 降级 */
	}
	try {
		return ctxValue ? ctxValue[name] || undefined : undefined;
	} catch {
		return undefined;
	}
}
