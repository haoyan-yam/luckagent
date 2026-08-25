---
name: image-gen
description: 直接调 API 生图（文生图 / 图生图 / 编辑），双 provider：OpenAI gpt-image-2 与火山 Seedream，均零第三方依赖。provider 由已配置的 API key 自动判定（统一入口 gen.py），不靠语义猜测。当用户说"生图""画一张""生成图片""做张海报""画个 logo""画个 icon""出张图""生成 banner""做张封面""生成插画""image generation""text to image""img2img""图生图""编辑这张图""把这张图改成 XXX""换背景""透明背景图""出张参考图""文生图"，或任何明显在请求生成/编辑视觉图像产物的场景时使用此 skill。品牌营销物料（海报/货品卡/H5 界面图/长图文/封面/banner，画面含品牌 logo/产品包装/真实文案）也直接用本 skill 整图直出——产出定位是 ref/提案稿，美观第一，打法见正文「品牌物料出图法」一节。即使没有明确说 "OpenAI" 或 "gpt-image-2"，只要意图是生成一张新图或编辑现有图，且没有指定走 Midjourney / Stable Diffusion / Gemini 等其他模型，就触发本 skill。本 skill 不适用于：视频生成（走 seedance-video）、3D 模型、矢量图 SVG 设计稿（走对应专门工具）、实拍照片修图/合焦/清晰化/放大（走 refocus-composite）。
---

# image-gen — API 直调生图（gpt-image-2 / 火山 Seedream）

> 通过 `scripts/gen_image.py` 直接调用 OpenAI Images API（端点 `/v1/images/generations` 和 `/v1/images/edits`），用 `gpt-image-2` 模型生成或编辑图像。
> 适用于：海报、icon、产品图、插画、参考图、概念图、社交媒体素材、文生图与图生图。

---

## 触发判定（先于一切）

收到生图请求后，先快速过一遍：

1. **场景必须落到"输出一张可视图像产物"**——不是分析图、不是流程图（流程图走 mermaid / 飞书画板）、不是 SVG 矢量稿（走 axi-front-design）、不是视频（走视频生成工具）。
2. **如果用户已经指明非 OpenAI 的模型**（如 Midjourney / SD / Flux / Gemini image / 通义千问 / 即梦），不要用本 skill。
3. **没指定模型 + 想要质量过得去 + 中英文文字渲染重要时**，本 skill 是首选。
4. **品牌营销物料直接归本 skill**：海报/货品卡/H5 界面图/长图文，含品牌 logo·产品包装·真实文案，都整图直出——产出定位是 ref/提案稿不出街，**美观第一**，按下方「品牌物料出图法（美观优先）」操作。实拍照片修图/合焦/放大让路给 `refocus-composite`。

如果用户只给了一个含糊的"画一张图"没说细节，按 [澄清流程](#澄清流程) 先问关键参数。

---

## 统一入口与 provider 判定（一律用 gen.py）

**永远调 `scripts/gen.py`**，不要自己挑后端脚本。provider 由已配置的 key 确定性判定：

| 配置情况 | 生效 provider |
| --- | --- |
| 配了 `OPENAI_IMAGE_API_KEY` 或 `OPENAI_API_KEY`（无论是否也配了火山） | **openai**（gpt-image-2） |
| 只配了 `ARK_API_KEY` | **seedream**（火山方舟） |
| 都没配 | 报错并给出配置指引 |

```bash
python3 scripts/gen.py "提示词" -o out.png [--image ref.jpg]... [--size WxH] [--n 4]
```

- 仅当用户**明确点名**要某家时才加 `--provider openai|seedream` 强制指定；其余情况不要根据提示词内容猜 provider。
- `--n` 自动翻译（openai 的多图 / seedream 的组图）；provider 专属参数（`--quality`/`--mask`/`--seed`/`--watermark` 等）错配时会警告并忽略，不会失败。
- 调试：`--print-cmd` 只打印将执行的后端命令。
- 两家产出都是本地图片文件，后续发送/归档流程完全一致。下文两节是各后端的参数细节，仅在需要专属能力时参考。

## 核心命令

脚本位置（相对本 skill）：`scripts/gen_image.py`
**API key 从环境变量读取**（`OPENAI_IMAGE_API_KEY` 优先，其次 `OPENAI_API_KEY`，都已在用户环境配置），无需在命令里传。

### 文生图（最常见）

```bash
python3 scripts/gen_image.py "<prompt>" \
  --size 1024x1024 \
  --quality high \
  --out <文件名>.png
```

### 图生图 / 编辑（带参考图）

```bash
python3 scripts/gen_image.py "<改写指令>" \
  --image <参考图路径> \
  --out <文件名>.png
```

参考图可以多张：再加几个 `--image <path>`。

### 透明背景（出 icon / logo / 贴纸时用）

> **红线：`gpt-image-2` 不支持 `--background transparent`，传了必 400 报错，永远不要组合。** 透明需求走下面两条路之一。

**路径 A —— 原生透明（简单主体 / 图标，一步到位）**：切到 `gpt-image-1.5`，它支持原生透明输出。毛发、玻璃、烟雾、半透明材质等复杂边缘也走这条（chroma-key 抠不干净）。

```bash
python3 scripts/gen_image.py "<prompt>" \
  --model gpt-image-1.5 \
  --background transparent \
  --output-format png \
  --out icon.png
```

**路径 B —— gpt-image-2 画质 + chroma-key 抠图**（要 gpt-image-2 的文字渲染 / 画质时）：先在纯平色键背景上生成，再本地抠掉。

1. prompt 里明确要求：主体画在**纯平 `#00ff00` 背景**上（主体是绿色系就换 `#ff00ff`），背景单一颜色、无阴影 / 渐变 / 纹理 / 反光 / 地面，主体边缘清晰、留足 padding，主体内不得出现色键色。
2. 本地去背景（脚本在本 skill `scripts/` 下，纯 Pillow 无其他依赖）：

```bash
python3 scripts/remove_chroma_key.py \
  --input <生成图>.png --out <最终>.png \
  --auto-key border --soft-matte \
  --transparent-threshold 12 --opaque-threshold 220 --despill
```

3. 验证：输出必须是 RGBA、四角透明、主体覆盖合理、无绿边。残留细绿边补 `--edge-contract 1`；边缘锯齿明显（且主体不反光）再加 `--edge-feather 0.25`。

---

## 关键参数速查

| 参数 | 取值 | 说明 |
|---|---|---|
| `--size` | `1024x1024` / `1024x1536`（竖）/ `1536x1024`（横）/ `2048x2048` / `2048x1152`（2K 横）/ `3840x2160`（4K 横）/ `2160x3840`（4K 竖）/ `auto` | 默认 1024x1024；海报用竖图，banner 用横图。gpt-image-2 支持任意自定义尺寸，约束：最长边 ≤3840、宽高均为 16 的倍数、长短边比 ≤3:1、总像素 655,360–8,294,400（**没有 4096x4096**）|
| `--quality` | `low` / `medium` / `high` / `auto` | 默认 `high`；low 用于试稿、icon 这类不复杂场景 |
| `--n` | int | 一次出几张，默认 1。要候选时用 `--n 4` |
| `--background` | `transparent` / `opaque` / `auto` | **仅 gpt-image-1.5 / gpt-image-1 支持 transparent**（gpt-image-2 会 400）；仅 png/webp 格式有透明意义 |
| `--output-format` | `png` / `jpeg` / `webp` | 默认 png |
| `--mask` | 路径 | edit 模式专用，定义可编辑区域（白色=可改，黑色=保留）|
| `--model` | `gpt-image-2` / `gpt-image-1` / `gpt-image-1.5` | 默认 gpt-image-2（最新最强）|
| `--timeout` | int 秒 | HTTP 超时，默认 300。high 质量大图可能需要 60–120s |

---

## 单次成本参考（gpt-image-2）

按 token 计费，不按张（金额用「x 美元」写法——本文件作为斜杠命令加载时，`$` 紧跟数字会被参数替换吃掉）：
- `low` 质量：约 0.006 美元 / 张
- `medium`：约 0.03–0.05 美元 / 张
- `high`：约 0.15–0.25 美元 / 张（1024×1024）
- `2048×2048` / 4K（3840×2160）：约 0.5–2 美元 / 张

脚本每次跑完都会自动打印实际 token 消耗和估算的美元成本。

---

## 澄清流程（参数不明时）

如果用户只说"画一张图"或同等模糊请求，**先用 AskUserQuestion 工具**问以下关键参数（一次问完，不要逐条来回）：

1. **用途**：海报 / icon / banner / 产品图 / 插画 / 参考图 / 其他？（决定 size 比例）
2. **质量档**：low（试稿，几分钱）/ medium（日常用）/ high（正式交付）？
3. **要不要透明背景**：icon / logo / 贴纸要选 transparent
4. **要不要带文字**：gpt-image-2 文字渲染强，但用户要明确写出来要哪些字
5. **风格 / 参考图**：摄影 / 插画 / 极简 / 国风 / 赛博朋克 ... 有参考图就传 `--image`

prompt 本身要尽量具体：主体 + 构图 + 光线 + 风格 + 氛围。中英文都行，gpt-image-2 多语言能力强。

---

## 深入参考（按需加载，来自 OpenAI Codex 官方 imagegen skill）

复杂 / 高要求的出图任务，先读对应参考再动手：

- `references/prompting.md` —— prompt 结构、增强尺度（何时加细节何时只归一化）、编辑不变量、迭代方法、11 类用例要点
- `references/sample-prompts.md` —— 11 类生成用例 + 8 类编辑用例的完整 prompt 配方，含网站素材 / 游戏素材 / 线框图 / logo 模板
- `references/image-api.md` —— 4 个 gpt-image 模型对比、gpt-image-2 尺寸约束、API 参数权威表（生成 / 编辑 / mask / 透明）

---

## 品牌物料出图法（美观优先）

> 定位（2026-07-20 主人拍板）：品牌物料产出默认是 **ref/提案稿**，不出街。**美观第一，正确性第二。**
> 好看的来源是一次成像的**全局一致性**——构图、光影、色彩、字形在同一次采样里联合决定：文字受场景光照、产品有投影、整图同色调同颗粒。所以**能整图就整图，不要拆层合成**（AI 背景 + 抠图 + HTML 排字的旧管线 brand-visual-pipeline 已废弃——拆层恰恰破坏全局一致性，成品有"贴上去"感）。
> 已知代价（可披露，不是绕道理由）：gpt-image-2 不认字体文件（prompt 写字体名无效）、中文长文案会乱码、会一本正经编造产品名。

打法五条：

1. **文案写进 prompt**：真实标题/副标题/CTA 直接写进 prompt 让 AI 画进画面——AI 画的字有光照有质感、和构图咬合，这正是整图好看的来源。短英文和数字准确率尚可；中文长文案会乱码，ref 阶段可接受，扎眼再用 `--mask` 局部修。
2. **用整张画布**：不要预留留白安全区、不要禁硬边界，让 AI 自由构图——文字穿插画面、元素压字、对角线都是张力来源。
3. **参考图锚定风格**：客户认可过的视觉、品牌往期 KV 用 `--image` 喂进去锚定。系列/多屏共用一张母版，各屏用 PIL 裁切/续接或 `--mask` 派生，别每屏独立生成（必然风格漂移）；扩幅裁边缘色带 `resize` 续接即可，别为改画幅重摇。
4. **best-of-N 重摇挑图**：`--n 2` 或多摇几轮挑最好的。构图和氛围是摇出来的不是修出来的；零点几美元一张不是该省的地方。
5. **反馈对号入座**：氛围/构图/风格不对 → 改 prompt 整图重摇；单点小错（手指、logo 花押崩、局部乱码）→ `--mask` 局部编辑，其余像素不动；别为改一句话重摇整图（画对的细节会全部重新掷骰子）。

发送前美观三眼：候选缩略**并排挑**一张最好的；AI 高频翻车区（手指、五官、logo、文字区、产品透视）**放大目检**；缩到手机宽度看**第一眼**抓不抓人——群里的 ref 就是被当缩略图看的。

随图带一句：「方向稿：图中文字/logo/产品为 AI 示意，出街前需替换官方资产与真字体。」AI 编造的产品名要逐个点名（实证：AI 编过不存在的「光采奢养臻萃礼盒」），防止客户当真拿去用。两条红线：不抄竞品参考件里的代言人/会员体系/IP（别家合约资产，合规事故）；真要出街定稿时，logo/产品图管客户要原件替换，别默默用 AI 造的顶上。

---

## 工作目录与输出

- 跑命令前 `cd` 到本 skill 目录的父级，确保 `scripts/gen_image.py` 路径正确
- 输出文件默认放当前工作目录；建议显式传 `--out <绝对路径>` 落到 outputs 文件夹
- 生成完用 `mcp__cowork__present_files` 把图给用户看

---

## 失败处理

| 现象 | 排查 |
|---|---|
| `HTTP 401` | key 失效或被撤销，需要换新 key（[换 key 方法](#换-key)）|
| `HTTP 429` | 触发速率限制（Tier 1 是 5 IPM）。等 1 分钟重试，或降低并发 |
| `HTTP 400 invalid_request_error` | 检查 size / quality 取值是否合法（gpt-image-2 尺寸约束见参数表）、是否对 gpt-image-2 误传了 `--background transparent`、prompt 是否被安全策略拦截 |
| HTTP 超时 | 大图 high 质量可能 90s+。脚本默认 300s 应该够，超时再加 `--timeout 600` |
| `content_policy_violation` | prompt 含暴力 / 真人裸露 / 政治人物等敏感内容被拦。改写后重试 |

---

## 换 key

key 从环境变量读取，优先级：`OPENAI_IMAGE_API_KEY` > `OPENAI_API_KEY` > 脚本内 `API_KEY_DEFAULT` 常量（当前为空串，仅作最后兜底）。
要替换：更新 shell 配置里的 `OPENAI_IMAGE_API_KEY` 环境变量。
也可以临时覆盖：`OPENAI_IMAGE_API_KEY=sk-xxx python3 scripts/gen_image.py ...`。

---

## 火山 Seedream 生图（gen_seedream.py，通常经 gen.py 自动调用）

前置：`.env` 配 `ARK_API_KEY`（火山方舟控制台创建），且账号已在方舟「开通管理」开通 Doubao-Seedream 模型。脚本自动绕过系统代理（国内直连域名）。

```bash
# 文生图（默认 2048x2048）
python3 scripts/gen_seedream.py "海边日落的插画，扁平风格" -o out.png

# 图生图 / 改图（参考图可本地路径或 URL，可 --image 多次传多参考）
python3 scripts/gen_seedream.py "把背景换成雪山" --image ref.jpg -o edited.png

# 组图：同风格连出多张（目录输出）
python3 scripts/gen_seedream.py "同一 IP 角色的四个表情" --max-images 4 -o outdir/

# 4K / 指定尺寸 / 固定种子复现
python3 scripts/gen_seedream.py "..." --size 4096x4096 --seed 42 -o big.png
```

参数：`--size WxH`（默认 2048x2048）、`--model`（默认 doubao-seedream-5-0-pro-260628，火山滚版本后用控制台当前 id 覆盖，或设 `SEEDREAM_MODEL` 环境变量）、`--watermark`（默认关水印）、`--timeout`。

排错：`AuthenticationError`=key 不对；`ModelNotOpen`=账号未开通该模型（控制台「开通管理」一键开通）；`InvalidEndpointOrModel.NotFound`=模型 id 已滚版本。**查当前可用 id**：

```bash
curl -s https://ark.cn-beijing.volces.com/api/v3/models -H "Authorization: Bearer $ARK_API_KEY" | python3 -c "import json,sys;[print(m['id']) for m in json.load(sys.stdin)['data'] if 'seedream' in m['id']]"
```

## 典型示例

```bash
# 1. 一张海报（竖图，high 质量）
python3 scripts/gen_image.py \
  "极简主义海报，黑底白字，画面中央一个金色几何螺旋，下方衬线字体 'INFINITY'，瑞士设计风格" \
  --size 1024x1536 --quality high --out poster.png

# 2. 一个透明背景的图标（原生透明必须切 gpt-image-1.5，gpt-image-2 不支持）
python3 scripts/gen_image.py \
  "极简扁平图标：一只折纸鹤，柔和渐变蓝紫色，纯色单层" \
  --model gpt-image-1.5 --background transparent --quality medium --out crane_icon.png

# 3. 改图：把一张产品图的背景换掉
python3 scripts/gen_image.py \
  "保持杯子主体不变，把背景换成日式枯山水庭院" \
  --image ./product.jpg --quality high --out product_zen.png

# 4. 一次出 4 张候选 logo
python3 scripts/gen_image.py \
  "现代极简 logo for a coffee brand named 'AURA', 抽象波纹意象, 单色" \
  --n 4 --quality medium --out logo.png
```

---

## 与其他 skill 的边界

- **要可视化数据 / 流程 / 架构** → 用 `lark-whiteboard`（飞书画板）或 mermaid
- **要 HTML 落地页 / 设计稿原型** → 用 `axi-front-design`
- **要可编辑的矢量素材（SVG / Figma）** → 不要用本 skill，gpt-image-2 出的是栅格图
- **要做 PPT 里的图** → 先用本 skill 出图，再交给 `pptx` skill 插入
- **要给文档配图** → 出图后用 `docx` / `lark-doc` skill 插入

---

## 安全提醒（写给 Claude，不要主动跟用户提）

- key 存在用户 shell 环境变量 `OPENAI_IMAGE_API_KEY` 里。
- 如果用户后来说"key 泄露了 / 撤销了 / 换一把"，引导他更新 shell 配置里的该环境变量。
- 不要把 key 内容回显到聊天里（包括打印日志、`env` 输出），脚本本身已经避免了。