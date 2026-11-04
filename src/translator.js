/**
 * translator.js
 * 使用大模型 (OpenAI 兼容接口) 翻译字幕
 *
 * 支持的模型：
 *   - bili-translate/Index-Translate-9B (B站开源翻译模型，推荐)
 *   - bili-translate/Index-Translate-2B / 35B-A3B
 *   - OpenAI gpt-4o-mini / DeepSeek deepseek-chat 等通用大模型
 */

const axios = require('axios');

// 简单内存缓存: cacheKey -> { result, timestamp }
const cache = new Map();

/**
 * 将字幕条目分批
 * @param {Array} entries - 字幕条目
 * @param {number} batchSize - 每批大小
 * @returns {Array<Array>} 分批后的数组
 */
function chunkEntries(entries, batchSize) {
    const chunks = [];
    const size = batchSize > 0 ? batchSize : 30;
    for (let i = 0; i < entries.length; i += size) {
        chunks.push(entries.slice(i, i + size));
    }
    return chunks;
}

/**
 * 判断是否为 Index-Translate 系列翻译模型
 * Index-Translate 是 B站开源的专业翻译模型，prompt 可以更简洁
 */
function isIndexTranslateModel(modelName) {
    return !!modelName && modelName.toLowerCase().includes('index-translate');
}

const LANG_NAMES = {
    zh: '中文',
    'zh-cn': '中文',
    'zh-tw': '繁体中文',
    en: 'English',
    ja: '日本語',
    ko: '한국어',
    fr: 'Français',
    de: 'Deutsch',
    es: 'Español',
};

/**
 * 构建翻译 prompt
 * @param {Array} entries - 字幕条目
 * @param {string} targetLang - 目标语言
 * @param {boolean} concise - 是否使用简洁版 (Index-Translate 专用)
 */
function buildPrompt(entries, targetLang, concise = false) {
    const langName = LANG_NAMES[targetLang] || targetLang;
    const lines = entries.map(e => `[${e.index}] ${e.text}`).join('\n');

    if (concise) {
        return `请将以下字幕文本翻译成${langName}，保持 [序号] 格式不变，只输出翻译结果。
每条字幕的换行请原样保留。

${lines}`;
    }

    return `你是一位专业的影视字幕翻译专家。请将以下字幕文本翻译成${langName}。

要求：
1. 保持字幕的口语化和自然表达，符合影视对话风格
2. 准确传达原文含义，不遗漏、不添加
3. 每行字幕单独翻译，保持原有的换行结构
4. 保持 [序号] 格式不变，只翻译文本内容
5. 如果原文已包含中文，则保持原文不变
6. 注意上下文语境，保持前后一致性
7. 只输出翻译结果，不要输出任何解释

字幕文本：
${lines}

请输出翻译结果，保持 [序号] 格式：`;
}

/**
 * 从大模型回复中解析翻译结果
 *
 * 说明：一条字幕常常包含多行（例如 "-What was your response?" + "-I told her..."），
 * 模型会原样保留换行。所以这里按"块"解析：以 [序号] 开头的行开启一条新字幕，
 * 后续不以 [序号] 开头的行都视为该条字幕的续行。
 *
 * @param {string} response - 大模型回复
 * @param {Array} entries - 原始字幕条目
 * @returns {{results: Array<{index, text}>, matched: number}} 翻译结果
 */
function parseTranslationResponse(response, entries) {
    const results = [];
    if (typeof response !== 'string' || !response.trim()) {
        return { results: entries.map(e => ({ index: e.index, text: e.text })), matched: 0 };
    }

    // 去掉可能的 markdown 代码块围栏
    const cleaned = response.replace(/```[a-zA-Z]*\n?/g, '');

    // 支持 [12] 中文 / 【12】中文 / 12. 中文 / 12、中文 这几种写法
    const headPattern = /^[\[【](\d{1,5})[\]】]\s*(.*)$/;
    const altPattern = /^(\d{1,5})[.、)]\s+(.+)$/;

    const blocks = [];
    let current = null;

    for (const rawLine of cleaned.replace(/\r\n/g, '\n').split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        const head = line.match(headPattern) || line.match(altPattern);
        if (head) {
            if (current) blocks.push(current);
            current = { index: parseInt(head[1], 10), text: head[2].trim() };
        } else if (current) {
            // 续行：保留换行结构
            current.text = current.text ? `${current.text}\n${line}` : line;
        }
    }
    if (current) blocks.push(current);

    const map = new Map();
    for (const block of blocks) {
        const text = block.text.trim();
        if (text) map.set(block.index, text);
    }

    let matched = 0;
    for (const entry of entries) {
        if (map.has(entry.index)) {
            matched++;
            results.push({ index: entry.index, text: map.get(entry.index) });
        } else {
            // 翻译结果缺失时保留原文，避免字幕消失
            results.push({ index: entry.index, text: entry.text });
        }
    }

    // 注意：这里刻意不做"按行顺序硬映射"的兜底，
    // 一旦模型跑题会把错行文串进字幕，比回退原文更糟。
    return { results, matched };
}

/**
 * 判断错误是否值得重试（网络抖动 / 限流 / 上游 5xx）
 */
function isRetryableError(error) {
    if (!error.response) return true;
    const status = error.response.status;
    return status === 429 || status >= 500;
}

/**
 * 判断是否为本机地址
 * 本机服务（如 Magpie）不应走 HTTP_PROXY，否则会被代理拦成 404
 */
function isLoopbackUrl(baseUrl) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(baseUrl);
}

/**
 * 调用大模型 API 翻译一批字幕
 * @param {Array} entries - 字幕条目
 * @param {object} config - 配置
 * @param {number} [attempt] - 当前尝试次数 (内部使用)
 * @returns {Promise<{results: Array<{index, text}>, matched: number, ok: boolean}>}
 */
async function translateBatch(entries, config, attempt = 1) {
    const isIndexModel = isIndexTranslateModel(config.llmModel);
    const prompt = buildPrompt(entries, config.targetLang, isIndexModel);
    const baseUrl = config.llmBaseUrl.replace(/\/+$/, '');

    // 构建 headers (本地 Magpie 服务不需要 Authorization)
    const headers = { 'Content-Type': 'application/json' };
    if (config.llmApiKey) {
        headers['Authorization'] = `Bearer ${config.llmApiKey}`;
    }

    try {
        const response = await axios.post(
            `${baseUrl}/chat/completions`,
            {
                model: config.llmModel,
                messages: [
                    {
                        role: 'system',
                        content: isIndexModel
                            ? 'You are a professional subtitle translator.'
                            : '你是一位专业的影视字幕翻译专家，擅长将影视对话翻译成目标语言，保持口语化和自然表达。',
                    },
                    {
                        role: 'user',
                        content: prompt,
                    },
                ],
                temperature: 0.3,
                max_tokens: Math.min(8192, Math.max(1024, entries.length * 160)),
            },
            {
                headers,
                // 本机服务绕过系统代理
                proxy: isLoopbackUrl(baseUrl) ? false : undefined,
                timeout: 120000, // 本地模型可能较慢，给 2 分钟
            }
        );

        const choice = response.data && response.data.choices && response.data.choices[0];
        const reply = choice && choice.message && choice.message.content;
        if (typeof reply !== 'string') {
            throw new Error('大模型返回内容为空或格式异常');
        }

        const { results, matched } = parseTranslationResponse(reply, entries);
        return { results, matched, ok: matched > 0 };
    } catch (error) {
        console.error(`[translator] 翻译批次失败 (第 ${attempt} 次): ${error.message}`);
        if (error.response) {
            console.error(`[translator] API 响应状态: ${error.response.status}`);
            console.error(`[translator] API 响应: ${JSON.stringify(error.response.data).slice(0, 300)}`);
        }

        if (attempt < 2 && isRetryableError(error)) {
            await new Promise(resolve => setTimeout(resolve, 800));
            return translateBatch(entries, config, attempt + 1);
        }

        // 翻译失败时返回原文，保证字幕时间轴仍然可用
        return {
            results: entries.map(e => ({ index: e.index, text: e.text })),
            matched: 0,
            ok: false,
        };
    }
}

/**
 * 翻译完整字幕
 * @param {Array<{index, startTime, endTime, text}>} entries - 字幕条目
 * @param {object} config - 配置
 * @param {function} onProgress - 进度回调 (0-100)
 * @returns {Promise<{entries: Array, stats: {total, translated, fallback}}>}
 */
/**
 * 把「首批 + 顺序批次」重排成「首批 + 分段交错」。
 * 首批（片头那一小段）保持第一位，其余批次切成 concurrency 个连续段，
 * 再按段轮转交错取出，这样并发 worker 天然落在片头 / 25% / 50% / 75% 附近，
 * 用户从任意位置开始播放，都不至于长时间只有原文。
 */
function interleaveChunks(chunks, concurrency) {
    if (concurrency <= 1 || chunks.length <= concurrency + 1) return chunks;
    const [head, ...rest] = chunks;
    const seg = Math.ceil(rest.length / concurrency);
    const parts = [];
    for (let i = 0; i < rest.length; i += seg) parts.push(rest.slice(i, i + seg));

    const ordered = [];
    const maxLen = Math.max(...parts.map((part) => part.length));
    for (let i = 0; i < maxLen; i++) {
        for (const part of parts) {
            if (i < part.length) ordered.push(part[i]);
        }
    }
    return [head, ...ordered];
}

async function translateSubtitles(entries, config, onProgress, options = {}) {
    if (!entries || entries.length === 0) {
        return { entries: [], stats: { total: 0, translated: 0, fallback: 0 } };
    }

    const batchSize = config.translateBatchSize || 30;
    // 第一批故意做小：Stremio 请求字幕有超时，先用一小批换出「第一段中文」，
    // 后面的批次仍按正常大小跑，整体速度不受影响
    const firstSize = Math.min(
        batchSize,
        Math.max(1, Number(config.firstBatchSize) || 12)
    );

    const rawChunks = firstSize < batchSize && entries.length > firstSize
        ? [entries.slice(0, firstSize), ...chunkEntries(entries.slice(firstSize), batchSize)]
        : chunkEntries(entries, batchSize);
    const isIndexModel = isIndexTranslateModel(config.llmModel);
    const concurrency = Math.min(8, Math.max(1, Number(config.translateConcurrency) || 1));
    // Stremio 请求字幕时不会带播放位置，用户完全可能从中间开始看。
    // 若所有 worker 都按顺序从片头啃，中途那段要很久才轮得到中文，所以把并发
    // 分散到全片不同位置；首批仍留在片头，保证从头看的用户先看到连续中文。
    const chunks = interleaveChunks(rawChunks, concurrency);
    const sink = Array.isArray(options.sink) ? options.sink : null;

    console.log(`[translator] 共 ${entries.length} 条字幕，分为 ${chunks.length} 批 (每批 ${batchSize} 条，并发 ${concurrency})`);
    console.log(`[translator] 模型: ${config.llmModel} ${isIndexModel ? '(Index-Translate 专业翻译模型)' : '(通用大模型)'}`);

    const perChunk = new Array(chunks.length);
    let cursor = 0;
    let completed = 0;
    let translatedCount = 0;

    const worker = async () => {
        while (cursor < chunks.length) {
            const i = cursor++;
            const chunk = chunks[i];
            console.log(`[translator] 翻译第 ${i + 1}/${chunks.length} 批 (${chunk.length} 条)...`);

            const { results, matched } = await translateBatch(chunk, config);
            const map = new Map(results.map(r => [r.index, r.text]));

            // 将翻译后的文本合并回原始条目 (保留时间轴)
            perChunk[i] = chunk.map((entry) => ({
                index: entry.index,
                startTime: entry.startTime,
                endTime: entry.endTime,
                text: map.has(entry.index) ? map.get(entry.index) : entry.text,
            }));

            translatedCount += matched;
            completed++;

            // 让调用方随时可以读到「已经翻好哪些」，用于先返回部分结果
            if (sink) sink.push(...perChunk[i]);

            if (onProgress) {
                const progress = Math.round((completed / chunks.length) * 100);
                onProgress(progress);
            }

            // 批次间短暂延迟 (本地模型不需要延迟；有并发时也不需要)
            if (concurrency === 1 && i < chunks.length - 1 && !isIndexModel) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker())
    );

    // 按原始顺序排序
    const translatedEntries = perChunk.flat().sort((a, b) => a.index - b.index);

    const stats = {
        total: translatedEntries.length,
        translated: translatedCount,
        fallback: translatedEntries.length - translatedCount,
    };
    console.log(`[translator] 翻译完成，共 ${stats.total} 条，成功 ${stats.translated} 条，回退原文 ${stats.fallback} 条`);

    return { entries: translatedEntries, stats };
}

// 进行中的翻译任务：同一部片的重复请求（Stremio 会不停重试）共用一个任务，
// 否则每次重试都从第 1 批重新开始，永远翻不完
const inflight = new Map();
// 进行中任务的已完成条目，供"先返回一部分"读取
const progressSnapshots = new Map();

/**
 * 读取某个任务当前已翻好的条目（可能为空）
 */
function getProgressSnapshot(cacheKey) {
    const items = progressSnapshots.get(cacheKey);
    return items ? items.slice() : [];
}

/**
 * 获取缓存或翻译字幕
 * @returns {Promise<{entries: Array, stats: object, cached: boolean, shared?: boolean}>}
 */
async function translateWithCache(cacheKey, entries, config, onProgress) {
    const cached = cache.get(cacheKey);
    if (cached) {
        const age = Date.now() - cached.timestamp;
        const ttl = (config.cacheTtlHours || 24) * 60 * 60 * 1000;
        if (age < ttl) {
            console.log(`[translator] 命中缓存: ${cacheKey}`);
            if (onProgress) onProgress(100);
            return { ...cached.result, cached: true };
        }
        cache.delete(cacheKey);
    }

    const existing = inflight.get(cacheKey);
    if (existing) {
        console.log(`[translator] 复用进行中的翻译任务: ${cacheKey}`);
        const result = await existing;
        return { ...result, cached: false, shared: true };
    }

    const sink = [];
    progressSnapshots.set(cacheKey, sink);

    const task = (async () => {
        const result = await translateSubtitles(entries, config, onProgress, { sink });
        cache.set(cacheKey, { result, timestamp: Date.now() });
        return result;
    })().finally(() => {
        inflight.delete(cacheKey);
        progressSnapshots.delete(cacheKey);
    });

    // 后面可能有请求已经放弃等待，避免未处理的 rejection
    task.catch(() => {});
    inflight.set(cacheKey, task);

    const result = await task;
    return { ...result, cached: false };
}

/**
 * 清空翻译缓存
 */
function clearCache() {
    cache.clear();
}

/**
 * 当前缓存条目数
 */
function cacheSize() {
    return cache.size;
}

module.exports = {
    translateSubtitles,
    translateBatch,
    translateWithCache,
    getProgressSnapshot,
    chunkEntries,
    interleaveChunks,
    isIndexTranslateModel,
    buildPrompt,
    parseTranslationResponse,
    clearCache,
    cacheSize,
    _inflightSize: () => inflight.size,
};
