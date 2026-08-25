#!/usr/bin/env python3
"""统一生图入口 —— 按已配置的 API key 自动选 provider，不做任何语义猜测。

判定规则（确定性）：
  1. --provider openai|seedream    显式指定，最高优先级
  2. 配了 OPENAI_IMAGE_API_KEY 或 OPENAI_API_KEY   → openai（gpt-image-2）
  3. 否则配了 ARK_API_KEY                          → seedream（火山方舟）
  4. 两者都没有 → 报错并给出配置指引

即：两个 key 都在时**默认 OpenAI**；只有火山 key 时用 Seedream。

用法（与后端脚本参数对齐，专属参数自动翻译/剔除）：
  python3 gen.py "提示词" -o out.png [--image ref.jpg]... [--size WxH] [--n 4]
  python3 gen.py "..." --provider seedream          # 强制指定
  python3 gen.py "..." --print-cmd                  # 只打印将执行的后端命令（调试）
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _env_or_dotenv(*names: str) -> str | None:
    for n in names:
        v = os.environ.get(n)
        if v and v.strip():
            return v.strip()
    for envf in (Path.home() / "luckagent" / ".env", Path.cwd() / ".env"):
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


def resolve_provider(explicit: str | None) -> str:
    if explicit:
        return explicit
    if _env_or_dotenv("OPENAI_IMAGE_API_KEY", "OPENAI_API_KEY"):
        return "openai"
    if _env_or_dotenv("ARK_API_KEY"):
        return "seedream"
    sys.exit(
        "ERROR: 未配置任何生图 key。\n"
        "  OpenAI:  .env 里填 OPENAI_IMAGE_API_KEY（或 OPENAI_API_KEY）\n"
        "  火山:    .env 里填 ARK_API_KEY（并在方舟控制台开通 Doubao-Seedream 模型）\n"
        "两者都配时默认走 OpenAI；可用 --provider seedream 强制。"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="统一生图入口（key 判定 provider）", add_help=True)
    ap.add_argument("prompt", help="生图提示词")
    ap.add_argument("-o", "--out", help="输出文件（多图时给目录）")
    ap.add_argument("--image", action="append", default=[], help="参考图，可重复（图生图/多参考）")
    ap.add_argument("--size", help="尺寸 WxH（不传用各后端默认）")
    ap.add_argument("--n", type=int, default=1, help="出图张数（openai=--n；seedream=组图 --max-images）")
    ap.add_argument("--model", help="覆盖后端模型 id")
    ap.add_argument("--provider", choices=["openai", "seedream"], help="强制指定 provider")
    ap.add_argument("--timeout", type=int, help="超时秒数")
    ap.add_argument("--print-cmd", action="store_true", help="只打印将执行的后端命令后退出")
    # provider 专属（错配时警告并忽略，不失败）
    ap.add_argument("--mask", help="[openai] 局部重绘 mask")
    ap.add_argument("--quality", help="[openai] 质量档位")
    ap.add_argument("--background", help="[openai] 背景，如 transparent")
    ap.add_argument("--output-format", help="[openai] 输出格式")
    ap.add_argument("--seed", type=int, help="[seedream] 随机种子")
    ap.add_argument("--watermark", action="store_true", help="[seedream] 保留平台水印")
    args = ap.parse_args()

    provider = resolve_provider(args.provider)

    def warn_dropped(flag: str) -> None:
        print(f"WARN: {flag} 仅适用于另一 provider，已忽略（当前 {provider}）", file=sys.stderr)

    argv: list[str] = [args.prompt]
    if args.image:
        for x in args.image:
            argv += ["--image", x]
    if args.out:
        argv += ["--out", args.out]
    if args.size:
        argv += ["--size", args.size]
    if args.model:
        argv += ["--model", args.model]
    if args.timeout is not None:
        argv += ["--timeout", str(args.timeout)]

    if provider == "openai":
        script = HERE / "gen_image.py"
        if args.n != 1:
            argv += ["--n", str(args.n)]
        if args.mask:
            argv += ["--mask", args.mask]
        if args.quality:
            argv += ["--quality", args.quality]
        if args.background:
            argv += ["--background", args.background]
        if args.output_format:
            argv += ["--output-format", args.output_format]
        if args.seed is not None:
            warn_dropped("--seed")
        if args.watermark:
            warn_dropped("--watermark")
    else:
        script = HERE / "gen_seedream.py"
        if args.n != 1:
            argv += ["--max-images", str(args.n)]
        if args.seed is not None:
            argv += ["--seed", str(args.seed)]
        if args.watermark:
            argv.append("--watermark")
        for flag, val in (("--mask", args.mask), ("--quality", args.quality),
                          ("--background", args.background), ("--output-format", args.output_format)):
            if val:
                warn_dropped(flag)

    cmd = [sys.executable, str(script), *argv]
    if args.print_cmd:
        print(f"provider={provider}")
        print(" ".join(cmd))
        return
    os.execv(sys.executable, cmd)


if __name__ == "__main__":
    main()
