/**
 * 翻译调度测试：并发、去重、过程中可见的进度
 * 这三件事决定了「Stremio 反复重试时能不能等到结果」
 */

const test = require('node:test');
const assert = require('node:assert');

const { startFakeLLM } = require('./helpers/fake-servers');
const {
    translateSubtitles,
    translateWithCache,
    getProgressSnapshot,
    clearCache,
} = require('../src/translator');

function makeEntries(n) {
    return Array.from({ length: n }, (_, i) => ({
        index: i + 1,
        startTime: '00:00:01,000',
        endTime: '00:00:02,000',
        text: `line ${i + 1}`,
    }));
}

function makeConfig(llmUrl, extra = {}) {
    return {
        llmBaseUrl: llmUrl,
        llmModel: 'bili-translate/Index-Translate-9B',
        llmApiKey: '',
        sourceLang: 'en',
        targetLang: 'zh',
        translateBatchSize: 4,
        translateConcurrency: 1,
        ...extra,
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('并发翻译：多批同时发，实际并发数符合配置', async () => {
    clearCache();
    const llm = await startFakeLLM(0, { delayMs: 150 });

    try {
        const entries = makeEntries(12); // 4 条/批 -> 3 批
        const started = Date.now();
        const { entries: out, stats } = await translateSubtitles(
            entries,
            makeConfig(llm.url, { translateConcurrency: 3 })
        );
        const elapsed = Date.now() - started;

        assert.equal(out.length, 12);
        assert.equal(stats.translated, 12);
        assert.equal(llm.calls.length, 3, '应为 3 批');
        assert.ok(llm.stats.maxActive >= 2, `并发应生效，实际峰值 ${llm.stats.maxActive}`);
        assert.ok(elapsed < 400, `并发后应明显快于串行(450ms)，实际 ${elapsed}ms`);
    } finally {
        llm.server.close();
    }
});

test('重复请求共用同一个翻译任务，不会重头再翻一遍', async () => {
    clearCache();
    const llm = await startFakeLLM(0, { delayMs: 120 });
    const cacheKey = 'dedupe-test';

    try {
        const entries = makeEntries(12); // 3 批
        const cfg = makeConfig(llm.url, { translateConcurrency: 1 });

        // 模拟 Stremio 连续两次请求同一部片
        const [a, b] = await Promise.all([
            translateWithCache(cacheKey, entries, cfg),
            translateWithCache(cacheKey, entries, cfg),
        ]);

        assert.equal(llm.calls.length, 3, `只应翻译 3 批，实际 ${llm.calls.length}`);
        assert.equal(a.entries.length, 12);
        assert.equal(b.entries.length, 12);
        assert.ok(b.shared === true, '第二个请求应标记为复用了进行中的任务');
        assert.equal(b.stats.translated, 12);

        // 完成后再请求，直接命中缓存，不再调用模型
        const c = await translateWithCache(cacheKey, entries, cfg);
        assert.equal(c.cached, true);
        assert.equal(llm.calls.length, 3);
    } finally {
        llm.server.close();
    }
});

test('翻译过程中就能读到已完成部分，用于先返回一部分字幕', async () => {
    clearCache();
    const llm = await startFakeLLM(0, { delayMs: 150 });
    const cacheKey = 'progress-test';

    try {
        const entries = makeEntries(12); // 3 批，串行
        const cfg = makeConfig(llm.url, { translateConcurrency: 1 });

        const pending = translateWithCache(cacheKey, entries, cfg);

        // 等第一批翻完，此时整体还没结束
        let snapshot = [];
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && snapshot.length === 0) {
            await sleep(20);
            snapshot = getProgressSnapshot(cacheKey);
        }

        assert.ok(snapshot.length > 0, '过程中应能读到已翻好的条目');
        assert.ok(snapshot.length < entries.length, '此时应还没翻完');
        assert.equal(snapshot[0].index, 1);
        assert.match(snapshot[0].text, /译文1/);

        const result = await pending;
        assert.equal(result.entries.length, 12);
        assert.equal(getProgressSnapshot(cacheKey).length, 0, '任务结束后进度快照应清理');
    } finally {
        llm.server.close();
    }
});

test('单批失败时该批退回原文，整体仍能产出字幕', async () => {
    clearCache();
    const llm = await startFakeLLM(0, { delayMs: 0 });

    try {
        const entries = makeEntries(8); // 2 批
        const cfg = makeConfig(llm.url, { translateConcurrency: 1, llmRetries: 0 });

        // 第二批开始前把服务关掉，制造失败
        const pending = translateSubtitles(entries, cfg);
        await sleep(30);
        llm.server.close();

        const { entries: out, stats } = await pending;
        assert.equal(out.length, 8, '条目数不能少');
        assert.ok(stats.translated >= 4, '至少第一批应成功');
        assert.ok(out.every((e) => typeof e.text === 'string' && e.text.length > 0));
    } catch (error) {
        // 全部失败时抛错也可以接受，但必须不是静默丢条目
        assert.match(String(error.message), /翻译|fetch|ECONN/i);
    }
});

test('第一批刻意用小批量，让首段中文更早出来', async () => {
    clearCache();
    const llm = await startFakeLLM(0, { delayMs: 0 });

    try {
        const entries = makeEntries(40);
        const cfg = makeConfig(llm.url, {
            translateBatchSize: 30,
            firstBatchSize: 10,
            translateConcurrency: 1,
        });

        await translateSubtitles(entries, cfg);

        const countCues = (call) => {
            const user = (call.messages || []).find((m) => m.role === 'user');
            return ((user && user.content) || '').split('\n').filter((l) => /^\[\d+\]/.test(l.trim())).length;
        };

        assert.equal(llm.calls.length, 2, '10 + 30 = 2 批');
        assert.equal(countCues(llm.calls[0]), 10, '第一批应为 10 条');
        assert.equal(countCues(llm.calls[1]), 30, '第二批按正常大小');
    } finally {
        llm.server.close();
    }
});
