/**
 * mediaId.js
 * 解析 Stremio 传来的内容 ID
 *
 * Stremio 的 id 有两种形式：
 *   电影: tt0111161
 *   剧集: tt0944947:1:1  (imdbId:season:episode)
 */

/**
 * @param {string} id
 * @returns {{imdbId: string, isSeries: boolean, season: number|null, episode: number|null}}
 */
function parseMediaId(id) {
    const raw = String(id || '').trim();
    const parts = raw.split(':');

    const imdbId = parts[0].trim();
    const season = parts.length > 1 ? parseInt(parts[1], 10) : NaN;
    const episode = parts.length > 2 ? parseInt(parts[2], 10) : NaN;

    const hasSeason = Number.isInteger(season) && season >= 0;
    const hasEpisode = Number.isInteger(episode) && episode >= 0;
    const isSeries = hasSeason && hasEpisode;

    return {
        imdbId,
        isSeries,
        season: isSeries ? season : null,
        episode: isSeries ? episode : null,
    };
}

module.exports = { parseMediaId };
