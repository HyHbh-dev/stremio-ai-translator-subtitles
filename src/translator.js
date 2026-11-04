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

// 简单内存缓存: cacheKey -> { translations, timestamp }
const cache = new Map();

/**
 * 将字幕条目分批
 * @param {Array} entries - 字幕条目
 * @param {number} batchSize - 每批大小
 * @returns {Array<Array>} 分批后的数组
 */
function chunkEntries(entries, batchSize) {
    const chunks = [];
    for (let i = 0; i < entries.length; i += batchSize) {
        chunks.push(entries.slice(i, i + batchSize));
    }
    return chunks;
}

/**
 * 判断是否为 Index-Translate 系列翻译模型
 * Index-Translate 是 B站开源的专业翻译模型，prompt 可以更简洁
 */
function isIndexTranslateModel(modelName) {
    return modelName && modelName.toLowerCase().includes('index-translate');
}

/**
 * 构建翻译 prompt (针对通用大模型)
 */
function buildGeneralPrompt(entries, targetLang) {
    const langMap = {
        zh: '中文',
        en: 'English',
        ja: '日本語',
        ko: '한국어',
        fr: 'Français',
        de: 'Deutsch',
        es: 'Español',
    };
    const langName = langMap[targetLang] || targetLang;

    const lines = entries.map(e => `[${e.index}] ${e.text}`).join('\n');

    return `你是一位专业的影视字幕翻译专家。请将以下字幕文本翻译成${langName}。

要求：
1. 保持字幕的口语化和自然表达，符合影视对话风格
2. 准确传达原文含义，不遗漏、不添加
3. 每行字幕单独翻译，保持原有的换行结构
4. 保持 [序号] 格式不变，只翻译文本内容
5. 如果原文已包含中文，则保持原文不变
6. 注意上下文语境，保持前后一致性

字幕文本：
${lines}

请输出翻译结果，保持 [序号] 格式：`;
}

/**
 * 构建翻译 prompt (针对 Index-Translate 专业翻译模型)
 * Index-Translate 已针对翻译优化，prompt 更简洁
 */
function buildIndexTranslatePrompt(entries, targetLang) {
    const langMap = {
        zh: '中文',
        en: 'English',
        ja: '日本語',
        ko: '한국어',
        fr: 'Français',
        de: 'Deutsch',
        es: 'Español',
    };
    const langName = langMap[targetLang] || targetLang;

    const lines = entries.map(e => `[${e.index}] ${e.text}`).join('\n');

    return `请将以下字幕文本翻译成${langName}，保持 [序号] 格式不变，只输出翻译结果：

${lines}`;
}

/**
 * 从大模型回复中解析翻译结果
 * @param {string} response - 大模型回复
 * @param {Array} entries - 原始字幕条目
 * @returns {Array<{index, text}>} 翻译结果
 */
function parseTranslationResponse(response, entries) {
    const translations = {};
    const lines = response.split('\n');

    for (const line of lines) {
        // 匹配 [序号] 翻译文本 的格式
        const match = line.match(/^\[(\d+)\]\s*(.+)$/);
        if (match) {
            const idx = parseInt(match[1], 10);
            const text = match[2].trim();
            if (text) {
                translations[idx] = text;
            }
        }
    }

    // 将翻译结果映射回字幕条目
    const results = [];
    for (const entry of entries) {
        const translatedText = translations[entry.index] || entry.text; // 翻译失败保留原文
        results.push({
            index: entry.index,
            text: translatedText,
        });
    }

    return results;
}

/**
 * 调用大模型 API 翻译一批字幕
 * @param {Array} entries - 字幕条目
 * @param {object} config - 配置
 * @returns {Promise<Array<{index, text}>>} 翻译结果
 */
async function translateBatch(entries, config) {
    const isIndexModel = isIndexTranslateModel(config.llmModel);
    const prompt = isIndexModel
        ? buildIndexTranslatePrompt(entries, config.targetLang)
        : buildGeneralPrompt(entries, config.targetLang);

    // 构建 headers (本地 Magpie 服务不需要 Authorization)
    const headers = { 'Content-Type': 'application/json' };
    if (config.llmApiKey) {
        headers['Authorization'] = `Bearer ${config.llmApiKey}`;
    }

    try {
        const response = await axios.post(
            `${config.llmBaseUrl}/chat/completions`,
            {
                model: config.llmModel,
                messages: [
                    {
                        role: 'system',
                        content: isIndexModel
                            ? 'You are a professional subtitle translator.'
                            : '你是一位专业的影视字幕翻译专家，擅长将影视对话翻译成目标语言，保持口语化和自然表达。'
                    },
                    {
                        role: 'user',
                        content: prompt,
                    }
                ],
                temperature: 0.3,
                max_tokens: Math.min(4000, entries.length * 200),
            },
            {
                headers,
                timeout: 120000, // 本地模型可能较慢，给 2 分钟
            }
        );

        const reply = response.data.choices[0].message.content;
        return parseTranslationResponse(reply, entries);
    } catch (error) {
        console.error(`[translator] 翻译批次失败: ${error.message}`);
        if (error.response) {
            console.error(`[translator] API 响应状态: ${error.response.status}`);
            console.error(`[translator] API 响应: ${JSON.stringify(error.response.data)}`);
        }
        // 翻译失败时返回原文
        return entries.map(e => ({ index: e.index, text: e.text }));
    }
}

/**
 * 翻译完整字幕
 * @param {Array<{index, startTime, endTime, text}>} entries - 字幕条目
 * @param {object} config - 配置
 * @param {function} onProgress - 进度回调 (0-100)
 * @returns {Promise<Array<{index, startTime, endTime, text}>>} 翻译后的字幕条目
 */
async function translateSubtitles(entries, config, onProgress) {
    if (!entries || entries.length === 0) {
        return [];
    }

    const batchSize = config.translateBatchSize || 30;
    const chunks = chunkEntries(entries, batchSize);
    const isIndexModel = isIndexTranslateModel(config.llmModel);
    console.log(`[translator] 共 ${entries.length} 条字幕，分为 ${chunks.length} 批 (每批 ${batchSize} 条)`);
    console.log(`[translator] 模型: ${config.llmModel} ${isIndexModel ? '(Index-Translate 专业翻译模型)' : '(通用大模型)'}`);

    const translatedEntries = [];
    let completed = 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`[translator] 翻译第 ${i + 1}/${chunks.length} 批 (${chunk.length} 条)...`);

        const results = await translateBatch(chunk, config);

        // 将翻译后的文本合并回原始条目 (保留时间轴)
        for (const entry of chunk) {
            const translated = results.find(r => r.index === entry.index);
            translatedEntries.push({
                index: entry.index,
                startTime: entry.startTime,
                endTime: entry.endTime,
                text: translated ? translated.text : entry.text,
            });
        }

        completed++;
        if (onProgress) {
            const progress = Math.round((completed / chunks.length) * 100);
            onProgress(progress);
        }

        // 批次间短暂延迟 (本地模型不需要延迟)
        if (i < chunks.length - 1 && !isIndexModel) {
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    // 按原始顺序排序
    translatedEntries.sort((a, b) => a.index - b.index);

    console.log(`[translator] 翻译完成，共 ${translatedEntries.length} 条`);
    return translatedEntries;
}

/**
 * 获取缓存或翻译字幕
 */
async function translateWithCache(cacheKey, entries, config, onProgress) {
    const cached = cache.get(cacheKey);
    if (cached) {
        const age = Date.now() - cached.timestamp;
        const ttl = (config.cacheTtlHours || 24) * 60 * 60 * 1000;
        if (age < ttl) {
            console.log(`[translator] 命中缓存: ${cacheKey}`);
            if (onProgress) onProgress(100);
            return cached.translations;
        }
    }

    const translations = await translateSubtitles(entries, config, onProgress);
    cache.set(cacheKey, { translations, timestamp: Date.now() });
    return translations;
}

module.exports = {
    translateSubtitles,
    translateBatch,
    translateWithCache,
    chunkEntries,
    isIndexTranslateModel,
};
