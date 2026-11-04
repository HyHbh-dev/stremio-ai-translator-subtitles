/**
 * 单元测试：字幕解析、VTT 生成、翻译结果解析、ID 解析
 * 运行: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    parseSRT,
    parseVTT,
    parseSubtitle,
    entriesToVTT,
    pickBestSubtitle,
    decodeSubtitleContent,
} = require('../src/subtitleFetcher');
const {
    chunkEntries,
    interleaveChunks,
    isIndexTranslateModel,
    buildPrompt,
    parseTranslationResponse,
} = require('../src/translator');
const { parseMediaId } = require('../src/mediaId');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('parseSRT 能解析序号、时间轴和多行字幕', () => {
    const entries = parseSRT(fixture('sample.srt'));
    assert.strictEqual(entries.length, 3);
    assert.deepStrictEqual(entries[0], {
        index: 1,
        startTime: '00:00:01,000',
        endTime: '00:00:03,000',
        text: 'Hello there.',
    });
    // 双行字幕必须完整保留，不能被截断
    assert.strictEqual(entries[1].text, '-What was your response?\n-I told her I would not grant one.');
    assert.strictEqual(entries[2].text, '<i>It was very bitter.</i>');
});

test('parseSRT 兼容 CRLF 与 BOM', () => {
    const content = '\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n\r\n';
    const entries = parseSRT(content);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].text, 'Hi');
});

test('parseVTT 能跳过 WEBVTT 头、Kind/Language 与 cue 标识', () => {
    const entries = parseVTT(fixture('sample.vtt'));
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].startTime, '00:01.000');
    assert.strictEqual(entries[1].text, 'Second line one,\nsecond line two.');
});

test('parseSubtitle 能自动识别格式', () => {
    assert.strictEqual(parseSubtitle(fixture('sample.srt')).length, 3);
    assert.strictEqual(parseSubtitle(fixture('sample.vtt')).length, 2);
    assert.deepStrictEqual(parseSubtitle(''), []);
});

test('entriesToVTT 输出合法 VTT（时间用点号、MM:SS 补全、过滤 -->）', () => {
    const vtt = entriesToVTT([
        { index: 1, startTime: '00:00:01,000', endTime: '00:00:03,000', text: '你好' },
        { index: 2, startTime: '00:01.000', endTime: '00:02.000', text: 'a --> b' },
    ]);

    assert.ok(vtt.startsWith('WEBVTT\n\n'));
    assert.ok(vtt.includes('00:00:01.000 --> 00:00:03.000'));
    assert.ok(vtt.includes('00:00:01.000 --> 00:00:02.000'));
    // 正文里的 --> 会被解析成新的时间轴，必须转义掉
    assert.ok(vtt.includes('a → b'));
    assert.ok(!vtt.includes('a --> b'));
});

test('pickBestSubtitle 优先选择非听障字幕', () => {
    const best = pickBestSubtitle([
        { fileId: 1, downloadCount: 900, hearingImpaired: true },
        { fileId: 2, downloadCount: 50, hearingImpaired: false },
    ]);
    assert.strictEqual(best.fileId, 2);
    assert.strictEqual(pickBestSubtitle([]), null);
});

test('decodeSubtitleContent 能处理 UTF-8 BOM 与非 UTF-8 编码', () => {
    assert.strictEqual(decodeSubtitleContent(Buffer.from('\uFEFFhello', 'utf8')), 'hello');
    // windows-1252 的 é 是 0xE9，不是合法 UTF-8
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    assert.strictEqual(decodeSubtitleContent(latin1), 'café');
});

test('parseMediaId 区分电影与剧集', () => {
    assert.deepStrictEqual(parseMediaId('tt0111161'), {
        imdbId: 'tt0111161', isSeries: false, season: null, episode: null,
    });
    assert.deepStrictEqual(parseMediaId('tt0944947:1:2'), {
        imdbId: 'tt0944947', isSeries: true, season: 1, episode: 2,
    });
});

test('chunkEntries 按批次切分', () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({ index: i + 1, text: `t${i}` }));
    assert.deepStrictEqual(chunkEntries(entries, 3).map(c => c.length), [3, 3, 1]);
    assert.deepStrictEqual(chunkEntries([], 30), []);
});

test('isIndexTranslateModel 识别 B站翻译模型', () => {
    assert.ok(isIndexTranslateModel('bili-translate/Index-Translate-9B'));
    assert.ok(!isIndexTranslateModel('deepseek-chat'));
    assert.ok(!isIndexTranslateModel(undefined));
});

test('buildPrompt 保留 [序号] 并包含多行原文', () => {
    const prompt = buildPrompt([
        { index: 1, text: 'Hello' },
        { index: 2, text: 'line one\nline two' },
    ], 'zh');

    assert.ok(prompt.includes('[1] Hello'));
    assert.ok(prompt.includes('[2] line one\nline two'));
    assert.ok(prompt.includes('中文'));
});

test('parseTranslationResponse 能还原多行译文（此前的实现会丢行）', () => {
    const entries = [
        { index: 1, text: 'Hello' },
        { index: 2, text: '-What was your response?\n-I told her I would not grant one.' },
    ];
    const reply = '[1] 你好\n[2] -你当时怎么回应？\n-我告诉她我不会同意。';

    const { results, matched } = parseTranslationResponse(reply, entries);
    assert.strictEqual(matched, 2);
    assert.strictEqual(results[0].text, '你好');
    assert.strictEqual(results[1].text, '-你当时怎么回应？\n-我告诉她我不会同意。');
});

test('parseTranslationResponse 容忍 markdown 围栏与全角括号', () => {
    const entries = [{ index: 1, text: 'Hello' }];
    const reply = '```\n【1】你好\n```';
    const { results } = parseTranslationResponse(reply, entries);
    assert.strictEqual(results[0].text, '你好');
});

test('parseTranslationResponse 在序号缺失时保留原文，不做按行硬映射', () => {
    const entries = [
        { index: 5, text: 'fallback text' },
        { index: 6, text: 'another text' },
    ];
    const { results, matched } = parseTranslationResponse('甲\n乙', entries);
    assert.strictEqual(matched, 0);
    assert.deepStrictEqual(results.map(r => r.text), ['fallback text', 'another text']);
});

// ============================================
// 安装配置（/configure 生成的链接）
// ============================================

const {
    encodeConfig,
    decodeConfig,
    sanitizeConfig,
    mergeConfig,
    configHash,
    buildManifest,
} = require('../src/addonConfig');

test('encodeConfig / decodeConfig 能往返传递配置', () => {
    const token = encodeConfig({
        llmBaseUrl: 'http://127.0.0.1:3425/v1/',
        llmModel: 'bili-translate/Index-Translate-9B',
        opensubtitlesApiKey: 'abc123',
        targetLang: 'zh',
        translateBatchSize: 40,
    });

    const cfg = decodeConfig(token);
    assert.strictEqual(cfg.llmBaseUrl, 'http://127.0.0.1:3425/v1'); // 去掉尾部斜杠
    assert.strictEqual(cfg.llmModel, 'bili-translate/Index-Translate-9B');
    assert.strictEqual(cfg.opensubtitlesApiKey, 'abc123');
    assert.strictEqual(cfg.translateBatchSize, 40);
});

test('sanitizeConfig 丢弃非法字段但保留合法字段', () => {
    const cfg = sanitizeConfig({
        llmBaseUrl: 'ftp://bad',
        llmModel: 'x',
        translateBatchSize: 9999,
        targetLang: 'zh',
        unknown: 'should be dropped',
    });

    assert.strictEqual(cfg.llmBaseUrl, undefined);
    assert.strictEqual(cfg.translateBatchSize, undefined);
    assert.strictEqual(cfg.targetLang, 'zh');
    assert.strictEqual(cfg.unknown, undefined);
});

test('decodeConfig 对垃圾输入返回 null', () => {
    assert.strictEqual(decodeConfig('not-a-config'), null);
    assert.strictEqual(decodeConfig(''), null);
    assert.strictEqual(decodeConfig(Buffer.from('[1,2,3]').toString('base64url')), null);
});

test('mergeConfig 中链接配置覆盖服务端默认值', () => {
    const defaults = { llmModel: 'env-model', targetLang: 'zh', opensubtitlesApiKey: '' };
    const merged = mergeConfig(defaults, { llmModel: 'url-model', opensubtitlesApiKey: 'k' });

    assert.strictEqual(merged.llmModel, 'url-model');
    assert.strictEqual(merged.opensubtitlesApiKey, 'k');
    assert.strictEqual(merged.targetLang, 'zh');
});

test('configHash 区分模型但不泄露 Key 内容', () => {
    const base = { llmBaseUrl: 'http://x/v1', llmModel: 'm1', targetLang: 'zh', sourceLang: 'en' };
    assert.notStrictEqual(
        configHash({ ...base }).slice(0, 8),
        configHash({ ...base, llmModel: 'm2' }).slice(0, 8)
    );
    assert.strictEqual(
        configHash({ ...base, opensubtitlesApiKey: 'a' }),
        configHash({ ...base, opensubtitlesApiKey: 'b' })
    );
});

test('buildManifest 为不同配置生成不同的 addon', () => {
    const base = {
        id: 'org.ai-translator.subtitles',
        version: '1.0.0',
        name: 'AI 字幕翻译',
        behaviorHints: {},
    };
    const a = buildManifest(base, { llmModel: 'bili-translate/Index-Translate-9B' });
    const b = buildManifest(base, { llmModel: 'deepseek-chat' });

    assert.ok(a.id.startsWith('org.ai-translator.subtitles.'));
    assert.notStrictEqual(a.id, b.id);
    assert.ok(a.name.includes('Index-Translate-9B'));
    assert.strictEqual(a.behaviorHints.configurable, true);
});

// ============================================
// 旧版接口（免 Key 通道）
// ============================================

const { startFakeLegacy } = require('./helpers/fake-servers');
const { searchSubtitlesLegacy, downloadSubtitleLegacy, _resetTokenCache } = require('../src/legacyFetcher');
const { fetchFromLegacy, fetchFromCdn, fetchBestSubtitle } = require('../src/subtitleFetcher');

test('旧接口：登录 + 搜索 + gzip 下载能走通', async () => {
    const legacy = await startFakeLegacy();
    _resetTokenCache();

    const cfg = {
        opensubtitlesLegacyUrl: legacy.url,
        opensubtitlesUserAgent: 'test-agent',
        sourceLang: 'en',
    };

    try {
        const list = await searchSubtitlesLegacy('tt0111161', 'en', cfg, {});
        assert.strictEqual(list.length, 2);
        assert.strictEqual(list[0].fileName, 'legacy-hi.srt');
        assert.strictEqual(list[0].hearingImpaired, true);
        assert.strictEqual(list[1].hearingImpaired, false);
        assert.ok(legacy.calls.includes('LogIn'), '应先登录拿 token');

        // gzip 解压后应拿到可解析的 SRT
        const content = await downloadSubtitleLegacy(list[1].downloadLink, cfg);
        assert.ok(content.includes('-->'), '下载内容应是解压后的 SRT');
    } finally {
        legacy.server.close();
    }
});

test('旧接口：优先选非听障字幕并解析出条目', async () => {
    const legacy = await startFakeLegacy();
    _resetTokenCache();

    const cfg = {
        opensubtitlesLegacyUrl: legacy.url,
        opensubtitlesUserAgent: 'test-agent',
        sourceLang: 'en',
    };

    try {
        const result = await fetchFromLegacy('tt0111161', cfg, {});
        assert.ok(result, '应取到字幕');
        assert.strictEqual(result.subtitleInfo.fileName, 'legacy-clean.srt');
        assert.ok(result.entries.length > 0);
    } finally {
        legacy.server.close();
    }
});

test('auto 模式：新版接口不可用时回退旧接口（有账号）', async () => {
    const legacy = await startFakeLegacy();
    _resetTokenCache();

    const cfg = {
        opensubtitlesLegacyUrl: legacy.url,
        opensubtitlesBaseUrl: 'http://127.0.0.1:9/api/v1', // 必然连不上
        opensubtitlesApiKey: '',
        opensubtitlesUsername: 'demo-user',
        opensubtitlesPassword: 'demo-pass',
        opensubtitlesUserAgent: 'test-agent',
        sourceLang: 'en',
        subtitleSource: 'auto',
    };

    try {
        const result = await fetchBestSubtitle('tt0111161', cfg, {});
        assert.ok(result, '旧接口应兜底成功');
        assert.strictEqual(result.source, 'legacy');
    } finally {
        legacy.server.close();
    }
});

test('subtitleSource 只接受 auto / rest / legacy', () => {
    assert.strictEqual(sanitizeConfig({ subtitleSource: 'legacy' }).subtitleSource, 'legacy');
    assert.strictEqual(sanitizeConfig({ subtitleSource: 'AUTO' }).subtitleSource, 'auto');
    assert.strictEqual(sanitizeConfig({ subtitleSource: 'ftp' }).subtitleSource, undefined);
});

// ============================================
// 占位字幕识别 & 官方 CDN 通道
// ============================================

const { isPromoPlaceholder } = require('../src/legacyFetcher');
const {
    normalizeLang,
    searchSubtitlesViaCdn,
    downloadSubtitleViaCdn,
} = require('../src/stremioCdnFetcher');
const { startFakeCdn } = require('./helpers/fake-servers');

test('能识别「开通 VIP」占位字幕', () => {
    const promo = '1\n00:00:00,001 --> 04:00:00,002\nBecome OpenSubtitles.org VIP member \nto get subtitles -> osdb.link/vip';
    assert.strictEqual(isPromoPlaceholder(promo), true);

    const normal = '1\n00:00:01,000 --> 00:00:02,000\nHello there';
    assert.strictEqual(isPromoPlaceholder(normal), false);

    // 大文件即使含关键字也不当成占位
    assert.strictEqual(isPromoPlaceholder('osdb.link ' + 'x'.repeat(1000)), false);
});

test('语言码归一化：eng -> en', () => {
    assert.strictEqual(normalizeLang('eng'), 'en');
    assert.strictEqual(normalizeLang('zho'), 'zh');
    assert.strictEqual(normalizeLang('EN'), 'en');
});

test('官方 CDN：按语言过滤并解析出条目', async () => {
    const cdn = await startFakeCdn();
    const cfg = { stremioCdnUrl: cdn.url, sourceLang: 'en' };

    try {
        const list = await searchSubtitlesViaCdn('tt0111161', 'en', cfg, {});
        assert.strictEqual(list.length, 2, '西班牙语字幕应被过滤掉');
        assert.ok(list.every((s) => s.language === 'eng'));

        const content = await downloadSubtitleViaCdn(list[0].downloadLink, cfg);
        assert.ok(content.includes('-->'));
    } finally {
        cdn.server.close();
    }
});

test('官方 CDN：优先选非听障字幕', async () => {
    const cdn = await startFakeCdn();
    const cfg = { stremioCdnUrl: cdn.url, sourceLang: 'en' };

    try {
        const result = await fetchFromCdn('tt0111161', cfg, {});
        assert.ok(result, '应取到字幕');
        assert.strictEqual(result.subtitleInfo.fileName, 'movie.2020.1080p.srt');
        assert.ok(result.entries.length > 0);
    } finally {
        cdn.server.close();
    }
});

test('并发批次分散到全片，而不是全挤在片头（中途开始播放才有中文）', () => {
    const entries = Array.from({ length: 70 }, (_, i) => ({
        index: i + 1,
        startTime: '00:00:01,000',
        endTime: '00:00:02,000',
        text: `line ${i + 1}`,
    }));
    // 首批 12 条 + 每批 10 条 => 7 批
    const chunks = [entries.slice(0, 12), ...chunkEntries(entries.slice(12), 10)];
    assert.strictEqual(chunks.length, 7);

    const ordered = interleaveChunks(chunks, 4);
    assert.strictEqual(ordered.length, chunks.length, '不能丢批次');
    assert.deepStrictEqual(ordered[0], chunks[0], '首批（片头）必须留在第一位');

    // 全部批次内容不重不漏
    const flat = ordered.flat().map((e) => e.index).sort((a, b) => a - b);
    assert.deepStrictEqual(flat, entries.map((e) => e.index));

    // 前 4 个批次的起始条目应该落在片子不同位置，而不是连着的前 4 批
    const starts = ordered.slice(0, 4).map((c) => c[0].index);
    assert.ok(Math.max(...starts) > 40, `起始批次应分散到后半段，实际 ${starts.join(',')}`);
    assert.strictEqual(new Set(starts).size, 4, '起始批次不能重复');
});
