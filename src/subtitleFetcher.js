/**
 * subtitleFetcher.js
 * 从 OpenSubtitles 获取字幕，并解析 SRT/VTT 格式
 */

const axios = require('axios');

const OPEN_SUBS_API = 'https://api.opensubtitles.com/api/v2';

/**
 * 根据 IMDb ID 搜索字幕
 * @param {string} imdbId - IMDb ID (如 tt1234567)
 * @param {string} language - 字幕语言代码 (如 en, zh)
 * @param {object} config - 配置对象
 * @returns {Promise<Array>} 字幕列表
 */
async function searchSubtitles(imdbId, language, config) {
    try {
        // 获取 IMDb ID 的数字部分用于查询
        const imdbIdNum = imdbId.replace(/^tt/, '');

        const response = await axios.get(`${OPEN_SUBS_API}/subtitles`, {
            params: {
                imdb_id: imdbIdNum,
                languages: language,
                order_by: 'download_count',
                order_direction: 'desc',
            },
            headers: {
                'Api-Key': config.opensubtitlesApiKey,
                'User-Agent': config.opensubtitlesUserAgent,
            },
            timeout: 15000,
        });

        if (!response.data || !response.data.data) {
            return [];
        }

        return response.data.data
            .filter(item => item.attributes && item.attributes.files && item.attributes.files.length > 0)
            .map(item => ({
                id: item.id,
                fileName: item.attributes.files[0].file_name || item.attributes.release,
                downloadUrl: item.attributes.files[0].file_id ? null : null, // 需要 file_id 下载
                fileId: item.attributes.files[0].file_id,
                language: item.attributes.language,
                downloadCount: item.attributes.download_count,
                rating: item.attributes.ratings,
                format: (item.attributes.files[0].file_name || '').endsWith('.vtt') ? 'vtt' : 'srt',
            }));
    } catch (error) {
        console.error(`[subtitleFetcher] 搜索字幕失败: ${error.message}`);
        if (error.response) {
            console.error(`[subtitleFetcher] 响应状态: ${error.response.status}`);
            console.error(`[subtitleFetcher] 响应数据: ${JSON.stringify(error.response.data)}`);
        }
        return [];
    }
}

/**
 * 下载字幕文件内容
 * @param {number} fileId - OpenSubtitles file_id
 * @param {object} config - 配置对象
 * @returns {Promise<string>} 字幕文件内容
 */
async function downloadSubtitle(fileId, config) {
    try {
        // 请求下载链接
        const downloadResp = await axios.post(
            `${OPEN_SUBS_API}/download`,
            { file_id: fileId },
            {
                headers: {
                    'Api-Key': config.opensubtitlesApiKey,
                    'User-Agent': config.opensubtitlesUserAgent,
                    'Content-Type': 'application/json',
                },
                timeout: 15000,
            }
        );

        const downloadLink = downloadResp.data.link;

        // 下载字幕内容
        const subtitleResp = await axios.get(downloadLink, {
            timeout: 30000,
            responseType: 'text',
        });

        return subtitleResp.data;
    } catch (error) {
        console.error(`[subtitleFetcher] 下载字幕失败: ${error.message}`);
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
    // 统一换行符
    const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // 按空行分割条目
    const blocks = normalized.trim().split(/\n\s*\n/);

    for (const block of blocks) {
        const lines = block.split('\n').filter(l => l.trim());
        if (lines.length < 2) continue;

        // 第一行是序号，第二行是时间轴
        let timeLineIdx = 0;
        let index = entries.length + 1;

        // 尝试解析序号
        const possibleIndex = parseInt(lines[0], 10);
        if (!isNaN(possibleIndex) && lines.length >= 2) {
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
    const normalized = vttContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // 移除 WEBVTT 头
    const body = normalized.replace(/^WEBVTT.*\n/, '');
    const blocks = body.trim().split(/\n\s*\n/);

    let autoIndex = 1;

    for (const block of blocks) {
        const lines = block.split('\n').filter(l => l.trim());
        if (lines.length < 1) continue;

        let timeLineIdx = 0;

        // 跳过 CUE 标识行
        const possibleCueId = lines[0];
        if (!possibleCueId.includes('-->')) {
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

    if (content.trim().startsWith('WEBVTT')) {
        return parseVTT(content);
    }
    return parseSRT(content);
}

/**
 * 将字幕条目数组转换为 VTT 格式字符串
 * @param {Array<{index, startTime, endTime, text}>} entries
 * @returns {string}
 */
function entriesToVTT(entries) {
    let vtt = 'WEBVTT\n\n';

    for (const entry of entries) {
        // 统一时间格式为 VTT 格式 (用 . 而非 ,)
        const start = entry.startTime.replace(',', '.');
        const end = entry.endTime.replace(',', '.');

        vtt += `${start} --> ${end}\n`;
        vtt += `${entry.text}\n\n`;
    }

    return vtt;
}

/**
 * 获取最佳源字幕
 * @param {string} imdbId - IMDb ID
 * @param {object} config - 配置对象
 * @returns {Promise<{content, format, entries}|null>}
 */
async function fetchBestSubtitle(imdbId, config) {
    console.log(`[subtitleFetcher] 搜索 IMDb ${imdbId} 的 ${config.sourceLang} 字幕...`);

    const subtitles = await searchSubtitles(imdbId, config.sourceLang, config);

    if (subtitles.length === 0) {
        console.log(`[subtitleFetcher] 未找到 ${config.sourceLang} 字幕`);
        return null;
    }

    // 选择下载量最高的字幕
    const best = subtitles[0];
    console.log(`[subtitleFetcher] 找到 ${subtitles.length} 条字幕，选择: ${best.fileName}`);

    const content = await downloadSubtitle(best.fileId, config);
    if (!content) {
        console.error(`[subtitleFetcher] 下载字幕失败`);
        return null;
    }

    const entries = parseSubtitle(content);
    console.log(`[subtitleFetcher] 解析到 ${entries.length} 条字幕`);

    return { content, format: best.format, entries, subtitleInfo: best };
}

module.exports = {
    searchSubtitles,
    downloadSubtitle,
    parseSRT,
    parseVTT,
    parseSubtitle,
    entriesToVTT,
    fetchBestSubtitle,
};
