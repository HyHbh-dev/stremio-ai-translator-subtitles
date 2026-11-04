/**
 * addonConfig.js
 * 安装配置的编解码
 *
 * Stremio 的插件没有服务端"设置面板"，配置通过安装链接传递：
 *   http://your-host/c/<config>/manifest.json
 * 其中 <config> 是 base64url 编码的 JSON。访问 /configure 生成该链接。
 */

const crypto = require('crypto');

// 允许通过安装链接覆盖的字段
const URL_CONFIG_FIELDS = [
    'llmBaseUrl',
    'llmModel',
    'llmApiKey',
    'opensubtitlesApiKey',
    'targetLang',
    'sourceLang',
    'translateBatchSize',
    'subtitleSource',
    'opensubtitlesUsername',
    'opensubtitlesPassword',
];

// 字幕源可选值
const SUBTITLE_SOURCES = ['auto', 'rest', 'legacy', 'cdn'];

/**
 * 校验并规范化单个字段
 */
function sanitizeField(key, value) {
    if (value === undefined || value === null) return undefined;

    if (key === 'translateBatchSize') {
        const n = parseInt(value, 10);
        if (!Number.isInteger(n) || n < 1 || n > 500) return undefined;
        return n;
    }

    const str = String(value).trim();
    if (!str) return undefined;

    if (key === 'llmBaseUrl') {
        if (!/^https?:\/\/[^\s]+$/i.test(str)) return undefined;
        return str.replace(/\/+$/, '');
    }

    if (key === 'targetLang' || key === 'sourceLang') {
        if (!/^[a-zA-Z-]{2,8}$/.test(str)) return undefined;
        return str.toLowerCase();
    }

    if (key === 'subtitleSource') {
        const v = str.toLowerCase();
        return SUBTITLE_SOURCES.includes(v) ? v : undefined;
    }

    if (key === 'llmModel') return str.slice(0, 200);
    if (key === 'llmApiKey') return str.replace(/\s+/g, '').slice(0, 300);
    if (key === 'opensubtitlesApiKey') return str.replace(/\s+/g, '').slice(0, 300);
    if (key === 'opensubtitlesUsername') return str.slice(0, 120);
    if (key === 'opensubtitlesPassword') return str.slice(0, 120);

    return str.slice(0, 300);
}

/**
 * 只保留允许通过链接传递的字段并校验
 * @param {object} raw
 * @returns {object} 干净的配置（可能为空对象）
 */
function sanitizeConfig(raw) {
    const result = {};
    if (!raw || typeof raw !== 'object') return result;

    for (const key of URL_CONFIG_FIELDS) {
        const value = sanitizeField(key, raw[key]);
        if (value !== undefined) result[key] = value;
    }
    return result;
}

/**
 * 把配置编码成安装链接里的那一段
 */
function encodeConfig(raw) {
    const clean = sanitizeConfig(raw);
    return Buffer.from(JSON.stringify(clean), 'utf8').toString('base64url');
}

/**
 * 解析安装链接里的配置段
 * @returns {object|null} 解析失败返回 null
 */
function decodeConfig(encoded) {
    if (typeof encoded !== 'string' || !encoded) return null;
    try {
        const json = Buffer.from(encoded, 'base64url').toString('utf8');
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return sanitizeConfig(parsed);
    } catch (_) {
        return null;
    }
}

/**
 * 合并服务端默认配置与链接里的配置（链接优先）
 */
function mergeConfig(defaults, override) {
    return { ...defaults, ...sanitizeConfig(override) };
}

/**
 * 配置指纹，用于区分同一服务的不同安装实例
 */
function configHash(cfg) {
    const basis = [
        cfg.llmBaseUrl || '',
        cfg.llmModel || '',
        cfg.opensubtitlesApiKey ? 'has-os-key' : 'no-os-key',
        cfg.llmApiKey ? 'has-llm-key' : 'no-llm-key',
        cfg.targetLang || '',
        cfg.sourceLang || '',
        cfg.subtitleSource || '',
        cfg.opensubtitlesUsername ? 'has-os-user' : 'no-os-user',
        String(cfg.translateBatchSize || ''),
    ].join('|');
    return crypto.createHash('sha1').update(basis).digest('hex');
}

/**
 * 生成带配置信息的 manifest
 * 不同配置用不同的 id，Stremio 才会把它们当成两个独立插件
 */
function buildManifest(baseManifest, cfg) {
    const hash = configHash(cfg).slice(0, 8);
    const model = (cfg.llmModel || '').split('/').pop();
    return {
        ...baseManifest,
        id: `${baseManifest.id}.${hash}`,
        name: model ? `${baseManifest.name} · ${model}` : baseManifest.name,
        behaviorHints: { configurable: true, configurationRequired: false },
    };
}

module.exports = {
    URL_CONFIG_FIELDS,
    SUBTITLE_SOURCES,
    sanitizeConfig,
    encodeConfig,
    decodeConfig,
    mergeConfig,
    configHash,
    buildManifest,
};
