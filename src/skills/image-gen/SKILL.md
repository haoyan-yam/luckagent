---
name: image-gen
description: 生图（文生图 / 图生图 / 改图 / 透明背景），统一入口 gen.py，两个后端按本机配置自动选择：Codex CLI 内置 image_gen（走 ChatGPT 订阅，无需 key，默认首选）与火山 Seedream（ARK_API_KEY）；Codex 未登录或撞额度时自动改走 Seedream。当用户说"生图""画一张""生成图片""做张海报""画个 logo""画个 icon""出张图""生成 banner""做张封面""生成插画""image generation""text to image""img2img""图生图""编辑这张图""把这张图改成 XXX""换背景""透明背景图""出张参考图""文生图"，或任何明显在请求生成/编辑视觉图像产物的场景时使用此 skill。品牌营销物料（海报/货品卡/H5 界面图/长图文/封面/banner，画面含品牌 logo/产品包装/真实文案）也直接用本 skill 整图直出——产出定位是 ref/提案稿，美观第一，打法见正文「品牌物料出图法」一节。只要意图是生成一张新图或编辑现有图，且没有指定走 Midjourney / Stable Diffusion / Flux / Gemini 等其他模型，就触发本 skill。本 skill 不适用于：视频生成（走 seedance-video）、3D 模型、矢量图 SVG 设计稿（走对应专门工具）、实拍照片修图/合焦/清晰化/放大（走 refocus-composite）。
---

# image-gen — 生图（Codex 优先，火山 Seedream 兜底）

> 统一入口 `scripts/gen.py`。后端由本机配置确定性选出，不靠语义猜测：
> - **codex**：本机 Codex CLI 内置的 `image_gen` 工具（ChatGPT 同款 gpt-image 模型），走 ChatGPT 订阅额度，不需要任何 key。
> - **seedream**：火山方舟 Doubao-Seedream，需要 `ARK_API_KEY`。
>
> 适用于：海报、icon、产品图、插画、参考图、概念图、社交媒体素材、文生图与图生图。

---

## 触发判定（先于一切）

收到生图请求后，先快速过一遍：

1. **场景必须落到"输出一张可视图像产物"**——不是分析图、不是流程图（流程图走 mermaid / 飞书画板）、不是 SVG 矢量稿、不是视频（走视频生成工具）。
2. **如果用户已经指明别的模型**（如 Midjourney / SD / Flux / Gemini image / 通义千问），不要用本 skill。
3. **没指定模型 + 想要质量过得去 + 中英文文字渲染重要时**，本 skill 是首选。
4. **品牌营销物料直接归本 skill**：海报/货品卡/H5 界面图/长图文，含品牌 logo·产品包装·真实文案，都整图直出——产出定位是 ref/提案稿不出街，**美观第一**，按下方「品牌物料出图法（美观优先）」操作。实拍照片修图/合焦/放大让路给 `refocus-composite`。

如果用户只给了一个含糊的"画一张图"没说细节，按 [澄清流程](#澄清流程先判断要不要问) 先问关键参数。

---

## 统一入口与后端判定（一律用 gen.py）

**永远调 `scripts/gen.py`**，不要自己挑后端脚本。

| 顺序 | 条件 | 生效后端 |
| --- | --- | --- |
| 1 | 传了 `--provider codex\|seedream` | 指定的那个（**不兜底**） |
| 2 | `.env` 里 `IMAGE_GEN_PROVIDER=codex\|seedream`（安装时写入） | 配置的那个 |
| 3 | 自动：Codex 已安装且已登录 | **codex** |
| 4 | 自动：配了 `ARK_API_KEY` | **seedream** |
| — | 都没有 | 报错并给出配置指引 |

**自动兜底**：走 codex 时如果「未登录 / 找不到 codex」或「撞订阅额度 / 限流」，且配了 `ARK_API_KEY`，gen.py 会自动改用 Seedream 重出，日志打印 `[fallback]`。

- 仅当用户**明确点名**要某家时才加 `--provider`；其余情况不要根据提示词内容猜后端。
- 调试：`--print-cmd` 只打印选中的后端、判定来源和将执行的命令。
- 两家产出都是本地图片文件，后续发送/归档流程完全一致。

## 核心命令

脚本位置（相对本 skill）：`scripts/gen.py`

```bash
# 文生图（默认 1:1）
python3 scripts/gen.py "<prompt>" --aspect 2:3 -o <发送目录>/poster.png

# 图生图 / 编辑（参考图可多张，prompt 里用 Image 1 / Image 2 指代）
python3 scripts/gen.py "把 Image 1 的产品放进 Image 2 的场景，产品外观保持不变" \
  --image product.png --image scene.jpg -o <发送目录>/v1.png

# 精确像素（下游要固定尺寸时）
python3 scripts/gen.py "..." --size 3200x2560 -o kv.png

# 透明背景（icon / logo / 贴纸）
python3 scripts/gen.py "扁平图标：折纸鹤，蓝紫渐变" --aspect 1:1 --transparent -o crane.png

# 一次出多张候选（文件名 cand_1.png cand_2.png …）
python3 scripts/gen.py "..." --n 3 -o cand.png

# prompt 原样透传，不让 Codex 润色（有词系纪律的项目必用）
python3 scripts/gen.py "<完整 prompt>" --verbatim -o x.png
```

## 参数速查

| 参数 | 说明 |
|---|---|
| `prompt` | 需求描述。codex 默认会把它润色成完整 prompt（保留所有元素和引号内文字，不加品牌、人物、额外文字）；seedream 原样使用 |
| `--aspect W:H` | 画幅比例，默认 `1:1`。常用 `2:3` 竖、`3:2` 横、`16:9`、`9:16`、`5:4`。上限 3:1 |
| `--size WxH` | 精确输出尺寸，给了就覆盖 `--aspect`。codex 出图后本地缩放 + 居中裁；seedream 原生出该尺寸 |
| `--image path` | 参考图，可重复。codex 会把长边超过 1536px 的自动压一份临时副本 |
| `--transparent` | 透明背景 PNG。codex 原生透明；seedream 在纯色键背景上生成后本地自动抠图 |
| `--n` | 出几张，1–10。codex 并行出独立候选；seedream 是同风格组图 |
| `-o` / `--out` | 输出路径，扩展名决定格式（.png / .jpg / .webp）。多张时文件名 `<stem>_1..N` |
| `--timeout` | 秒，默认 300（codex 含排队） |
| `--verbatim` | [codex] 不润色，prompt 原样传给工具 |
| `--seed` / `--watermark` / `--model` | [seedream] 随机种子 / 保留水印 / 覆盖模型 id（错配到 codex 时警告并忽略） |
| `--provider` | 强制指定后端，不兜底 |

## 两个后端的真实边界

**codex（Codex CLI image_gen）**
- 只能控**比例**，不能控像素：输出总像素固定约 1.57 MP（2:3 → 1024×1536，3:2 → 1536×1024，1:1 → 1254×1254）。`--size` 是本地放大或缩小，放大超过 2 倍时细节偏软，日志有提示。原生 2K / 4K 给不了——要大图且有火山 key 时可 `--provider seedream`。
- 没有质量档位、没有 mask 局部修图、不能选模型。要改局部：用 PIL 裁出那块，`--image` 喂回去重生成，再贴回。
- 单张 40–90 秒；走 ChatGPT 订阅额度，不按张付费。
- 并发上限默认 3（`CODEX_IMAGE_MAX_CONCURRENCY` 可调），跨进程文件锁限流，多个 bot 同时出图共用这个上限，超出的排队并打印 `[wait]`。
- 日志里 `prompt_used` 一行是 Codex 实际发给工具的 prompt，出问题先看这行。默认润色会自己加 `editorial / cinematic / studio lighting` 这类词，项目有禁用词系时用 `--verbatim`。

**seedream（火山方舟）**
- 原生支持大尺寸（默认约 2048×2048，可到 4096×4096），`--aspect` 会自动换算成约 400 万像素的尺寸。
- 中文 prompt 效果好；`--n` 是同风格组图。
- 透明背景不是原生能力：gen.py 自动在 prompt 里追加色键背景要求，出图后用 `scripts/remove_chroma_key.py` 抠图。毛发、玻璃、烟雾等复杂边缘抠不干净，这类需求优先 codex。
- 前置：账号已在方舟「开通管理」开通 Doubao-Seedream 模型。脚本自动绕过系统代理（国内直连域名）。

---

## 澄清流程（先判断要不要问）

**主体 + 场景明确的请求直接出图，不要提问**——"一张外滩夜景""草地上的柴犬""赛博朋克风格的上海街头"都属于此类：用默认参数（按内容选比例、不透明底）立刻生成，快速给结果比追问偏好更有价值；用户不满意自然会提修改要求（那才是澄清的最佳时机）。

**只有存在关键歧义时才问**——典型：明确说要做 icon/logo（涉及透明底与尺寸）、要求带具体文字但没给文案、"给 XX 做张图"看不出画什么。此时**用 AskUserQuestion 一次问完**（绝不逐条来回），每个问题都给出默认选项让用户可以一键跳过：

1. **用途**：海报 / icon / banner / 产品图 / 插画（决定比例与透明底）
2. **画面文字**：要哪些字（不写 = 无文字）
3. **风格 / 参考图**：有参考图就传 `--image`（不选 = 按内容自定）

超时或用户未答：按默认参数直接出图，不要放弃任务。

prompt 本身要尽量具体：主体 + 构图 + 光线 + 风格 + 氛围。中英文都行。

---

## 出图前先填表（use case + prompt schema）

> 澄清流程定的是**执行参数**（比例/透明），这一节定的是**画面参数**。每次出图都过一遍，别跳。

### 第一步：认领 use case

先给这次任务定一个 slug，它决定默认动作，也是去 `references/sample-prompts.md` 抄配方的索引键。

**生成类（11）**

| slug | 用在哪 / 默认动作 |
|---|---|
| `photorealistic-natural` | 生活方式实拍感；要写具体材质瑕疵（毛孔、织物磨损、颗粒）才像真的 |
| `product-mockup` | 产品/包装/目录图；干净布光，默认无多余文字与水印 |
| `ui-mockup` | App/网页界面稿、线框图；**必须指明保真度**（低保真线框 or 高保真） |
| `infographic-diagram` | 信息图/图解；结构化版式 + 密集文字 |
| `scientific-educational` | 教学/科学示意；标注必须准确，先列出必需标签 |
| `ads-marketing` | 广告 campaign 创意；写清受众、品牌调性、逐字 slogan |
| `productivity-visual` | 幻灯片、图表、流程、商业数据视觉 |
| `logo-brand` | logo/标记探索；单色、矢量友好、留白充足 |
| `illustration-story` | 漫画、绘本、叙事场景 |
| `stylized-concept` | 风格化概念图、3D/渲染风；网站与游戏素材多归这类 |
| `historical-scene` | 年代与世界知识准确的场景 |

**编辑类（8）**

| slug | 用在哪 / 默认动作 |
|---|---|
| `text-localization` | 换图内文字；只改字，保版式、字体、字号层级 |
| `identity-preserve` | 试穿、人入场景；锁脸、体型、姿势、发型、表情 |
| `precise-object-edit` | 增删换某个具体元素；其余像素不动 |
| `lighting-weather` | 只改时间/季节/天气/氛围，别的不许动 |
| `background-extraction` | 抠图/透明背景 → 直接用 `--transparent` |
| `style-transfer` | 套参考图风格，主体/场景可变 |
| `compositing` | 多图合成插入；对齐光照与透视 |
| `sketch-to-render` | 线稿/草图 → 写实渲染 |

### 第二步：按 schema 填 prompt

用得上的行才写，空行删掉；需要时可临时加一行自定义标签。

```text
Use case: <上表 slug>
Asset type: <这张图最终用在哪>
Primary request: <用户的核心诉求>
Input images: <Image 1: 角色; Image 2: 角色>
Scene/backdrop: <环境>
Subject: <主体>
Style/medium: <摄影 / 插画 / 3D / …>
Composition/framing: <景别、视角、元素位置>
Lighting/mood: <光线 + 氛围>
Color palette: <配色>
Materials/textures: <材质与表面细节>
Text (verbatim): "<画面里要出现的字，逐字写>"
Constraints: <必须保持 / 必须避免>
Avoid: <负面约束>
```

### 使用规则

- **不加戏**：用户 prompt 已经具体 → 只做归一化整理；很泛 → 才补构图/用途/光线。任何情况下都不要凭空加人、加物、加品牌词、加 slogan。
- **编辑类每轮重写 invariants**：`change only X; keep Y unchanged` 每次迭代都要重复写，否则多轮必漂移。
- **迭代只动一行**：改哪里就改哪一行，其余逐字复用——这样重摇不会把已经画对的细节重新掷骰子（同[品牌物料出图法](#品牌物料出图法美观优先)第 5 条）。自己写好的完整 prompt 配 `--verbatim`，避免 Codex 每轮润色出不同版本。
- **母版派生靠它**：系列/多屏共用母版时，各屏之间只允许 `Composition/framing` 这类少数行不同，其余保持逐字一致。
- **别混淆**：`Scene/backdrop` 是画面里的环境；`--transparent` 是控透明的 CLI 参数，两回事。`Asset type` / `Input images` 只是 prompt 脚手架，没有对应的命令行参数。
- **抄现成的**：18 类的完整配方（外加网站素材 / 游戏素材 / 线框图 / logo 四套模板）在 `references/sample-prompts.md`，认准 slug 抄那一节。

---

## 深入参考（按需加载，来自 OpenAI Codex 官方 imagegen skill）

复杂 / 高要求的出图任务，先读对应参考再动手：

- `references/prompting.md` —— prompt 结构、增强尺度（何时加细节何时只归一化）、编辑不变量、迭代方法、11 类用例要点
- `references/sample-prompts.md` —— 11 类生成用例 + 8 类编辑用例的完整 prompt 配方，含网站素材 / 游戏素材 / 线框图 / logo 模板

---

## 品牌物料出图法（美观优先）

> 定位：品牌物料产出默认是 **ref/提案稿**，不出街。**美观第一，正确性第二。**
> 好看的来源是一次成像的**全局一致性**——构图、光影、色彩、字形在同一次采样里联合决定：文字受场景光照、产品有投影、整图同色调同颗粒。所以**能整图就整图，不要拆层合成**（AI 背景 + 抠图 + HTML 排字的拆层管线恰恰破坏全局一致性，成品有"贴上去"感）。
> 已知代价（可披露，不是绕道理由）：模型不认字体文件（prompt 写字体名无效）、中文长文案会乱码、会一本正经编造产品名。

打法五条：

1. **文案写进 prompt**：真实标题/副标题/CTA 直接写进 prompt 让 AI 画进画面——AI 画的字有光照有质感、和构图咬合，这正是整图好看的来源。短英文和数字准确率尚可；中文长文案会乱码，ref 阶段可接受，扎眼再局部修（裁出那块用 `--image` 喂回重生成再贴回）。
2. **用整张画布**：不要预留留白安全区、不要禁硬边界，让 AI 自由构图——文字穿插画面、元素压字、对角线都是张力来源。
3. **参考图锚定风格**：客户认可过的视觉、品牌往期 KV 用 `--image` 喂进去锚定。系列/多屏共用一张母版，各屏用 PIL 裁切/续接或以母版为参考图派生，别每屏独立生成（必然风格漂移）；扩幅裁边缘色带 `resize` 续接即可，别为改画幅重摇。
4. **best-of-N 重摇挑图**：`--n 2` 或多摇几轮挑最好的。构图和氛围是摇出来的不是修出来的，这不是该省的地方。
5. **反馈对号入座**：氛围/构图/风格不对 → 改 prompt 整图重摇；单点小错（手指、logo 花押崩、局部乱码）→ 局部修，其余像素不动；别为改一句话重摇整图（画对的细节会全部重新掷骰子）。

发送前美观三眼：候选缩略**并排挑**一张最好的；AI 高频翻车区（手指、五官、logo、文字区、产品透视）**放大目检**；缩到手机宽度看**第一眼**抓不抓人——群里的 ref 就是被当缩略图看的。

随图带一句：「方向稿：图中文字/logo/产品为 AI 示意，出街前需替换官方资产与真字体。」AI 编造的产品名要逐个点名，防止客户当真拿去用。两条红线：不抄竞品参考件里的代言人/会员体系/IP（别家合约资产，合规事故）；真要出街定稿时，logo/产品图管客户要原件替换，别默默用 AI 造的顶上。

---

## 工作目录与输出

- 命令里用本 skill 的绝对路径调 `scripts/gen.py`，工作目录无所谓。
- **`-o` 直接写到发送目录**（系统提示「Output Files」一节给的路径），桥接会把图自动发到当前会话；要留档再另拷一份到项目目录。
- 不传 `-o` 时落在当前目录 `image_<时间戳>.png`，不会自动发送。

---

## 失败处理（gen.py 退出码）

| 退出码 | 含义 | 处理 |
|---|---|---|
| 2 | 参数错误 | 看 stderr 提示 |
| 3 | Codex 未登录 / 找不到 codex（有火山 key 时已自动兜底） | 请管理员在这台 Mac 上执行 `codex login`；所有 bot 共用这一个登录 |
| 4 | 撞 ChatGPT 订阅额度或限流（已自动重试一次；有火山 key 时已自动兜底） | 等额度窗口重置，或把并发调到 1 |
| 5 | 图像安全系统或模型拒绝出图（已自动重试一次） | 这个拒绝不是确定性的：先原样再跑一次；仍拒就改写触发点（品牌名 + 人物、暴露、真人、敏感场景） |
| 6 | 超时（含排队） | 加大 `--timeout` |
| 7 | Codex 跑完但没出图（已自动重试） | 简化需求，去掉会被当成指令的句子 |
| 1 | 其他（含 seedream 报错） | 看 stderr 最后几行 |

seedream 常见报错：`AuthenticationError` = key 不对；`ModelNotOpen` = 账号未开通该模型（方舟控制台「开通管理」一键开通）；`InvalidEndpointOrModel.NotFound` = 模型 id 已滚版本，用 `--model` 或 `SEEDREAM_MODEL` 环境变量指定控制台当前 id。查当前可用 id：

```bash
curl -s https://ark.cn-beijing.volces.com/api/v3/models -H "Authorization: Bearer $ARK_API_KEY" | python3 -c "import json,sys;[print(m['id']) for m in json.load(sys.stdin)['data'] if 'seedream' in m['id']]"
```

Codex 升级后若事件流或 `generated_images` 目录布局变了，脚本会退到按时间戳找图并打 `[warn]`，此时先 `codex --version` 报给管理员。

---

## 与其他 skill 的边界

- **要可视化数据 / 流程 / 架构** → 用 `lark-whiteboard`（飞书画板）或 mermaid
- **要可编辑的矢量素材（SVG / Figma）** → 不要用本 skill，出的是栅格图
- **要做 PPT 里的图** → 先用本 skill 出图，再交给 `pptx` skill 插入
- **要给文档配图** → 出图后用 `docx` / `lark-doc` skill 插入

---

## 安全提醒（写给 Claude，不要主动跟用户提）

- Codex 的凭据是 `~/.codex/auth.json` 里的 ChatGPT 登录态，火山的是 `.env` 里的 `ARK_API_KEY`。**不要读、不要打印、不要复制**它们（包括 `env` 输出、cat 配置文件）。
- 登录失效或 key 要换：告诉用户请管理员在这台机器上执行 `codex login`，或更新 `.env` 里的 `ARK_API_KEY` 后 `luckagent restart`。
