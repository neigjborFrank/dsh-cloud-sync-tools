/**
 * 云端同步面板 v2 —— 浏览器端
 *
 * 由 DSH 以脚本方式加载（window.__ModuleLoader__），因此保持单文件、无 ESM 依赖。
 * 内部按区域拆分：基础 API → 项目树 → 上传 → 下载 → 仓库管理 → 云端与同步 → 挂载。
 *
 * 后端接口见 docs/架构说明-v2.md 第 6 节。
 */
const PLUGIN = "dsh-plugin-cloud-sync-panel";
const HOSTS = ["http://127.0.0.1:8732", "http://localhost:8732"];
const CSS_ID = PLUGIN + "/panel.css";
const BTN_ID = PLUGIN + "-launch";
const MENU_ID = PLUGIN + "-menu";

const CSS = `
.dsh-csp-btn { display:inline-flex; align-items:center; gap:6px; width:100%; box-sizing:border-box;
	padding:6px 8px; border:none; border-radius:8px; background:transparent; color:inherit;
	font:inherit; font-size:12px; line-height:1; cursor:pointer; opacity:.85; }
.dsh-csp-btn:hover { opacity:1; background:rgba(127,127,127,.14); }
.dsh-csp-btn .dsh-csp-icon { font-size:14px; }
.dsh-csp-btn[data-state="down"] { color:#ff5c5c; opacity:1; }
.dsh-csp-menu { position:fixed; z-index:2147483000; width:300px; background:#1f2127; color:#e8eaf0;
	border:1px solid #33363f; border-radius:10px; box-shadow:0 12px 32px rgba(0,0,0,.45);
	padding:6px; font-size:12.5px; font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif; user-select:none; }
.dsh-csp-menu[hidden] { display:none; }
.dsh-csp-item { display:flex; align-items:center; gap:8px; width:100%; box-sizing:border-box;
	padding:8px 10px; border:none; border-radius:7px; background:transparent; color:#e8eaf0;
	font:inherit; text-align:left; cursor:pointer; }
.dsh-csp-item:hover:not(:disabled) { background:rgba(127,127,127,.16); }
.dsh-csp-item:disabled { opacity:.4; cursor:default; }
.dsh-csp-item .dsh-csp-k { margin-left:auto; color:#8b90a0; font-size:11px; }
.dsh-csp-note { padding:6px 10px 4px; color:#8b90a0; font-size:11px; line-height:1.5;
	word-break:break-word; white-space:pre-wrap; max-height:140px; overflow:auto; }
.dsh-csp-note.err { color:#ff9a9a; }
.dsh-csp-picker { padding:4px; }
.dsh-csp-picker[hidden] { display:none; }
.dsh-csp-head { display:flex; align-items:center; justify-content:space-between; gap:8px;
	padding:4px 6px; color:#c7cbd8; font-size:11.5px; }
.dsh-csp-head span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-csp-list { max-height:280px; overflow:auto; border-top:1px solid #33363f; border-bottom:1px solid #33363f; }
.dsh-csp-proj { display:flex; align-items:center; gap:6px; padding:7px 8px; border-radius:6px; cursor:pointer; }
.dsh-csp-proj:hover { background:rgba(127,127,127,.12); }
.dsh-csp-proj .n { flex:1; min-width:0; }
.dsh-csp-proj .n b { display:block; font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-csp-proj .n span { color:#8b90a0; font-size:10.5px; }
.dsh-csp-sess { display:flex; gap:6px; align-items:flex-start; padding:5px 8px 5px 24px; border-radius:6px; }
.dsh-csp-sess:hover { background:rgba(127,127,127,.1); }
.dsh-csp-sess input { margin-top:3px; accent-color:#2f6df6; }
.dsh-csp-sess .n { flex:1; min-width:0; }
.dsh-csp-sess .n b { display:block; font-size:11.5px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-csp-sess .n span { color:#8b90a0; font-size:10px; }
.dsh-csp-foot { display:flex; gap:6px; padding:6px 4px 2px; }
.dsh-csp-foot button { flex:1; padding:6px; border-radius:6px; border:1px solid #33363f;
	background:#262931; color:#e8eaf0; font-size:11.5px; cursor:pointer; }
.dsh-csp-foot button:hover { background:#2f333d; }
.dsh-csp-foot button.go { background:linear-gradient(180deg,#2f6df6,#2559d6); border-color:#3b74f2; color:#fff; font-weight:600; }
.dsh-csp-mini { flex:0 0 auto; padding:4px 8px; border-radius:6px; border:1px solid #3a3f4b;
	background:#262931; color:#c7cbd8; font-size:11px; cursor:pointer; }
.dsh-csp-mini:hover { background:#313642; color:#fff; }
.dsh-csp-input { padding:6px 8px; }
.dsh-csp-input input { width:100%; box-sizing:border-box; padding:7px 8px; border-radius:7px;
	border:1px solid #3a3f4b; background:#17181c; color:#e8eaf0; font:inherit; font-size:11.5px; }
.dsh-csp-input input:focus { outline:none; border-color:#2f6df6; }
.dsh-csp-cv-repo { padding:5px 8px; color:#8b90a0; font-size:10.5px; line-height:1.65;
	border-bottom:1px solid #33363f; }
.dsh-csp-cv-proj { display:flex; align-items:center; gap:6px; padding:7px 8px; border-radius:6px; cursor:pointer; }
.dsh-csp-cv-proj:hover { background:rgba(127,127,127,.12); }
.dsh-csp-cv-proj .caret { width:10px; color:#8b90a0; font-size:10px; flex:0 0 auto; }
.dsh-csp-cv-proj .nm { flex:1; min-width:0; }
.dsh-csp-cv-proj .nm b { display:block; font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-csp-cv-proj .nm span { color:#8b90a0; font-size:10px; }
.dsh-csp-cv-proj .stat { flex:0 0 auto; color:#8b90a0; font-size:9.5px; }
.dsh-csp-cv-kids { margin-left:14px; border-left:1px solid #33363f; padding-left:4px; }
.dsh-csp-cv-wsrow { display:flex; align-items:center; gap:6px; padding:4px 8px; }
.dsh-csp-cv-sess { display:flex; align-items:center; gap:6px; padding:4px 8px; }
.dsh-csp-cv-wsrow .ico, .dsh-csp-cv-sess .ico { font-size:10px; opacity:.75; flex:0 0 auto; }
.dsh-csp-cv-wsrow .nm, .dsh-csp-cv-sess .nm { flex:1; min-width:0; font-size:11px; color:#d5d8e1;
	white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-csp-cv-sess .nm { color:#c2c6d2; }
.dsh-csp-cv-state { flex:0 0 auto; font-size:9.5px; padding:1px 5px; border-radius:4px; }
.dsh-csp-cv-state.ok { background:#1f3326; color:#7fcf9a; }
.dsh-csp-cv-state.warn { background:#3a3020; color:#e6b85c; }
.dsh-csp-cv-state.cloud { background:#22303f; color:#7fb0e6; }
.dsh-csp-cv-state.muted { background:#2a2d35; color:#8b90a0; }
.dsh-csp-repobadge { display:inline-block; margin-left:4px; padding:0 4px; border:1px solid #3a3f4b; border-radius:4px; font-size:9.5px; color:#8b90a0; }
.muted { color:#8b90a0; }
`;

window.__ModuleLoader__.load({
	id: PLUGIN,
	factory() {
		function apply(ctx) {
			try {
				const style = document.createElement("style");
				style.dataset.pluginCss = CSS_ID;
				style.textContent = CSS;

				const button = document.createElement("button");
				button.type = "button";
				button.className = "dsh-csp-btn";
				button.title = "云端同步";
				button.setAttribute("aria-label", "云端同步");
				button.setAttribute("aria-haspopup", "menu");
				const icon = document.createElement("span");
				icon.className = "dsh-csp-icon";
				icon.textContent = "⇅";
				const label = document.createElement("span");
				label.textContent = "同步";
				button.append(icon, label);

				const menu = document.createElement("div");
				menu.className = "dsh-csp-menu";
				menu.id = MENU_ID;
				menu.hidden = true;
				menu.setAttribute("role", "menu");
				menu.innerHTML = [
					'<button class="dsh-csp-item" data-act="upload">上传会话…<span class="dsh-csp-k">⇡</span></button>',
					'<button class="dsh-csp-item" data-act="download">下载会话…<span class="dsh-csp-k">⇣</span></button>',
					'<button class="dsh-csp-item" data-act="cloud">云端与同步…<span class="dsh-csp-k">☁</span></button>',
					'<button class="dsh-csp-item" data-act="repos">仓库管理…<span class="dsh-csp-k">🗄</span></button>',
					'<div class="dsh-csp-note" data-k="note" hidden></div>',
					'<div class="dsh-csp-picker" data-k="picker" hidden></div>',
				].join("");

				const note = menu.querySelector('[data-k="note"]');
				const picker = menu.querySelector('[data-k="picker"]');
				const items = Array.from(menu.querySelectorAll(".dsh-csp-item"));

				let base = HOSTS[0];
				let token = "";
				let treeCache = null;

				const escapeHtml = (value) =>
					String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
				const fmtMB = (bytes) => (Number(bytes || 0) / 1024 / 1024).toFixed(2) + " MB";

				// ---------- 布局 ----------
				const place = () => {
					const rect = button.getBoundingClientRect();
					menu.style.left = Math.max(8, Math.round(rect.left)) + "px";
					const below = Math.round(rect.bottom + 6);
					menu.style.top = below + "px";
					requestAnimationFrame(() => {
						const height = menu.offsetHeight;
						if (below + height > window.innerHeight - 8) {
							menu.style.top = Math.max(8, Math.round(rect.top - height - 6)) + "px";
						}
					});
				};
				const setNote = (text, isErr) => {
					note.hidden = !text;
					note.textContent = text || "";
					note.classList.toggle("err", Boolean(isErr));
					if (!menu.hidden) place();
				};

				// ---------- 与宿主通信 ----------
				const fetchTimed = async (url, init, ms) => {
					const controller = new AbortController();
					const timer = window.setTimeout(() => controller.abort(), ms || 6000);
					try {
						return await fetch(url, { ...(init || {}), signal: controller.signal, cache: "no-store" });
					} finally {
						window.clearTimeout(timer);
					}
				};
				const resolveBase = async () => {
					let lastError = null;
					for (const host of [base, ...HOSTS.filter((item) => item !== base)]) {
						try {
							const response = await fetchTimed(host + "/api/health", null, 2500);
							const data = await response.json();
							if (data && data.ok) {
								base = host;
								return host;
							}
							lastError = new Error("健康检查异常");
						} catch (error) {
							lastError = error;
						}
					}
					token = "";
					throw lastError || new Error("无法连接同步服务");
				};
				const ensureToken = async () => {
					if (token) return token;
					await resolveBase();
					const response = await fetchTimed(base + "/token", null, 4000);
					const data = await response.json();
					token = data.token || "";
					if (!token) throw new Error("未取得访问令牌");
					return token;
				};
				const call = async (apiPath, init) => {
					const current = await ensureToken();
					const separator = apiPath.includes("?") ? "&" : "?";
					const response = await fetchTimed(`${base}${apiPath}${separator}token=${encodeURIComponent(current)}`, init, 300000);
					if (response.status === 401) {
						token = "";
						throw new Error("访问令牌失效，请重试");
					}
					return response.json();
				};
				const postJson = (apiPath, body) =>
					call(apiPath, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
				// 自动更新云端状态：fast-forward 拉取远端仓库，同时拿到最新 tree/cloudView
				const syncCloudState = async () => {
					try {
						const result = await postJson("/api/sync-status", {});
						if (result.tree) treeCache = result.tree;
						return { ok: true, changed: Boolean(result.changed), output: String(result.output || ""), data: result };
					} catch (error) {
						try {
							treeCache = await call("/api/tree");
						} catch {}
						return { ok: false, changed: false, output: `自动同步失败（使用本地缓存）：${error.message || error}`, data: null };
					}
				};
				const showDown = (error) => {
					const detail = error ? `（${error.message || error}）` : "";
					setNote(`连不上 ${HOSTS[0]}${detail}\n服务由插件宿主内置提供，请重启 DSH`, true);
					button.dataset.state = "down";
				};
				const busyRun = async (fn) => {
					items.forEach((item) => (item.disabled = true));
					try {
						return await fn();
					} finally {
						items.forEach((item) => (item.disabled = false));
					}
				};

				// ---------- 项目树 ----------
				const repos = () => (treeCache && treeCache.repos) || [];
				const usableRepos = () => repos().filter((repo) => repo.ok);
				const bindingOf = (project) => (treeCache && treeCache.bindings && treeCache.bindings[project.name]) || "";

				const renderTree = (mode) => {
					const projects = ((treeCache && treeCache.projects) || []).filter((project) =>
						mode === "upload" ? Boolean(project.cwd) : Boolean(project.cloudProject),
					);
					const rows = projects
						.map((project, index) => {
							const cloud = project.cloudProject;
							const badge = cloud
								? `云端 ${cloud.files} 文件 / ${cloud.sessionCount} 会话${cloud.repoName ? " · " + cloud.repoName : ""}`
								: "云端未上传";
							return (
								`<div class="dsh-csp-proj"><span class="n">` +
								`<b>${escapeHtml(project.title || project.name || "(无工作区)")}</b>` +
								`<span>${(project.sessions || []).length} 个会话 · ${escapeHtml(badge)}</span></span>` +
								`<button class="dsh-csp-mini" data-open="${index}">会话</button></div>`
							);
						})
						.join("");
					picker.hidden = false;
					const noRepo = usableRepos().length === 0;
					picker.innerHTML =
						`<div class="dsh-csp-head"><span>${mode === "upload" ? "上传：选项目" : "下载：选项目"}</span>` +
						`<span>${projects.length} 个</span></div>` +
						(noRepo
							? `<div class="dsh-csp-cv-repo">还没有登记同步仓库。请先在「仓库管理…」登记你的私有仓库（例如 git@github.com:you/deepseek_cloud.git）。</div>` +
								`<div class="dsh-csp-foot"><button class="go" data-goto-repos="1">去登记仓库</button></div>`
							: `<div class="dsh-csp-list">${rows || '<div class="dsh-csp-proj">没有项目</div>'}</div>`);
					const gotoRepos = picker.querySelector("[data-goto-repos]");
					if (gotoRepos) gotoRepos.onclick = () => void showRepos();
					picker.querySelectorAll("[data-open]").forEach((btn) => {
						btn.onclick = () => {
							const project = projects[Number(btn.dataset.open)];
							if (project) void renderSessions(project, mode);
						};
					});
					place();
				};

				const renderSessions = async (project, mode) => {
					const canUpload = mode === "upload" && Boolean(project.cwd);
					const canDownload = mode === "download" && Boolean(project.cloudProject);
					const sessions = project.sessions || [];
					const rows = sessions
						.map(
							(session) =>
								`<div class="dsh-csp-sess"><input type="checkbox" data-sid="${escapeHtml(session.id)}" ` +
								`${session.archived ? "disabled" : "checked"}>` +
								`<span class="n"><b>${session.subagent ? "〔子会话〕" : ""}${escapeHtml(session.title || "(无标题)")}</b>` +
								`<span>${fmtMB(session.bytes)} · ${session.cloud ? "云端已有" : "云端无"}${session.archived ? " · 已归档" : ""}${session.subagent ? " · 子会话（侧边栏默认不显示）" : ""}</span></span></div>`,
						)
						.join("");
					picker.innerHTML =
						`<div class="dsh-csp-head"><span>${escapeHtml(project.title || project.name)} · 会话</span>` +
						`<button class="dsh-csp-mini" data-back="1">返回</button></div>` +
						`<div class="dsh-csp-list">${rows || '<div class="dsh-csp-sess">该项目下没有会话</div>'}</div>` +
						`<div class="dsh-csp-foot">` +
						(canUpload ? `<button data-all="1">全选</button><button class="go" data-go="upload">上传</button>` : "") +
						(canDownload ? `<button class="go" data-go="download">下载</button>` : "") +
						`</div>`;

					const boxes = () => Array.from(picker.querySelectorAll('input[type="checkbox"]:not([disabled])'));
					const allBtn = picker.querySelector("[data-all]");
					if (allBtn) allBtn.onclick = () => boxes().forEach((box) => (box.checked = true));
					const back = picker.querySelector("[data-back]");
					if (back) back.onclick = () => renderTree(mode);
					const go = picker.querySelector("[data-go]");
					if (go) {
						go.onclick = () => {
							const ids = boxes().filter((box) => box.checked).map((box) => box.dataset.sid);
							if (!ids.length) return setNote("请先勾选会话", true);
							if (go.dataset.go === "upload") void chooseRepoAndUpload(project, ids);
							else void showDownloadDialog(project, ids);
						};
					}
					place();
				};

				// ---------- 上传 ----------
				const chooseRepoAndUpload = async (project, ids) => {
					const list = usableRepos();
					if (!list.length) return setNote("还没有登记仓库，请先打开「仓库管理…」", true);
					if (list.length === 1) return doUpload(project, ids, list[0].id);

					const boundId = bindingOf(project);
					const options = list
						.map((repo, index) => {
							const checked = boundId ? repo.id === boundId : index === 0;
							return (
								`<label class="dsh-csp-sess" style="padding-left:8px"><input type="radio" name="csp-repo" value="${escapeHtml(repo.id)}" ${checked ? "checked" : ""}>` +
								`<span class="n"><b>${escapeHtml(repo.name)}</b><span>${escapeHtml(repo.url || repo.path || "")}</span></span></label>`
							);
						})
						.join("");
					picker.hidden = false;
					picker.innerHTML =
						`<div class="dsh-csp-head"><span>上传到哪个仓库？</span></div>` +
						`<div class="dsh-csp-list">${options}</div>` +
						`<div class="dsh-csp-foot"><button data-cancel="1">取消</button><button class="go" data-go="1">开始上传</button></div>`;
					picker.querySelector("[data-cancel]").onclick = () => {
						picker.hidden = true;
						setNote("");
					};
					picker.querySelector("[data-go]").onclick = () => {
						const chosen = picker.querySelector('input[name="csp-repo"]:checked');
						if (!chosen) return setNote("请选择一个仓库", true);
						void doUpload(project, ids, chosen.value);
					};
					place();
				};

				const doUpload = async (project, ids, repoId) => {
					await busyRun(async () => {
						setNote(`正在上传工作区与 ${ids.length} 个会话…`);
						try {
							const result = await postJson("/api/upload-project", { cwd: project.cwd, sessionIds: ids, repoId });
							const lines = [String(result.output || "")];
							if (result.mergedInto) lines.push(`已合并到「${result.mergedInto}」`);
							if (result.migrated) lines.push(`已把旧项目「${result.migrated}」并入当前工作区`);
							if (result.conflicts && result.conflicts.length) lines.push(`冲突文件 ${result.conflicts.length} 个（旧版保留，新内容在 conflicts/）`);
							setNote(lines.join("\n").split("\n").slice(-10).join("\n"), !result.ok);
							treeCache = await call("/api/tree");
						} catch (error) {
							setNote("上传失败：" + (error.message || error), true);
						}
					});
				};

				// ---------- 下载 ----------
				const suggestedTarget = (project) => {
					const base = (treeCache && treeCache.suggestedBase) || "";
					const rawTitle = project.title || (project.name || "workspace").split("__")[0] || "workspace";
					const safe = String(rawTitle).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim() || "workspace";
					return base ? `${base}\\${safe}` : safe;
				};

				const showDownloadDialog = async (project, ids) => {
					// 不再自动弹系统选择框；默认目录已预填，留空则由服务端自动创建
					const target = suggestedTarget(project);
					const base = (treeCache && treeCache.suggestedBase) || "";

					picker.hidden = false;
					picker.innerHTML =
						`<div class="dsh-csp-head"><span>下载到</span><button class="dsh-csp-mini" data-browse="1">选择文件夹…</button></div>` +
						`<div class="dsh-csp-input"><input id="csp-target" value="${escapeHtml(target)}" placeholder="留空则自动在默认目录创建"></div>` +
						`<div class="dsh-csp-cv-repo">默认目录：${escapeHtml(base || "(未配置)")}<br>目录不存在时会自动创建；留空则按项目名创建子文件夹。</div>` +
						`<div class="dsh-csp-sess"><input type="checkbox" id="csp-with" checked>` +
						`<span class="n"><b>同时下载工作区</b><span>并自动登记为新工作区（推荐）</span></span></div>` +
						`<div class="dsh-csp-sess"><input type="checkbox" id="csp-pull" checked>` +
						`<span class="n"><b>先拉取远端更新</b><span>多设备时推荐：下载前同步远端最新提交</span></span></div>` +
						`<div class="dsh-csp-sess"><input type="checkbox" id="csp-migrate" checked>` +
						`<span class="n"><b>迁移会话（清理旧位置副本）</b><span>把旧工作区目录下的同 ID 会话移到 session-trash，避免侧边栏重复</span></span></div>` +
						`<div class="dsh-csp-sess"><input type="checkbox" id="csp-convert" checked>` +
						`<span class="n"><b>子会话转为普通会话</b><span>父会话不在时自动转普通，否则子会话不会显示在侧边栏</span></span></div>` +
						`<div class="dsh-csp-foot"><button data-cancel="1">取消</button><button class="go" data-go="1">开始下载</button></div>`;

					const input = picker.querySelector("#csp-target");
					const withBox = picker.querySelector("#csp-with");
					const pullBox = picker.querySelector("#csp-pull");
					const migrateBox = picker.querySelector("#csp-migrate");
					const convertBox = picker.querySelector("#csp-convert");
					picker.querySelector("[data-browse]").onclick = async () => {
						setNote("正在打开系统文件夹选择框…");
						try {
							const picked = await postJson("/api/pick-directory", {});
							if (picked.canceled) {
								setNote("已取消选择");
								return;
							}
							if (picked.path) {
								input.value = picked.path;
								setNote("已选择：" + picked.path);
								return;
							}
							if (picked.available === false) {
								setNote(picked.hint || "当前环境没有系统选择框，将使用默认目录自动创建", false);
								return;
							}
							setNote("打开选择框失败：" + (picked.error || "未知错误"), true);
						} catch (error) {
							setNote("打开选择框失败：" + (error.message || error), true);
						}
					};
					picker.querySelector("[data-cancel]").onclick = () => {
						picker.hidden = true;
						setNote("");
					};
					picker.querySelector("[data-go]").onclick = () => {
						// 允许留空：服务端自动在默认目录下创建项目文件夹
						void doDownload(project, ids, String(input.value || "").trim(), withBox.checked, pullBox.checked, migrateBox.checked, convertBox.checked);
					};
					place();
				};

				const doDownload = async (project, ids, targetDir, withWorkspace, pullRemote = true, migrate = true, convertSubagent = true) => {
					await busyRun(async () => {
						setNote(withWorkspace ? "正在下载并镜像工作区…" : "正在下载会话…");
						try {
							const result = await postJson("/api/download-project", {
								name: project.cloudProject ? project.cloudProject.name : project.name,
								repoId: project.cloudProject ? project.cloudProject.repoId : undefined,
								targetDir,
								sessionIds: ids,
								withWorkspace,
								pull: pullRemote,
								migrate,
								convertSubagent,
							});
							let text = String(result.output || "");
							if (result.targetDir) text += `\n目标目录：${result.targetDir}`;
							const pending = result.pendingLarge || [];
							if (pending.length) {
								text += `\n\n有 ${pending.length} 个大文件未能自动恢复：\n` + pending.slice(0, 5).map((item) => `${item.reason}：${item.path}`).join("\n");
							}
							setNote(text.split("\n").slice(-12).join("\n"), !result.ok);
							treeCache = await call("/api/tree");
							picker.hidden = true;
						} catch (error) {
							setNote("下载失败：" + (error.message || error), true);
						}
					});
				};

				// ---------- 仓库管理 ----------
				const showRepos = async () => {
					picker.hidden = false;
					menu.style.width = "340px";
					picker.innerHTML = '<div class="dsh-csp-head"><span>正在读取仓库…</span></div>';
					try {
						const data = await call("/api/repos");
						renderRepos(data.repos || []);
					} catch (error) {
						picker.hidden = true;
						showDown(error);
					}
				};

				const renderRepos = (list) => {
					const rows = list
						.map(
							(repo) =>
								`<div class="dsh-csp-sess" style="padding-left:8px"><span class="n">` +
								`<b>${escapeHtml(repo.name)}${repo.ok ? "" : "（本地缺失）"}</b>` +
								`<span>${escapeHtml(repo.url || "(无地址)")}</span></span>` +
								`<button class="dsh-csp-mini" data-rm="${escapeHtml(repo.id)}">移除</button></div>`,
						)
						.join("");
					picker.innerHTML =
						`<div class="dsh-csp-head"><span>已登记仓库 ${list.length} 个</span></div>` +
						`<div class="dsh-csp-list" style="max-height:200px">${rows || '<div class="dsh-csp-sess"><span class="n"><b>还没有仓库</b></span></div>'}</div>` +
						`<div class="dsh-csp-cv-repo">工具所在仓库不会自动登记；请在此登记<b>你自己的私有仓库</b>（会话与工作区会保存到它）。</div>` +
						`<div class="dsh-csp-input"><input id="csp-repo-url" placeholder="私有仓库地址，如 git@github.com:you/deepseek_cloud.git"></div>` +
						`<div class="dsh-csp-input"><input id="csp-repo-path" placeholder="或本机已有仓库的绝对路径（二选一）"></div>` +
						`<div class="dsh-csp-input"><input id="csp-repo-name" placeholder="名称（可空）"></div>` +
						`<div class="dsh-csp-foot"><button data-cancel="1">关闭</button><button class="go" data-add="1">添加仓库</button></div>`;

					const urlInput = picker.querySelector("#csp-repo-url");
					const pathInput = picker.querySelector("#csp-repo-path");
					const nameInput = picker.querySelector("#csp-repo-name");
					picker.querySelector("[data-cancel]").onclick = () => {
						picker.hidden = true;
						setNote("");
					};
					picker.querySelectorAll("[data-rm]").forEach((btn) => {
						btn.onclick = async () => {
							try {
								const result = await postJson("/api/repos/remove", { id: btn.dataset.rm });
								if (!result.ok) return setNote(result.output || "移除失败", true);
								treeCache = null;
								renderRepos(result.repos || []);
							} catch (error) {
								setNote("移除失败：" + (error.message || error), true);
							}
						};
					});
					picker.querySelector("[data-add]").onclick = async () => {
						const url = String(urlInput.value || "").trim();
						const localPath = String(pathInput.value || "").trim();
						if (!url && !localPath) return setNote("请输入仓库地址或本机仓库路径", true);
						setNote(url ? "正在克隆仓库（首次可能较慢）…" : "正在登记本机仓库…");
						try {
							const result = await postJson("/api/repos", { url, path: localPath, name: String(nameInput.value || "").trim() });
							if (!result.ok) return setNote(result.output || "添加失败", true);
							treeCache = null;
							setNote("已登记仓库：" + (result.added && result.added.name ? result.added.name : url || localPath));
							renderRepos(result.repos || []);
						} catch (error) {
							setNote("添加失败：" + (error.message || error), true);
						}
					};
					place();
				};

				// ---------- 云端与同步 ----------
				const workspaceStatusText = (workspace) => {
					const status = workspace ? workspace.status : "cloud-only";
					if (status === "clean") return "一致";
					if (status === "dirty") {
						const parts = [];
						if (workspace.changed) parts.push(`改 ${workspace.changed}`);
						if (workspace.added) parts.push(`增 ${workspace.added}`);
						if (workspace.removed) parts.push(`删 ${workspace.removed}`);
						return `有未上传改动（${parts.join(" / ") || "有变化"}）`;
					}
					if (status === "cloud-only") return "仅云端（本地缺失）";
					if (status === "not-uploaded") return "云端未上传";
					return "无法判断";
				};
				const workspaceStatusClass = (workspace) => {
					const status = workspace ? workspace.status : "cloud-only";
					if (status === "clean") return "ok";
					if (status === "dirty" || status === "not-uploaded") return "warn";
					return "muted";
				};
				const sessionStatusText = (state) => {
					switch (state) {
						case "synced":
							return "一致";
						case "local-only":
							return "未上传";
						case "cloud-only":
							return "仅云端";
						case "archived":
							return "已归档";
						default:
							return "未知";
					}
				};
				const sessionStatusClass = (state) => {
					if (state === "synced") return "ok";
					if (state === "local-only") return "warn";
					if (state === "cloud-only") return "cloud";
					return "muted";
				};

				const renderCloudView = (data, expanded) => {
					const totals = data.totals || { projects: 0, sessions: 0, pendingWorkspaces: 0, pendingSessions: 0 };
					const repoNames = (data.repos || []).map((repo) => repo.name).join(" / ") || "（无可用仓库）";
					const summary =
						`工作区 ${totals.projects} · 会话 ${totals.sessions} · 待同步 工作区 ${totals.pendingWorkspaces} / 会话 ${totals.pendingSessions}` +
						(totals.ignoredInstall ? ` · 忽略 ${totals.ignoredInstall} 个安装目录内工作区` : "");

					const rows = (data.projects || [])
						.map((project) => {
							const open = expanded.has(project.name);
							const sessions = project.sessions || [];
							const wsState = workspaceStatusClass(project.workspace);
							const pending =
								(project.workspace && project.workspace.status === "dirty" ? 1 : 0) +
								sessions.filter((session) => session.state === "local-only").length;
							const kids = !open
								? ""
								: `<div class="dsh-csp-cv-kids">` +
									`<div class="dsh-csp-cv-wsrow"><span class="ico">▦</span><span class="nm">工作区</span>` +
									`<span class="dsh-csp-cv-state ${wsState}">${escapeHtml(workspaceStatusText(project.workspace))}</span></div>` +
									sessions
										.map(
											(session) =>
												`<div class="dsh-csp-cv-sess"><span class="ico">💬</span>` +
												`<span class="nm">${session.subagent ? "〔子会话〕" : ""}${escapeHtml(session.title || "(无标题)")}</span>` +
												`<span class="dsh-csp-cv-state ${sessionStatusClass(session.state)}">${escapeHtml(sessionStatusText(session.state))}</span></div>`,
										)
										.join("") +
									(sessions.length ? "" : '<div class="dsh-csp-cv-sess"><span class="nm muted">无会话</span></div>') +
									`</div>`;
							const badge = project.repoName ? `<span class="dsh-csp-repobadge">${escapeHtml(project.repoName)}</span>` : "";
							return (
								`<div class="dsh-csp-cv-proj" data-proj="${escapeHtml(project.name)}" title="${escapeHtml(project.cwd || "")}">` +
								`<span class="caret">${open ? "▾" : "▸"}</span>` +
								`<span class="nm"><b>${escapeHtml(project.title || project.name)}${badge}</b>` +
								`<span>${escapeHtml(project.cwd || "")}</span></span>` +
								`<span class="stat">${sessions.length} 会话${pending ? ` · 待同步 ${pending}` : ""}</span></div>` +
								kids
							);
						})
						.join("");

					picker.hidden = false;
					const noRepo = (data.repos || []).filter((repo) => repo.ok).length === 0;
					picker.innerHTML =
						`<div class="dsh-csp-head"><span>云端与同步</span><button class="dsh-csp-mini" data-sync="1">同步云端</button><button class="dsh-csp-mini" data-refresh="1">刷新</button></div>` +
						(noRepo
							? `<div class="dsh-csp-cv-repo">还没有登记同步仓库。请先在「仓库管理…」登记你自己的私有仓库。</div>` +
								`<div class="dsh-csp-foot"><button class="go" data-goto-repos="1">去登记仓库</button></div>`
							: `<div class="dsh-csp-cv-repo">${escapeHtml(repoNames)}<br>${escapeHtml(summary)}</div>` +
								`<div class="dsh-csp-list" style="max-height:420px">${rows || '<div class="dsh-csp-cv-proj"><span class="nm"><b>还没有任何工作区</b></span></div>'}</div>`);
					const gotoRepos = picker.querySelector("[data-goto-repos]");
					if (gotoRepos) gotoRepos.onclick = () => void showRepos();
					const refresh = picker.querySelector("[data-refresh]");
					if (refresh) refresh.onclick = () => void showCloudView(expanded);
					const syncBtn = picker.querySelector("[data-sync]");
					if (syncBtn) {
						syncBtn.onclick = async () => {
							if (syncBtn.dataset.busy) return;
							syncBtn.dataset.busy = "1";
							syncBtn.textContent = "同步中…";
							try {
								await showCloudView(expanded);
							} finally {
								syncBtn.textContent = "同步云端";
								delete syncBtn.dataset.busy;
							}
						};
					}
					picker.querySelectorAll("[data-proj]").forEach((row) => {
						row.onclick = () => {
							const name = row.dataset.proj;
							if (expanded.has(name)) expanded.delete(name);
							else expanded.add(name);
							renderCloudView(data, expanded);
						};
					});
					place();
				};

				const showCloudView = async (expanded) => {
					const set = expanded || new Set();
					menu.style.width = "340px";
					picker.hidden = false;
					picker.innerHTML = '<div class="dsh-csp-head"><span>正在同步云端状态…</span></div>';
					place();
					try {
						const sync = await syncCloudState();
						const data = sync.data && sync.data.cloudView ? sync.data.cloudView : await call("/api/cloud-view");
						if (!expanded) for (const project of data.projects || []) set.add(project.name);
						renderCloudView(data, set);
						if (!sync.ok) setNote(sync.output, true);
						else setNote(sync.changed ? "云端状态已自动更新（拉取到新提交）" : "云端状态已是最新", false);
					} catch (error) {
						picker.hidden = true;
						showDown(error);
					}
				};

				// ---------- 菜单开关 ----------
				const openPicker = async (mode) => {
					picker.hidden = false;
					picker.innerHTML = '<div class="dsh-csp-head"><span>正在同步云端状态…</span></div>';
					try {
						const sync = await syncCloudState();
						treeCache = sync.data && sync.data.tree ? sync.data.tree : await call("/api/tree");
						renderTree(mode);
						if (!sync.ok) setNote(sync.output, true);
						else if (sync.changed) setNote("已自动同步云端状态（拉取到新提交）", false);
					} catch (error) {
						picker.hidden = true;
						showDown(error);
					}
				};

				const open = () => {
					if (!document.getElementById(MENU_ID)) document.body.append(menu);
					menu.hidden = false;
					place();
					resolveBase()
						.then(() => {
							button.dataset.state = "up";
						})
						.catch((error) => showDown(error));
				};
				const close = () => {
					menu.hidden = true;
					menu.style.width = "";
					picker.hidden = true;
					picker.innerHTML = "";
				};
				const toggle = () => (menu.hidden ? open() : close());

				const onDocDown = (event) => {
					if (menu.hidden) return;
					if (menu.contains(event.target) || button.contains(event.target)) return;
					close();
				};
				const onKey = (event) => {
					if (event.key === "Escape" && !menu.hidden) close();
				};

				button.addEventListener("click", toggle);
				menu.addEventListener("click", (event) => {
					const item = event.target.closest(".dsh-csp-item");
					if (!item) return;
					switch (item.dataset.act) {
						case "upload":
							void openPicker("upload");
							break;
						case "download":
							void openPicker("download");
							break;
						case "cloud":
							void showCloudView();
							break;
						case "repos":
							void showRepos();
							break;
					}
				});
				document.addEventListener("mousedown", onDocDown, true);
				document.addEventListener("keydown", onKey, true);

				const mount = () => {
					if (document.getElementById(BTN_ID)) return true;
					const host = document.querySelector('[class*="_footerActions"]');
					if (!host) return false;
					button.id = BTN_ID;
					host.append(button);
					return true;
				};
				const fallback = () => {
					if (document.getElementById(BTN_ID)) return;
					button.id = BTN_ID;
					Object.assign(button.style, {
						position: "fixed",
						left: "10px",
						bottom: "10px",
						width: "auto",
						zIndex: "2147482999",
						background: "rgba(30,32,38,.92)",
						border: "1px solid rgba(255,255,255,.12)",
						color: "#e8eaf0",
					});
					document.body.append(button);
				};

				let observer = null;
				let timer = 0;

				ctx.effect(() => {
					try {
						document.head.append(style);
						if (!mount()) {
							observer = new MutationObserver(() => {
								if (mount() && observer) {
									observer.disconnect();
									observer = null;
								}
							});
							observer.observe(document.body, { childList: true, subtree: true });
							timer = window.setTimeout(() => {
								if (observer) {
									observer.disconnect();
									observer = null;
								}
								fallback();
							}, 5000);
						}
					} catch (error) {
						console.warn("[cloud-sync-panel] 挂载失败", error);
					}

					return () => {
						try {
							window.clearTimeout(timer);
							if (observer) observer.disconnect();
							document.removeEventListener("mousedown", onDocDown, true);
							document.removeEventListener("keydown", onKey, true);
							button.removeEventListener("click", toggle);
							button.remove();
							menu.remove();
							style.remove();
						} catch {
							/* 忽略清理错误 */
						}
					};
				});
			} catch (error) {
				console.warn("[cloud-sync-panel] 初始化失败（已忽略）", error);
			}
		}

		return { apply };
	},
});
