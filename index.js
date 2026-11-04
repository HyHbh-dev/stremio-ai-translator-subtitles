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

const { fetchBestSubtitle, entriesToVTT } = require('./src/subtitleFetcher');
const { translateWithCache } = require('./src/translator');

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
    opensubtitlesUserAgent: process.env.OPENSUBTITLES_USER_AGENT || 'StremioAITranslator v1.0',
    translateBatchSize: parseInt(process.env.TRANSLATE_BATCH_SIZE || '30', 10),
    cacheTtlHours: parseInt(process.env.CACHE_TTL_HOURS || '24', 10),
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

// 翻译结果的内存存储: subtitleId -> vttContent
const translatedSubtitlesStore = new Map();

// 语言代码映射 (ISO 639-2/B 用于 Stremio)
const LANG_MAP = {
    zh: 'chi',
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
    console.log(`\n[subtitlesHandler] 收到请求: id=${id}, type=${type}`);

    try {
        // id 可能是 IMDb ID 或 IMDb ID:season:episode
        const parts = id.split(':');
        const imdbId = parts[0];

        // 构建缓存键
        const cacheKey = `${id}_${config.sourceLang}_${config.targetLang}`;

        // 1. 从 OpenSubtitles 获取源语言字幕
        console.log(`[subtitlesHandler] 获取 ${config.sourceLang} 源字幕...`);
        const subtitleData = await fetchBestSubtitle(imdbId, config);

        if (!subtitleData || !subtitleData.entries || subtitleData.entries.length === 0) {
            console.log(`[subtitlesHandler] 未找到可翻译的源字幕`);
            return { subtitles: [] };
        }

        console.log(`[subtitlesHandler] 获取到 ${subtitleData.entries.length} 条源字幕，开始翻译...`);

        // 2. 调用大模型翻译
        const translatedEntries = await translateWithCache(
            cacheKey,
            subtitleData.entries,
            config,
            (progress) => {
                console.log(`[subtitlesHandler] 翻译进度: ${progress}%`);
            }
        );

        // 3. 生成 VTT 字幕
        const vttContent = entriesToVTT(translatedEntries);

        // 4. 存储翻译结果并生成字幕 ID
        const subtitleId = `ai-trans-${Buffer.from(id).toString('base64url').slice(0, 20)}`;
        translatedSubtitlesStore.set(subtitleId, vttContent);

        // 5. 返回字幕信息给 Stremio
        const subtitleUrl = `http://localhost:${config.port}/subtitle/${subtitleId}.vtt`;

        const subtitles = [
            {
                id: subtitleId,
                url: subtitleUrl,
                lang: LANG_MAP[config.targetLang] || config.targetLang,
                title: `AI翻译中文字幕 (${config.llmModel})`,
            },
        ];

        console.log(`[subtitlesHandler] 返回 ${subtitles.length} 条翻译字幕`);
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
            version: '1.0.0',
            model: config.llmModel,
            targetLang: config.targetLang,
            sourceLang: config.sourceLang,
            cachedSubtitles: translatedSubtitlesStore.size,
        }));
        return;
    }

    // 字幕文件下载端点 (VTT)
    if (path.startsWith('/subtitle/') && path.endsWith('.vtt')) {
        const subtitleId = path.replace('/subtitle/', '').replace('.vtt', '');

        const vttContent = translatedSubtitlesStore.get(subtitleId);
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
    router(req, res, () => {
        // 未匹配的路由返回 404
        if (!res.headersSent) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
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
    console.log('========================================');
    console.log('\n在 Stremio 中添加插件:');
    console.log(`  stremio://http://localhost:${config.port}/manifest.json`);
    console.log('\n或手动添加 URL:');
    console.log(`  http://localhost:${config.port}/manifest.json\n`);
});
