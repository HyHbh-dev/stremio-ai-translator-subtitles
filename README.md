# Stremio AI 字幕翻译插件

使用大模型（LLM）自动为没有中文字幕的影视翻译字幕。支持 OpenAI、DeepSeek、Moonshot、通义千问等 OpenAI 兼容接口。

## 工作原理

```
Stremio 播放影视
    ↓
插件拦截字幕请求
    ↓
从 OpenSubtitles 获取英文字幕
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

复制 `.env.example` 为 `.env`，填写配置：

```bash
cp .env.example .env
```

必须配置的两项：

| 配置项 | 说明 | 获取方式 |
|--------|------|----------|
| `LLM_API_KEY` | 大模型 API Key | [DeepSeek](https://platform.deepseek.com/) / [OpenAI](https://platform.openai.com/) 等平台获取 |
| `OPENSUBTITLES_API_KEY` | OpenSubtitles API Key | [opensubtitles.com](https://www.opensubtitles.com/consumers) 注册获取 |

完整配置项说明：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `PORT` | 7000 | 服务端口 |
| `LLM_API_KEY` | - | 大模型 API Key (必填) |
| `LLM_BASE_URL` | https://api.deepseek.com/v1 | API 基础地址 |
| `LLM_MODEL` | deepseek-chat | 模型名称 |
| `TARGET_LANG` | zh | 翻译目标语言 |
| `SOURCE_LANG` | en | 源字幕语言 |
| `OPENSUBTITLES_API_KEY` | - | OpenSubtitles API Key (必填) |
| `OPENSUBTITLES_BASE_URL` | https://api.opensubtitles.com/api/v1 | OpenSubtitles 接口地址（一般不用改，便于走自建代理） |
| `OPENSUBTITLES_USER_AGENT` | StremioAITranslator v1.0 | OpenSubtitles 用户代理标识 |
| `TRANSLATE_BATCH_SIZE` | 30 | 每批发送给大模型的字幕条数 |
| `CACHE_TTL_HOURS` | 24 | 缓存过期时间 (小时) |
| `PUBLIC_URL` | - | 对外访问地址，如 `https://sub.example.com`；不填则自动使用请求的 Host |

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

### 6. 在 Stremio 中添加插件

**方式一（点击链接）：**

将以下链接复制到浏览器地址栏打开：

```
stremio://http://localhost:7000/manifest.json
```

**方式二（手动添加）：**

1. 打开 Stremio
2. 点击右上角「插件」图标（拼图图标）
3. 在地址栏输入：`http://localhost:7000/manifest.json`
4. 按 Enter，点击「Install」

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
│   ├── subtitleFetcher.js    # 字幕获取与解析 (OpenSubtitles API)
│   ├── translator.js         # 大模型翻译模块 (OpenAI 兼容接口)
│   └── mediaId.js            # Stremio 内容 ID 解析 (电影 / 剧集)
└── test/                     # 测试 (Node 内置 test runner，无需额外依赖)
    ├── unit.test.js          # 解析、VTT 生成、翻译结果解析
    ├── e2e.test.js           # 启动插件跑完整链路 (假 OpenSubtitles + 假大模型)
    ├── helpers/              # 测试用的假服务
    └── fixtures/             # 字幕样本
```

## 测试

```bash
npm test
```

不需要真实 API Key 和外网：测试会启动假的 OpenSubtitles 与大模型服务，跑通
`/manifest.json` → `/subtitles/:type/:id.json` → `/subtitle/:id.vtt` 全链路，并覆盖：

- SRT / VTT 解析（多行字幕、CRLF、BOM、cue 标识）
- VTT 输出合法性（时间格式、正文转义）
- 多行字幕翻译结果还原（历史版本会丢第二行）
- 剧集请求是否正确携带季/集参数
- 翻译全部失败时不返回"伪装成中文"的字幕
- 重复点播命中缓存、不再消耗 OpenSubtitles 下载配额

## 技术细节

### 字幕处理流程

1. **获取字幕**: 通过 IMDb ID 调用 OpenSubtitles API 搜索源语言字幕；剧集使用 `parent_imdb_id` + 季/集号查询
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

A: OpenSubtitles 匿名接口每天只有 5 次下载配额（免费账号 10 次/天，VIP 更高）。翻译结果会缓存 `CACHE_TTL_HOURS` 小时，同一部片重复播放不会重复下载。如需更多配额，请在 `.env` 中配置 OpenSubtitles 账号（登录后配额更高）。

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
