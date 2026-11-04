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
