// 辅助路由：健康检查 / 目录选择 / 工作区管理（从 routes.js 拆分，保持文件规模约束）
import fs from "node:fs";
import path from "node:path";

import { AppError } from "../shared.js";
import { readRegistry, registerWorkspace, removeWorkspaces } from "../core/registry.js";
import { pickFolderWindows, windowsPickerAvailable } from "./folder-picker.js";
import { PLUGIN_VERSION, getService } from "./services.js";

/** 通过 DSH directoryPicker 服务选择目录（native / browse / 旧版兼容） */
async function pickWithDshPicker(ctx, body = {}, probeOnly = false) {
	const picker = getService(ctx, "directoryPicker");
	if (!picker) {
		return { available: false, kind: "none", hint: "当前环境没有目录选择服务，可在下载对话框直接编辑路径（默认目录已自动填充）" };
	}
	try {
		const capability = typeof picker.capability === "function" ? picker.capability() : null;
		if (capability && capability.kind === "native" && typeof capability.pick === "function") {
			if (probeOnly) return { available: true, kind: "native" };
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 180000);
			try {
				const selected = await capability.pick(controller.signal);
				return { available: true, kind: "native", path: selected || "", canceled: !selected };
			} finally {
				clearTimeout(timer);
			}
		}
		if (capability && capability.kind === "browse") {
			return {
				available: false,
				kind: "browse",
				hint: "当前环境使用应用内目录浏览器；默认目录已自动填充，可直接编辑路径",
			};
		}
		// 兼容旧版目录选择服务
		if (typeof picker.pickDirectory === "function") {
			const picked = await picker.pickDirectory({ title: "选择下载位置" });
			const selected = typeof picked === "string" ? picked : picked && picked.path ? picked.path : "";
			return { available: true, kind: "legacy", path: selected, canceled: !selected };
		}
		return { available: false, kind: capability ? capability.kind : "unknown" };
	} catch (error) {
		return { available: true, kind: "native", path: "", canceled: false, error: error.message || String(error) };
	}
}

/** 工作区列表（官方 workspaceRegistry 优先，文件注册表兜底） */
function listWorkspaces(ctx) {
	const workspaceRegistry = getService(ctx, "workspaceRegistry");
	if (workspaceRegistry && typeof workspaceRegistry.list === "function") {
		const workspaces = workspaceRegistry.list().map((entry) => {
			let raw = entry;
			try {
				if (entry && typeof entry.toJSON === "function") raw = entry.toJSON();
			} catch {}
			raw = raw || {};
			const record = raw.path && typeof raw.path === "object" ? raw.path.path : raw.path;
			return {
				id: String(raw.id || raw.workspaceId || ""),
				title: raw.title || "",
				path: typeof record === "string" ? record : "",
				sessions: Array.isArray(raw.sessionIds) ? raw.sessionIds.length : Number(raw.sessionCount || 0),
			};
		});
		return { ok: true, mode: "official", workspaces };
	}
	const json = readRegistry();
	const table = (json && json.tables && json.tables.workspaces) || {};
	const ids = (json && json.global && json.global.workspaceIds) || Object.keys(table);
	const workspaces = ids
		.filter((id) => table[id])
		.map((id) => ({ id, title: table[id].title || "", path: table[id].path || "", sessions: (table[id].sessionIds || []).length }));
	return { ok: true, mode: "file", workspaces };
}

export function createExtraRoutes(ctx) {
	return {
		"GET /api/health": () => {
			const picker = getService(ctx, "directoryPicker");
			let pickerKind = picker ? "unknown" : "none";
			try {
				if (picker && typeof picker.capability === "function") pickerKind = picker.capability().kind || "unknown";
			} catch {}
			return {
				ok: true,
				service: "cloud-sync",
				version: PLUGIN_VERSION,
				repoRoot: ctx.repoRoot,
				features: {
					workspaceRegistry: Boolean(getService(ctx, "workspaceRegistry")),
					directoryPicker: pickerKind,
					windowsPicker: process.platform === "win32" && windowsPickerAvailable(),
				},
			};
		},

		"POST /api/workspaces/register": async (body) => {
			const target = typeof body.path === "string" ? body.path.trim() : "";
			if (!target || !path.isAbsolute(target)) throw new AppError("bad-request", "请提供工作区绝对路径");
			if (!fs.existsSync(target)) throw new AppError("path-missing", `目录不存在：${target}`);
			const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : path.basename(target) || "workspace";
			const workspaceRegistry = getService(ctx, "workspaceRegistry");
			if (workspaceRegistry && typeof workspaceRegistry.create === "function") {
				let record = null;
				if (typeof workspaceRegistry.resolveByPath === "function") record = (await workspaceRegistry.resolveByPath(target)) || null;
				if (!record) record = await workspaceRegistry.create(target, title);
				return { ok: true, mode: "official", existing: Boolean(record), workspace: record ? { id: record.id || "", title: record.title || title, path: target } : null };
			}
			const fallback = registerWorkspace(target, title, []);
			return { ok: Boolean(fallback.ok), mode: "file", existing: Boolean(fallback.updated), workspace: fallback.ok ? { id: fallback.workspaceId || "", title, path: target } : null, output: fallback.ok ? "已写入注册表（DSH 需刷新/重启）" : fallback.error };
		},

		"POST /api/pick-directory": async (body) => {
			const probeOnly = Boolean(body && body.probe === true);
			const preferDsh = Boolean(body && body.useDshNative === true) || process.platform !== "win32";

			// Windows：默认使用系统标准的"浏览文件夹"对话框（PowerShell FolderBrowserDialog）
			if (!preferDsh && windowsPickerAvailable()) {
				if (probeOnly) return { available: true, kind: "windows" };
				const picked = await pickFolderWindows({ title: "选择下载位置" });
				if (picked.ok) return { available: true, kind: "windows", path: picked.path, canceled: picked.canceled };
				const fallback = await pickWithDshPicker(ctx, body, false);
				if (fallback.available && !fallback.error) return fallback;
				return {
					available: true,
					kind: "windows",
					path: "",
					canceled: false,
					error: picked.error || (fallback && fallback.error) || "打开系统选择框失败",
				};
			}
			return pickWithDshPicker(ctx, body, probeOnly);
		},

		"GET /api/workspaces": () => listWorkspaces(ctx),

		"POST /api/workspaces/remove": async (body) => {
			const ids = Array.isArray(body && body.ids) ? [...new Set(body.ids.map(String))] : [];
			if (!ids.length) throw new AppError("bad-request", "缺少要删除的工作区 id");
			const workspaceRegistry = getService(ctx, "workspaceRegistry");
			const results = [];
			if (workspaceRegistry && typeof workspaceRegistry.delete === "function") {
				for (const id of ids) {
					try {
						const deleted = await workspaceRegistry.delete(id);
						results.push({ id, ok: deleted !== false });
					} catch (error) {
						results.push({ id, ok: false, error: error.message });
					}
				}
				const failed = results.filter((item) => !item.ok);
				return {
					ok: failed.length === 0,
					mode: "official",
					output: failed.length ? `部分删除失败：${failed.map((item) => item.id).join(", ")}` : `已删除 ${ids.length} 个工作区`,
					results,
				};
			}
			const fallback = removeWorkspaces(ids);
			const removed = fallback.removed || [];
			return {
				ok: fallback.ok === true,
				mode: "file",
				output: fallback.ok ? `已从注册表删除 ${removed.length} 个工作区（DSH 需刷新/重启生效）` : fallback.error,
				results: removed.map((id) => ({ id, ok: true })),
			};
		},
	};
}
