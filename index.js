/**
 * index.js
 * Stremio AI Translator Subtitles Addon
 *
 * 功能：当影视没有中文字幕时，通过大模型将英文字幕翻译为中文
 *
 * 工作流程：
 *   1. Stremio 请求字幕 → addon 定义 subtitles 资源
 *   2. 从 OpenSubtitles 获取源语言字幕
 *   3. 调用大模型 API 翻译字幕
 *   4. 返回翻译后的 VTT 字幕流 URL
 *
 * 配置方式：
 *   - 服务端 .env（默认值）
 *   - /configure 页面生成的安装链接（/c/<config>/manifest.json），优先于 .env
 */

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const dotenv = require('dotenv');
const http = require('http');
const url = require('url');
const crypto = require('crypto');
const axios = require('axios');
const { AsyncLocalStorage } = require('async_hooks');

const { fetchBestSubtitle, entriesToVTT } = require('./src/subtitleFetcher');
const { translateWithCache, cacheSize } = require('./src/translator');
const { parseMediaId } = require('./src/mediaId');
const { decodeConfig, mergeConfig, configHash, buildManifest } = require('./src/addonConfig');
const { renderConfigurePage } = require('./src/configurePage');

// 加载环境变量
dotenv.config();

// 服务端默认配置（可被安装链接里的配置覆盖）
const config = {
    port: parseInt(process.env.PORT || '7000', 10),
    llmApiKey: process.env.LLM_API_KEY || '',
    llmBaseUrl: process.env.LLM_BASE_URL || 'http://127.0.0.1:3425/v1',
    llmModel: process.env.LLM_MODEL || 'bili-translate/Index-Translate-9B',
    targetLang: process.env.TARGET_LANG || 'zh',
    sourceLang: process.env.SOURCE_LANG || 'en',
    opensubtitlesApiKey: process.env.OPENSUBTITLES_API_KEY || '',
    opensubtitlesBaseUrl: process.env.OPENSUBTITLES_BASE_URL || 'https://api.opensubtitles.com/api/v1',
    opensubtitlesUserAgent: process.env.OPENSUBTITLES_USER_AGENT || 'StremioAITranslator v1.0',
    translateBatchSize: parseInt(process.env.TRANSLATE_BATCH_SIZE || '30', 10),
    cacheTtlHours: parseInt(process.env.CACHE_TTL_HOURS || '24', 10),
    // 反向代理 / 远程部署时，用于生成对外可访问的字幕地址
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
};

// 缺少 OpenSubtitles Key 时不再直接退出——用户可以在 /configure 页面里填写
if (!config.opensubtitlesApiKey) {
    console.warn('\n[警告] 未配置 OPENSUBTITLES_API_KEY。');
    console.warn('       打开 http://localhost:' + config.port + '/configure 填写后安装；');
    console.warn('       或在 .env 中配置后重启。\n');
}

// ============================================
// 字幕存储（带过期时间，避免长期运行内存膨胀）
// ============================================

const translationsStore = new Map(); // subtitleId -> { content, title, expiresAt }
const STORE_TTL_MS = Math.max(1, config.cacheTtlHours) * 60 * 60 * 1000;

function storeSubtitle(subtitleId, content, title) {
    translationsStore.set(subtitleId, { content, title, expiresAt: Date.now() + STORE_TTL_MS });
}

function getSubtitleItem(subtitleId) {
    const item = translationsStore.get(subtitleId);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
        translationsStore.delete(subtitleId);
        return null;
    }
    return item;
}

function getSubtitle(subtitleId) {
    const item = getSubtitleItem(subtitleId);
    return item ? item.content : null;
}

function sweepExpired() {
    const now = Date.now();
    for (const [key, item] of translationsStore) {
        if (item.expiresAt <= now) translationsStore.delete(key);
    }
}

const sweepTimer = setInterval(sweepExpired, 10 * 60 * 1000);
sweepTimer.unref();

// 保存当前请求的访问来源与配置（用于安装链接带来的独立配置）
const requestContext = new AsyncLocalStorage();

/**
 * 当前请求生效的配置：链接配置 > 服务端 .env
 */
function getConfig() {
    const store = requestContext.getStore();
    return (store && store.config) || config;
}

function resolveOrigin(req) {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
        || (req.socket && req.socket.encrypted ? 'https' : 'http');
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || req.headers.host;
    return host ? `${proto}://${host}` : null;
}

function getBaseUrl() {
    if (config.publicUrl) return config.publicUrl;
    const store = requestContext.getStore();
    if (store && store.origin) return store.origin;
    return `http://localhost:${config.port}`;
}

// 语言代码映射 (ISO 639-2/B 用于 Stremio)
const LANG_MAP = {
    zh: 'chi',
    'zh-tw': 'chi',
    en: 'eng',
    ja: 'jpn',
    ko: 'kor',
    fr: 'fre',
    de: 'ger',
    es: 'spa',
};

// ============================================
// 创建 Stremio Addon
// ============================================

const manifest = {
    id: 'org.ai-translator.subtitles',
    version: '1.0.0',
    name: 'AI 字幕翻译',
    description: '使用大模型自动翻译字幕为中文，让没有中文字幕的影视也能看懂',
    logo: 'https://fonts.gstatic.com/s/i/materialicons/translate/v16/translate_24px.svg',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: {
        configurable: true,
        configurationRequired: false,
    },
};

const builder = new addonBuilder(manifest);

/**
 * 字幕资源处理函数
 * Stremio 播放视频时会请求 subtitles 资源
 */
builder.defineSubtitlesHandler(async ({ id, type }) => {
    const cfg = getConfig();
    console.log(`\n[subtitlesHandler] 收到请求: id=${id}, type=${type}, model=${cfg.llmModel}`);

    try {
        // id 可能是 IMDb ID 或 IMDb ID:season:episode
        const { imdbId, season, episode } = parseMediaId(id);
        if (!/^tt\d+$/.test(imdbId)) {
            console.log(`[subtitlesHandler] 不支持的 id 格式: ${id}`);
            return { subtitles: [] };
        }

        if (!cfg.opensubtitlesApiKey) {
            console.error('[subtitlesHandler] 未配置 OpenSubtitles API Key，请在 /configure 页面填写');
            return { subtitles: [] };
        }

        // 构建缓存键（包含模型与配置指纹，不同安装实例不会串用缓存）
        const cacheKey = [
            id,
            cfg.sourceLang,
            cfg.targetLang,
            cfg.llmModel,
            configHash(cfg).slice(0, 8),
        ].join('_');
        const subtitleId = `ai-${crypto
            .createHash('sha1')
            .update(cacheKey)
            .digest('hex')
            .slice(0, 16)}`;

        const buildEntry = (title) => ({
            id: subtitleId,
            url: `${getBaseUrl()}/subtitle/${subtitleId}.vtt`,
            lang: LANG_MAP[cfg.targetLang] || cfg.targetLang,
            title,
        });

        // 已有缓存时直接返回，避免重复下载源字幕（OpenSubtitles 匿名配额只有 5 次/天）
        const cachedItem = getSubtitleItem(subtitleId);
        if (cachedItem) {
            console.log(`[subtitlesHandler] 命中已有翻译结果: ${subtitleId}`);
            return { subtitles: [buildEntry(cachedItem.title)] };
        }

        // 1. 从 OpenSubtitles 获取源语言字幕
        console.log(`[subtitlesHandler] 获取 ${cfg.sourceLang} 源字幕...`);
        const subtitleData = await fetchBestSubtitle(imdbId, cfg, { season, episode });

        if (!subtitleData || !subtitleData.entries || subtitleData.entries.length === 0) {
            console.log('[subtitlesHandler] 未找到可翻译的源字幕');
            return { subtitles: [] };
        }

        console.log(`[subtitlesHandler] 获取到 ${subtitleData.entries.length} 条源字幕，开始翻译...`);

        // 2. 调用大模型翻译
        const { entries: translatedEntries, stats } = await translateWithCache(
            cacheKey,
            subtitleData.entries,
            cfg,
            (progress) => {
                console.log(`[subtitlesHandler] 翻译进度: ${progress}%`);
            }
        );

        // 整条字幕一条都没翻译成功时，不要假装"已翻译"（否则用户会看到英文字幕被标成 AI 中文字幕）
        if (stats.translated === 0) {
            console.error('[subtitlesHandler] 所有批次翻译均失败，返回空字幕列表');
            return { subtitles: [] };
        }

        // 3. 生成 VTT 字幕
        const vttContent = entriesToVTT(translatedEntries);

        // 4. 存储翻译结果
        const partial = stats.fallback > 0
            ? ` · ${stats.fallback}/${stats.total} 条未翻译`
            : '';
        const title = `AI翻译中文字幕 (${cfg.llmModel})${partial}`;
        storeSubtitle(subtitleId, vttContent, title);

        // 5. 返回字幕信息给 Stremio
        const subtitles = [buildEntry(title)];

        console.log(`[subtitlesHandler] 返回 ${subtitles.length} 条翻译字幕: ${subtitles[0].url}`);
        return { subtitles };
    } catch (error) {
        console.error(`[subtitlesHandler] 处理失败: ${error.message}`);
        return { subtitles: [] };
    }
});

// 构建接口和路由器 (处理 Stremio 标准请求: /manifest.json, /subtitles/...)
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);

// ============================================
// 配置检测接口
// ============================================

function isLoopbackHost(baseUrl) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(baseUrl);
}

function axiosOptions(cfg, timeout) {
    return {
        timeout,
        proxy: isLoopbackHost(cfg.llmBaseUrl || '') ? false : undefined,
    };
}

/**
 * 检查大模型接口是否可用
 */
async function testLLM(cfg) {
    const base = String(cfg.llmBaseUrl || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) {
        return { ok: false, message: '模型地址需要以 http:// 或 https:// 开头' };
    }

    try {
        const headers = {};
        if (cfg.llmApiKey) headers['Authorization'] = `Bearer ${cfg.llmApiKey}`;
        const res = await axios.get(`${base}/models`, { headers, ...axiosOptions(cfg, 8000) });
        const models = (res.data && Array.isArray(res.data.data)) ? res.data.data.map((m) => m.id) : [];
        if (!models.length) {
            return { ok: true, message: '接口可访问，但没读到模型列表' };
        }
        if (cfg.llmModel && !models.includes(cfg.llmModel)) {
            return { ok: false, message: `接口可访问，但模型列表里没有 ${cfg.llmModel}` };
        }
        return { ok: true, message: `${models.length} 个模型可用` };
    } catch (error) {
        const status = error.response && error.response.status;
        if (status === 401 || status === 403) {
            return { ok: false, message: 'API Key 无效或没有权限' };
        }
        return { ok: false, message: `无法连接（${error.message}）` };
    }
}

/**
 * 检查 OpenSubtitles Key 是否可用（只查询不下载，不消耗配额）
 */
async function testOpenSubtitles(cfg) {
    if (!cfg.opensubtitlesApiKey) {
        return { ok: false, message: '未填写 API Key' };
    }

    const base = String(cfg.opensubtitlesBaseUrl || 'https://api.opensubtitles.com/api/v1').replace(/\/+$/, '');
    try {
        const res = await axios.get(`${base}/subtitles`, {
            params: { imdb_id: '0111161', languages: 'en' },
            headers: {
                'Api-Key': cfg.opensubtitlesApiKey,
                'User-Agent': cfg.opensubtitlesUserAgent || 'StremioAITranslator v1.0',
                'Accept': 'application/json',
            },
            maxRedirects: 5,
            timeout: 10000,
            proxy: isLoopbackHost(base) ? false : undefined,
        });
        const count = (res.data && res.data.data && res.data.data.length) || 0;
        if (!count) {
            return { ok: true, message: 'Key 有效，但示例影片没查到字幕' };
        }
        return { ok: true, message: `Key 有效（示例查询到 ${count} 条字幕）` };
    } catch (error) {
        const status = error.response && error.response.status;
        if (status === 401 || status === 403) {
            return { ok: false, message: 'API Key 无效' };
        }
        if (status === 404) {
            return { ok: false, message: '接口地址不对，应为 /api/v1' };
        }
        return { ok: false, message: `请求失败（${error.message}）` };
    }
}

function readJsonBody(req, limit = 16 * 1024) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > limit) body = body.slice(0, limit);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body || '{}'));
            } catch (_) {
                resolve({});
            }
        });
    });
}

// ============================================
// 启动 HTTP 服务
// 同时处理 Stremio SDK 路由 + 配置页 + 字幕文件下载
// ============================================

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const path = parsedUrl.pathname;

    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 首页 → 配置页
    if (path === '/' && req.method === 'GET') {
        res.writeHead(302, { Location: '/configure' });
        res.end();
        return;
    }

    // 配置页
    if (path === '/configure' && req.method === 'GET') {
        const html = renderConfigurePage({
            defaults: config,
            origin: config.publicUrl || resolveOrigin(req) || `http://localhost:${config.port}`,
            serverHasKeys: {
                llm: !!config.llmApiKey,
                opensubtitles: !!config.opensubtitlesApiKey,
            },
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
    }

    // 配置检测
    if (path === '/api/test-config' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const cfg = mergeConfig(config, body);
        if (body.llmBaseUrl) cfg.llmBaseUrl = body.llmBaseUrl;
        if (body.llmApiKey) cfg.llmApiKey = body.llmApiKey;
        if (body.opensubtitlesApiKey) cfg.opensubtitlesApiKey = body.opensubtitlesApiKey;

        const [llm, opensubtitles] = await Promise.all([testLLM(cfg), testOpenSubtitles(cfg)]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ llm, opensubtitles }));
        return;
    }

    // 健康检查端点
    if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            version: manifest.version,
            model: config.llmModel,
            targetLang: config.targetLang,
            sourceLang: config.sourceLang,
            configured: {
                llmApiKey: !!config.llmApiKey,
                opensubtitles: !!config.opensubtitlesApiKey,
            },
            cachedSubtitles: translationsStore.size,
            cachedTranslations: cacheSize(),
            uptime: Math.round(process.uptime()),
        }));
        return;
    }

    // 带配置的安装链接: /c/<config>/manifest.json 与 /c/<config>/subtitles/...
    const configRoute = path.match(/^\/c\/([A-Za-z0-9_-]+)\/(manifest\.json|configure|subtitles\/.+)$/);
    if (configRoute) {
        const override = decodeConfig(configRoute[1]);
        if (!override) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('配置解析失败，请回到 /configure 重新生成安装链接');
            return;
        }

        const cfg = mergeConfig(config, override);

        // Stremio 会在 manifest 同级打开 configure，这里引导回配置页
        if (configRoute[2] === 'configure') {
            res.writeHead(302, { Location: '/configure' });
            res.end();
            return;
        }

        if (configRoute[2] === 'manifest.json') {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify(buildManifest(manifest, cfg)));
            return;
        }

        // 交给 Stremio SDK 路由处理（去掉 /c/<config> 前缀）
        req.url = `/${configRoute[2]}${parsedUrl.search || ''}`;
        requestContext.run({ origin: resolveOrigin(req), config: cfg }, () => {
            router(req, res, () => {
                if (!res.headersSent) {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                }
            });
        });
        return;
    }

    // 字幕文件下载端点 (VTT)
    if (path.startsWith('/subtitle/') && path.endsWith('.vtt')) {
        const subtitleId = path.replace('/subtitle/', '').replace('.vtt', '');

        const vttContent = getSubtitle(subtitleId);
        if (vttContent) {
            res.writeHead(200, {
                'Content-Type': 'text/vtt; charset=utf-8',
                'Cache-Control': 'public, max-age=86400',
            });
            res.end(vttContent);
            console.log(`[http] 返回字幕: ${subtitleId} (${vttContent.length} bytes)`);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Subtitle not found');
            console.log(`[http] 字幕未找到: ${subtitleId}`);
        }
        return;
    }

    // 其他请求交给 Stremio SDK 路由处理
    // 包括: /manifest.json, /subtitles/:type/:id.json 等
    requestContext.run({ origin: resolveOrigin(req), config }, () => {
        router(req, res, () => {
            // 未匹配的路由返回 404
            if (!res.headersSent) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            }
        });
    });
});

server.listen(config.port, () => {
    const baseUrl = config.publicUrl || `http://localhost:${config.port}`;
    console.log('\n========================================');
    console.log('  AI 字幕翻译插件已启动');
    console.log('========================================');
    console.log(`  服务地址:    http://localhost:${config.port}`);
    console.log(`  配置页面:    ${baseUrl}/configure`);
    console.log(`  Manifest:    http://localhost:${config.port}/manifest.json`);
    console.log(`  健康检查:     http://localhost:${config.port}/health`);
    console.log(`  大模型:      ${config.llmModel}`);
    console.log(`  翻译方向:    ${config.sourceLang} → ${config.targetLang}`);
    console.log(`  批次大小:    ${config.translateBatchSize} 条/批`);
    console.log(`  字幕来源:    ${config.opensubtitlesBaseUrl}`);
    console.log('========================================');
    console.log('\n安装方式（推荐）：');
    console.log(`  1. 打开 ${baseUrl}/configure 填写模型地址与 OpenSubtitles Key`);
    console.log('  2. 点「生成安装链接」，再点「在 Stremio 中安装」');
    console.log('\n或直接用服务端 .env 配置的默认值安装:');
    console.log(`  stremio://localhost:${config.port}/manifest.json\n`);
});

// 优雅退出
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        console.log(`\n收到 ${signal}，正在关闭服务...`);
        clearInterval(sweepTimer);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
