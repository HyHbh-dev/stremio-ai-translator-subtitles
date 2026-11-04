/**
 * subtitleFetcher.js
 * 从 OpenSubtitles 获取字幕，并解析 SRT/VTT 格式
 *
 * 注意：OpenSubtitles REST API 的版本路径是 /api/v1（站内文档地址写的是 v2，但
 * /api/v2/* 会返回 HTML 404，不要用）。
 */

const axios = require('axios');

const DEFAULT_OPEN_SUBS_API = 'https://api.opensubtitles.com/api/v1';

/**
 * 解析 API 基础地址（允许通过环境变量覆盖，方便自建代理与测试）
 */
function getApiBase(config = {}) {
    const base = config.opensubtitlesBaseUrl || process.env.OPENSUBTITLES_BASE_URL || DEFAULT_OPEN_SUBS_API;
    return base.replace(/\/+$/, '');
}

/**
 * 构造 OpenSubtitles 请求头
 */
function buildHeaders(config, extra = {}) {
    return {
        'Api-Key': config.opensubtitlesApiKey,
        'User-Agent': config.opensubtitlesUserAgent || 'StremioAITranslator v1.0',
        'Accept': 'application/json',
        ...extra,
    };
}

/**
 * 根据 IMDb ID 搜索字幕
 * @param {string} imdbId - IMDb ID (如 tt1234567)
 * @param {string} language - 字幕语言代码 (如 en, zh)
 * @param {object} config - 配置对象
 * @param {object} [options] - 可选参数 { season, episode }
 * @returns {Promise<Array>} 字幕列表
 */
async function searchSubtitles(imdbId, language, config, options = {}) {
    const { season, episode } = options;

    try {
        // IMDb ID 去掉 tt 前缀
        const imdbIdNum = String(imdbId).replace(/^tt/, '');

        const params = {
            languages: language,
            order_by: 'download_count',
            order_direction: 'desc',
        };

        // 剧集必须用 parent_imdb_id + 季/集查询，
        // 否则只会命中剧集本身的"正片"条目，拿不到对应集数的字幕
        if (Number.isInteger(season) && Number.isInteger(episode)) {
            params.parent_imdb_id = imdbIdNum;
            params.season_number = season;
            params.episode_number = episode;
        } else {
            params.imdb_id = imdbIdNum;
        }

        const response = await axios.get(`${getApiBase(config)}/subtitles`, {
            params,
            headers: buildHeaders(config),
            // 带前导 0 的 imdb_id 会被 API 301 重定向到规范形式，交给 axios 跟随
            maxRedirects: 5,
            timeout: 15000,
        });

        if (!response.data || !Array.isArray(response.data.data)) {
            return [];
        }

        return response.data.data
            .filter(item => item && item.attributes && Array.isArray(item.attributes.files) && item.attributes.files.length > 0)
            .map(item => {
                const file = item.attributes.files[0];
                const fileName = file.file_name || item.attributes.release || '';
                return {
                    id: item.id,
                    fileName,
                    fileId: file.file_id,
                    language: item.attributes.language,
                    downloadCount: item.attributes.download_count || 0,
                    rating: item.attributes.ratings,
                    hearingImpaired: !!item.attributes.hearing_impaired,
                    aiTranslated: !!item.attributes.ai_translated,
                    format: fileName.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt',
                };
            })
            .filter(item => item.fileId);
    } catch (error) {
        const status = error.response && error.response.status;
        console.error(`[subtitleFetcher] 搜索字幕失败: ${error.message}${status ? ` (HTTP ${status})` : ''}`);
        if (error.response) {
            // OpenSubtitles 出错时可能返回整页 HTML，避免刷屏只截一段
            const data = typeof error.response.data === 'string'
                ? error.response.data.slice(0, 200)
                : JSON.stringify(error.response.data).slice(0, 200);
            console.error(`[subtitleFetcher] 响应内容: ${data}`);
            if (status === 401 || status === 403) {
                console.error('[subtitleFetcher] 提示: 请检查 OPENSUBTITLES_API_KEY 是否有效');
            }
            if (status === 404) {
                console.error('[subtitleFetcher] 提示: 接口路径可能不对，OpenSubtitles REST API 为 /api/v1');
            }
        }
        return [];
    }
}

/**
 * 把 Buffer 解码成字符串（OpenSubtitles 上不少字幕是 windows-1252/latin1）
 * @param {Buffer|string} data
 * @returns {string}
 */
function decodeSubtitleContent(data) {
    if (typeof data === 'string') return stripBOM(data);

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const utf8 = buf.toString('utf8');
    // utf8 解码失败会出现替换字符，此时回退到 latin1
    const decoded = utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
    return stripBOM(decoded);
}

/**
 * 去掉 BOM 头
 */
function stripBOM(text) {
    return text.replace(/^\uFEFF/, '');
}

/**
 * 下载字幕文件内容
 * @param {number} fileId - OpenSubtitles file_id
 * @param {object} config - 配置对象
 * @returns {Promise<string|null>} 字幕文件内容
 */
async function downloadSubtitle(fileId, config) {
    try {
        // 请求下载链接
        const downloadResp = await axios.post(
            `${getApiBase(config)}/download`,
            { file_id: fileId },
            {
                headers: buildHeaders(config, { 'Content-Type': 'application/json' }),
                timeout: 15000,
            }
        );

        const downloadLink = downloadResp.data && downloadResp.data.link;
        if (!downloadLink) {
            console.error('[subtitleFetcher] 下载接口未返回 link');
            return null;
        }

        // 下载字幕内容（按二进制取回，再自行解码，避免非 UTF-8 字幕乱码）
        const subtitleResp = await axios.get(downloadLink, {
            headers: { 'User-Agent': config.opensubtitlesUserAgent || 'StremioAITranslator v1.0' },
            responseType: 'arraybuffer',
            timeout: 30000,
            maxRedirects: 5,
        });

        return decodeSubtitleContent(subtitleResp.data);
    } catch (error) {
        const status = error.response && error.response.status;
        console.error(`[subtitleFetcher] 下载字幕失败: ${error.message}${status ? ` (HTTP ${status})` : ''}`);
        if (status === 406) {
            console.error('[subtitleFetcher] 提示: OpenSubtitles 当日下载配额已用完');
        }
        if (status === 401 || status === 403) {
            console.error('[subtitleFetcher] 提示: 请检查 OPENSUBTITLES_API_KEY，或登录以提升下载配额');
        }
        return null;
    }
}

/**
 * 解析 SRT 格式字幕
 * @param {string} srtContent - SRT 文件内容
 * @returns {Array<{index, startTime, endTime, text}>}
 */
function parseSRT(srtContent) {
    const entries = [];
    if (!srtContent) return entries;

    // 统一换行符
    const normalized = stripBOM(srtContent).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // 按空行分割条目
    const blocks = normalized.trim().split(/\n\s*\n/);

    for (const block of blocks) {
        const lines = block.split('\n').filter(l => l.trim());
        if (lines.length < 2) continue;

        // 第一行可能是序号，第二行是时间轴
        let timeLineIdx = 0;
        let index = entries.length + 1;

        const possibleIndex = parseInt(lines[0], 10);
        if (!isNaN(possibleIndex) && /^\d+$/.test(lines[0].trim()) && lines.length >= 2) {
            index = possibleIndex;
            timeLineIdx = 1;
        }

        const timeLine = lines[timeLineIdx];
        const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
        if (!timeMatch) continue;

        const startTime = timeMatch[1];
        const endTime = timeMatch[2];
        const text = lines.slice(timeLineIdx + 1).join('\n');

        entries.push({ index, startTime, endTime, text });
    }

    return entries;
}

/**
 * 解析 VTT 格式字幕
 * @param {string} vttContent - VTT 文件内容
 * @returns {Array<{index, startTime, endTime, text}>}
 */
function parseVTT(vttContent) {
    const entries = [];
    if (!vttContent) return entries;

    const normalized = stripBOM(vttContent).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // 移除 WEBVTT 头（含紧跟的元信息行，如 Kind/Language）
    const body = normalized.replace(/^WEBVTT[^\n]*\n/, '').replace(/^(Kind|Language):[^\n]*\n/gm, '');
    const blocks = body.trim().split(/\n\s*\n/);

    let autoIndex = 1;

    for (const block of blocks) {
        const lines = block.split('\n').filter(l => l.trim());
        if (lines.length < 1) continue;

        // 跳过 CUE 标识行
        let timeLineIdx = 0;
        if (!lines[0].includes('-->')) {
            timeLineIdx = 1;
        }

        if (timeLineIdx >= lines.length) continue;

        const timeLine = lines[timeLineIdx];
        const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})/);
        if (!timeMatch) continue;

        const startTime = timeMatch[1];
        const endTime = timeMatch[2];
        const text = lines.slice(timeLineIdx + 1).join('\n');

        entries.push({ index: autoIndex++, startTime, endTime, text });
    }

    return entries;
}

/**
 * 自动检测并解析字幕格式
 * @param {string} content - 字幕内容
 * @returns {Array<{index, startTime, endTime, text}>}
 */
function parseSubtitle(content) {
    if (!content) return [];

    if (stripBOM(content).trim().startsWith('WEBVTT')) {
        return parseVTT(content);
    }
    return parseSRT(content);
}

/**
 * 把时间轴统一成 WebVTT 要求的 HH:MM:SS.mmm
 * @param {string} time
 */
function normalizeVttTime(time) {
    const normalized = time.replace(',', '.');
    // VTT 允许 MM:SS.mmm 简写，但补全成 HH:MM:SS.mmm 兼容性更好
    if (/^\d{2}:\d{2}\.\d{3}$/.test(normalized)) {
        return `00:${normalized}`;
    }
    return normalized;
}

/**
 * 将字幕条目数组转换为 VTT 格式字符串
 * @param {Array<{index, startTime, endTime, text}>} entries
 * @returns {string}
 */
function entriesToVTT(entries) {
    let vtt = 'WEBVTT\n\n';

    for (const entry of entries) {
        const start = normalizeVttTime(entry.startTime);
        const end = normalizeVttTime(entry.endTime);
        // 字幕正文里不允许出现 "-->"，否则会被解析成新的时间轴
        const text = String(entry.text || '').replace(/-->/g, '→');

        vtt += `${start} --> ${end}\n`;
        vtt += `${text}\n\n`;
    }

    return vtt;
}

/**
 * 在候选字幕里挑一条最适合翻译的
 * 非听障版本（不带 [SOUND] 之类标注）翻译效果更好
 */
function pickBestSubtitle(subtitles) {
    if (!subtitles || subtitles.length === 0) return null;

    const score = (s) => {
        let v = s.downloadCount || 0;
        if (s.hearingImpaired) v -= 100000;
        if (s.aiTranslated) v -= 50000;
        return v;
    };

    return subtitles.slice().sort((a, b) => score(b) - score(a))[0];
}

/**
 * 获取最佳源字幕
 * @param {string} imdbId - IMDb ID
 * @param {object} config - 配置对象
 * @param {object} [options] - { season, episode } 剧集时需要
 * @returns {Promise<{content, format, entries, subtitleInfo}|null>}
 */
async function fetchBestSubtitle(imdbId, config, options = {}) {
    const { season, episode } = options;
    const label = Number.isInteger(season) && Number.isInteger(episode)
        ? `${imdbId} S${season}E${episode}`
        : imdbId;
    console.log(`[subtitleFetcher] 搜索 ${label} 的 ${config.sourceLang} 字幕...`);

    const subtitles = await searchSubtitles(imdbId, config.sourceLang, config, { season, episode });

    if (subtitles.length === 0) {
        console.log(`[subtitleFetcher] 未找到 ${config.sourceLang} 字幕`);
        return null;
    }

    const best = pickBestSubtitle(subtitles);
    console.log(`[subtitleFetcher] 找到 ${subtitles.length} 条字幕，选择: ${best.fileName}`);

    const content = await downloadSubtitle(best.fileId, config);
    if (!content) {
        console.error('[subtitleFetcher] 下载字幕失败');
        return null;
    }

    const entries = parseSubtitle(content);
    console.log(`[subtitleFetcher] 解析到 ${entries.length} 条字幕`);

    return { content, format: best.format, entries, subtitleInfo: best };
}

module.exports = {
    DEFAULT_OPEN_SUBS_API,
    getApiBase,
    searchSubtitles,
    downloadSubtitle,
    decodeSubtitleContent,
    parseSRT,
    parseVTT,
    parseSubtitle,
    entriesToVTT,
    pickBestSubtitle,
    fetchBestSubtitle,
};
