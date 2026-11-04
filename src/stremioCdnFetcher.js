/**
 * stremioCdnFetcher.js
 * 通过 Stremio 官方字幕插件（OpenSubtitles v3）的公开接口取字幕
 *
 * 这是 Stremio 官方插件自己在用的通道：
 *   GET https://opensubtitles-v3.strem.io/subtitles/movie/tt0111161.json
 * 它直接返回 CDN 上已经转好 UTF-8 的明文字幕地址（subs5.strem.io），
 * 不需要 API Key，也没有下载次数限制——因为配额是官方插件自己承担并缓存的。
 *
 * 说明：这是借用第三方服务，稳定性不由本项目控制，所以只作为兜底源，
 * 并在配置里明确标注。想长期稳定用，还是配自己的 Key 或账号。
 */

const axios = require('axios');

const DEFAULT_CDN_BASE = 'https://opensubtitles-v3.strem.io';

// ISO 639-2/B → 639-1，用于把目标语言和 CDN 返回的语言码对齐
const LANG_ALIAS = {
    eng: 'en',
    chi: 'zh',
    zho: 'zh',
    jpn: 'ja',
    kor: 'ko',
    fre: 'fr',
    fra: 'fr',
    ger: 'de',
    deu: 'de',
    spa: 'es',
    por: 'pt',
    rus: 'ru',
    ita: 'it',
};

function getCdnBase(config = {}) {
    const base = config.stremioCdnUrl || process.env.STREMIO_CDN_URL || DEFAULT_CDN_BASE;
    return base.replace(/\/+$/, '');
}

function normalizeLang(code) {
    const key = String(code || '').toLowerCase();
    return LANG_ALIAS[key] || key;
}

/**
 * 搜索字幕
 * @param {string} imdbId - tt1234567
 * @param {string} language - en / zh ...
 * @param {object} config
 * @param {{season?: number, episode?: number}} [options]
 */
async function searchSubtitlesViaCdn(imdbId, language, config = {}, options = {}) {
    const { season, episode } = options;
    const base = getCdnBase(config);
    const isEpisode = Number.isInteger(season) && Number.isInteger(episode);

    const type = isEpisode ? 'series' : 'movie';
    const id = isEpisode ? `${imdbId}:${season}:${episode}` : imdbId;
    const endpoint = `${base}/subtitles/${type}/${encodeURIComponent(id)}.json`;

    const res = await axios.get(endpoint, {
        headers: { 'User-Agent': config.opensubtitlesUserAgent || 'StremioAITranslator v1.0' },
        timeout: 20000,
        proxy: /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(base) ? false : undefined,
    });

    const list = (res.data && Array.isArray(res.data.subtitles)) ? res.data.subtitles : [];
    const want = normalizeLang(language);

    return list
        .filter((s) => s && s.url)
        .filter((s) => normalizeLang(s.lang) === want)
        .map((s) => ({
            id: s.id,
            fileName: s.subtitleFileName || s.movieReleaseName || `${id}.srt`,
            downloadLink: s.url,
            language: s.lang,
            downloadCount: 0,
            // 文件名带 .HI. / [HI] 的通常是听障版本
            hearingImpaired: /(^|[.\s[])hi([.\s\]]|$)/i.test(s.subtitleFileName || ''),
            aiTranslated: false,
            format: 'srt',
            source: 'cdn',
        }));
}

/**
 * 下载 CDN 上的字幕（已经是 UTF-8 明文 SRT）
 * @returns {Promise<string|null>}
 */
async function downloadSubtitleViaCdn(downloadUrl, config = {}) {
    try {
        const res = await axios.get(downloadUrl, {
            headers: { 'User-Agent': config.opensubtitlesUserAgent || 'StremioAITranslator v1.0' },
            responseType: 'arraybuffer',
            timeout: 30000,
            maxRedirects: 5,
        });

        const buf = Buffer.from(res.data);
        const utf8 = buf.toString('utf8');
        const text = utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
        return text.replace(/^\uFEFF/, '');
    } catch (error) {
        const status = error.response && error.response.status;
        console.error(`[stremioCdnFetcher] 下载字幕失败: ${error.message}${status ? ` (HTTP ${status})` : ''}`);
        return null;
    }
}

/**
 * 只做一次查询，用于配置页连通性检测
 */
async function probeCdn(config = {}) {
    const list = await searchSubtitlesViaCdn('tt0111161', 'en', config, {});
    return list.length;
}

module.exports = {
    DEFAULT_CDN_BASE,
    getCdnBase,
    normalizeLang,
    searchSubtitlesViaCdn,
    downloadSubtitleViaCdn,
    probeCdn,
};
