#!/usr/bin/env python3
"""
gen_image.py — 调用 OpenAI gpt-image-2 生图（文生图 + 图生图）

用法：
  python3 gen_image.py "<prompt>" [--size 1024x1024] [--quality high] [--out file.png]
  python3 gen_image.py "<prompt>" --image ref.png --out edited.png   # 图生图

依赖：仅 Python 3 标准库。

API key 优先级：环境变量 OPENAI_API_KEY > 下面 API_KEY_DEFAULT 常量
"""
import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

# ====== 配置（按需修改这一行替换 key）======
API_KEY_DEFAULT = ""  # key 已挪到环境变量 OPENAI_IMAGE_API_KEY / OPENAI_API_KEY
# ===========================================

MODEL_DEFAULT = "gpt-image-2"
BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")

# 价格表（USD per 1M tokens，2026-05 数据，仅作估算）
PRICE = {
    "gpt-image-2": {"text_in": 8.0, "image_in": 8.0, "cached_in": 2.0, "image_out": 30.0},
    "gpt-image-1.5": {"text_in": 6.0, "image_in": 10.0, "cached_in": 2.5, "image_out": 35.0},
    "gpt-image-1": {"text_in": 5.0, "image_in": 10.0, "cached_in": 2.5, "image_out": 40.0},
}


def estimate_cost(model: str, usage: dict) -> float:
    p = PRICE.get(model, PRICE["gpt-image-2"])
    text_in = usage.get("input_tokens_details", {}).get("text_tokens", 0)
    image_in = usage.get("input_tokens_details", {}).get("image_tokens", 0)
    image_out = usage.get("output_tokens_details", {}).get("image_tokens", 0)
    return (
        text_in * p["text_in"] / 1_000_000
        + image_in * p["image_in"] / 1_000_000
        + image_out * p["image_out"] / 1_000_000
    )


def post_json(url: str, payload: dict, api_key: str, timeout: int) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def post_multipart(url: str, fields: dict, files: list, api_key: str, timeout: int) -> dict:
    boundary = f"----gen_image_{uuid.uuid4().hex}"
    body = bytearray()

    def write_field(name: str, value: str):
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.extend(str(value).encode())
        body.extend(b"\r\n")

    for k, v in fields.items():
        if v is not None:
            write_field(k, v)

    for field_name, filepath in files:
        filename = os.path.basename(filepath)
        ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        with open(filepath, "rb") as f:
            data = f.read()
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(
            f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'.encode()
        )
        body.extend(f"Content-Type: {ctype}\r\n\r\n".encode())
        body.extend(data)
        body.extend(b"\r\n")

    body.extend(f"--{boundary}--\r\n".encode())

    req = urllib.request.Request(
        url,
        data=bytes(body),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def generate(prompt: str, args, api_key: str) -> dict:
    payload = {
        "model": args.model,
        "prompt": prompt,
        "size": args.size,
        "quality": args.quality,
        "n": args.n,
    }
    if args.background:
        payload["background"] = args.background
    if args.output_format:
        payload["output_format"] = args.output_format
    return post_json(f"{BASE_URL}/images/generations", payload, api_key, args.timeout)


def edit(prompt: str, image_paths: list, args, api_key: str) -> dict:
    fields = {
        "model": args.model,
        "prompt": prompt,
        "size": args.size,
        "quality": args.quality,
        "n": args.n,
    }
    if args.background:
        fields["background"] = args.background
    if args.output_format:
        fields["output_format"] = args.output_format

    files = []
    if len(image_paths) == 1:
        files.append(("image", image_paths[0]))
    else:
        for p in image_paths:
            files.append(("image[]", p))
    if args.mask:
        files.append(("mask", args.mask))

    return post_multipart(f"{BASE_URL}/images/edits", fields, files, api_key, args.timeout)


def main():
    ap = argparse.ArgumentParser(description="OpenAI gpt-image-2 image generator")
    ap.add_argument("prompt", help="生图提示词")
    ap.add_argument("--image", action="append", default=[], help="参考图（可重复传多张，触发图生图）")
    ap.add_argument("--mask", help="可选 mask（仅 edit 模式）")
    ap.add_argument("--out", "-o", default=None, help="输出文件名，默认 gen_<ts>.png")
    ap.add_argument("--model", default=MODEL_DEFAULT,
                    choices=["gpt-image-2", "gpt-image-1.5", "gpt-image-1"])
    ap.add_argument("--size", default="1024x1024",
                    help="1024x1024 / 1024x1536 / 1536x1024 / 2048x2048 / 4096x4096 / auto")
    ap.add_argument("--quality", default="high",
                    choices=["low", "medium", "high", "auto"])
    ap.add_argument("--n", type=int, default=1)
    ap.add_argument("--background", default=None,
                    choices=["transparent", "opaque", "auto"])
    ap.add_argument("--output-format", default=None,
                    choices=["png", "jpeg", "webp"])
    ap.add_argument("--timeout", type=int, default=300)
    args = ap.parse_args()

    api_key = (os.environ.get("OPENAI_IMAGE_API_KEY") or os.environ.get("OPENAI_API_KEY")) or API_KEY_DEFAULT
    if not api_key or api_key.startswith("sk-REPLACE"):
        sys.exit("ERROR: 未配置 API key。设置环境变量 OPENAI_API_KEY，或编辑脚本里的 API_KEY_DEFAULT。")

    is_edit = bool(args.image)
    mode = "edit (image-to-image)" if is_edit else "generate (text-to-image)"
    print(f"[mode] {mode}  model={args.model}  size={args.size}  quality={args.quality}  n={args.n}")
    short = args.prompt if len(args.prompt) <= 200 else args.prompt[:200] + "..."
    print(f"[prompt] {short}")
    if is_edit:
        print(f"[refs] {args.image}")

    start = time.time()
    try:
        data = edit(args.prompt, args.image, args, api_key) if is_edit \
               else generate(args.prompt, args, api_key)
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:1000]
        sys.exit(f"HTTP {e.code}: {body}")
    elapsed = time.time() - start

    images = data.get("data", [])
    if not images:
        sys.exit(f"无返回图像: {json.dumps(data)[:500]}")

    ext = (args.output_format or "png").lower()
    saved = []
    for i, item in enumerate(images):
        b64 = item.get("b64_json")
        if b64:
            raw = base64.b64decode(b64)
        elif item.get("url"):
            with urllib.request.urlopen(item["url"]) as r:
                raw = r.read()
        else:
            continue

        if args.out:
            base, dot, _ = args.out.rpartition(".")
            fname = f"{base}_{i}.{ext}" if (dot and args.n > 1) else args.out
        else:
            fname = f"gen_{int(time.time())}_{i}.{ext}"

        with open(fname, "wb") as f:
            f.write(raw)
        saved.append((fname, len(raw)))

    print(f"[done] {elapsed:.1f}s")
    for fname, size in saved:
        print(f"  saved: {fname}  ({size/1024:.1f} KB)")

    usage = data.get("usage")
    if usage:
        cost = estimate_cost(args.model, usage)
        print(f"[usage] {usage}")
        print(f"[cost] ~${cost:.4f} USD")


if __name__ == "__main__":
    main()