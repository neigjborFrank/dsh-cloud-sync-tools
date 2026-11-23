// Windows 原生"浏览文件夹"选择框（PowerShell FolderBrowserDialog）
// 作为 DSH directoryPicker 的可靠兜底：Windows 上默认优先用它。
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function windowsPickerAvailable() {
	if (process.platform !== "win32") return false;
	const systemRoot = process.env.SystemRoot || "C:\\Windows";
	const candidates = [
		path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		path.join(systemRoot, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
	];
	return candidates.some((candidate) => fs.existsSync(candidate));
}

const quote = (text) => String(text || "").replace(/'/g, "''");

/**
 * 打开 Windows 标准"浏览文件夹"对话框。
 * @returns {Promise<{ok:boolean, canceled:boolean, path:string, error?:string}>}
 */
export function pickFolderWindows({ title = "选择下载位置", timeoutMs = 300000 } = {}) {
	if (process.platform !== "win32") return Promise.resolve({ ok: false, canceled: false, path: "", error: "unsupported-platform" });
	const script = [
		"Add-Type -AssemblyName System.Windows.Forms",
		"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
		`$dialog.Description = '${quote(title)}'`,
		"$dialog.ShowNewFolderButton = $true",
		"$form = New-Object System.Windows.Forms.Form",
		"$form.TopMost = $true",
		"$form.ShowInTaskbar = $false",
		"$form.WindowState = 'Minimized'",
		"$form.Show()",
		"$result = $dialog.ShowDialog($form)",
		"if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
		"$form.Close()",
	].join("\n");

	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
			{ timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
			(error, stdout, stderr) => {
				const selected = String(stdout || "").trim();
				if (error) {
					return resolve({ ok: false, canceled: false, path: "", error: String(stderr || error.message || error).trim().slice(0, 300) });
				}
				if (!selected) return resolve({ ok: true, canceled: true, path: "" });
				return resolve({ ok: true, canceled: false, path: selected });
			},
		);
	});
}
