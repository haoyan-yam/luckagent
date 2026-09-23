#!/usr/bin/env python3
"""
codex_image.py — 用本机 Codex CLI 的内置 image_gen 工具生图（image-gen 技能的 codex 后端，
通常经 gen.py 调用；也可单独跑）。

  python3 codex_image.py "<需求>" --aspect 2:3 --out poster.png
  python3 codex_image.py "<需求>" --ref a.jpg --ref b.jpg --out v2.png     # 带参考图
  python3 codex_image.py "<需求>" --size 3200x2560 --out kv.png            # 精确尺寸（本地缩放）
  python3 codex_image.py "<需求>" --transparent --out icon.png             # 原生透明
  python3 codex_image.py "<需求>" --n 3 --out cand.png                     # 并行出 3 张 cand_1..3.png
  python3 codex_image.py "<完整 prompt>" --verbatim --out x.png            # 不让 Codex 改写

默认由 Codex 把「需求」润色成完整生图 prompt（用它自带的 imagegen skill）；--verbatim 时原样透传。
依赖：codex CLI（已 codex login）；Pillow 可选（精确尺寸、参考图压缩、jpg/webp 落盘）。无需 API key。

Codex image_gen 的真实边界（codex-cli 0.153.2 实测）：
  - 只能控比例，不能控像素；出图总像素约 1.57 MP。--size 是本地缩放到精确尺寸。
  - 没有 quality / mask / 模型选择。透明背景原生支持。
  - 产物落在 $CODEX_HOME/generated_images/<thread_id>/，本脚本拷走后删除。
"""
import argparse
import fcntl
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

CODEX_BIN = os.environ.get("CODEX_BIN", "codex")
MAX_CONCURRENCY = max(1, int(os.environ.get("CODEX_IMAGE_MAX_CONCURRENCY", "3")))
LOCK_DIR = Path(os.environ.get("CODEX_IMAGE_LOCK_DIR") or (Path.home() / ".cache" / "codex-image-gen" / "locks"))
STAGGER_SECONDS = 1.0   # 两次 codex 启动至少间隔 1 s，避开它安装系统 skill 的目录竞态
PRUNE_DAYS = 7
REF_MAX_EDGE = 1536
RETRY_SLEEP = 15
MAX_RATIO = 3.0

EXIT_OK, EXIT_OTHER, EXIT_USAGE, EXIT_LOGIN, EXIT_QUOTA, EXIT_REFUSAL, EXIT_TIMEOUT, EXIT_NO_IMAGE = 0, 1, 2, 3, 4, 5, 6, 7

ENVELOPE_CODEX_WRITES = """Generate ONE image with the image_gen tool for the REQUEST below, then stop.
Calling the image_gen tool is mandatory: never reply DONE without having actually called it and received an image.

How to write the prompt for the tool:
- Turn the REQUEST into a complete, well-crafted image prompt (scene, subject, composition, lighting, materials, style).
- Keep every explicit element, wording constraint and any quoted text from the REQUEST exactly; do not drop or replace them.
- Do not add brand names, logos, people, or on-image text that the REQUEST did not ask for.
- The prompt you send to the tool MUST state this framing verbatim: "{aspect_sentence}"
{transparent_rule}{refs_rule}
Rules: call image_gen exactly once (this is mandatory, not optional). Do not run shell commands. Do not create, move, copy or delete files.
If you believe the request cannot be generated, say why in one sentence instead of DONE.
After the tool returns, reply with exactly two lines:
DONE
PROMPT_USED: <the exact prompt text you sent to the tool, on one line>

REQUEST:
{request}
"""

ENVELOPE_VERBATIM = """Generate ONE image with the image_gen tool. Pass the PROMPT below to the tool verbatim:
do not rewrite, shorten, translate, or add to it.
Calling the image_gen tool is mandatory: never reply DONE without having actually called it and received an image.
{refs_rule}
Rules: call image_gen exactly once (this is mandatory, not optional). Do not run shell commands. Do not create, move, copy or delete files.
If you believe the prompt cannot be generated, say why in one sentence instead of DONE.
After the tool returns, reply with exactly: DONE

PROMPT:
{prompt}
"""

_lock = threading.Lock()


def log(msg):
    with _lock:
        print(msg, flush=True)


def die(msg, code=EXIT_USAGE):
    with _lock:
        print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def pil():
    try:
        from PIL import Image
        return Image
    except Exception:
        return None


# ---------- 画幅 ----------
class Framing:
    """比例 + 可选精确尺寸。"""

    def __init__(self, aspect: str, size):
        self.w = self.h = None
        if size:
            m = re.fullmatch(r"(\d+)x(\d+)", size)
            if not m:
                die(f"--size 必须是 WIDTHxHEIGHT，当前：{size}")
            self.w, self.h = int(m.group(1)), int(m.group(2))
            if min(self.w, self.h) < 64:
                die(f"--size 太小：{size}")
            g = math.gcd(self.w, self.h)
            self.rw, self.rh = self.w // g, self.h // g
        else:
            m = re.fullmatch(r"(\d+):(\d+)", aspect)
            if not m:
                die(f"--aspect 必须是 W:H（如 2:3、16:9、1:1），当前：{aspect}")
            self.rw, self.rh = int(m.group(1)), int(m.group(2))
            if self.rw == 0 or self.rh == 0:
                die(f"--aspect 不能为 0：{aspect}")
            g = math.gcd(self.rw, self.rh)
            self.rw, self.rh = self.rw // g, self.rh // g
        if max(self.rw, self.rh) / min(self.rw, self.rh) > MAX_RATIO:
            die(f"长短边比不能超过 {MAX_RATIO:g}:1，当前 {self.rw}:{self.rh}")
        self.orientation = "landscape" if self.rw > self.rh else "portrait" if self.rw < self.rh else "square"
        shape = {"landscape": "wider than tall", "portrait": "taller than wide", "square": "width equals height"}[self.orientation]
        self.sentence = f"Aspect ratio {self.rw}:{self.rh}, {self.orientation} orientation ({shape})."

    @property
    def exact(self):
        return self.w is not None


# ---------- prompt ----------
def build_envelope(args, framing: Framing, n_refs: int) -> str:
    refs_rule = ""
    if n_refs:
        refs_rule = (f"- {n_refs} reference image(s) are attached (Image 1..{n_refs}, in order); pass them to the tool "
                     f"as references and follow the REQUEST about how to use them.\n")
    transparent = ""
    if args.transparent:
        transparent = ("- The image must have a fully transparent background (PNG alpha): no backdrop, no floor, "
                       "no cast shadow behind the subject. Say so in the prompt.\n")
    if args.verbatim:
        body = args.prompt.rstrip() + "\n" + framing.sentence
        if args.transparent:
            body += " Transparent background (PNG with alpha): no backdrop, no floor, no cast shadow."
        return ENVELOPE_VERBATIM.format(refs_rule=refs_rule, prompt=body)
    return ENVELOPE_CODEX_WRITES.format(aspect_sentence=framing.sentence, transparent_rule=transparent,
                                        refs_rule=refs_rule, request=args.prompt.rstrip())


# ---------- 参考图 ----------
def prepare_refs(paths, tmpdir: Path):
    Image = pil()
    out = []
    for i, p in enumerate(paths):
        if not os.path.isfile(p):
            die(f"参考图不存在：{p}")
        src = os.path.abspath(p)
        if Image is None:
            out.append(src)
            continue
        try:
            im = Image.open(src)
            im.load()
        except Exception as e:
            die(f"参考图无法读取：{p}（{e}）")
        if max(im.size) <= REF_MAX_EDGE:
            out.append(src)
            continue
        scale = REF_MAX_EDGE / max(im.size)
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
        alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
        dst = tmpdir / (f"ref_{i + 1}.png" if alpha else f"ref_{i + 1}.jpg")
        (im.convert("RGBA").save(dst) if alpha else im.convert("RGB").save(dst, quality=90))
        log(f"[ref] {p} 长边超过 {REF_MAX_EDGE}px，已压缩临时副本")
        out.append(str(dst))
    return out


# ---------- codex ----------
def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex")).expanduser()


def codex_login_state():
    """(ok, detail)：codex 是否已安装且已登录。gen.py 选后端时也用它，所以不退出进程。"""
    if shutil.which(CODEX_BIN) is None:
        return False, f"找不到 codex（{CODEX_BIN}）。先安装 Codex CLI（npm i -g @openai/codex）并 `codex login`"
    try:
        r = subprocess.run([CODEX_BIN, "login", "status"], capture_output=True, text=True, timeout=10)
    except subprocess.TimeoutExpired:
        return False, "`codex login status` 超时"
    text = (r.stdout + r.stderr).lower()
    if r.returncode != 0 or "logged in" not in text or "not logged in" in text:
        return False, f"Codex 未登录：{(r.stdout + r.stderr).strip()[:200]}。在这台 Mac 上执行 `codex login` 后重试"
    return True, ""


def check_login():
    ok, detail = codex_login_state()
    if not ok:
        die(detail, EXIT_LOGIN)


class Slot:
    """跨进程并发槽：flock 抢 slot_i.lock；抢到后与上一次启动错开 STAGGER_SECONDS。"""

    def __init__(self, deadline):
        self.deadline = deadline
        self.fh = None

    def __enter__(self):
        LOCK_DIR.mkdir(parents=True, exist_ok=True)
        waited = False
        while True:
            for i in range(MAX_CONCURRENCY):
                fh = open(LOCK_DIR / f"slot_{i}.lock", "w")
                try:
                    fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.fh = fh
                    self._stagger()
                    return self
                except OSError:
                    fh.close()
            if not waited:
                log(f"[wait] 已有 {MAX_CONCURRENCY} 个 codex 生图在跑，排队中（CODEX_IMAGE_MAX_CONCURRENCY 可调）")
                waited = True
            if time.time() > self.deadline:
                raise TimeoutError("等待并发槽超时")
            time.sleep(2)

    def _stagger(self):
        stamp = LOCK_DIR / "last_start"
        with open(LOCK_DIR / "start.lock", "w") as sl:
            fcntl.flock(sl, fcntl.LOCK_EX)
            try:
                last = float(stamp.read_text().strip() or 0)
            except Exception:
                last = 0.0
            gap = STAGGER_SECONDS - (time.time() - last)
            if gap > 0:
                time.sleep(gap)
            stamp.write_text(str(time.time()))

    def __exit__(self, *exc):
        if self.fh:
            try:
                fcntl.flock(self.fh, fcntl.LOCK_UN)
            finally:
                self.fh.close()
        return False


class Run:
    rc = None
    timed_out = False
    thread_id = None
    stdout = ""
    stderr = ""
    last_message = ""
    usage = None
    images = ()


IMG_EXTS = (".png", ".jpg", ".jpeg", ".webp")


def run_codex(envelope: str, refs, args, tmpdir: Path) -> Run:
    res = Run()
    last_file = tmpdir / "last_message.txt"
    cmd = [CODEX_BIN, "exec", "--skip-git-repo-check", "-C", str(tmpdir), "-s", "read-only",
           "-c", f"model_reasoning_effort={args.effort}", "--json", "-o", str(last_file)]
    for r in refs:
        cmd += ["-i", r]   # -i 变长，必须放最后；prompt 走 stdin
    started = time.time()
    try:
        p = subprocess.run(cmd, input=envelope, capture_output=True, text=True, timeout=args.timeout)
        res.rc, res.stdout, res.stderr = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        res.timed_out, res.rc = True, -1
        res.stdout = e.stdout.decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        res.stderr = e.stderr.decode(errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
    for line in res.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get("type") == "thread.started" and ev.get("thread_id"):
            res.thread_id = ev["thread_id"]
        elif ev.get("type") == "turn.completed":
            res.usage = ev.get("usage")
    try:
        res.last_message = last_file.read_text().strip()
    except Exception:
        pass
    res.images = collect_images(res.thread_id, started)
    return res


def collect_images(thread_id, started_at):
    root = codex_home() / "generated_images"
    if not root.is_dir():
        return []
    if thread_id and (root / thread_id).is_dir():
        files = [p for p in (root / thread_id).iterdir() if p.suffix.lower() in IMG_EXTS]
    else:
        files = [p for p in root.glob("*/*") if p.suffix.lower() in IMG_EXTS and p.stat().st_mtime >= started_at - 2]
        if files:
            log("[warn] 事件流里没有 thread_id，按时间戳兜底找图；并发时可能串图")
    return sorted(files, key=lambda p: p.stat().st_mtime)


LOGIN_RE = re.compile(r"not logged in|login required|unauthorized|\b401\b|codex login|reauthenticat", re.I)
QUOTA_RE = re.compile(r"usage limit|quota|rate.?limit|too many requests|\b429\b|limit reached|try again (later|in)", re.I)
REFUSAL_RE = re.compile(r"can(?:'|no)t (?:help|generate|create)|unable to (?:generate|create)|could not be generated|cannot be generated|content policy|violat|not allowed|safety|rejected|refus", re.I)


def classify(res: Run):
    blob = "\n".join([res.stderr[-3000:], res.stdout[-3000:], res.last_message[-1000:]])
    if res.timed_out:
        return EXIT_TIMEOUT, "codex 超时", False
    if LOGIN_RE.search(blob):
        return EXIT_LOGIN, "Codex 登录失效，在 Mac 上执行 `codex login`", False
    if QUOTA_RE.search(blob):
        return EXIT_QUOTA, "撞到 ChatGPT 订阅额度/限流", True
    if res.rc != 0:
        tail = (res.stderr.strip().splitlines() or ["(无 stderr)"])[-1][:300]
        return EXIT_OTHER, f"codex 退出码 {res.rc}：{tail}", True
    if not res.images:
        if REFUSAL_RE.search(res.last_message):
            # 图像安全系统的拒绝不是确定性的（同一 prompt 并行三次可能两过一拒），值得重试一次
            return EXIT_REFUSAL, f"图像安全系统/模型拒绝出图：{res.last_message[:300]}", True
        return EXIT_NO_IMAGE, f"codex 正常退出但没有出图（回复：{res.last_message[:200] or '空'}）", True
    return EXIT_OK, "", False


def prompt_used(res: Run) -> str:
    m = re.search(r"PROMPT_USED:\s*(.+)", res.last_message, re.S)
    return " ".join(m.group(1).split()) if m else ""


# ---------- 落盘 ----------
def out_path(args, i: int) -> Path:
    if args.out:
        p = Path(args.out)
        if args.n > 1:
            return p.with_name(f"{p.stem}_{i}{p.suffix or '.png'}")
        return p if p.suffix else p.with_suffix(".png")
    return Path(f"codex_{int(time.time())}_{i}.png")


def finalize(src: Path, dst: Path, args, framing: Framing):
    """拷到 dst；--size 时 cover 缩放 + 居中裁；按扩展名转格式；透明校验。返回说明文字。"""
    Image = pil()
    dst.parent.mkdir(parents=True, exist_ok=True)
    if Image is None:
        shutil.copy2(src, dst)
        return "Pillow 缺失：原图直出"
    im = Image.open(src)
    im.load()
    gw, gh = im.size
    note = f"{gw}x{gh}"
    if framing.exact and (gw, gh) != (framing.w, framing.h):
        tw, th = framing.w, framing.h
        scale = max(tw / gw, th / gh)
        rw, rh = max(tw, round(gw * scale)), max(th, round(gh * scale))
        im = im.resize((rw, rh), Image.LANCZOS)
        left, top = (rw - tw) // 2, (rh - th) // 2
        im = im.crop((left, top, left + tw, top + th))
        crop = max(1 - tw / rw, 1 - th / rh) * 100
        note += f" → x{scale:.2f} 缩放 + 居中裁 {crop:.1f}% → {tw}x{th}"
        if scale > 2:
            note += "（放大超 2 倍，细节偏软）"
    ext = dst.suffix.lower()
    if ext in (".jpg", ".jpeg"):
        im.convert("RGB").save(dst, "JPEG", quality=95)
    elif ext == ".webp":
        im.save(dst, "WEBP", quality=95)
    else:
        im.save(dst, "PNG")
    if args.transparent:
        ok = im.mode in ("RGBA", "LA") and im.getchannel("A").getextrema()[0] < 255
        note += "；透明 OK" if ok else "；[warn] 没有透明通道，换个说法重出"
    return note


def cleanup(thread_id, keep):
    if keep or not thread_id:
        return
    d = codex_home() / "generated_images" / thread_id
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)


def prune_old():
    root = codex_home() / "generated_images"
    if not root.is_dir():
        return
    cutoff = time.time() - PRUNE_DAYS * 86400
    for d in root.iterdir():
        try:
            if d.is_dir() and d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True)
        except Exception:
            pass


# ---------- 单张 ----------
def generate_one(i, envelope, refs, args, framing, deadline):
    tmpdir = Path(tempfile.mkdtemp(prefix="codeximg_"))
    t0 = time.time()
    try:
        attempt = 0
        while True:
            attempt += 1
            try:
                with Slot(deadline):
                    res = run_codex(envelope, refs, args, tmpdir)
            except TimeoutError as e:
                return dict(code=EXIT_TIMEOUT, msg=str(e), t=time.time() - t0)
            code, msg, retryable = classify(res)
            if code == EXIT_OK:
                break
            cleanup(res.thread_id, args.keep_originals)
            max_retries = 2 if code == EXIT_NO_IMAGE else 1
            if retryable and attempt <= max_retries and time.time() + RETRY_SLEEP < deadline:
                log(f"[retry] 第 {i} 张：{msg}；{RETRY_SLEEP}s 后重试（{attempt}/{max_retries}）")
                time.sleep(RETRY_SLEEP)
                continue
            if res.timed_out:
                msg = f"codex 超时（--timeout {args.timeout}s）"
            return dict(code=code, msg=msg, t=time.time() - t0, usage=res.usage)
        dst = out_path(args, i)
        note = finalize(res.images[-1], dst, args, framing)
        if args.keep_originals:
            note += f"；原图 {res.images[-1]}"
        cleanup(res.thread_id, args.keep_originals)
        return dict(code=EXIT_OK, path=dst, note=note, t=time.time() - t0, usage=res.usage,
                    prompt=prompt_used(res))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="Codex CLI image_gen 生图", formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="退出码：0 成功 / 2 参数 / 3 未登录 / 4 额度限流 / 5 拒绝 / 6 超时 / 7 没出图 / 1 其他")
    ap.add_argument("prompt", help="需求描述（默认由 Codex 润色成完整 prompt；--verbatim 则原样透传）")
    ap.add_argument("--aspect", default="2:3", help="画幅比例 W:H，默认 2:3（竖版）。常用：3:2 横、1:1 方、16:9、9:16")
    ap.add_argument("--size", default=None, help="精确输出尺寸 WIDTHxHEIGHT（本地缩放+居中裁；给了就覆盖 --aspect）")
    ap.add_argument("--ref", action="append", default=[], help="参考图，可重复")
    ap.add_argument("--transparent", action="store_true", help="原生透明背景 PNG")
    ap.add_argument("--n", type=int, default=1, help="出几张（并行，受并发槽限制），文件名 <out>_1.. _N")
    ap.add_argument("--out", "-o", default=None, help="输出路径；扩展名决定格式（.png/.jpg/.webp），默认 codex_<ts>_<i>.png")
    ap.add_argument("--verbatim", action="store_true", help="不让 Codex 改写 prompt，原样传给 image_gen（有词系纪律的项目用）")
    ap.add_argument("--effort", default="low", choices=["low", "medium", "high"], help="Codex 推理强度，默认 low")
    ap.add_argument("--timeout", type=int, default=300, help="单张总超时（含排队），秒")
    ap.add_argument("--keep-originals", action="store_true", help="保留 ~/.codex/generated_images 里的原图")
    args = ap.parse_args()

    if not args.prompt.strip():
        die("prompt 不能为空")
    if not 1 <= args.n <= 10:
        die(f"--n 必须在 1–10，当前 {args.n}")
    if args.transparent and args.out and Path(args.out).suffix.lower() in (".jpg", ".jpeg"):
        die("--transparent 需要 .png 或 .webp 输出（jpg 没有 alpha）")
    framing = Framing(args.aspect, args.size)
    check_login()

    log(f"[codex-image] {'verbatim' if args.verbatim else 'codex-writes-prompt'}  aspect={framing.rw}:{framing.rh}"
        f"{'  size=' + args.size if args.size else ''}  n={args.n}  refs={len(args.ref)}  effort={args.effort}"
        f"  concurrency<={MAX_CONCURRENCY}")
    short = args.prompt if len(args.prompt) <= 200 else args.prompt[:200] + "..."
    log(f"[request] {short}")

    ref_tmp = Path(tempfile.mkdtemp(prefix="codeximg_refs_"))
    t0 = time.time()
    try:
        refs = prepare_refs(args.ref, ref_tmp) if args.ref else []
        envelope = build_envelope(args, framing, len(refs))
        deadline = time.time() + args.timeout
        with ThreadPoolExecutor(max_workers=args.n) as ex:
            results = list(ex.map(lambda i: generate_one(i, envelope, refs, args, framing, deadline), range(1, args.n + 1)))
    finally:
        shutil.rmtree(ref_tmp, ignore_errors=True)
    prune_old()

    log(f"[done] {time.time() - t0:.1f}s")
    failed = []
    tokens = 0
    for i, r in enumerate(results, 1):
        if r["code"] == EXIT_OK:
            kb = r["path"].stat().st_size / 1024
            log(f"  saved: {r['path']}  ({kb:.0f} KB)  [{r['note']}; {r['t']:.0f}s]")
            if r.get("prompt"):
                log(f"  prompt_used[{i}]: {r['prompt'][:600]}")
        else:
            log(f"  FAILED #{i} (exit {r['code']}): {r['msg']}")
            failed.append(r["code"])
        u = r.get("usage") or {}
        tokens += int(u.get("total_tokens") or (u.get("input_tokens", 0) + u.get("output_tokens", 0)))
    if tokens:
        log(f"[usage] codex tokens ≈ {tokens:,}（走 ChatGPT 订阅额度）")
    specific = [c for c in failed if c != EXIT_OTHER]
    sys.exit((specific or failed or [EXIT_OK])[0])


if __name__ == "__main__":
    main()
