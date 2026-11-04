/**
 * 端到端测试：启动插件 + 假 OpenSubtitles + 假大模型，走完整链路
 * 覆盖 /manifest.json -> /subtitles/...json -> /subtitle/xxx.vtt -> /health
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

const { startFakeOpenSubtitles, startFakeLegacy, startFakeCdn, startFakeLLM } = require('./helpers/fake-servers');
const { encodeConfig } = require('../src/addonConfig');

const ROOT = path.join(__dirname, '..');

/**
 * 启动 addon 子进程，等待 /health 就绪
 */
async function startAddon(env) {
    const port = 7300 + Math.floor(Math.random() * 400);
    const child = spawn(process.execPath, ['index.js'], {
        cwd: ROOT,
        env: {
            ...process.env,
            // 本地假服务不需要走系统代理
            NO_PROXY: '127.0.0.1,localhost',
            no_proxy: '127.0.0.1,localhost',
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            http_proxy: '',
            https_proxy: '',
            PORT: String(port),
            LLM_API_KEY: '',
            LLM_MODEL: 'bili-translate/Index-Translate-9B',
            TARGET_LANG: 'zh',
            SOURCE_LANG: 'en',
            OPENSUBTITLES_API_KEY: 'test-key',
            // 默认只测新版接口，避免用例偷偷打外网；旧接口行为由专门的用例覆盖
            SUBTITLE_SOURCE: 'rest',
            TRANSLATE_BATCH_SIZE: '30',
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${base}/health`);
            if (res.ok) return { child, base, getOutput: () => output };
        } catch (_) {
            /* 还没起来 */
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    child.kill();
    throw new Error(`addon 启动超时，日志:\n${output}`);
}

async function stop(child) {
    child.kill();
    await new Promise((r) => setTimeout(r, 100));
}

test('完整链路：manifest -> 字幕列表 -> VTT 文件', async (t) => {
    const openSubs = await startFakeOpenSubtitles();
    const llm = await startFakeLLM();

    // 记录真实打到 OpenSubtitles 的请求，用于验证缓存短路
    const osRequests = [];
    openSubs.server.on('request', (req) => osRequests.push(req.url));

    const { child, base, getOutput } = await startAddon({
        OPENSUBTITLES_BASE_URL: openSubs.url,
        LLM_BASE_URL: llm.url,
    });

    t.after(async () => {
        await stop(child);
        openSubs.server.close();
        llm.server.close();
    });

    // 1. manifest
    const manifestRes = await fetch(`${base}/manifest.json`);
    assert.strictEqual(manifestRes.status, 200);
    const manifest = await manifestRes.json();
    assert.deepStrictEqual(manifest.resources, ['subtitles']);
    assert.ok(manifest.types.includes('series'));

    // 2. 字幕列表
    const subsRes = await fetch(`${base}/subtitles/movie/tt0111161.json`);
    assert.strictEqual(subsRes.status, 200);
    const { subtitles } = await subsRes.json();
    assert.strictEqual(subtitles.length, 1);
    assert.strictEqual(subtitles[0].lang, 'chi');

    // 字幕 URL 必须使用请求方看到的主机名，而不是写死的 localhost
    assert.ok(
        subtitles[0].url.startsWith(base),
        `字幕 URL 应基于请求 Host 生成，实际: ${subtitles[0].url}`
    );

    // 3. 下载 VTT 并校验内容
    const vttRes = await fetch(subtitles[0].url);
    assert.strictEqual(vttRes.status, 200);
    assert.ok(vttRes.headers.get('content-type').includes('text/vtt'));
    const vtt = await vttRes.text();

    assert.ok(vtt.startsWith('WEBVTT'));
    assert.ok(vtt.includes('译文1'));
    // 多行字幕的译文必须两行都在
    assert.ok(vtt.includes('译文2第1行'));
    assert.ok(vtt.includes('译文2第2行'));
    assert.ok(!vtt.includes('Hello there.'), '原文不应残留');

    // 4. 选中的应是非听障版本（file_id=222）
    assert.ok(llm.calls.length >= 1, '应至少调用一次大模型');
    assert.ok(osRequests.some((u) => u.includes('/download')), '应请求过字幕下载接口');

    // 5. 再次点播同一部片时，应直接命中缓存，不再消耗 OpenSubtitles 下载配额
    const before = osRequests.length;
    const again = await (await fetch(`${base}/subtitles/movie/tt0111161.json`)).json();
    assert.strictEqual(again.subtitles.length, 1);
    assert.strictEqual(again.subtitles[0].url, subtitles[0].url);
    assert.strictEqual(osRequests.length, before, '二次请求不应再访问 OpenSubtitles');

    // 6. health
    const health = await (await fetch(`${base}/health`)).json();
    assert.strictEqual(health.status, 'ok');
    assert.strictEqual(health.cachedSubtitles, 1);

    // 7. 未知字幕 id 返回 404
    const missing = await fetch(`${base}/subtitle/ai-unknown.vtt`);
    assert.strictEqual(missing.status, 404);

    // 启动日志里不应出现接口 404 的错误
    assert.ok(!getOutput().includes('搜索字幕失败'), getOutput());
});

test('剧集请求会带上季/集信息查询字幕', async (t) => {
    const openSubs = await startFakeOpenSubtitles();
    const llm = await startFakeLLM();

    // 记录 fake 服务收到的查询参数
    const queries = [];
    openSubs.server.on('request', (req) => {
        queries.push(new URL(req.url, 'http://127.0.0.1').searchParams);
    });

    const { child, base } = await startAddon({
        OPENSUBTITLES_BASE_URL: openSubs.url,
        LLM_BASE_URL: llm.url,
    });

    t.after(async () => {
        await stop(child);
        openSubs.server.close();
        llm.server.close();
    });

    const res = await fetch(`${base}/subtitles/series/tt0944947:1:2.json`);
    assert.strictEqual(res.status, 200);
    const { subtitles } = await res.json();
    assert.strictEqual(subtitles.length, 1);

    const searchQuery = queries.find((q) => q.has('parent_imdb_id'));
    assert.ok(searchQuery, '剧集应该用 parent_imdb_id 查询');
    assert.strictEqual(searchQuery.get('parent_imdb_id'), '0944947');
    assert.strictEqual(searchQuery.get('season_number'), '1');
    assert.strictEqual(searchQuery.get('episode_number'), '2');
    assert.ok(!searchQuery.has('imdb_id'), '剧集查询不应再用 imdb_id');
});

test('翻译全部失败时不返回伪装成中文的字幕', async (t) => {
    const openSubs = await startFakeOpenSubtitles();

    // 一个永远返回 500 的大模型服务
    const http = require('http');
    const brokenLLM = http.createServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"boom"}');
    });
    await new Promise((r) => brokenLLM.listen(0, '127.0.0.1', r));

    const { child, base } = await startAddon({
        OPENSUBTITLES_BASE_URL: openSubs.url,
        LLM_BASE_URL: `http://127.0.0.1:${brokenLLM.address().port}/v1`,
    });

    t.after(async () => {
        await stop(child);
        openSubs.server.close();
        brokenLLM.close();
    });

    const res = await fetch(`${base}/subtitles/movie/tt0111161.json`);
    const { subtitles } = await res.json();
    assert.deepStrictEqual(subtitles, [], '翻译全失败时不应返回字幕条目');
});

test('没配 Key 和账号时自动落到官方 CDN，安装链接里的配置优先生效', async (t) => {
    const openSubs = await startFakeOpenSubtitles();
    const legacy = await startFakeLegacy();
    const cdn = await startFakeCdn();
    const llm = await startFakeLLM();

    // 服务端完全不带 Key / 账号，模拟"开箱即用"
    const { child, base, getOutput } = await startAddon({
        OPENSUBTITLES_BASE_URL: openSubs.url,
        OPENSUBTITLES_LEGACY_URL: legacy.url,
        STREMIO_CDN_URL: cdn.url,
        SUBTITLE_SOURCE: 'auto',
        LLM_BASE_URL: llm.url,
        OPENSUBTITLES_API_KEY: '',
        OPENSUBTITLES_USERNAME: '',
        OPENSUBTITLES_PASSWORD: '',
    });

    t.after(async () => {
        await stop(child);
        openSubs.server.close();
        legacy.server.close();
        cdn.server.close();
        llm.server.close();
    });

    // 没有 Key 也不该崩：auto 模式回退到免 Key 的官方 CDN
    const plain = await (await fetch(`${base}/subtitles/movie/tt0111161.json`)).json();
    assert.strictEqual(plain.subtitles.length, 1, '没有 Key 时应由官方 CDN 兜底');
    assert.ok(getOutput().includes('未配置 OPENSUBTITLES_API_KEY'), getOutput());
    assert.ok(getOutput().includes('CDN'), '日志里应能看到走了 CDN 通道');
    // 没账号时不该去打旧接口（匿名只会拿到占位字幕）
    assert.strictEqual(legacy.calls.length, 0, '没账号时应跳过旧接口');

    // 通过安装链接传入 Key 后改走新版接口
    const token = encodeConfig({ opensubtitlesApiKey: 'key-from-stremio', translateBatchSize: 20 });
    const res = await fetch(`${base}/c/${token}/subtitles/movie/tt0111161.json`);
    assert.strictEqual(res.status, 200);
    const { subtitles } = await res.json();
    assert.strictEqual(subtitles.length, 1);

    const vtt = await (await fetch(subtitles[0].url)).text();
    assert.ok(vtt.includes('译文1'));
});

test('配置页与带配置的 manifest', async (t) => {
    const openSubs = await startFakeOpenSubtitles();
    const llm = await startFakeLLM();

    const { child, base } = await startAddon({
        OPENSUBTITLES_BASE_URL: openSubs.url,
        LLM_BASE_URL: llm.url,
        OPENSUBTITLES_API_KEY: 'test-key',
    });

    t.after(async () => {
        await stop(child);
        openSubs.server.close();
        llm.server.close();
    });

    // 首页跳到配置页
    const home = await fetch(`${base}/`, { redirect: 'manual' });
    assert.strictEqual(home.status, 302);
    assert.strictEqual(home.headers.get('location'), '/configure');

    const page = await fetch(`${base}/configure`);
    assert.strictEqual(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('OpenSubtitles API Key'));
    assert.ok(html.includes('生成安装链接'));
    // 字幕源选择 + 两个测试按钮
    assert.ok(html.includes('id="subtitleSource"'), '应有字幕源选择');
    assert.ok(html.includes('id="btnTest"'), '应有测试连接按钮');
    assert.ok(html.includes('id="btnSample"'), '应有试翻按钮');
    assert.ok(html.includes('/api/test-translate'), '试翻按钮应调用后端接口');

    // 带配置的 manifest：id 与名称随配置变化
    const tokenA = encodeConfig({ llmModel: 'model-a', opensubtitlesApiKey: 'k' });
    const tokenB = encodeConfig({ llmModel: 'model-b', opensubtitlesApiKey: 'k' });

    const mfA = await (await fetch(`${base}/c/${tokenA}/manifest.json`)).json();
    const mfB = await (await fetch(`${base}/c/${tokenB}/manifest.json`)).json();

    assert.strictEqual(mfA.resources[0], 'subtitles');
    assert.strictEqual(mfA.behaviorHints.configurable, true);
    assert.notStrictEqual(mfA.id, mfB.id, '不同配置应生成不同的 addon id');
    assert.ok(mfA.name.includes('model-a'), mfA.name);

    // Stremio 会在 manifest 同级路径打开 configure
    const cfgPage = await fetch(`${base}/c/${tokenA}/configure`, { redirect: 'manual' });
    assert.strictEqual(cfgPage.status, 302);

    // 非法配置返回 400 而不是 500
    const bad = await fetch(`${base}/c/not-a-config/manifest.json`);
    assert.strictEqual(bad.status, 400);
});
