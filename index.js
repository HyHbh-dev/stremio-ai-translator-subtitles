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
const { translateWithCache, translateBatch, cacheSize, getProgressSnapshot } = require('./src/translator');
const { parseMediaId } = require('./src/mediaId');
const { decodeConfig, mergeConfig, configHash, buildManifest } = require('./src/addonConfig');
const { renderConfigurePage } = require('./src/configurePage');
const { probeLegacy } = require('./src/legacyFetcher');
const { probeCdn } = require('./src/stremioCdnFetcher');

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
    opensubtitlesLegacyUrl: process.env.OPENSUBTITLES_LEGACY_URL || 'https://api.opensubtitles.org/xml-rpc',
    opensubtitlesUsername: process.env.OPENSUBTITLES_USERNAME || '',
    opensubtitlesPassword: process.env.OPENSUBTITLES_PASSWORD || '',
    stremioCdnUrl: process.env.STREMIO_CDN_URL || 'https://opensubtitles-v3.strem.io',
    opensubtitlesUserAgent: process.env.OPENSUBTITLES_USER_AGENT || 'StremioAITranslator v1.0',
    // 字幕源：auto = 新版 → 旧版 → 官方 CDN 依次尝试；rest / legacy / cdn = 只用指定通道
    subtitleSource: process.env.SUBTITLE_SOURCE || 'auto',
    translateBatchSize: parseInt(process.env.TRANSLATE_BATCH_SIZE || '30', 10),
    // 第一批单独用小批量，换取更快的「首段中文」（其余批次按 TRANSLATE_BATCH_SIZE）
    firstBatchSize: parseInt(process.env.FIRST_BATCH_SIZE || '12', 10),
    // 同时向大模型发多少批。串行翻译一整部片要几分钟，Stremio 等不了
    translateConcurrency: parseInt(process.env.TRANSLATE_CONCURRENCY || '4', 10),
    // 字幕接口最多等多久（毫秒）再先把已翻好的部分返回
    firstResponseWaitMs: parseInt(process.env.FIRST_RESPONSE_WAIT_MS || '8000', 10),
    cacheTtlHours: parseInt(process.env.CACHE_TTL_HOURS || '24', 10),
    // 反向代理 / 远程部署时，用于生成对外可访问的字幕地址
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
};

// 只有强制走新版接口时才必须配 Key；旧接口不需要 Key
if (!config.opensubtitlesApiKey && config.subtitleSource !== 'legacy') {
    console.warn('\n[提示] 未配置 OPENSUBTITLES_API_KEY。');
    console.warn('       默认会用免 Key 的旧接口抓字幕；如想用新版接口，');
    console.warn('       打开 http://localhost:' + config.port + '/configure 填写后安装。\n');
}

// ============================================
// 字幕存储（带过期时间，避免长期运行内存膨胀）
// ============================================

const translationsStore = new Map(); // subtitleId -> { content, title, expiresAt }
const STORE_TTL_MS = Math.max(1, config.cacheTtlHours) * 60 * 60 * 1000;

function storeSubtitle(subtitleId, content, title, extra = {}) {
    translationsStore.set(subtitleId, {
        content,
        title,
        expiresAt: Date.now() + STORE_TTL_MS,
        ...extra,
    });
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

/**
 * 等「任意一批翻好」或超时，谁先到返回谁。
 * 用于尽量早地把第一段中文字幕交出去，而不是干等固定时长。
 */
async function firstProgressSignal(cacheKey, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (getProgressSnapshot(cacheKey).length > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return getProgressSnapshot(cacheKey).length > 0;
}

/**
 * 等第一批译文产出，最多等 timeoutMs。
 * Stremio 请求字幕有超时，但如果一条译文都没有就返回，用户那边是什么都看不到，
 * 所以宁可再等一会儿，先给出一段中文字幕。
 */
async function waitUntilFirstProgress(cacheKey, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (getProgressSnapshot(cacheKey).length > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return getProgressSnapshot(cacheKey).length > 0;
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

        if (!cfg.opensubtitlesApiKey && (cfg.subtitleSource === 'rest')) {
            console.error('[subtitlesHandler] 字幕源设为「仅新版接口」但未配置 Api-Key');
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

        // 已完整翻译过：直接返回，避免重复下载源字幕（OpenSubtitles 匿名配额只有 5 次/天）
        const cachedItem = getSubtitleItem(subtitleId);
        if (cachedItem && cachedItem.final) {
            console.log(`[subtitlesHandler] 命中已有翻译结果: ${subtitleId}`);
            return { subtitles: [buildEntry(cachedItem.title)] };
        }

        // 上次只返回了部分结果时，源字幕已经抓过，直接复用，不再消耗下载配额
        let sourceEntries = cachedItem && Array.isArray(cachedItem.entries) ? cachedItem.entries : null;

        if (sourceEntries) {
            console.log(`[subtitlesHandler] 复用已抓取的 ${sourceEntries.length} 条源字幕，继续翻译`);
        } else {
            // 1. 从 OpenSubtitles 获取源语言字幕
            console.log(`[subtitlesHandler] 获取 ${cfg.sourceLang} 源字幕...`);
            const subtitleData = await fetchBestSubtitle(imdbId, cfg, { season, episode });

            if (!subtitleData || !subtitleData.entries || subtitleData.entries.length === 0) {
                console.log('[subtitlesHandler] 未找到可翻译的源字幕');
                return { subtitles: [] };
            }
            sourceEntries = subtitleData.entries;
        }

        console.log(`[subtitlesHandler] 共 ${sourceEntries.length} 条源字幕，开始翻译...`);

        // 2. 调用大模型翻译
        //    Stremio 请求字幕有超时，整片翻完要几十秒到几分钟，所以：
        //    - 同一部片只跑一个翻译任务（重复请求挂在同一个任务上，不重头再来）
        //    - 限时等待，到点先把「已翻好的部分」返回，后台继续翻，下次请求就能拿到全量
        const pending = translateWithCache(
            cacheKey,
            sourceEntries,
            cfg,
            (progress) => {
                console.log(`[subtitlesHandler] 翻译进度: ${progress}%`);
            }
        );

        const waitMs = Math.max(1000, Number(cfg.firstResponseWaitMs) || 8000);
        // 谁先到算谁：整片翻完，或者「任意一批已翻好」——后者能让第一段中文尽早出现
        const settled = await Promise.race([
            pending.then((value) => ({ kind: 'done', value })),
            firstProgressSignal(cacheKey, waitMs).then((ok) => ({ kind: ok ? 'progress' : 'timeout' })),
        ]);

        let translatedEntries;
        let stats;

        if (settled.kind === 'done') {
            ({ entries: translatedEntries, stats } = settled.value);
        } else {
            // 到点仍无任何译文时，再宽限一会儿等首批，否则用户那边完全看不到这条字幕
            if (settled.kind === 'timeout') {
                console.warn(`[subtitlesHandler] ${waitMs}ms 内尚无任何译文，再等首批…`);
                await waitUntilFirstProgress(cacheKey, 8000);
            }

            const done = getProgressSnapshot(cacheKey);
            if (done.length === 0) {
                console.warn('[subtitlesHandler] 仍未产出任何译文，先返回空，后台继续翻译');
                return { subtitles: [] };
            }

            // 已翻的用译文，没翻的保留原文，保证整片都有字幕可看
            const byIndex = new Map(done.map((entry) => [entry.index, entry.text]));
            translatedEntries = sourceEntries.map((entry) => ({
                index: entry.index,
                startTime: entry.startTime,
                endTime: entry.endTime,
                text: byIndex.has(entry.index) ? byIndex.get(entry.index) : entry.text,
            }));
            stats = {
                total: translatedEntries.length,
                translated: done.length,
                fallback: translatedEntries.length - done.length,
                partial: true,
            };

            const partialVtt = entriesToVTT(translatedEntries);
            const partialTitle = `AI翻译中文字幕 (${cfg.llmModel}) · 后台翻译中 ${done.length}/${translatedEntries.length}`;
            // 记住源字幕，后续请求不用再下载（配额很贵）
            storeSubtitle(subtitleId, partialVtt, partialTitle, {
                entries: sourceEntries,
                final: false,
            });
            console.log(`[subtitlesHandler] 先返回部分结果: ${done.length}/${translatedEntries.length}`);

            return { subtitles: [buildEntry(partialTitle)] };
        }

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
        storeSubtitle(subtitleId, vttContent, title, { final: true });

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

/**
 * 检查旧版接口是否可用（免 Key，只查询不下载）
 */
async function testOpenSubtitlesLegacy(cfg) {
    try {
        const count = await probeLegacy(cfg);
        if (!count) {
            return { ok: true, message: '接口可访问，但示例影片没查到字幕' };
        }
        return { ok: true, message: `免 Key 可用（示例查询到 ${count} 条）` };
    } catch (error) {
        return { ok: false, message: `请求失败（${error.message}）` };
    }
}

/**
 * 检查 Stremio 官方插件 CDN 是否可用（免 Key）
 */
async function testStremioCdn(cfg) {
    try {
        const count = await probeCdn(cfg);
        if (!count) {
            return { ok: true, message: '接口可访问，但示例影片没查到英文字幕' };
        }
        return { ok: true, message: `免 Key 可用（示例查询到 ${count} 条英文字幕）` };
    } catch (error) {
        return { ok: false, message: `请求失败（${error.message}）` };
    }
}

/**
 * 端到端试翻：真取一次字幕、真调一次模型，只翻前几条
 * 会消耗一次字幕下载配额，所以单独做成按钮，不混进"测试连接"
 */
async function testTranslateSample(cfg, imdbId) {
    const started = Date.now();
    const id = /^tt\d+$/.test(imdbId || '') ? imdbId : 'tt0111161';

    try {
        const data = await fetchBestSubtitle(id, cfg, {});
        if (!data) {
            return { ok: false, message: '没取到源字幕，检查网络或更换字幕源' };
        }

        const sample = data.entries.filter((e) => String(e.text || '').trim()).slice(0, 3);
        if (sample.length === 0) {
            return { ok: false, message: '字幕解析结果为空' };
        }

        const { results, matched } = await translateBatch(sample, cfg);
        if (!matched) {
            return { ok: false, message: '模型没有按序号返回译文，换模型或降低批次条数试试' };
        }

        const pairs = sample.map((entry, i) => ({
            source: entry.text,
            target: (results.find((r) => r.index === entry.index) || results[i] || {}).text || '',
        }));

        const SOURCE_LABEL = { rest: '新版接口', legacy: '旧接口', cdn: '官方 CDN' };
        return {
            ok: true,
            message: `${SOURCE_LABEL[data.source] || data.source}取到 ${data.entries.length} 条，试翻 ${matched}/${sample.length} 条，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
            source: data.source,
            sourceLabel: SOURCE_LABEL[data.source] || data.source,
            sampleFile: data.subtitleInfo && data.subtitleInfo.fileName,
            pairs,
        };
    } catch (error) {
        return { ok: false, message: `试翻失败（${error.message}）` };
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

        const [llm, opensubtitles, legacy, cdn] = await Promise.all([
            testLLM(cfg),
            testOpenSubtitles(cfg),
            testOpenSubtitlesLegacy(cfg),
            testStremioCdn(cfg),
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ llm, opensubtitles, legacy, cdn }));
        return;
    }

    // 端到端试翻（会真实下载 1 条字幕 + 调用模型）
    if (path === '/api/test-translate' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const cfg = mergeConfig(config, body);
        if (body.llmBaseUrl) cfg.llmBaseUrl = body.llmBaseUrl;
        if (body.llmApiKey) cfg.llmApiKey = body.llmApiKey;
        if (body.opensubtitlesApiKey) cfg.opensubtitlesApiKey = body.opensubtitlesApiKey;

        const result = await testTranslateSample(cfg, body.imdbId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
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
    console.log(`  字幕源:      ${config.subtitleSource}${config.subtitleSource === 'auto' ? '（新版 → 旧版 → 官方 CDN 依次尝试）' : ''}`);
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
