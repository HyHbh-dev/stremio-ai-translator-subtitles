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
 */

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const dotenv = require('dotenv');
const http = require('http');
const url = require('url');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const { fetchBestSubtitle, entriesToVTT } = require('./src/subtitleFetcher');
const { translateWithCache, cacheSize } = require('./src/translator');
const { parseMediaId } = require('./src/mediaId');

// 加载环境变量
dotenv.config();

// 配置
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

// 验证必要配置
// 注意: LLM_API_KEY 在使用本地 Magpie 服务时可以为空
const requiredConfigs = [
    { key: 'opensubtitlesApiKey', label: 'OPENSUBTITLES_API_KEY' },
];
const missingConfigs = requiredConfigs.filter(c => !config[c.key]);
if (missingConfigs.length > 0) {
    console.error('\n========================================');
    console.error('  缺少必要配置！');
    console.error('========================================');
    missingConfigs.forEach(c => {
        console.error(`  请在 .env 文件中设置: ${c.label}`);
    });
    console.error('  参考 .env.example 文件');
    console.error('========================================\n');
    process.exit(1);
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

// 保存当前请求的访问来源，用于生成绝对字幕 URL（兼容远程/反代部署）
const requestContext = new AsyncLocalStorage();

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
};

const builder = new addonBuilder(manifest);

/**
 * 字幕资源处理函数
 * Stremio 播放视频时会请求 subtitles 资源
 */
builder.defineSubtitlesHandler(async ({ id, type }) => {
    console.log(`\n[subtitlesHandler] 收到请求: id=${id}, type=${type}`);

    try {
        // id 可能是 IMDb ID 或 IMDb ID:season:episode
        const { imdbId, isSeries, season, episode } = parseMediaId(id);
        if (!/^tt\d+$/.test(imdbId)) {
            console.log(`[subtitlesHandler] 不支持的 id 格式: ${id}`);
            return { subtitles: [] };
        }

        // 构建缓存键（包含模型，切换模型时不会串用缓存）
        const cacheKey = [id, config.sourceLang, config.targetLang, config.llmModel].join('_');
        const subtitleId = `ai-${crypto
            .createHash('sha1')
            .update(cacheKey)
            .digest('hex')
            .slice(0, 16)}`;

        const buildEntry = (title) => ({
            id: subtitleId,
            url: `${getBaseUrl()}/subtitle/${subtitleId}.vtt`,
            lang: LANG_MAP[config.targetLang] || config.targetLang,
            title,
        });

        // 已有缓存时直接返回，避免重复下载源字幕（OpenSubtitles 匿名配额只有 5 次/天）
        const cachedItem = getSubtitleItem(subtitleId);
        if (cachedItem) {
            console.log(`[subtitlesHandler] 命中已有翻译结果: ${subtitleId}`);
            return { subtitles: [buildEntry(cachedItem.title)] };
        }

        // 1. 从 OpenSubtitles 获取源语言字幕
        console.log(`[subtitlesHandler] 获取 ${config.sourceLang} 源字幕...`);
        const subtitleData = await fetchBestSubtitle(imdbId, config, { season, episode });

        if (!subtitleData || !subtitleData.entries || subtitleData.entries.length === 0) {
            console.log('[subtitlesHandler] 未找到可翻译的源字幕');
            return { subtitles: [] };
        }

        console.log(`[subtitlesHandler] 获取到 ${subtitleData.entries.length} 条源字幕，开始翻译...`);

        // 2. 调用大模型翻译
        const { entries: translatedEntries, stats } = await translateWithCache(
            cacheKey,
            subtitleData.entries,
            config,
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
        const title = `AI翻译中文字幕 (${config.llmModel})${partial}`;
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
// 启动 HTTP 服务
// 同时处理 Stremio SDK 路由 + 自定义字幕文件下载
// ============================================

const server = http.createServer((req, res) => {
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

    // 健康检查端点
    if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            version: manifest.version,
            model: config.llmModel,
            targetLang: config.targetLang,
            sourceLang: config.sourceLang,
            cachedSubtitles: translationsStore.size,
            cachedTranslations: cacheSize(),
            uptime: Math.round(process.uptime()),
        }));
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
    requestContext.run({ origin: resolveOrigin(req) }, () => {
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
    console.log('\n========================================');
    console.log('  AI 字幕翻译插件已启动');
    console.log('========================================');
    console.log(`  服务地址:    http://localhost:${config.port}`);
    console.log(`  Manifest:    http://localhost:${config.port}/manifest.json`);
    console.log(`  健康检查:     http://localhost:${config.port}/health`);
    console.log(`  大模型:      ${config.llmModel}`);
    console.log(`  翻译方向:    ${config.sourceLang} → ${config.targetLang}`);
    console.log(`  批次大小:    ${config.translateBatchSize} 条/批`);
    console.log(`  字幕来源:    ${config.opensubtitlesBaseUrl}`);
    if (config.publicUrl) {
        console.log(`  对外地址:    ${config.publicUrl}`);
    }
    console.log('========================================');
    console.log('\n在 Stremio 中添加插件:');
    console.log(`  stremio://http://localhost:${config.port}/manifest.json`);
    console.log('\n或手动添加 URL:');
    console.log(`  http://localhost:${config.port}/manifest.json\n`);
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
