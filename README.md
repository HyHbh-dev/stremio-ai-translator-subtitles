# Stremio AI 字幕翻译插件

使用大模型（LLM）自动为没有中文字幕的影视翻译字幕。支持 OpenAI、DeepSeek、Moonshot、通义千问等 OpenAI 兼容接口。

## 工作原理

```
Stremio 播放影视
    ↓
插件拦截字幕请求
    ↓
从 OpenSubtitles 获取英文字幕（三条通道自动降级）
    ↓
批量发送给大模型翻译为中文
    ↓
返回翻译后的 VTT 字幕给 Stremio
    ↓
播放器加载中文字幕，开始观看
```

## 快速开始

### 1. 安装 Node.js

需要 Node.js 16+，从 [nodejs.org](https://nodejs.org) 下载安装。

### 2. 安装依赖

```bash
cd stremio-ai-translator-subtitles
npm install
```

### 3. 配置

`.env` 里填的是**服务端默认值**，可以全部留空——装到 Stremio 时在 `/configure` 页面填写即可（见第 6 步）。

```bash
cp .env.example .env
```

关键的两项：

| 配置项 | 说明 | 获取方式 |
|--------|------|----------|
| `LLM_API_KEY` | 大模型 API Key（本地 Magpie 不需要） | [DeepSeek](https://platform.deepseek.com/) / [OpenAI](https://platform.openai.com/) 等平台获取 |
| `OPENSUBTITLES_API_KEY` | OpenSubtitles API Key，**可留空** | [opensubtitles.com](https://www.opensubtitles.com/consumers) 注册获取 |

> OpenSubtitles 的 Key 不是必填项：留空时字幕源会自动走免 Key 通道（见下方「字幕源」）。

> `/configure` 页面里填写的值会写进安装链接，优先级高于 `.env`。

完整配置项说明：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `PORT` | 7000 | 服务端口 |
| `LLM_API_KEY` | - | 大模型 API Key（本地 Magpie 可留空） |
| `LLM_BASE_URL` | https://api.deepseek.com/v1 | API 基础地址 |
| `LLM_MODEL` | deepseek-chat | 模型名称 |
| `TARGET_LANG` | zh | 翻译目标语言 |
| `SOURCE_LANG` | en | 源字幕语言 |
| `SUBTITLE_SOURCE` | auto | 字幕源：`auto` / `rest` / `legacy` / `cdn`，见下方说明 |
| `OPENSUBTITLES_API_KEY` | - | 新版 REST 接口的 Key（可选） |
| `OPENSUBTITLES_BASE_URL` | https://api.opensubtitles.com/api/v1 | 新版接口地址（一般不用改，便于走自建代理） |
| `OPENSUBTITLES_LEGACY_URL` | https://api.opensubtitles.org/xml-rpc | 旧版 XML-RPC 接口地址 |
| `OPENSUBTITLES_USERNAME` / `OPENSUBTITLES_PASSWORD` | - | 旧接口下载需要账号，匿名只能拿到占位字幕 |
| `STREMIO_CDN_URL` | https://opensubtitles-v3.strem.io | 官方插件的 CDN 地址（免 Key 兜底通道） |
| `OPENSUBTITLES_USER_AGENT` | StremioAITranslator v1.0 | 用户代理标识 |
| `TRANSLATE_BATCH_SIZE` | 30 | 每批发送给大模型的字幕条数 |
| `CACHE_TTL_HOURS` | 24 | 缓存过期时间 (小时) |
| `PUBLIC_URL` | - | 对外访问地址，如 `https://sub.example.com`；不填则自动使用请求的 Host |

### 字幕源说明

OpenSubtitles 有不止一套接口，配额差别很大：

| 源 | 需要什么 | 配额 | 说明 |
|----|----------|------|------|
| `rest` | API Key | 匿名 5 次/天下载 | 官方新版接口，最稳定 |
| `legacy` | 账号（Key 不需要） | 按账号计算，宽松 | 匿名可搜索，但**下载只会返回 VIP 占位字幕**，所以没账号时自动跳过 |
| `cdn` | 什么都不需要 | 无限制 | Stremio 官方插件自己的接口，字幕直接从它的 CDN 取，配额由官方承担 |
| `auto` | - | - | 按 `rest` → `legacy` → `cdn` 顺序尝试，任一成功即返回（默认） |

想完全不管配额，用默认的 `auto` 或直接选 `cdn` 即可。`cdn` 是借用 Stremio 官方服务，稳定性不由本项目控制，长期使用建议配自己的 Key。

### 4. 支持的大模型

只需修改 `LLM_BASE_URL` 和 `LLM_MODEL` 即可切换：

#### 推荐：B站 Index-Translate（专业翻译模型，效果最佳）

[Index-Translate](https://huggingface.co/bili-translate) 是哔哩哔哩开源的多语言翻译模型，基于 Qwen3.5 构建，支持 150 种语言，专为翻译优化。

配合 [Magpie](https://github.com/66hxhx/magpie) 本地部署后，无需 API Key、无需联网、翻译速度快：

| 配置项 | 值 |
|--------|------|
| `LLM_BASE_URL` | `http://127.0.0.1:3425/v1` |
| `LLM_MODEL` | `bili-translate/Index-Translate-9B` (均衡推荐) |

可选模型规格：
- `bili-translate/Index-Translate-2B` — 最快，低显存可用 (6GB)
- `bili-translate/Index-Translate-9B` — 均衡，翻译质量好 (推荐)
- `bili-translate/Index-Translate-35B-A3B` — 效果最佳，需较高显存

#### 其他通用大模型

| 服务商 | LLM_BASE_URL | LLM_MODEL |
|--------|-------------|-----------|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Moonshot (月之暗面) | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 通义千问 (阿里) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-turbo` |
| 智谱 AI | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |

### 5. 启动插件

```bash
npm start
```

启动后会显示：

```
========================================
  AI 字幕翻译插件已启动
========================================
  服务地址:    http://localhost:7000
  Manifest:    http://localhost:7000/manifest.json
  大模型:      bili-translate/Index-Translate-9B
  翻译方向:    en → zh
  批次大小:    30 条/批
========================================

在 Stremio 中添加插件:
  stremio://http://localhost:7000/manifest.json
```

### 6. 在 Stremio 中添加插件（配置模型地址与 OpenSubtitles Key）

打开配置页：

```
http://localhost:7000/configure
```

在页面上填写：

| 字段 | 说明 |
|------|------|
| 大模型地址 | OpenAI 兼容接口，如 `http://127.0.0.1:3425/v1`（Magpie）或 `https://api.deepseek.com/v1` |
| 模型名称 | 如 `bili-translate/Index-Translate-9B`、`deepseek-chat` |
| 模型 API Key | 本地 Magpie 可留空；云端服务商需要填 |
| 字幕源 | `auto` 最省心；想完全不管配额就选「官方 CDN」 |
| OpenSubtitles API Key | 可留空，留空时自动走免 Key 通道 |
| OpenSubtitles 账号 | 只有用「旧接口」下载时才需要 |
| 源/目标语言、每批条数 | 按需调整 |

页面右侧有三个按钮：

| 按钮 | 作用 | 是否消耗配额 |
|------|------|--------------|
| 测试连接 | 分别检查大模型、新版接口、旧接口、官方 CDN 四项 | 不消耗（只查询不下载） |
| 试翻 3 条 | 真实下载一条字幕并翻译前 3 句，展示中英对照 | 消耗 1 次下载 |
| 生成安装链接 | 把配置编码进链接 | - |

先点「测试连接」确认各项状态，再点「试翻 3 条」确认整条链路通了，最后点「生成安装链接」，然后：

- 点页面上的「在 Stremio 中安装」按钮（`stremio://` 链接），或
- 把生成的 `http://localhost:7000/c/xxxx/manifest.json` 粘贴到 Stremio 的插件地址栏

> 配置全部写进安装链接里，所以同一台服务器可以装多个不同配置的实例（换模型、换 Key），互不干扰。
> 链接里包含 API Key / 账号密码，不要公开分享。
> 不填的部分会自动回落到服务端 `.env` 的配置。

**使用旧方式（只用 .env 的默认配置）也可以：**

```
stremio://localhost:7000/manifest.json
```

### 7. 使用

1. 在 Stremio 中打开一部没有中文字幕的影视
2. 播放时，插件会自动获取英文字幕并翻译为中文
3. 字幕列表中会出现「AI翻译中文字幕」选项
4. 首次翻译需要等待（取决于字幕数量和大模型速度）
5. 翻译结果会缓存 24 小时，后续播放直接使用缓存

## 项目结构

```
stremio-ai-translator-subtitles/
├── index.js                  # 插件入口 (HTTP 服务 + Stremio Addon)
├── package.json              # 项目配置
├── .env.example              # 配置模板
├── .env                      # 你的配置 (需要自己创建)
├── README.md                 # 使用说明
├── src/
│   ├── subtitleFetcher.js    # 字幕获取调度 + SRT/VTT 解析
│   ├── legacyFetcher.js      # 旧版 XML-RPC 接口（免 Key，需账号下载）
│   ├── stremioCdnFetcher.js  # 官方插件的 CDN 通道（免 Key，无限次）
│   ├── translator.js         # 大模型翻译模块 (OpenAI 兼容接口)
│   ├── addonConfig.js        # 安装链接里的配置编解码
│   ├── configurePage.js      # /configure 配置页
│   └── mediaId.js            # Stremio 内容 ID 解析 (电影 / 剧集)
└── test/                     # 测试 (Node 内置 test runner，无需额外依赖)
    ├── unit.test.js          # 解析、VTT 生成、翻译解析、占位字幕识别
    ├── e2e.test.js           # 启动插件跑完整链路（假接口 + 假大模型）
    ├── helpers/              # 测试用的假服务（REST / XML-RPC / CDN / 大模型）
    └── fixtures/             # 字幕样本
```

## 测试

```bash
npm test
```

不需要真实 API Key 和外网：测试会启动假的 OpenSubtitles（REST / XML-RPC）与假大模型服务，跑通
`/manifest.json` → `/subtitles/:type/:id.json` → `/subtitle/:id.vtt` 全链路，并覆盖：

- SRT / VTT 解析（多行字幕、CRLF、BOM、cue 标识）
- VTT 输出合法性（时间格式、正文转义）
- 多行字幕翻译结果还原（历史版本会丢第二行）
- 剧集请求是否正确携带季/集参数
- 翻译全部失败时不返回"伪装成中文"的字幕
- 重复点播命中缓存、不再消耗 OpenSubtitles 下载配额
- 三条字幕通道的搜索/下载/语言过滤，以及 auto 模式的降级顺序
- 「开通 VIP」占位字幕识别（匿名下载旧接口时会拿到 102 字节广告）

## 技术细节

### 字幕处理流程

1. **获取字幕**: 按 `SUBTITLE_SOURCE` 选择通道（新版 REST / 旧版 XML-RPC / 官方 CDN），用 IMDb ID 搜索源语言字幕；剧集分别用 `parent_imdb_id` + 季/集号（REST）或 `imdbid` + `season`/`episode`（旧接口）或 `ttxxx:季:集`（CDN）查询
2. **解析格式**: 自动检测 SRT / VTT 格式，解析时间轴和文本
3. **批量翻译**: 将字幕条目分批（默认 30 条/批），每批构建带序号的 prompt 发送给大模型
4. **格式还原**: 将翻译后的文本合并回原始时间轴，生成 VTT 格式
5. **缓存优化**: 翻译结果按内容 + 目标语言 + 模型缓存，重复播放直接返回，不会重复消耗字幕下载配额

### 翻译 Prompt 设计

```
你是一位专业的影视字幕翻译专家。请将以下字幕文本翻译成中文。

要求：
1. 保持字幕的口语化和自然表达，符合影视对话风格
2. 准确传达原文含义，不遗漏、不添加
3. 每行字幕单独翻译，保持原有的换行结构
4. 保持 [序号] 格式不变，只翻译文本内容
...

字幕文本：
[1] Hello, how are you?
[2] I'm fine, thank you.
...
```

使用 `[序号]` 格式确保翻译结果能准确映射回对应的字幕条目和时间轴。

## 常见问题

### Q: 翻译速度很慢？

A: 翻译速度取决于字幕数量和大模型响应速度。一部 2 小时的电影约有 1000-1500 条字幕，按每批 30 条计算需要 35-50 次 API 调用。可以：
- 使用响应更快的模型（如 `deepseek-chat` 或 `gpt-4o-mini`）
- 增大 `TRANSLATE_BATCH_SIZE`（但注意不要超过模型的 token 限制）
- 翻译完成后会缓存，再次播放时无需重新翻译

### Q: 翻译质量不好？

A: 可以尝试使用更强的模型（如 `gpt-4o` 或 `deepseek-chat`），或调整 `src/translator.js` 中的 prompt。

### Q: 找不到源字幕？

A: 确保影视内容有 IMDb ID，且 OpenSubtitles 上有该影视的英文字幕。部分小众内容可能没有字幕。剧集需要 OpenSubtitles 上有对应季/集的字幕。

### Q: 提示字幕下载配额用完？

A: 说明当前走的是新版 REST 接口（匿名 5 次/天）。三种解法：

1. 把 `SUBTITLE_SOURCE` 设为 `cdn`，用官方 CDN 通道，不消耗任何配额；
2. 保持默认的 `auto`，新版配额用完后自动往后降级；
3. 在 opensubtitles.com 登录后重新生成 API Key，登录态配额更高。

翻译结果会缓存 `CACHE_TTL_HOURS` 小时，同一部片重复播放不会重复下载。

### Q: 为什么 Stremio 官方 OpenSubtitles 插件可以"无限调用"？

A: 因为它不是调用新版 REST 接口，而是走了另外两条路：

1. **旧版 XML-RPC 接口**（`api.opensubtitles.org/xml-rpc`）不需要 API Key，只要带一个 User-Agent 就能登录。它的下载配额按 IP / 账号计算，比新版宽松得多。
2. **官方自建 CDN**：v3 插件返回的字幕地址是 `subs5.strem.io/.../file/<file_id>`，也就是官方事先把字幕取回来、转成 UTF-8 明文缓存到自己 CDN 上。播放时你的 Stremio 直接从官方 CDN 拉文件，根本不经过 OpenSubtitles 的下载计数。

换句话说，"无限"不是没有限制，而是**限制被官方插件自己承担了**。本项目把这条通道做成了可选的 `cdn` 源，所以也能达到同样效果，但稳定性取决于官方服务。

⚠️ 另外注意：旧接口虽然免 Key 能搜索，但**匿名下载拿到的是 102 字节的「成为 VIP」占位字幕**，不是真内容。所以用 `legacy` 源必须在配置里填 OpenSubtitles 账号，本项目会识别这种占位文件并判为失败。

### Q: 如何修改翻译的目标语言？

A: 修改 `.env` 中的 `TARGET_LANG`，如 `ja`（日语）、`ko`（韩语）等。

### Q: 插件没有出现在 Stremio 中？

A: 确保插件服务正在运行（`npm start`），且 Stremio 能访问到该地址。如果在不同设备上使用，见下方「远程访问」。

### Q: 已经设置了系统代理（HTTP_PROXY），本地 Magpie 却报 404？

A: 插件已经对 `127.0.0.1` / `localhost` 这类本机地址跳过代理，但如果你的 Magpie 部署在其他内网机器上，需要把该地址加入 `NO_PROXY`。

## 进阶配置

### 远程访问

字幕地址会根据 Stremio 请求的 Host 自动生成，**不需要再改代码**。如果你的服务前面有反向代理，可以让插件显式知道对外地址：

```bash
# .env
PUBLIC_URL=https://sub.example.com
```

也可以反向代理时透传 `X-Forwarded-Proto` / `X-Forwarded-Host`，插件会据此生成字幕地址。

### Docker 部署

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 7000
CMD ["node", "index.js"]
```

```bash
docker build -t stremio-ai-translator .
docker run -p 7000:7000 --env-file .env stremio-ai-translator
```

## License

MIT
