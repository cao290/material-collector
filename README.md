# 素材采集器 · Material Collector

一个把浏览器**内嵌在软件窗口里**的桌面应用：批量采集短视频素材、文案与评论，并可做 AI 加工、口播转写。

采集、登录、选片、下载**全程在自己的窗口里完成，不弹出任何外部浏览器**。

## 能做什么

| 能力 | 说明 |
|---|---|
| **四平台采集** | 抖音 / 小红书 / B站 / 快手，按关键词自动翻页搜索、入库 |
| **无水印下载** | 自动走无水印源；B站 DASH 音视频分流下载后 ffmpeg 合并 |
| **文案与评论** | 抓爆款文案、采评论区（一级评论与二级回复分层落库） |
| **AI 加工** | 改写 / 仿写文案、提炼钩子、总结评论、生成混剪口播脚本 |
| **视频转写** | 口播转带时间轴文字（faster-whisper + GPU 加速），可**只取音频**省 90% 空间 |
| **外部接入** | 本机其它软件可通过 HTTP API 与 Webhook 调用，复用登录态 |

## 特点

- **浏览器内嵌**：登录、搜索、采集全在软件窗口内，不弹外部窗口、不抢焦点
- **不碰平台签名**：抖音 `a_bogus`、快手 `sig3`、B站 `wbi` 都由页面自身的 JS 生成，工具只监听结果——平台改签名不会把它打死
- **界面不被遮挡**：采集任务跑在一个隐藏的任务窗口里，功能界面全时可用
- **登录态可移植**：存程序目录 `profile-electron/`，拷走目录即带走登录
- **静默**：自动化过程永久静音，不弹窗、不出声

---

## 安装

需要 **Node.js 18+**（建议 20 / 22 / 24）。

```bash
git clone https://github.com/cao290/material-collector.git
cd material-collector
npm install
```

启动：

```bash
# Windows：双击
启动素材采集器.bat

# 任意平台
npm start
```

> 开发态需要看日志时：`node node_modules/electron/cli.js .`
> 直接 `node server.mjs` 只起纯后端（无内嵌浏览器），仅用于调试接口。

### 可选：视频转写

转写是可选功能，用本地 Python 引擎（faster-whisper），**不装也不影响其它功能**。

```bash
pip install faster-whisper

# 有 NVIDIA 显卡可装 CUDA 运行库加速（可选）
pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-runtime-cu12
```

没装 CUDA 库会自动回退 CPU（慢一些但可用），界面会提示。另需 `ffmpeg` 在 PATH 中（B站合并、抽取音频用）。

---

## 首次使用：登录

1. 点左侧「**内置浏览器**」
2. 点顶部的平台按钮（抖音 / 小红书 / B站 / 快手），面板里打开对应网站
3. 像平常一样扫码登录；登录态保存在程序目录，长期有效
4. 点「检测登录」确认平台都变绿
5. 回「采集」页开工

---

## 使用说明

### 采集

1. 选平台（一次一个，避免同时打多个站触发风控）
2. 关键词一行一个，可一次提交多个
3. 设目标条数（每个关键词）
4. 点 **开始采集**

过程自动完成：打开搜索页 → 滚动加载 → 拦接口拿数据 → 直链不全时逐条进详情补全 → 入库。

- 出现**登录墙或验证码** → 任务变黄提示「需要你操作」，在内嵌面板处理后点 **我已登录，继续**
- 采集到的条目实时出现在「结果」页

### 结果与下载

- 勾选后点 **下载选中**（后台任务，不卡界面）
- 下载前会**重新进一次详情页取新鲜直链**（B站直链带 `deadline`，过期即 403）
- 已下载过的自动跳过

### 素材库

已下载素材按 `下载目录 / 平台 / 关键词 /` 归档，每条带 `.mp4`、封面 `.jpg` 与元信息 `.json`：

```
<下载目录>/
└─ B站/
   └─ 城市夜景/
      ├─ B站_@作者_4429赞_标题_BVxxxx.mp4
      ├─ B站_@作者_4429赞_标题_BVxxxx.jpg      ← 封面
      └─ B站_@作者_4429赞_标题_BVxxxx.json     ← 元信息
```

元信息旁车：标题、文案、话题标签、BGM、作者、点赞/评论/分享/收藏、时长、发布时间、采集关键词、原链接、直链、文件大小、采集时间。

素材库页支持本地播放（Range 流式）、搜索、打开目录、导出 CSV。

### 文案·评论 + AI 加工

1. **按关键词搜文案**：自动翻页，把标题、正文、话题标签、点赞/收藏/评论数收进文案库（B站自动进详情页补全正文）
2. **同时采评论**：一级评论与二级回复**分开落库**（回复带 `parent_id` 关联父评论，界面缩进显示）；可设每条上限，到数即停

AI 加工需在「设置 → AI 模型接口」配置任意 **OpenAI 兼容接口**（本地中转站、自建网关、云厂商均可）：

| 动作 | 用法 |
|---|---|
| 改写文案 | 勾选文案 → 出 3 个口语化改写版本 |
| 提炼钩子 | 勾选同主题多条 → 提炼钩子公式 + 5 个开头句式 |
| 仿写同款 | 填主题 → 按爆款结构仿写 3 条 |
| 总结评论 | 采完评论 → 总结高频痛点 TOP5 + 选题方向 |
| 混剪脚本 | 勾一条文案 → 生成 30-45 秒分镜口播脚本 |
| 自定义 | 任意提示词，`{content}` 占位符代入素材 |

### 视频转写

把素材里的说话/口播转成带时间轴的文字，供检索与 AI 二次加工。

- **引擎**：本地 Python 微服务（faster-whisper，端口 8355），Node 后端按需自动拉起，无需手动启动
- **模型**：默认 `medium`，可切 `small`（快）/ `large-v3`（最准）
- **只取音频、不占空间**（重点）：勾 **「不下载视频，只取音频转写」**——
  - B站/抖音有**独立音频流**（DASH），只拉音频，**完全不碰视频**
  - 小红书/快手只有合流，先下整片 → ffmpeg 抽音频 → **随即删掉视频**
  - 再勾 **「转写完删掉音频文件」**，则只留文字，**长期占用接近 0**
- **结果**：显示时长/字数/段数/设备，可看逐句时间轴，导出 **SRT 字幕** 或 **TXT 文本**

> 实测（B站 258 秒视频）：只取音频 4.9MB（下整片约 50-100MB）；转写完删音频 → 0 字节。

环境变量：`TRANSCRIBE_MODEL`（默认 medium）、`TRANSCRIBE_DEVICE`（默认 cuda）、`TRANSCRIBE_COMPUTE`（默认 float16）、`TRANSCRIBE_PORT`（默认 8355）。

---

## 去水印原理

下载默认走无水印源，按候选链自动降级：

| 平台 | 无水印方式 |
|---|---|
| 抖音 | ① `aweme/v1/play` 接口（302 到无水印 CDN，需登录态）→ ② `playwm→play` 地址替换 → ③ 最高码率 `bit_rate` 流 → ④ 原始地址兜底 |
| 快手 | web 端 `photoUrl` 本身无水印，h265/manifest 作备用源 |
| 小红书 | `master_url` 本身无水印，h264/h265/av1 多档候选 |
| B站 | 无水印概念，DASH 流合成本身干净 |

候选链在采集/详情时生成，下载时按序尝试，全部失败才落 yt-dlp。若平台接口改动导致候选链失效，跑 `node scripts/probe.mjs <平台> <关键词>` 重新摸字段。

## 各平台实现方式

| 平台 | 取数方式 | 直链来源 | 登录 |
|---|---|---|---|
| 抖音 | 拦 `/aweme/v1/web/*/search/*` + DOM 兜底 | `video.play_addr.url_list` | 必须 |
| 小红书 | 拦 `/api/sns/web/v1/search/notes`，逐条进详情 | `video.media.stream.h264[0].master_url` | 必须 |
| B站 | DOM 卡片 + 详情页 `window.__playinfo__` | DASH 视频流 + 音频流，ffmpeg 合并 | 可选（登录后画质更高） |
| 快手 | 拦 `/graphql`（visionSearchPhoto）+ DOM 兜底 | `photoUrl` / `photoH265Url` | 必须 |

**B站下载的三个坑（已内置处理）**：

1. yt-dlp 已失效（`Unable to extract initial state`），改从 `__playinfo__` 自取 DASH 流
2. CDN 硬规则：不带 `Range` 头一律 567；缺 `sec-fetch-*` 也 567 —— 下载器已按浏览器头 + Range 处理
3. 直链带 `deadline`，故每次下载前现取，不落库存旧链

---

## 外部接入（给其它软件用）

内置浏览器本质是一个**带登录态的自动化浏览器内核**，本机其它软件可通过 HTTP API 调用（仅监听 `127.0.0.1`）。完整清单：`GET http://127.0.0.1:8343/api/docs`

**① 拉模式**（发任务后轮询）：

```
POST /api/jobs        {platform:"bilibili", keywords:["夜景"], target:30}  → {jobIds}
GET  /api/jobs?id=xxx                                                       → 轮询状态
GET  /api/items?keyword=夜景&platform=bilibili                              → 取结果
POST /api/download    {ids:[...]} → {taskId} → 轮询 /api/download/task?id=
```

文案/评论/AI 同理：`POST /api/copy/jobs` → `GET /api/copies` / `GET /api/comments`；`POST /api/ai/run`。
转写：`POST /api/transcribe` → 轮询 `/api/transcribe/task?id=`（支持 `audioOnly` 只取音频）。

**② 推模式（Webhook）**：设置里配「Webhook 通知地址」，事件主动 POST：

| 事件 | 时机 |
|---|---|
| `collect.done` | 视频采集完成 |
| `collect.need_human` | 需要人工登录/过验证 |
| `collect.error` | 采集失败 |
| `copy.done` / `copy.error` | 文案（含评论）任务结束 |
| `download.done` | 批量下载结束 |
| `transcribe.done` | 转写任务结束 |

Header 带 `X-Collector-Event`，Body 为 JSON。

**自动化原语**：

```
POST /api/automation/eval   {url?, script}   打开页面执行 JS，返回结果
GET  /api/automation/cookies?domain=douyin.com   导出登录 cookie（本机自用）
GET  /api/automation/status   内核是否空闲（忙时返回 409 BUSY）
```

---

## 设置

| 项 | 默认 | 说明 |
|---|---|---|
| 下载目录 | `~/MaterialCollector` | 按 平台/关键词 自动建子目录；可在设置里改 |
| 并发下载数 | 3 | 最高 6 |
| 默认条数 | 50 | 每个关键词 |
| 滚动间隔 | 800–1800ms | 随机延迟，调大更安全 |

配置持久化在 `data/settings.json`。

## 项目结构

```
material-collector/
├─ electron-main.cjs         Electron 主进程（建窗口、装配宿主）
├─ server.mjs                后端 API（与界面同源；可独立跑纯后端）
├─ lib/
│  ├─ electron-host.mjs      内嵌浏览器宿主（面板控制 / 登录检测 / 采集会话）
│  ├─ collector.mjs          采集引擎（翻页/去重/风控暂停）
│  ├─ downloader.mjs         下载器（直链/DASH/ffmpeg 合并/旁车/只取音频）
│  ├─ db.mjs                 SQLite 素材库
│  ├─ db-copies.mjs          文案/评论/AI 结果表
│  ├─ transcribe.mjs         视频转写后端（数据层/服务客户端/取音频/批量任务/API）
│  ├─ copy-api.mjs           文案·评论与 AI 加工 API
│  ├─ login-guard.mjs        登录态备份/恢复/翻转检测
│  ├─ detail.mjs             单条详情补全
│  ├─ captcha.mjs            验证码探测与缺口参考（仅辅助）
│  ├─ cdp.mjs                CDP 客户端
│  └─ adapters/              四平台适配器
├─ web/                      界面（含内嵌浏览器面板）
├─ scripts/
│  ├─ transcribe_server.py   本地转写服务（faster-whisper + CUDA）
│  ├─ probe.mjs              平台接口探针（改版时重新摸字段）
│  ├─ e2e.mjs                端到端测试
│  └─ bili-comment-script.js B站评论 wbi 签名采集脚本
├─ data/                     数据库与设置（gitignore）
└─ profile-electron/         登录态（gitignore）
```

## 边界

- 只采集**当前账号能正常访问**的公开内容
- **不破解签名、不逆向 App 接口、不绕过登录**
- 验证码必须人工处理，工具只负责暂停与恢复
- 短时间大量采集可能触发风控，出现验证码属正常

## 免责声明

本项目仅供**个人学习、技术研究与自有素材整理**使用。

- 使用者应自行确保其行为符合目标平台的服务条款及所在地区法律法规
- 请勿用于批量抓取、商业爬取、绕过付费/版权保护或任何侵犯他人权益的用途
- 通过本项目获取的任何内容，其版权归原作者所有
- 作者不对因使用本项目产生的任何直接或间接损失负责

**若不同意上述条款，请勿使用本项目。**

## License

MIT License

Copyright (c) 2026 Material Collector contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
