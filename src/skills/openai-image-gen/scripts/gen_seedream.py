#!/usr/bin/env python3
"""火山方舟 Seedream 生图（文生图 / 图生图 / 组图）——零第三方依赖。

用法示例：
  python3 gen_seedream.py "海边日落的插画" -o out.png
  python3 gen_seedream.py "把背景换成雪山" --image ref.jpg -o edited.png
  python3 gen_seedream.py "同一角色的四格表情包" --max-images 4 -o outdir/
  python3 gen_seedream.py "..." --size 4096x4096 --model doubao-seedream-4-0-250828

API key：环境变量 ARK_API_KEY，或自动从 ~/luckagent/.env 读取，无需 export。
注意：直连火山域名，已强制绕过 HTTP(S)_PROXY（代理会劫持国内直连域名）。
模型 id 会随火山滚版本——报「model 不存在」时用 --model 指定控制台里的当前 id。
"""

import argparse
import base64
import json
import os
import sys
import urllib.request
from pathlib import Path

BASE_URL = os.environ.get("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
DEFAULT_MODEL = "doubao-seedream-4-0-250828"

# 绕过系统代理：Ark 是国内直连域名，走代理常见循环重定向/超时
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

MIME_BY_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}


def resolve_api_key() -> str:
    k = os.environ.get("ARK_API_KEY")
    if k:
        return k.strip()
    for envf in (Path.home() / "luckagent" / ".env", Path.cwd() / ".env"):
        try:
            for line in envf.read_text().splitlines():
                if line.startswith("ARK_API_KEY="):
                    v = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if v:
                        return v
        except OSError:
            continue
    sys.exit("ERROR: 未配置 ARK_API_KEY（环境变量或 ~/luckagent/.env）。到火山方舟控制台创建 API Key。")


def to_image_ref(spec: str) -> str:
    """本地文件转 base64 data URL；http(s) URL 原样透传。"""
    if spec.startswith("http://") or spec.startswith("https://"):
        return spec
    p = Path(spec)
    if not p.is_file():
        sys.exit(f"ERROR: 参考图不存在: {spec}")
    mime = MIME_BY_EXT.get(p.suffix.lower(), "image/png")
    return f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"


def post_json(url: str, payload: dict, api_key: str, timeout: int) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        sys.exit(f"ERROR: HTTP {e.code}\n{body}\n"
                 "提示：AuthenticationError=key 不对；model 相关报错=模型 id 滚版本了，用 --model 指定控制台当前 id。")


def sniff_ext(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return ".png"


def save_one(raw: bytes, out: Path, index: int, total: int) -> Path:
    ext = sniff_ext(raw)
    if total > 1 or out.is_dir() or str(out).endswith("/"):
        out.mkdir(parents=True, exist_ok=True)
        path = out / f"seedream_{index + 1}{ext}"
    else:
        path = out if out.suffix else out.with_suffix(ext)
        path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return path


def fetch_url(url: str, timeout: int) -> bytes:
    with _OPENER.open(url, timeout=timeout) as resp:
        return resp.read()


def main() -> None:
    ap = argparse.ArgumentParser(description="火山方舟 Seedream 生图")
    ap.add_argument("prompt", help="提示词（中文效果好）")
    ap.add_argument("-o", "--out", default="seedream_out.png", help="输出文件；多图时给目录（默认 seedream_out.png）")
    ap.add_argument("--image", action="append", default=[], help="参考图（本地路径或 URL，可重复传多张做图生图/多参考）")
    ap.add_argument("--size", default="2048x2048", help="尺寸，如 2048x2048 / 2560x1440 / 4096x4096（默认 2048x2048）")
    ap.add_argument("--model", default=os.environ.get("SEEDREAM_MODEL", DEFAULT_MODEL), help=f"模型 id（默认 {DEFAULT_MODEL}，可用 SEEDREAM_MODEL 覆盖）")
    ap.add_argument("--max-images", type=int, default=1, help="组图张数（>1 时启用 sequential_image_generation）")
    ap.add_argument("--seed", type=int, help="随机种子（复现实验用）")
    ap.add_argument("--watermark", action="store_true", help="保留平台水印（默认关闭）")
    ap.add_argument("--timeout", type=int, default=300)
    args = ap.parse_args()

    api_key = resolve_api_key()
    payload: dict = {
        "model": args.model,
        "prompt": args.prompt,
        "size": args.size,
        "response_format": "url",
        "watermark": bool(args.watermark),
    }
    if args.image:
        refs = [to_image_ref(x) for x in args.image]
        payload["image"] = refs[0] if len(refs) == 1 else refs
    if args.max_images > 1:
        payload["sequential_image_generation"] = "auto"
        payload["sequential_image_generation_options"] = {"max_images": args.max_images}
    if args.seed is not None:
        payload["seed"] = args.seed

    result = post_json(f"{BASE_URL}/images/generations", payload, api_key, args.timeout)
    items = result.get("data") or []
    if not items:
        sys.exit(f"ERROR: 响应中没有图片: {json.dumps(result, ensure_ascii=False)[:400]}")

    out = Path(args.out)
    saved = []
    for i, item in enumerate(items):
        if item.get("b64_json"):
            raw = base64.b64decode(item["b64_json"])
        elif item.get("url"):
            raw = fetch_url(item["url"], args.timeout)
        else:
            continue
        saved.append(save_one(raw, out, i, len(items)))

    for p in saved:
        print(p)
    usage = result.get("usage") or {}
    if usage:
        print(f"# usage: {json.dumps(usage, ensure_ascii=False)}", file=sys.stderr)


if __name__ == "__main__":
    main()
