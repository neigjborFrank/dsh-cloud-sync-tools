# -*- coding: utf-8 -*-
"""把 Git 远端当作"云端仓库"，按需下载/上传本地工作区。

命令：
  check    [--json]          检查本地与云端是否一致（只读）
  download [--stash] [--json] 从云端下载（拉取），本地有改动时默认拒绝
  upload   [说明] [--json]   上传本地改动到云端（提交并推送）
  diff     [--json]          查看两侧差异
  status                     同 check，但输出给人看
  init <url> [branch]        首次绑定云端仓库
  log                        最近提交

配置：~/.dsh/cloud-sync.json  {"remote": "...", "branch": "main"}
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

CONFIG = Path.home() / ".dsh" / "cloud-sync.json"
WORKSPACE = Path.cwd()

GIT_CANDIDATES = [
    r"C:\Program Files\Git\cmd\git.exe",
    r"C:\Program Files (x86)\Git\cmd\git.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\Git\cmd\git.exe"),
]

GITIGNORE = """\
# 中间产物（预览图、试验文档、检查报告）——交付物请放 交付/
out/
tmp/
*.tmp
__pycache__/
*.pyc
.venv/
node_modules/

# 凭据
*.key
*.pem
.env
token*
credentials*
"""


def find_git():
    found = shutil.which("git")
    if found:
        return found
    for c in GIT_CANDIDATES:
        if os.path.isfile(c):
            return c
    raise SystemExit("找不到 git，请先安装 Git for Windows")


def git(*args, check=False):
    p = subprocess.run(
        [find_git(), *args], cwd=str(WORKSPACE), capture_output=True, text=True,
        encoding="utf-8", errors="replace",
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if check and p.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败: {p.stderr.strip()}")
    return p


def load_config():
    if CONFIG.exists():
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    return {}


def save_config(cfg):
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def is_repo():
    return (WORKSPACE / ".git").exists()


def ensure_identity():
    if not git("config", "user.email").stdout.strip():
        git("config", "user.name", "DSH User")
        git("config", "user.email", "dsh@localhost")


def ensure_repo():
    if not is_repo():
        git("init", "-b", "main")
        (WORKSPACE / ".gitignore").write_text(GITIGNORE, encoding="utf-8")
        ensure_identity()
        git("add", "-A")
        git("commit", "-m", "init: workspace baseline")


def upstream():
    p = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    return p.stdout.strip() if p.returncode == 0 else None


def state():
    """返回本地与云端的关系状态。"""
    if not is_repo():
        return {"state": "no-repo", "message": "尚未初始化本地仓库"}

    up = upstream()
    dirty_list = [l for l in git("status", "--porcelain").stdout.splitlines() if l.strip()]

    if not up:
        return {
            "state": "unbound",
            "message": "未绑定云端仓库",
            "dirty": len(dirty_list),
            "dirty_files": dirty_list[:20],
        }

    fetched = git("fetch", "origin", "--prune").returncode == 0
    if not fetched:
        return {"state": "offline", "message": "无法连接云端（fetch 失败）", "dirty": len(dirty_list)}

    ahead = behind = 0
    p = git("rev-list", "--left-right", "--count", f"HEAD...{up}")
    if p.returncode == 0 and p.stdout.strip():
        a, b = p.stdout.split()
        ahead, behind = int(a), int(b)

    if ahead == 0 and behind == 0:
        st, msg = ("dirty" if dirty_list else "in-sync"), ("有未提交改动" if dirty_list else "与云端一致")
    elif behind and not ahead:
        st, msg = "behind", f"落后云端 {behind} 个提交"
    elif ahead and not behind:
        st, msg = "ahead", f"本地领先云端 {ahead} 个提交"
    else:
        st, msg = "diverged", f"已分叉（本地 {ahead} / 云端 {behind}）"

    return {
        "state": st,
        "message": msg,
        "ahead": ahead,
        "behind": behind,
        "dirty": len(dirty_list),
        "dirty_files": dirty_list[:20],
        "local_head": git("rev-parse", "--short", "HEAD").stdout.strip(),
        "local_time": git("log", "-1", "--format=%ci").stdout.strip(),
        "cloud_head": git("rev-parse", "--short", up).stdout.strip(),
        "cloud_time": git("log", "-1", "--format=%ci", up).stdout.strip(),
        "branch": up,
    }


def emit(obj, human):
    if "--json" in sys.argv:
        print(json.dumps(obj, ensure_ascii=False, indent=2))
    else:
        print(human(obj))


def human_state(s):
    if s["state"] in ("no-repo", "unbound", "offline"):
        return f'[{s["state"]}] {s["message"]}'
    lines = [
        f'状态: {s["state"]} — {s["message"]}',
        f'本地 {s["local_head"]} @ {s["local_time"]}',
        f'云端 {s["cloud_head"]} @ {s["cloud_time"]}',
    ]
    if s["dirty"]:
        lines.append(f'未提交: {s["dirty"]} 个文件')
        lines += [f'  {x}' for x in s["dirty_files"]]
    return "\n".join(lines)


def cmd_check():
    emit(state(), human_state)


def cmd_download():
    s = state()
    if s["state"] == "no-repo":
        raise SystemExit("尚未初始化本地仓库")
    if s["state"] == "unbound":
        raise SystemExit("未绑定云端仓库，先执行 init <url>")
    if s["state"] == "offline":
        raise SystemExit("无法连接云端，稍后重试")
    if s["state"] == "diverged":
        raise SystemExit("本地与云端已分叉，需人工处理（先看 diff），不自动合并")

    stashed = False
    if s["dirty"]:
        if "--stash" not in sys.argv:
            raise SystemExit(
                f'本地有 {s["dirty"]} 个未提交改动。'
                "请先 upload，或加 --stash 由我暂存后拉取。"
            )
        if git("stash", "push", "-u", "-m", "cloud-sync auto stash").returncode != 0:
            raise SystemExit("暂存失败，已中止")
        stashed = True

    p = git("pull", "--rebase", "origin", load_config().get("branch", "main"))
    if stashed:
        pop = git("stash", "pop")
        if pop.returncode != 0:
            print("注意：暂存恢复有冲突，请手动处理")
            print(pop.stdout, pop.stderr)

    if p.returncode != 0:
        print("拉取失败：")
        print(p.stdout, p.stderr)
        raise SystemExit(p.returncode)

    print("已从云端下载完成")
    print(human_state(state()))


def cmd_upload():
    ensure_repo()
    s = state()
    if s["state"] in ("unbound",):
        raise SystemExit("未绑定云端仓库，先执行 init <url>")
    if s["state"] == "diverged":
        raise SystemExit("本地与云端已分叉，需人工处理，不自动推送")

    # 跳过命令名本身，取第一个非选项参数作为提交说明
    msg = next(
        (a for a in sys.argv[2:] if not a.startswith("--")),
        "sync: update workspace",
    )
    git("add", "-A")
    if git("status", "--porcelain").stdout.strip():
        if git("commit", "-m", msg).returncode != 0:
            raise SystemExit("提交失败")
        print("已提交:", msg)
    else:
        print("无新改动")

    p = git("push", "-u", "origin", load_config().get("branch", "main"))
    if p.returncode != 0:
        print("推送失败：")
        print(p.stdout, p.stderr)
        raise SystemExit(p.returncode)
    print("已上传到云端")
    print(human_state(state()))


def cmd_diff():
    up = upstream()
    if not up:
        raise SystemExit("未绑定云端仓库")
    print("=== 本地领先云端 ===")
    print(git("diff", "--stat", f"{up}..HEAD").stdout or "(无)")
    print("=== 云端领先本地 ===")
    print(git("diff", "--stat", f"HEAD..{up}").stdout or "(无)")


def cmd_init(remote, branch="main"):
    ensure_repo()
    git("remote", "remove", "origin")
    git("remote", "add", "origin", remote)
    cfg = load_config()
    cfg.update({"remote": remote, "branch": branch})
    save_config(cfg)
    git("fetch", "origin")
    print(f"云端已绑定: {remote} (分支 {branch})")
    print("下一步: check 查看状态，download 拉取，upload 推送")


def cmd_log():
    print(git("log", "--oneline", "-10").stdout or "(无提交)")


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    cmd = args[0]
    if cmd in ("check", "status"):
        cmd_check()
    elif cmd == "download":
        cmd_download()
    elif cmd == "upload":
        cmd_upload()
    elif cmd == "diff":
        cmd_diff()
    elif cmd == "init":
        if len(args) < 2:
            raise SystemExit("用法: init <remote-url> [branch]")
        cmd_init(args[1], args[2] if len(args) > 2 else "main")
    elif cmd == "log":
        cmd_log()
    elif cmd == "baseline":
        ensure_repo()
        print("本地仓库已就绪")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
