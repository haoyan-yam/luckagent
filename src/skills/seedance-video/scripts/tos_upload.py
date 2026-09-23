#!/usr/bin/env python3
"""
火山 TOS 上传（纯 Python 标准库，TOS4-HMAC-SHA256 预签名）。

用途：把本地参考视频/音频上传到 TOS，返回一个**限时预签名 GET URL**，供火山
Ark（Seedance）拉取——reference_video / reference_audio 只接受公网 URL，不收 base64。
生成结束后 gen_video.py 调 cleanup_uploads() 删掉本次上传的对象，桶里不留垃圾。

签名算法对齐火山官方 ve-tos-python-sdk（密钥派生 sk→date→region→"tos"→"request"，
算法串 TOS4-HMAC-SHA256，预签名用 UNSIGNED-PAYLOAD）。零第三方依赖。

配置（环境变量优先，其次 $LUCKAGENT_HOME/.env，默认 ~/luckagent/.env）：
  TOS_ACCESS_KEY / TOS_SECRET_KEY / TOS_BUCKET / TOS_REGION（默认 cn-beijing）
  TOS_ENDPOINT（可选）：完整的桶端点，如 https://<桶>.tos-cn-beijing.ivolces.com（内网）；
                       不设时用公网端点 https://{bucket}.tos-{region}.volces.com。

命令行：
  python3 tos_upload.py <本地文件> [有效期秒]   # 上传并打印预签名 GET URL
  python3 tos_upload.py --probe                 # 连通测试：上传一个小对象再删除
"""
from __future__ import annotations

import hashlib
import hmac
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

ALGO = "TOS4-HMAC-SHA256"
SERVICE = "tos"
UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"
KEY_PREFIX = "seedance-refs/"
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 直连，不走代理

CONFIG_HINT = "管理员可在管理台「系统配置 → 默认设置 → 视频生成」填写，或写进 .env 后 luckagent restart"

# 本进程上传过的对象（cleanup_uploads 删除用）
_UPLOADED: list[tuple[dict, str]] = []


def _env_files() -> list[Path]:
    home = Path(os.environ.get("LUCKAGENT_HOME") or (Path.home() / "luckagent")).expanduser()
    return [home / ".env", Path.cwd() / ".env"]


def load_conf(name: str) -> str | None:
    """环境变量 > $LUCKAGENT_HOME/.env > 当前目录 .env（后出现的同名行生效，同 dotenv）。"""
    v = os.environ.get(name)
    if v and v.strip():
        return v.strip()
    for envf in _env_files():
        try:
            lines = envf.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        found = None
        for line in lines:
            s = line.strip()
            if s.startswith(name + "="):
                found = s.split("=", 1)[1].strip().strip('"').strip("'")
        if found:
            return found
    return None


def tos_config() -> dict | None:
    ak = load_conf("TOS_ACCESS_KEY")
    sk = load_conf("TOS_SECRET_KEY")
    bucket = load_conf("TOS_BUCKET")
    region = load_conf("TOS_REGION") or "cn-beijing"
    if not (ak and sk and bucket):
        return None
    endpoint = load_conf("TOS_ENDPOINT")
    if endpoint:
        parsed = urllib.parse.urlparse(endpoint if "://" in endpoint else f"https://{endpoint}")
        base, host = f"{parsed.scheme}://{parsed.netloc}", parsed.netloc
    else:
        host = f"{bucket}.tos-{region}.volces.com"
        base = f"https://{host}"
    return {"ak": ak, "sk": sk, "bucket": bucket, "region": region, "host": host, "base": base}


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(sk: str, short_date: str, region: str) -> bytes:
    k = _hmac(sk.encode("utf-8"), short_date)
    k = _hmac(k, region)
    k = _hmac(k, SERVICE)
    k = _hmac(k, "request")
    return k


def _enc(s: str, keep_slash: bool = False) -> str:
    # AWS/TOS 规范编码：不编码 A-Za-z0-9-_.~，其余都编码；path 保留 "/"
    safe = "-_.~/" if keep_slash else "-_.~"
    return urllib.parse.quote(s, safe=safe)


def presign(cfg: dict, method: str, key: str, expires: int = 7200) -> str:
    """生成 TOS 预签名 URL（method=GET / PUT / DELETE）。"""
    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    short_date = amz_date[:8]
    scope = f"{short_date}/{cfg['region']}/{SERVICE}/request"
    canon_uri = "/" + _enc(key.lstrip("/"), keep_slash=True)
    query = {
        "X-Tos-Algorithm": ALGO,
        "X-Tos-Credential": f"{cfg['ak']}/{scope}",
        "X-Tos-Date": amz_date,
        "X-Tos-Expires": str(expires),
        "X-Tos-SignedHeaders": "host",
    }
    canon_qs = "&".join(f"{_enc(k)}={_enc(v)}" for k, v in sorted(query.items()))
    canon_headers = f"host:{cfg['host']}\n"
    signed_headers = "host"
    canon_req = "\n".join([method, canon_uri, canon_qs, canon_headers, signed_headers, UNSIGNED_PAYLOAD])
    sts = "\n".join([ALGO, amz_date, scope, hashlib.sha256(canon_req.encode("utf-8")).hexdigest()])
    sig = hmac.new(_signing_key(cfg["sk"], short_date, cfg["region"]), sts.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{cfg['base']}{canon_uri}?{canon_qs}&X-Tos-Signature={sig}"


def _request(method: str, url: str, data: bytes | None = None, timeout: int = 180) -> None:
    req = urllib.request.Request(url, data=data, method=method)
    with _OPENER.open(req, timeout=timeout) as r:
        r.read()


def _new_key(ext: str) -> str:
    # 时间戳 + 随机串：同一秒内上传多个同类型文件也不会互相覆盖
    return f"{KEY_PREFIX}{int(time.time())}-{uuid.uuid4().hex[:12]}{ext}"


def upload_and_presign(local_path: str, expires_get: int = 7200) -> str:
    """上传本地文件到 TOS（预签名 PUT），返回限时预签名 GET URL，并记下对象供 cleanup_uploads 删除。"""
    cfg = tos_config()
    if not cfg:
        raise SystemExit(
            "ERROR: 未配置 TOS（需要 TOS_ACCESS_KEY / TOS_SECRET_KEY / TOS_BUCKET），"
            f"本地参考视频/音频需要先上传到 TOS 拿 URL。{CONFIG_HINT}。"
        )
    p = Path(local_path).expanduser()
    if not p.exists():
        raise SystemExit(f"ERROR: 文件不存在: {local_path}")
    key = _new_key(p.suffix or ".bin")
    try:
        _request("PUT", presign(cfg, "PUT", key, expires=600), data=p.read_bytes())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"ERROR: TOS 上传失败 HTTP {e.code}:\n{body[:600]}")
    except (urllib.error.URLError, OSError) as e:
        raise SystemExit(f"ERROR: TOS 上传网络错误: {e}")
    _UPLOADED.append((cfg, key))
    return presign(cfg, "GET", key, expires=expires_get)


def cleanup_uploads() -> None:
    """删除本进程上传过的对象（尽力而为：失败只警告，不影响已生成的视频）。"""
    while _UPLOADED:
        cfg, key = _UPLOADED.pop()
        try:
            _request("DELETE", presign(cfg, "DELETE", key, expires=600), timeout=60)
            print(f"  🧹 已删除 TOS 上的参考素材 {key}", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠️ 删除 TOS 对象 {key} 失败（可在控制台手动清理 {KEY_PREFIX}）：{e}", file=sys.stderr)


def probe() -> tuple[bool, str]:
    """连通测试：上传一个小对象再删除。返回 (是否通过, 说明)。"""
    cfg = tos_config()
    if not cfg:
        return False, "未配置：TOS_ACCESS_KEY / TOS_SECRET_KEY / TOS_BUCKET 缺项"
    key = f"{KEY_PREFIX}.probe-{uuid.uuid4().hex[:12]}"
    try:
        _request("PUT", presign(cfg, "PUT", key, expires=300), data=b"luckagent tos probe", timeout=30)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        code = ""
        if "<Code>" in body:
            code = body.split("<Code>", 1)[1].split("</Code>", 1)[0]
        elif '"Code"' in body:
            code = body.split('"Code"', 1)[1].split('"', 2)[1]
        hint = {
            403: "密钥无效或没有该桶的写权限",
            404: "桶不存在（检查桶名与地域）",
        }.get(e.code, "")
        return False, f"上传失败 HTTP {e.code} {code} {hint}".strip()
    except (urllib.error.URLError, OSError) as e:
        return False, f"连不上 {cfg['host']}：{e}"
    try:
        _request("DELETE", presign(cfg, "DELETE", key, expires=300), timeout=30)
    except Exception as e:  # noqa: BLE001
        return False, f"上传成功但删除失败（缺删除权限？参考素材将无法自动清理）：{e}"
    return True, f"通过：{cfg['bucket']}（{cfg['region']}）可上传、可删除"


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--probe":
        ok, msg = probe()
        print(msg)
        sys.exit(0 if ok else 1)
    if len(sys.argv) < 2:
        sys.exit("用法: python3 tos_upload.py <本地文件> [有效期秒] | --probe")
    exp = int(sys.argv[2]) if len(sys.argv) > 2 else 7200
    print(upload_and_presign(sys.argv[1], expires_get=exp))
