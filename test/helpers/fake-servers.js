/**
 * 测试用的假服务：模拟 OpenSubtitles API 和 OpenAI 兼容大模型
 * 不依赖外网，可在 CI 中稳定运行
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FIXTURE_SRT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sample.srt'), 'utf8');

/**
 * 构造一条 SearchSubtitles 结果的 XML struct
 */
function legacyEntry(fields) {
    const members = Object.entries(fields)
        .map(([k, v]) => `<member><name>${k}</name><value><string>${v}</string></value></member>`)
        .join('');
    return `<value><struct>${members}</struct></value>`;
}

/**
 * 启动一个假的旧版 XML-RPC 接口
 * - LogIn            返回固定 token
 * - SearchSubtitles  返回两条候选（含一条听障版，下载量更高）
 * - GET /files/x.gz  返回 gzip 压缩的 SRT
 */
function startFakeLegacy(port = 0) {
    const calls = [];

    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/xml-rpc') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                const method = (body.match(/<methodName>([^<]+)</) || [])[1] || '';
                calls.push(method);

                if (method === 'LogIn') {
                    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
                    res.end('<?xml version="1.0" encoding="utf-8"?><methodResponse><params><param><value><struct>'
                        + '<member><name>token</name><value><string>fake-token</string></value></member>'
                        + '<member><name>status</name><value><string>200 OK</string></value></member>'
                        + '</struct></value></param></params></methodResponse>');
                    return;
                }

                if (method === 'SearchSubtitles') {
                    const base = `http://127.0.0.1:${server.address().port}`;
                    const data = [
                        legacyEntry({
                            IDSubtitleFile: '1001',
                            SubFileName: 'legacy-hi.srt',
                            SubFormat: 'srt',
                            SubLanguageID: 'eng',
                            SubDownloadsCnt: '5000',
                            SubHearingImpaired: '1',
                            SubDownloadLink: `${base}/files/1001.gz`,
                        }),
                        legacyEntry({
                            IDSubtitleFile: '1002',
                            SubFileName: 'legacy-clean.srt',
                            SubFormat: 'srt',
                            SubLanguageID: 'eng',
                            SubDownloadsCnt: '80',
                            SubHearingImpaired: '0',
                            SubDownloadLink: `${base}/files/1002.gz`,
                        }),
                    ].join('');

                    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
                    res.end('<?xml version="1.0" encoding="utf-8"?><methodResponse><params><param><value><struct>'
                        + `<member><name>data</name><value><array><data>${data}</data></array></value></member>`
                        + '<member><name>status</name><value><string>200 OK</string></value></member>'
                        + '</struct></value></param></params></methodResponse>');
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
                res.end('<?xml version="1.0"?><methodResponse><params><param><value><struct>'
                    + '<member><name>status</name><value><string>200 OK</string></value></member>'
                    + '</struct></value></param></params></methodResponse>');
            });
            return;
        }

        if (req.method === 'GET' && req.url.startsWith('/files/')) {
            res.writeHead(200, { 'Content-Type': 'application/gzip' });
            res.end(zlib.gzipSync(Buffer.from(FIXTURE_SRT, 'utf8')));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    });

    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}/xml-rpc`, calls });
        });
    });
}

/**
 * 启动一个假 OpenSubtitles 服务
 * - GET  /subtitles     返回两条候选（其中一条听障版本，下载量更高，用于验证优选逻辑）
 * - POST /download      返回字幕文件地址
 * - GET  /files/x.srt   返回 SRT 内容
 * @param {number} port
 */
function startFakeOpenSubtitles(port = 0) {
    const downloads = [];
    const server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url, 'http://127.0.0.1');

        if (req.method === 'GET' && reqUrl.pathname === '/subtitles') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                total_count: 2,
                data: [
                    {
                        id: '1',
                        attributes: {
                            language: 'en',
                            download_count: 900,
                            hearing_impaired: true,
                            ai_translated: false,
                            files: [{ file_id: 111, file_name: 'hi-version.srt' }],
                        },
                    },
                    {
                        id: '2',
                        attributes: {
                            language: 'en',
                            download_count: 50,
                            hearing_impaired: false,
                            ai_translated: false,
                            files: [{ file_id: 222, file_name: 'clean-version.srt' }],
                        },
                    },
                ],
            }));
            return;
        }

        if (req.method === 'POST' && reqUrl.pathname === '/download') {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                let payload = {};
                try { payload = JSON.parse(body); } catch (_) {}
                downloads.push(payload.file_id);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    file_id: payload.file_id,
                    // 记录收到的 file_id，方便断言
                    link: `http://127.0.0.1:${server.address().port}/files/${payload.file_id}.srt`,
                }));
            });
            return;
        }

        if (req.method === 'GET' && reqUrl.pathname.startsWith('/files/')) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(FIXTURE_SRT);
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 404, error: 'Not Found' }));
    });

    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, downloads });
        });
    });
}

/**
 * 启动一个假的大模型服务（OpenAI 兼容）
 * 把 "[n] 原文" 翻成 "[n] 译文n"；对包含换行的条目保留换行，用于验证多行字幕不丢行
 * @param {number} port
 * @param {{delayMs?: number}} [options] delayMs 用于模拟慢模型，验证并发与部分返回
 */
function startFakeLLM(port = 0, options = {}) {
    const calls = [];
    const delayMs = Number(options.delayMs) || 0;
    const stats = { active: 0, maxActive: 0 };

    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
            let body = '';
            req.on('data', (c) => (body += c));
            req.on('end', () => {
                let payload = {};
                try { payload = JSON.parse(body); } catch (_) {}
                calls.push(payload);

                stats.active++;
                stats.maxActive = Math.max(stats.maxActive, stats.active);

                const userMsg = (payload.messages || []).find((m) => m.role === 'user');
                const out = translatePrompt((userMsg && userMsg.content) || '');

                const reply = () => {
                    stats.active--;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'fake',
                        object: 'chat.completion',
                        model: payload.model,
                        choices: [{ index: 0, message: { role: 'assistant', content: out }, finish_reason: 'stop' }],
                    }));
                };

                if (delayMs > 0) setTimeout(reply, delayMs);
                else reply();
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            resolve({
                server,
                port: server.address().port,
                url: `http://127.0.0.1:${server.address().port}/v1`,
                calls,
                stats,
            });
        });
    });
}

/**
 * 模拟模型翻译：按块解析 prompt（[n] 开头的行 + 其后不带序号的续行），
 * 原文有几行译文就输出几行，用于验证多行字幕不会丢行
 */
function translatePrompt(prompt) {
    const blocks = [];
    let current = null;

    for (const rawLine of prompt.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const m = line.match(/^\[(\d+)\]\s*(.*)$/);
        if (m) {
            current = { index: m[1], lines: [m[2]] };
            blocks.push(current);
        } else if (current) {
            current.lines.push(line);
        }
    }

    const out = [];
    for (const block of blocks) {
        block.lines.forEach((_, i) => {
            const prefix = i === 0 ? `[${block.index}] ` : '';
            const suffix = block.lines.length > 1 ? `第${i + 1}行` : '';
            out.push(`${prefix}译文${block.index}${suffix}`);
        });
    }
    return out.join('\n');
}

/**
 * 启动一个假的 Stremio 官方字幕插件 CDN
 * - GET /subtitles/movie/tt...json  返回 v3 格式的字幕列表
 * - GET /files/x.srt                返回明文 SRT
 */
function startFakeCdn(port = 0) {
    const server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url, 'http://127.0.0.1');
        const base = `http://127.0.0.1:${server.address().port}`;

        if (req.method === 'GET' && reqUrl.pathname.startsWith('/subtitles/')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                subtitles: [
                    {
                        id: '9001',
                        // 听障版：文件名带 .HI.，应被降权
                        url: `${base}/files/9001.srt`,
                        lang: 'eng',
                        subtitleFileName: 'movie.2020.1080p.HI.srt',
                    },
                    {
                        id: '9002',
                        url: `${base}/files/9002.srt`,
                        lang: 'eng',
                        subtitleFileName: 'movie.2020.1080p.srt',
                    },
                    {
                        // 其他语言，应被过滤掉
                        id: '9003',
                        url: `${base}/files/9003.srt`,
                        lang: 'spa',
                        subtitleFileName: 'movie.2020.1080p.spa.srt',
                    },
                ],
            }));
            return;
        }

        if (req.method === 'GET' && reqUrl.pathname.startsWith('/files/')) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(FIXTURE_SRT);
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
    });

    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

module.exports = { startFakeOpenSubtitles, startFakeLegacy, startFakeCdn, startFakeLLM };
