/**
 * configurePage.js
 * 安装配置页：填写模型地址与 OpenSubtitles Key，生成可安装的链接
 */

/**
 * @param {{defaults: object, origin: string, serverHasKeys: {llm: boolean, opensubtitles: boolean}}} opts
 * @returns {string} HTML
 */
function renderConfigurePage({ defaults, origin, serverHasKeys }) {
    const safe = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const langOptions = (current, list) => list
        .map(([code, label]) => `<option value="${code}"${code === current ? ' selected' : ''}>${label}</option>`)
        .join('');

    const sourceOptions = (current) => [
        ['auto', '自动（推荐）'],
        ['cdn', 'Stremio 官方 CDN（免 Key，不限次数）'],
        ['rest', '新版 REST（必须填 Key，匿名 5 次/天）'],
        ['legacy', '旧接口 XML-RPC（免 Key，下载需账号）'],
    ]
        .map(([code, label]) => `<option value="${code}"${code === (current || 'auto') ? ' selected' : ''}>${label}</option>`)
        .join('');

    const SOURCE_NOTES = {
        auto: '默认。有 Key 先走新版接口，没 Key 直接走官方 CDN，都不会额外消耗你的下载次数。不确定就选这个。',
        cdn: '完全不填 Key 也能用，字幕直接取 Stremio 官方缓存（实测 1686 条无限制）。代价是借用第三方服务，它的接口哪天变了就得跟着改。',
        rest: '用你自己的 OpenSubtitles Key。匿名每天只有 5 次下载，超了返回 406；译文有缓存，同一部片重复播放不会重复扣。',
        legacy: '免 Key 也能搜到候选列表，但匿名下载只会拿到 102 字节的「成为 OpenSubtitles VIP」占位字幕。必须填下面的账号密码才有真字幕，否则会被判失败。',
    };

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI 字幕翻译 · 安装配置</title>
<style>
  :root {
    --bg: #f5f6f8; --card: #ffffff; --line: #e3e6eb; --text: #1b1f24;
    --muted: #6b7480; --accent: #3b6ef6; --ok: #12854b; --bad: #c0392b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px; background: var(--bg); color: var(--text);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  header { margin-bottom: 20px; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: .3px; }
  .sub { color: var(--muted); font-size: 13px; }
  .card {
    background: var(--card); border: 1px solid #e3e6eb; border-radius: 12px;
    padding: 22px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(16,24,40,.04);
  }
  .row { margin-bottom: 16px; }
  .row:last-child { margin-bottom: 0; }
  label { display: block; font-weight: 600; margin-bottom: 6px; font-size: 13px; }
  .hint { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 6px; }
  input, select {
    width: 100%; padding: 9px 11px; border: 1px solid #d5d9e0; border-radius: 8px;
    font-size: 14px; background: #fff; color: var(--text); outline: none;
  }
  input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59,110,246,.12); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 20px; }
  button {
    border: 0; border-radius: 8px; padding: 10px 16px; font-size: 14px; font-weight: 600;
    cursor: pointer; background: var(--accent); color: #fff;
  }
  button.secondary { background: #eef1f6; color: #2b3138; }
  button:disabled { opacity: .6; cursor: default; }
  .out { margin-top: 16px; display: none; }
  .out.show { display: block; }
  code.url {
    display: block; padding: 10px 12px; background: #f2f4f7; border: 1px solid #e3e6eb;
    border-radius: 8px; font-size: 12px; word-break: break-all; color: #333a41;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .install { display: inline-block; margin-top: 10px; text-decoration: none;
    background: #1b1f24; color: #fff; padding: 9px 16px; border-radius: 8px; font-weight: 600; font-size: 13px; }
  .note { font-size: 12px; color: var(--muted); margin-top: 10px; }
  .warn { font-size: 12px; color: #8a5a00; background: #fff8e6; border: 1px solid #ffe1a8;
    padding: 8px 10px; border-radius: 8px; margin-top: 10px; }
  .status { margin-top: 14px; font-size: 13px; }
  .status div { padding: 6px 0; border-top: 1px dashed #e3e6eb; }
  .status div:first-child { border-top: 0; }
  .ok { color: var(--ok); font-weight: 600; }
  .bad { color: var(--bad); font-weight: 600; }
  .sample { display: none; margin-top: 14px; }
  .sample.show { display: block; }
  .pair { border: 1px solid #e3e6eb; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; background: #fafbfc; }
  .pair .src { color: var(--muted); font-size: 12px; }
  .pair .dst { font-size: 13px; margin-top: 2px; }
  ol { padding-left: 20px; margin: 8px 0 0; color: #3a4048; font-size: 13px; }
  ol li { margin-bottom: 4px; }
  @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>AI 字幕翻译 · 安装配置</h1>
    <div class="sub">填好下面的配置后点「生成安装链接」，再把链接装进 Stremio。</div>
  </header>

  <div class="card">
    <div class="row">
      <label>大模型地址 <span class="hint">OpenAI 兼容接口，例如 Magpie 的 http://127.0.0.1:3425/v1</span></label>
      <input id="llmBaseUrl" value="${safe(defaults.llmBaseUrl)}" placeholder="http://127.0.0.1:3425/v1" />
    </div>
    <div class="row">
      <label>模型名称</label>
      <input id="llmModel" value="${safe(defaults.llmModel)}" placeholder="bili-translate/Index-Translate-9B" />
    </div>
    <div class="row">
      <label>模型 API Key <span class="hint">${serverHasKeys.llm ? '服务端已配置，可留空' : '本地 Magpie 可留空'}</span></label>
      <input id="llmApiKey" type="password" autocomplete="off" placeholder="sk-..." />
    </div>
    <div class="row">
      <label>字幕源 <span class="hint">决定从哪儿取英文字幕，下面会显示当前选项的代价</span></label>
      <select id="subtitleSource">
        ${sourceOptions(defaults.subtitleSource)}
      </select>
      <div id="sourceNote" class="hint" style="margin-top:6px;line-height:1.6"></div>
    </div>
    <div class="row">
      <label>OpenSubtitles API Key <span class="hint">${serverHasKeys.opensubtitles ? '服务端已配置，可留空' : '选「官方 CDN」或「旧接口」时可留空'}</span></label>
      <input id="opensubtitlesApiKey" type="password" autocomplete="off" placeholder="在 opensubtitles.com/consumers 申请" />
    </div>
    <div class="row">
      <label>OpenSubtitles 账号 <span class="hint">可选，只有用旧接口下载时才需要</span></label>
      <div class="grid">
        <input id="opensubtitlesUsername" autocomplete="off" placeholder="用户名" />
        <input id="opensubtitlesPassword" type="password" autocomplete="off" placeholder="密码" />
      </div>
    </div>
    <div class="grid">
      <div class="row">
        <label>源字幕语言</label>
        <select id="sourceLang">
          ${langOptions(defaults.sourceLang, [['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español']])}
        </select>
      </div>
      <div class="row">
        <label>翻译目标语言</label>
        <select id="targetLang">
          ${langOptions(defaults.targetLang, [['zh', '简体中文'], ['zh-tw', '繁体中文'], ['ja', '日本語'], ['ko', '한국어'], ['en', 'English']])}
        </select>
      </div>
    </div>
    <div class="row">
      <label>每批字幕条数 <span class="hint">越多越快，但可能超过模型上下文</span></label>
      <input id="translateBatchSize" type="number" min="1" max="500" value="${safe(defaults.translateBatchSize)}" />
    </div>

    <div class="actions">
      <button id="btnBuild">生成安装链接</button>
      <button id="btnTest" class="secondary">测试连接</button>
      <button id="btnSample" class="secondary">试翻 3 条</button>
    </div>

    <div id="status" class="status"></div>

    <div id="sampleBox" class="sample"></div>

    <div class="note">「测试连接」只查询不下载，不消耗任何字幕配额；「试翻 3 条」会真实下载 1 条字幕并调用模型，用于确认整条链路通不通。</div>

    <div id="out" class="out">
      <div class="row" style="margin-top:16px">
        <label>安装链接</label>
        <code class="url" id="url"></code>
        <a id="installLink" class="install" href="#">在 Stremio 中安装</a>
      </div>
      <div class="warn">这个链接里包含你的 API Key / 账号密码，请勿公开分享。</div>
      <div class="note">按钮没反应时，把上面的链接复制到 Stremio「插件」页的地址栏，按回车即可安装。</div>
    </div>
  </div>

  <div class="card">
    <label style="margin-bottom:8px">安装步骤</label>
    <ol>
      <li>填好模型地址、模型名称，选择字幕源（想省配额就选「旧接口」，不用填 Key）。</li>
      <li>点「测试连接」，确认大模型和两条字幕通道的状态。</li>
      <li>点「试翻 3 条」，看到中英对照就说明整条链路通了。</li>
      <li>点「生成安装链接」，再点「在 Stremio 中安装」。</li>
      <li>播放任意没有中文字幕的影视，字幕列表里会出现「AI翻译中文字幕」。</li>
    </ol>
  </div>
</div>

<script>
  const ORIGIN = ${JSON.stringify(origin)};

  const $ = (id) => document.getElementById(id);

  // 字幕源说明：跟着下拉框走，避免用户在四个选项之间猜代价
  const SOURCE_NOTES = ${JSON.stringify(SOURCE_NOTES)};

  function syncSourceNote() {
    const note = $('sourceNote');
    if (note) note.textContent = SOURCE_NOTES[$('subtitleSource').value] || '';
  }
  $('subtitleSource').addEventListener('change', syncSourceNote);
  syncSourceNote();

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    }[c]));
  }

  function collect() {
    const cfg = {
      llmBaseUrl: $('llmBaseUrl').value.trim(),
      llmModel: $('llmModel').value.trim(),
      llmApiKey: $('llmApiKey').value.trim(),
      opensubtitlesApiKey: $('opensubtitlesApiKey').value.trim(),
      opensubtitlesUsername: $('opensubtitlesUsername').value.trim(),
      opensubtitlesPassword: $('opensubtitlesPassword').value.trim(),
      subtitleSource: $('subtitleSource').value,
      sourceLang: $('sourceLang').value,
      targetLang: $('targetLang').value,
      translateBatchSize: parseInt($('translateBatchSize').value, 10) || 30,
    };
    Object.keys(cfg).forEach((k) => {
      if (cfg[k] === '' ) delete cfg[k];
    });
    return cfg;
  }

  function b64url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }

  function buildUrl() {
    const token = b64url(JSON.stringify(collect()));
    return ORIGIN + '/c/' + token + '/manifest.json';
  }

  $('btnBuild').addEventListener('click', () => {
    const url = buildUrl();
    $('url').textContent = url;
    const target = 'stremio://' + url.replace(/^https?:\\/\\//, '');
    $('installLink').href = target;
    $('out').classList.add('show');
  });

  function line(name, r) {
    const detail = r && r.message ? ' <span style="color:#6b7480">— ' + r.message + '</span>' : '';
    const state = r && r.ok ? '<span class="ok">正常</span>' : '<span class="bad">失败</span>';
    return '<div>' + name + '：' + state + detail + '</div>';
  }

  $('btnTest').addEventListener('click', async () => {
    const btn = $('btnTest');
    const box = $('status');
    btn.disabled = true;
    box.innerHTML = '<div>正在测试…</div>';
    try {
      const res = await fetch('/api/test-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collect()),
      });
      const data = await res.json();
      box.innerHTML =
        line('大模型', data.llm) +
        line('新版接口 (REST)', data.opensubtitles) +
        line('旧接口 (免 Key)', data.legacy) +
        line('官方 CDN (免 Key)', data.cdn);
    } catch (e) {
      box.innerHTML = '<div><span class="bad">请求失败</span> — ' + e.message + '</div>';
    } finally {
      btn.disabled = false;
    }
  });

  $('btnSample').addEventListener('click', async () => {
    const btn = $('btnSample');
    const box = $('status');
    const sample = $('sampleBox');
    btn.disabled = true;
    sample.classList.remove('show');
    box.innerHTML = '<div>正在取字幕并试翻 3 条，首次可能要几十秒…</div>';
    try {
      const res = await fetch('/api/test-translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collect()),
      });
      const data = await res.json();
      box.innerHTML = line('端到端试翻', data);
      if (data.pairs && data.pairs.length) {
        sample.innerHTML = data.pairs
          .map((p) => '<div class="pair"><div class="src">' + escapeHtml(p.source) + '</div>'
            + '<div class="dst">' + escapeHtml(p.target) + '</div></div>')
          .join('');
        sample.classList.add('show');
      }
    } catch (e) {
      box.innerHTML = '<div><span class="bad">请求失败</span> — ' + e.message + '</div>';
    } finally {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}

module.exports = { renderConfigurePage };
