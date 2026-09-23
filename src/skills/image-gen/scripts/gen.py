#!/usr/bin/env python3
"""统一生图入口 —— 按本机已配置的能力选后端，不做任何语义猜测。

后端：
  codex     本机 Codex CLI 内置 image_gen（走 ChatGPT 订阅，无需 key）  → codex_image.py
  seedream  火山方舟 Seedream（ARK_API_KEY）                          → gen_seedream.py

判定规则（确定性）：
  1. --provider codex|seedream           显式指定，最高优先级，不自动兜底
  2. IMAGE_GEN_PROVIDER=codex|seedream   安装时写进 .env 的选择
  3. 自动：Codex 已安装且已登录 → codex；否则配了 ARK_API_KEY → seedream
  4. 都没有 → 报错并给出配置指引

兜底：走 codex 时若「未登录 / 找不到 codex」（退出码 3）或「撞订阅额度 / 限流」（退出码 4），
且配了 ARK_API_KEY，自动改走 seedream 重出（--provider 显式指定时不兜底）。

用法（两个后端参数统一，专属参数错配时警告并忽略）：
  python3 gen.py "提示词" -o out.png [--image ref.jpg]... [--aspect 3:2 | --size WxH] [--n 3]
  python3 gen.py "..." --transparent -o icon.png     # codex 原生透明；seedream 色键生成后本地抠图
  python3 gen.py "..." --provider seedream           # 强制指定
  python3 gen.py "..." --print-cmd                   # 只打印选中的后端与命令（调试）
"""

from __future__ import annotations

import argparse
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from codex_image import EXIT_LOGIN, EXIT_QUOTA, codex_login_state  # noqa: E402

PROVIDERS = ("codex", "seedream")
FALLBACK_CODES = (EXIT_LOGIN, EXIT_QUOTA)
DEFAULT_ASPECT = "1:1"
SEEDREAM_AREA = 2048 * 2048   # seedream 按比例换算尺寸时的目标总像素（与其默认 2048x2048 一致）
CHROMA_RULE = (
    "\n\n背景要求（后期会抠成透明底）：主体画在纯平 #00ff00 绿色背景上（主体本身是绿色系时改用纯平 #ff00ff），"
    "背景是单一颜色，没有阴影、渐变、纹理、反光或地面；主体边缘清晰，四周留足边距；主体内部不得出现背景色。"
)


def _env_or_dotenv(*names: str) -> str | None:
    for n in names:
        v = os.environ.get(n)
        if v and v.strip():
            return v.strip()
    home = Path(os.environ.get("LUCKAGENT_HOME") or (Path.home() / "luckagent")).expanduser()
    for envf in (home / ".env", Path.cwd() / ".env"):
        try:
            lines = envf.read_text().splitlines()
        except OSError:
            continue
        for n in names:
            for line in lines:
                if line.startswith(f"{n}="):
                    v = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if v:
                        return v
    return None


def has_ark_key() -> bool:
    return bool(_env_or_dotenv("ARK_API_KEY"))


def resolve_provider(explicit: str | None) -> tuple[str, str]:
    """返回 (provider, 判定来源)。"""
    if explicit:
        return explicit, "--provider"
    configured = (_env_or_dotenv("IMAGE_GEN_PROVIDER") or "").lower()
    if configured in PROVIDERS:
        return configured, "IMAGE_GEN_PROVIDER"
    if configured:
        print(f"WARN: IMAGE_GEN_PROVIDER={configured} 无效（可选 codex / seedream），按自动判定处理", file=sys.stderr)
    ok, _ = codex_login_state()
    if ok:
        return "codex", "auto: Codex 已登录"
    if has_ark_key():
        return "seedream", "auto: 已配 ARK_API_KEY"
    sys.exit(
        "ERROR: 本机没有可用的生图后端。\n"
        "  Codex（推荐，有 ChatGPT 订阅即可）：npm i -g @openai/codex && codex login\n"
        "  火山 Seedream：.env 里填 ARK_API_KEY（并在方舟控制台开通 Doubao-Seedream 模型）\n"
        "配好后重跑 bash install.sh 或直接重试；两者都配时默认 Codex，Codex 不可用时自动用 Seedream。"
    )


def parse_ratio(aspect: str) -> tuple[int, int]:
    m = re.fullmatch(r"(\d+):(\d+)", aspect)
    if not m or int(m.group(1)) == 0 or int(m.group(2)) == 0:
        sys.exit(f"ERROR: --aspect 必须是 W:H（如 2:3、16:9、1:1），当前：{aspect}")
    return int(m.group(1)), int(m.group(2))


def seedream_size(aspect: str) -> str:
    """按比例换算 seedream 尺寸：总像素约 2048x2048，边长取 64 的倍数。"""
    rw, rh = parse_ratio(aspect)
    w = math.sqrt(SEEDREAM_AREA * rw / rh)
    h = w * rh / rw
    return f"{max(64, round(w / 64) * 64)}x{max(64, round(h / 64) * 64)}"


def final_paths(out: Path, n: int) -> list[Path]:
    """多张时文件名 <stem>_1..N（与 codex 后端一致）。"""
    if n == 1:
        return [out]
    return [out.with_name(f"{out.stem}_{i}{out.suffix}") for i in range(1, n + 1)]


def place(src: Path, dst: Path) -> None:
    """按 dst 扩展名落盘（Pillow 可用时转格式，否则原样拷贝）。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import Image
    except Exception:
        shutil.copy2(src, dst)
        return
    im = Image.open(src)
    im.load()
    ext = dst.suffix.lower()
    if ext in (".jpg", ".jpeg"):
        im.convert("RGB").save(dst, "JPEG", quality=95)
    elif ext == ".webp":
        im.save(dst, "WEBP", quality=95)
    else:
        im.save(dst, "PNG")


# ---------- 后端命令 ----------
def codex_cmd(args, out: Path) -> list[str]:
    cmd = [sys.executable, str(HERE / "codex_image.py"), args.prompt, "--out", str(out), "--n", str(args.n)]
    if args.size:
        cmd += ["--size", args.size]
    else:
        cmd += ["--aspect", args.aspect or DEFAULT_ASPECT]
    for ref in args.image:
        cmd += ["--ref", ref]
    if args.transparent:
        cmd.append("--transparent")
    if args.verbatim:
        cmd.append("--verbatim")
    if args.timeout is not None:
        cmd += ["--timeout", str(args.timeout)]
    return cmd


def seedream_cmd(args, tmpdir: Path) -> list[str]:
    prompt = args.prompt + (CHROMA_RULE if args.transparent else "")
    size = args.size or seedream_size(args.aspect or DEFAULT_ASPECT)
    cmd = [sys.executable, str(HERE / "gen_seedream.py"), prompt, "-o", str(tmpdir) + "/", "--size", size]
    if args.n != 1:
        cmd += ["--max-images", str(args.n)]
    for ref in args.image:
        cmd += ["--image", ref]
    if args.model:
        cmd += ["--model", args.model]
    if args.seed is not None:
        cmd += ["--seed", str(args.seed)]
    if args.watermark:
        cmd.append("--watermark")
    if args.timeout is not None:
        cmd += ["--timeout", str(args.timeout)]
    return cmd


def warn_dropped(provider: str, args) -> None:
    dropped = []
    if provider == "codex":
        dropped += [f for f, on in (("--seed", args.seed is not None), ("--watermark", args.watermark),
                                    ("--model", bool(args.model))) if on]
    for flag in dropped:
        print(f"WARN: {flag} 仅适用于 seedream，已忽略（当前 codex）", file=sys.stderr)


# ---------- 执行 ----------
def run_codex(args, out: Path) -> int:
    warn_dropped("codex", args)
    return subprocess.run(codex_cmd(args, out)).returncode


def run_seedream(args, out: Path) -> int:
    tmpdir = Path(tempfile.mkdtemp(prefix="seedream_"))
    try:
        p = subprocess.run(seedream_cmd(args, tmpdir), stdout=subprocess.PIPE, text=True)
        if p.returncode != 0:
            return p.returncode
        produced = [Path(line.strip()) for line in p.stdout.splitlines() if line.strip() and Path(line.strip()).is_file()]
        if not produced:
            print("ERROR: seedream 没有返回图片", file=sys.stderr)
            return 1
        if len(produced) < args.n:
            print(f"WARN: 要 {args.n} 张，seedream 组图只返回了 {len(produced)} 张", file=sys.stderr)
        for src, dst in zip(produced, final_paths(out, args.n)):
            if args.transparent:
                keyed = subprocess.run([
                    sys.executable, str(HERE / "remove_chroma_key.py"), "--input", str(src), "--out", str(dst),
                    "--auto-key", "border", "--soft-matte", "--transparent-threshold", "12",
                    "--opaque-threshold", "220", "--despill",
                ])
                if keyed.returncode != 0:
                    print(f"WARN: 抠图失败，保留色键原图：{dst}", file=sys.stderr)
                    place(src, dst)
            else:
                place(src, dst)
            print(f"  saved: {dst}  ({dst.stat().st_size / 1024:.0f} KB)", flush=True)
        return 0
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser(description="统一生图入口（codex 优先，seedream 兜底）")
    ap.add_argument("prompt", help="生图提示词 / 需求描述")
    ap.add_argument("-o", "--out", help="输出文件（扩展名决定格式 .png/.jpg/.webp）；多张时为 <stem>_1..N")
    ap.add_argument("--image", action="append", default=[], help="参考图，可重复（图生图 / 多参考）")
    ap.add_argument("--aspect", help=f"画幅比例 W:H，默认 {DEFAULT_ASPECT}（常用 2:3 竖、3:2 横、16:9、9:16）")
    ap.add_argument("--size", help="精确尺寸 WxH（给了就覆盖 --aspect；codex 为本地缩放+居中裁）")
    ap.add_argument("--n", type=int, default=1, help="出几张（codex 并行候选；seedream 组图），1–10")
    ap.add_argument("--transparent", action="store_true", help="透明背景 PNG（codex 原生；seedream 色键后本地抠图）")
    ap.add_argument("--provider", choices=PROVIDERS, help="强制指定后端（不自动兜底）")
    ap.add_argument("--timeout", type=int, help="超时秒数（默认 300）")
    ap.add_argument("--print-cmd", action="store_true", help="只打印选中的后端与命令后退出")
    ap.add_argument("--verbatim", action="store_true", help="[codex] prompt 原样透传，不让 Codex 润色")
    ap.add_argument("--seed", type=int, help="[seedream] 随机种子")
    ap.add_argument("--watermark", action="store_true", help="[seedream] 保留平台水印")
    ap.add_argument("--model", help="[seedream] 覆盖模型 id")
    args = ap.parse_args()

    if not args.prompt.strip():
        sys.exit("ERROR: prompt 不能为空")
    if not 1 <= args.n <= 10:
        sys.exit(f"ERROR: --n 必须在 1–10，当前 {args.n}")
    if args.aspect:
        parse_ratio(args.aspect)
    out = Path(args.out or f"image_{time.strftime('%Y%m%d_%H%M%S')}.png")
    if not out.suffix:
        out = out.with_suffix(".png")
    if args.transparent and out.suffix.lower() in (".jpg", ".jpeg"):
        sys.exit("ERROR: --transparent 需要 .png 或 .webp 输出（jpg 没有 alpha）")

    provider, source = resolve_provider(args.provider)
    can_fallback = provider == "codex" and args.provider is None and has_ark_key()

    if args.print_cmd:
        print(f"provider={provider}  ({source})")
        if provider == "codex":
            print(" ".join(codex_cmd(args, out)))
            print(f"fallback={'seedream' if can_fallback else 'none'}")
        else:
            print(" ".join(seedream_cmd(args, Path("<tmpdir>"))))
        return

    print(f"[image-gen] provider={provider}  ({source})", flush=True)
    if provider == "seedream":
        sys.exit(run_seedream(args, out))
    rc = run_codex(args, out)
    if rc in FALLBACK_CODES and can_fallback:
        why = "Codex 不可用（未登录 / 未安装）" if rc == EXIT_LOGIN else "Codex 撞到订阅额度 / 限流"
        print(f"[fallback] {why}，改用火山 Seedream 重出", file=sys.stderr, flush=True)
        rc = run_seedream(args, out)
    sys.exit(rc)


if __name__ == "__main__":
    main()
