/**
 * legacyFetcher.js
 * 通过 OpenSubtitles 旧版 XML-RPC 接口获取字幕
 *
 * 为什么需要它：
 *   - 新版 REST 接口（api.opensubtitles.com）必须带 Api-Key，匿名每天只有 5 次下载，
 *     配额一用完当天就没法再翻字幕。
 *   - 旧版接口（api.opensubtitles.org/xml-rpc）不需要 API Key，
 *     只要带一个 User-Agent 就能登录拿到临时 token，下载配额按 IP 计算且宽松得多。
 *   - Stremio 官方的 OpenSubtitles v3 插件走的就是这条路（它返回的 file id 与本接口
 *     返回的 file id 完全一致），只是它把字幕缓存到了自己的 CDN 上。
 *
 * 返回的下载链接是 .gz 压缩包，需要解压后再解码成文本。
 */

const axios = require('axios');
const zlib = require('zlib');

const DEFAULT_LEGACY_API = 'https://api.opensubtitles.org/xml-rpc';
const DEFAULT_USER_AGENT = 'StremioAITranslator v1.0';

// 登录 token 有效期较短，缓存 10 分钟即可，避免每次都多打一次请求
const TOKEN_TTL_MS = 10 * 60 * 1000;
let tokenCache = { token: null, key: '', expiresAt: 0 };

function getLegacyApiBase(config = {}) {
    const base = config.opensubtitlesLegacyUrl || process.env.OPENSUBTITLES_LEGACY_URL || DEFAULT_LEGACY_API;
    return base.replace(/\/+$/, '');
}

function getUserAgent(config = {}) {
    return config.opensubtitlesUserAgent || DEFAULT_USER_AGENT;
}

function xmlEscape(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 从 XML 里取某个 member 的文本值
 */
function memberValue(block, name) {
    const re = new RegExp(`<name>${name}</name>\\s*<value>\\s*(?:<[a-zA-Z]+>)?([^<]*)`, 'i');
    const m = block.match(re);
    return m ? decodeXmlEntities(m[1]) : '';
}

function decodeXmlEntities(str) {
    return String(str)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
        .replace(/&amp;/g, '&');
}

/**
 * 调用 XML-RPC 方法
 */
async function rpcCall(method, params, config) {
    const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>`
        + params.map((p) => `<param><value>${p}</value></param>`).join('')
        + '</params></methodCall>';

    const res = await axios.post(getLegacyApiBase(config), body, {
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'User-Agent': getUserAgent(config),
        },
        timeout: 20000,
        responseType: 'text',
        transformResponse: [(d) => d],
        proxy: /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(getLegacyApiBase(config))
            ? false
            : undefined,
    });

    return typeof res.data === 'string' ? res.data : String(res.data);
}

/**
 * 登录拿 token
 *
 * 匿名（不填账号）也能登录，但**下载会拿到一个 102 字节的"成为 VIP"占位文件**，
 * 不是真字幕。要拿真内容必须填 OpenSubtitles 账号。
 */
async function logIn(config = {}) {
    const base = getLegacyApiBase(config);
    const user = config.opensubtitlesUsername || '';
    const pass = config.opensubtitlesPassword || '';
    const now = Date.now();
    const cacheKey = `${base}|${user}`;

    if (tokenCache.token && tokenCache.key === cacheKey && tokenCache.expiresAt > now) {
        return tokenCache.token;
    }

    const xml = await rpcCall('LogIn', [
        `<string>${xmlEscape(user)}</string>`,
        `<string>${xmlEscape(pass)}</string>`,
        '<string>en</string>',
        `<string>${xmlEscape(getUserAgent(config))}</string>`,
    ], config);

    const token = memberValue(xml, 'token');
    if (!token) {
        const status = memberValue(xml, 'status');
        throw new Error(`旧接口登录失败${status ? `（${status}）` : ''}`);
    }

    tokenCache = { token, key: cacheKey, expiresAt: now + TOKEN_TTL_MS };
    return token;
}

/**
 * 解析 SearchSubtitles 的返回，拆出每条字幕的 struct 块
 */
function extractStructs(xml) {
    const dataPart = String(xml).split('<name>data</name>')[1];
    if (!dataPart) return [];

    const body = dataPart.split('</data>')[0];
    return body
        .split(/<value>\s*<struct>/i)
        .slice(1)
        .map((chunk) => chunk.split('</struct>')[0])
        .filter((chunk) => chunk.includes('<member>'));
}

/**
 * 搜索字幕
 * @param {string} imdbId - 带 tt 或纯数字
 * @param {string} language - 语言代码（这里是 3 位或 2 位都能识别，如 en / eng）
 * @param {object} config
 * @param {{season?: number, episode?: number}} [options]
 */
async function searchSubtitlesLegacy(imdbId, language, config = {}, options = {}) {
    const { season, episode } = options;
    const imdbIdNum = String(imdbId).replace(/^tt/, '');

    const criteria = [
        `<member><name>sublanguageid</name><value><string>${xmlEscape(language)}</string></value></member>`,
        `<member><name>imdbid</name><value><string>${xmlEscape(imdbIdNum)}</string></value></member>`,
    ];

    // 剧集：旧接口用 imdbid + season + episode 定位
    if (Number.isInteger(season) && Number.isInteger(episode)) {
        criteria.push(`<member><name>season</name><value><string>${season}</string></value></member>`);
        criteria.push(`<member><name>episode</name><value><string>${episode}</string></value></member>`);
    }

    const token = await logIn(config);
    const xml = await rpcCall('SearchSubtitles', [
        `<string>${xmlEscape(token)}</string>`,
        `<array><data><value><struct>${criteria.join('')}</struct></value></data></array>`,
        '<string>100</string>',
    ], config);

    const status = memberValue(xml, 'status');
    if (status && !/^200/.test(status)) {
        // token 过期就清掉，下次调用重新登录
        if (/406|401/.test(status)) tokenCache = { token: null, key: '', expiresAt: 0 };
        throw new Error(`旧接口搜索失败（${status}）`);
    }

    return extractStructs(xml)
        .map((block) => {
            const fileName = memberValue(block, 'SubFileName');
            const link = memberValue(block, 'SubDownloadLink');
            if (!fileName || !link) return null;

            const format = memberValue(block, 'SubFormat').toLowerCase();
            return {
                id: memberValue(block, 'IDSubtitleFile') || fileName,
                fileName,
                downloadLink: link,
                language: memberValue(block, 'SubLanguageID') || language,
                downloadCount: parseInt(memberValue(block, 'SubDownloadsCnt') || '0', 10) || 0,
                hearingImpaired: memberValue(block, 'SubHearingImpaired') === '1',
                aiTranslated: false,
                format: format === 'vtt' ? 'vtt' : 'srt',
                season: parseInt(memberValue(block, 'SeriesSeason') || '0', 10) || 0,
                episode: parseInt(memberValue(block, 'SeriesEpisode') || '0', 10) || 0,
                source: 'legacy',
            };
        })
        .filter(Boolean);
}

/**
 * 判断是不是"开通 VIP"占位字幕
 *
 * 旧接口允许匿名搜索，但匿名下载只会返回一条 100 来字节的提示：
 *   "Become OpenSubtitles.org VIP member / to get subtitles -> osdb.link/vip"
 * 不识别的话，用户会在屏幕上看到这条广告，而不是字幕。
 */
function isPromoPlaceholder(text) {
    if (!text) return false;
    if (Buffer.byteLength(text) > 600) return false;
    return /osdb\.link/i.test(text) || /OpenSubtitles\.org\s*VIP/i.test(text);
}

/**
 * 下载旧接口返回的字幕（.gz 压缩）
 * @returns {Promise<string|null>} 解码后的字幕文本；占位文件或失败返回 null
 */
async function downloadSubtitleLegacy(downloadLink, config = {}) {
    try {
        const res = await axios.get(downloadLink, {
            headers: { 'User-Agent': getUserAgent(config) },
            responseType: 'arraybuffer',
            timeout: 30000,
            maxRedirects: 5,
        });

        let buf = Buffer.from(res.data);
        // gzip magic number 0x1f 0x8b
        if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
            buf = zlib.gunzipSync(buf);
        }

        const text = decodeBuffer(buf);
        if (isPromoPlaceholder(text)) {
            console.error('[legacyFetcher] 下载到的是「开通 VIP」占位字幕（匿名下载限制），需要在配置里填 OpenSubtitles 账号');
            return null;
        }
        return text;
    } catch (error) {
        const status = error.response && error.response.status;
        console.error(`[legacyFetcher] 下载字幕失败: ${error.message}${status ? ` (HTTP ${status})` : ''}`);
        if (status === 403 || status === 429) {
            console.error('[legacyFetcher] 提示: 旧接口对该 IP 的下载次数已达上限，稍后再试或改用 REST 接口');
        }
        return null;
    }
}

/**
 * 把 Buffer 解码成字符串（老字幕大量使用 windows-1252/latin1）
 */
function decodeBuffer(buf) {
    const utf8 = buf.toString('utf8');
    const text = utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
    return text.replace(/^\uFEFF/, '');
}

/**
 * 只做一次查询，用于配置页的连通性检测（不消耗下载次数）
 */
async function probeLegacy(config = {}) {
    const list = await searchSubtitlesLegacy('tt0111161', 'en', config, {});
    return list.length;
}

module.exports = {
    DEFAULT_LEGACY_API,
    getLegacyApiBase,
    logIn,
    searchSubtitlesLegacy,
    downloadSubtitleLegacy,
    decodeBuffer,
    isPromoPlaceholder,
    probeLegacy,
    // 供测试重置 token 缓存
    _resetTokenCache: () => { tokenCache = { token: null, key: '', expiresAt: 0 }; },
};
