#!/usr/bin/env python3
"""
Seedance 视频生成（火山方舟 Ark）——纯 Python 标准库，零第三方依赖。

流程（异步三步）：
  1. POST /contents/generations/tasks  提交任务 → 拿 task id
  2. 轮询 GET /contents/generations/tasks/{id} 到 status=succeeded
  3. 下载 content.video_url 的 mp4（URL 24 小时失效，必须立刻下）

API key：环境变量 ARK_API_KEY > $LUCKAGENT_HOME/.env（默认 ~/luckagent/.env）里的 ARK_API_KEY，
bot 会话和终端手动跑都不必 export。与 image-gen 的火山 Seedream 共用同一把方舟 key。

本地参考视频/音频会先传到火山 TOS 换预签名 URL（见 tos_upload.py），任务结束后自动删除；
--keep-refs 可保留。

注意：全程用「无代理」opener 直连火山域内端点（ark.cn-beijing.volces.com / 对象存储），
避免走 Stash 等 TUN 代理导致的连接问题。
"""
from __future__ import annotations  # 兼容 Python <3.10 的 `X | None` 注解

import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ARK_BASE = os.environ.get("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
TASKS_URL = f"{ARK_BASE}/contents/generations/tasks"
MODEL_DEFAULT = os.environ.get("SEEDANCE_MODEL", "doubao-seedance-2-5-260628")
DURATION_CAP = 5  # 默认时长上限（秒），防群里刷视频烧钱；--allow-long 可突破

# 无代理 opener：域内端点直连，别走代理
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def load_api_key() -> str | None:
    from tos_upload import load_conf  # 同一套配置解析：环境变量 > $LUCKAGENT_HOME/.env > ./.env
    return load_conf("ARK_API_KEY")


class NetError(SystemExit):
    """网络层失败（连不上 / 读超时）。继承 SystemExit：未被捕获时行为同原来的报错退出，poll 里可捕获重试。"""


class PollTimeout(SystemExit):
    """轮询等满了任务还没到终态——服务端可能还在跑（还要拉参考素材）。"""


def http_json(method: str, url: str, api_key: str, payload: dict | None = None, timeout: int = 60) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"ERROR: HTTP {e.code} 调 {url}\n{body}")
    except (urllib.error.URLError, OSError) as e:  # OSError 覆盖 socket.timeout（读响应时超时不会包成 URLError）
        raise NetError(f"ERROR: 网络错误 {url}: {e}")


_DEFAULT_MIME = {"image": "image/png", "video": "video/mp4", "audio": "audio/mpeg"}
_KIND_CN = {"image": "图片", "video": "视频", "audio": "音频"}


def to_media_url(src: str, kind: str) -> str:
    """把一个媒体输入变成 API content 里能用的 url 字段值。

    图片(image/首帧或参考)：本地文件 → base64 data URI；URL 原样。
    视频/音频参考：**火山 API 要求必须是公网 URL**（实测 base64/data URI 会被拒:
      "reference_video must be provided as a web url"）。本地文件在此直接报错，
      提示先上传拿 URL——避免白烧一次生成。
    """
    if src.startswith(("http://", "https://")):
        return src
    if src.startswith("data:"):
        if kind in ("video", "audio"):
            raise SystemExit(f"ERROR: 参考{_KIND_CN[kind]}必须是公网 URL（http/https），API 不接受 data URI / base64。")
        return src
    # 本地文件
    p = Path(src).expanduser()
    if not p.exists():
        raise SystemExit(f"ERROR: {_KIND_CN.get(kind, kind)}文件不存在: {src}")
    if kind in ("video", "audio"):
        # 参考视频/音频只收公网 URL → 本地文件自动上传 TOS 换限时预签名 URL
        try:
            from tos_upload import CONFIG_HINT, tos_config, upload_and_presign
        except Exception as e:  # noqa: BLE001
            raise SystemExit(f"ERROR: 无法加载 tos_upload 模块: {e}")
        if tos_config() is None:
            raise SystemExit(
                f"ERROR: 参考{_KIND_CN[kind]} {src} 是本地文件，火山 API 要求公网 URL，"
                f"但未配置 TOS（TOS_ACCESS_KEY/TOS_SECRET_KEY/TOS_BUCKET）无法自动上传——任务未提交、未计费。"
                f"{CONFIG_HINT}；或改用一个可公网访问的 URL。"
            )
        print(f"  本地{_KIND_CN[kind]}参考 → 上传 TOS…", file=sys.stderr)
        url = upload_and_presign(str(p))
        print(f"  ✅ 已上传，改用预签名 URL 传给 Ark", file=sys.stderr)
        return url
    # 图片本地文件 → base64 data URI（图片可内联）
    mime = mimetypes.guess_type(str(p))[0] or _DEFAULT_MIME.get(kind, "image/png")
    b64 = base64.b64encode(p.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def submit(prompt: str, args, api_key: str) -> str:
    content: list[dict] = [{"type": "text", "text": prompt}]
    # 首帧模式（frame-control）
    if args.image:
        content.append({
            "type": "image_url",
            "image_url": {"url": to_media_url(args.image, "image")},
            "role": "first_frame",
        })
    # 多模态参考模式（reference）——可各传多个
    for ref in args.ref_image:
        content.append({
            "type": "image_url",
            "image_url": {"url": to_media_url(ref, "image")},
            "role": "reference_image",
        })
    for ref in args.ref_video:
        content.append({
            "type": "video_url",
            "video_url": {"url": to_media_url(ref, "video")},
            "role": "reference_video",
        })
    for ref in args.ref_audio:
        content.append({
            "type": "audio_url",
            "audio_url": {"url": to_media_url(ref, "audio")},
            "role": "reference_audio",
        })
    payload = {
        "model": args.model,
        "content": content,
        "ratio": args.ratio,
        "resolution": args.resolution,
        "duration": args.duration,
        "generate_audio": args.audio,
    }
    resp = http_json("POST", TASKS_URL, api_key, payload)
    tid = resp.get("id") or resp.get("task_id") or (resp.get("data") or {}).get("id")
    if not tid:
        raise SystemExit(f"ERROR: 未从提交响应拿到 task id。原始响应:\n{json.dumps(resp, ensure_ascii=False)[:800]}")
    return tid


def poll(tid: str, api_key: str, max_wait: int, interval: int) -> dict:
    url = f"{TASKS_URL}/{tid}"
    waited = 0
    net_fails = 0
    while True:
        try:
            resp = http_json("GET", url, api_key)
            net_fails = 0
        except NetError as e:
            # 单次轮询网络抖动不该丢掉服务端还在跑（且已计费）的任务
            net_fails += 1
            if net_fails >= 5 or waited >= max_wait:
                raise NetError(f"{e}\n任务仍可能在服务端完成，task id = {tid}")
            print(f"  ⚠️ 轮询网络错误（第 {net_fails} 次），{interval}s 后重试：{e}", file=sys.stderr)
            time.sleep(interval)
            waited += interval
            continue
        status = (resp.get("status") or (resp.get("data") or {}).get("status") or "").lower()
        if status in ("succeeded", "success"):
            return resp
        if status in ("failed", "canceled", "cancelled", "error"):
            raise SystemExit(f"ERROR: 任务 {status}。原始响应:\n{json.dumps(resp, ensure_ascii=False)[:800]}")
        if waited >= max_wait:
            raise PollTimeout(f"ERROR: 轮询超时（{max_wait}s），最后状态 = {status or '未知'}；task id = {tid}")
        time.sleep(interval)
        waited += interval
        print(f"...生成中（{waited}s，状态 {status or '?'}）", file=sys.stderr)


def extract_video_url(resp: dict) -> str | None:
    content = resp.get("content") or (resp.get("data") or {}).get("content") or {}
    if isinstance(content, dict):
        return content.get("video_url")
    return None


def download(url: str, out: str) -> None:
    req = urllib.request.Request(url)
    with _OPENER.open(req, timeout=300) as r, open(out, "wb") as f:
        f.write(r.read())


def main() -> None:
    ap = argparse.ArgumentParser(description="Seedance 视频生成（火山方舟）")
    ap.add_argument("prompt", help="视频内容提示词（越具体越好：主体/动作/场景/镜头/光线/风格）")
    ap.add_argument("--image", help="首帧图（本地路径或 URL）→ 首帧控制模式（不能和 --ref-* 混用）")
    ap.add_argument("--ref-image", action="append", default=[], metavar="路径/URL",
                    help="多模态参考图（可多次；本地文件自动 base64 或传 URL）→ reference_image，主体/风格一致")
    ap.add_argument("--ref-video", action="append", default=[], metavar="URL",
                    help="多模态参考视频（可多次；**必须是公网 URL**，API 不收 base64）→ reference_video，运镜/动作/风格参考")
    ap.add_argument("--ref-audio", action="append", default=[], metavar="URL",
                    help="多模态参考音频（可多次；本地文件自动传 TOS；2.5 起可单独使用）→ reference_audio")
    ap.add_argument("--model", default=MODEL_DEFAULT, help=f"模型 id，默认 {MODEL_DEFAULT}")
    ap.add_argument("--ratio", default=None,
                    help="画幅比例：16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9 / adaptive。"
                         "默认：文生 16:9；首帧图或带参考视频时 adaptive（2.5 硬性要求，跟随首帧/原视频）")
    ap.add_argument("--resolution", default="1080p", help="分辨率：480p / 720p / 1080p（默认 1080p）")
    ap.add_argument("--duration", type=int, default=5,
                    help="时长秒数 4~30，或 -1 由模型自选（视频编辑必须 -1）；默认 5，超过上限见 --allow-long")
    ap.add_argument("--audio", dest="audio", action="store_true", default=True, help="生成原生音频（默认开）")
    ap.add_argument("--no-audio", dest="audio", action="store_false", help="不生成音频（更快更省）")
    ap.add_argument("--allow-long", action="store_true", help=f"允许 duration 超过默认上限 {DURATION_CAP}s（更贵）")
    ap.add_argument("--out", "-o", default=None, help="输出 mp4 路径，默认 seedance_<ts>.mp4")
    ap.add_argument("--max-wait", type=int, default=360, help="轮询最长等待秒数（默认 360）")
    ap.add_argument("--interval", type=int, default=6, help="轮询间隔秒数（默认 6）")
    ap.add_argument("--keep-refs", action="store_true", help="保留上传到 TOS 的参考素材（默认任务结束后删除）")
    args = ap.parse_args()

    if args.duration > DURATION_CAP and not args.allow_long:
        raise SystemExit(
            f"ERROR: duration={args.duration}s 超过默认上限 {DURATION_CAP}s（防误刷烧钱）。"
            f"确需更长请显式加 --allow-long。"
        )

    # 首帧模式(--image) 与 多模态参考模式(--ref-*) 官方要求分开，不可混用
    has_ref = bool(args.ref_image or args.ref_video or args.ref_audio)
    if args.image and has_ref:
        raise SystemExit(
            "ERROR: --image(首帧控制模式) 不能和 --ref-*(多模态参考模式) 混用，二选一。"
        )
    # 2.5：首帧/首尾帧、视频编辑、视频延长任务 ratio 只能是 adaptive，否则任务异步报错
    # （InvalidParameter.TaskTypeConstraint）。带参考视频时模型可能判成编辑/延长，同样默认 adaptive。
    if args.ratio is None:
        args.ratio = "adaptive" if (args.image or args.ref_video) else "16:9"
    elif args.image and args.ratio != "adaptive":
        print(f"  ⚠️ 首帧模式 2.5 只支持 ratio=adaptive（跟随首帧图比例），已忽略 --ratio {args.ratio}",
              file=sys.stderr)
        args.ratio = "adaptive"

    api_key = load_api_key()
    if not api_key:
        from tos_upload import CONFIG_HINT
        raise SystemExit(f"ERROR: 视频生成未开通：未配置火山方舟 ARK_API_KEY。{CONFIG_HINT}。")

    out = args.out or f"seedance_{int(time.time())}.mp4"
    if args.image:
        mode = f"首帧图={args.image}"
    elif has_ref:
        parts = []
        if args.ref_image:
            parts.append(f"参考图×{len(args.ref_image)}")
        if args.ref_video:
            parts.append(f"参考视频×{len(args.ref_video)}")
        if args.ref_audio:
            parts.append(f"参考音频×{len(args.ref_audio)}")
        mode = "多模态参考(" + "+".join(parts) + ")"
    else:
        mode = "文生视频"
    print(
        f"提交任务: model={args.model} {args.resolution} {args.ratio} {args.duration}s audio={args.audio} | {mode}",
        file=sys.stderr,
    )
    # 任务到达终态（成功/失败）或根本没提交成功时，删掉本次上传到 TOS 的参考素材；
    # 轮询因网络断掉时任务可能还在服务端跑、还要拉素材，这时保留。
    cleanup_refs = not args.keep_refs
    try:
        tid = submit(args.prompt, args, api_key)
        print(f"task id: {tid}，开始轮询…", file=sys.stderr)
        resp = poll(tid, api_key, args.max_wait, args.interval)
    except (NetError, PollTimeout):
        cleanup_refs = False
        raise
    finally:
        if cleanup_refs:
            from tos_upload import cleanup_uploads
            cleanup_uploads()
    vurl = extract_video_url(resp)
    if not vurl:
        raise SystemExit(f"ERROR: 任务成功但没拿到 video_url。原始响应:\n{json.dumps(resp, ensure_ascii=False)[:800]}")
    print(f"下载中: {vurl[:80]}…", file=sys.stderr)
    download(vurl, out)
    size = os.path.getsize(out)
    print(f"✅ 完成: {out}（{size/1024/1024:.1f} MB）", file=sys.stderr)
    print(out)  # stdout 只输出产物路径，方便上层脚本取用


if __name__ == "__main__":
    main()
