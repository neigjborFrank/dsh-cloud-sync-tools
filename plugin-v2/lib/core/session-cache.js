// 会话日志扫描 + DSH 侧边栏投影缓存（session_projcache）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { writeJsonAtomic } from "../shared.js";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const fallbackHome = () => process.env.DSH_HOME || path.join(os.homedir(), ".dsh");

/** 读取会话日志：header、最后一个事件 seq、事件数、session/title 标题（多帧解压） */
export function readSessionLogInfo(file) {
	try {
		const buf = fs.readFileSync(file);
		let start = 0;
		let header = null;
		let lastSeq = -1;
		let eventCount = 0;
		let title = "";
		while (start < buf.length) {
			const at = buf.indexOf(MAGIC, start);
			if (at < 0) break;
			const next = buf.indexOf(MAGIC, at + 4);
			const end = next < 0 ? buf.length : next;
			let text;
			try {
				text = zstdDecompressSync(buf.subarray(at, end)).toString("utf8");
			} catch {
				break;
			}
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (!header && event.type === "session") header = event;
					else {
						eventCount++;
						if (typeof event.seq === "number" && event.seq > lastSeq) lastSeq = event.seq;
						if (event.type === "session/title") {
							const value = event.data && (event.data.title || event.data.val);
							if (typeof value === "string" && value.trim()) title = value.trim();
						}
					}
				} catch {}
			}
			start = end;
		}
		return { header, lastSeq: lastSeq >= 0 ? lastSeq : 0, eventCount, title };
	} catch {
		return null;
	}
}

/**
 * 写 DSH 侧边栏标题/列表投影缓存（session_projcache，version 7）。
 * 关键：DSH 只接受 identity（formatVersion/createdAt/cwd/isSeeded）与会话头**完全匹配**的记录，
 * 否则标题显示"未命名"，直到打开会话后 DSH 重建缓存。因此 identity 必须取自会话头而非当前时间。
 */
export function writeProjCache(sessionId, options = {}) {
	try {
		const home = options.home || fallbackHome();
		const header = options.header || {};
		const cwd = options.cwd || header.cwd || "";
		const title = options.title || "";
		const lastSeq = Number.isFinite(options.lastSeq) ? Number(options.lastSeq) : 0;
		const file = path.join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
		// 已有且 identity 匹配的缓存（DSH 写过的完整投影）不要覆盖，避免丢掉列表/统计投影
		try {
			const existing = JSON.parse(fs.readFileSync(file, "utf8"));
			const identity = existing && existing.record && existing.record.identity;
			const rows = (existing && existing.record && existing.record.rows) || {};
			if (
				identity &&
				identity.formatVersion === Number(header.version || 4) &&
				identity.createdAt === Number(header.createdAt || 0) &&
				identity.cwd === cwd &&
				Boolean(identity.isSeeded) === Boolean(header.isSeeded) &&
				rows.title &&
				rows.title.val
			) {
				return;
			}
		} catch {
			/* 缓存缺失/损坏时重建 */
		}
		const payload = {
			version: 7,
			record: {
				identity: {
					formatVersion: Number(header.version || 4),
					createdAt: Number(header.createdAt || 0),
					cwd,
					isSeeded: Boolean(header.isSeeded),
					inheritedEventCount: Number(header.inheritedEventCount || 0),
				},
				rows: {
					title: title ? { ver: 1, seq: lastSeq, val: title } : undefined,
					sessionListMetadata: { ver: 1, seq: lastSeq, val: { blank: false, lastPromptAt: null } },
				},
			},
		};
		writeJsonAtomic(file, payload);
	} catch {}
}
