'use strict';

/* ============ 端点与配置 ============ */
const DOWN_URL = 'https://speed.cloudflare.com/__down';
const UP_URL = 'https://speed.cloudflare.com/__up';
const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const IPINFO_URL = 'https://ipwho.is/';

const DURATION_PRESETS = {
  fast: { downMs: 5000, upMs: 4000, warmupMs: 1200 },
  std: { downMs: 10000, upMs: 8000, warmupMs: 1500 },
};

const CFG = {
  connections: 4,
  pingCount: 12,
  pingGap: 120,
  chunkBytes: 25 * 1024 * 1024,   // 单条下载流每次请求的字节数
  upChunkBytes: 8 * 1024 * 1024,  // 单条上传流每次请求的字节数
  probeEvery: 400,                // 加载延迟探测间隔
  sampleEvery: 200,               // 曲线采样间隔
  ...DURATION_PRESETS.std,
};

let SERVER_ON = false;

/* ============ 工具 ============ */
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtSpeed(v) {
  if (v == null || !isFinite(v)) return '--';
  if (v >= 100) return String(Math.round(v));
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
function fmtMs(v) { return v == null ? '--' : Math.round(v); }
function niceCeil(v) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1e-6))));
  for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

/* ============ 仪表盘 ============ */
class Gauge {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 320 * dpr; canvas.height = 320 * dpr;
    this.ctx.scale(dpr, dpr);
    this.disp = 0; this.target = 0; this.phase = 'idle';
    requestAnimationFrame(() => this.loop());
  }
  set(v) { this.target = v || 0; }
  setPhase(p) { this.phase = p; }
  frac(v) {
    if (!(v > 0)) return 0;
    const lo = Math.log10(0.1), hi = Math.log10(1000);
    return Math.min(1, Math.max(0, (Math.log10(v) - lo) / (hi - lo)));
  }
  loop() {
    this.disp += (this.target - this.disp) * 0.12;
    if (Math.abs(this.target - this.disp) < 0.01) this.disp = this.target;
    this.draw();
    requestAnimationFrame(() => this.loop());
  }
  draw() {
    const ctx = this.ctx, cx = 160, cy = 160, R = 126;
    ctx.clearRect(0, 0, 320, 320);
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    ctx.lineWidth = 14; ctx.lineCap = 'round';
    ctx.strokeStyle = '#1e2a47';
    ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.stroke();

    const f = this.frac(this.disp);
    if (f > 0.004) {
      const colors = this.phase === 'up' ? ['#a78bfa', '#6d5bd0']
        : this.phase === 'down' ? ['#22d3ee', '#2563eb'] : ['#64748b', '#94a3b8'];
      const grad = ctx.createLinearGradient(0, 0, 320, 320);
      grad.addColorStop(0, colors[0]); grad.addColorStop(1, colors[1]);
      ctx.strokeStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, R, a0, a0 + (a1 - a0) * f); ctx.stroke();
    }

    ctx.font = '11px "Segoe UI"'; ctx.textAlign = 'center';
    for (const tv of [0.1, 1, 10, 100, 1000]) {
      const a = a0 + (a1 - a0) * this.frac(tv);
      ctx.strokeStyle = '#3a4a72'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (R - 12), cy + Math.sin(a) * (R - 12));
      ctx.lineTo(cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24));
      ctx.stroke();
      // 首尾刻度（0.1 / 1000）位于按钮斜下方，标签额外外移避开按钮
      const rl = (tv === 0.1 || tv === 1000) ? R - 32 : R - 38;
      ctx.fillStyle = '#8b98b8';
      ctx.fillText(tv >= 1 ? String(tv) : tv.toFixed(1),
        cx + Math.cos(a) * rl, cy + Math.sin(a) * rl + 4);
    }

    ctx.fillStyle = '#e8edf7'; ctx.font = '700 34px "Segoe UI"';
    ctx.fillText(fmtSpeed(this.disp), cx, cy - 58);
    ctx.fillStyle = '#8b98b8'; ctx.font = '12px "Segoe UI"';
    ctx.fillText('Mbps', cx, cy - 36);
  }
}

/* ============ 实时曲线 ============ */
class Chart {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.data = [];
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.cv.clientWidth || this.cv.parentElement.clientWidth || 800;
    this.h = 150;
    this.cv.width = this.w * dpr; this.cv.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
  reset() { this.data = []; this.draw(); }
  push(s) { this.data.push(s); this.draw(); }
  draw() {
    const ctx = this.ctx, w = this.w, h = this.h, n = this.data.length;
    ctx.clearRect(0, 0, w, h);
    const maxV = Math.max(1, ...this.data.map(d => d.v));
    const niceMax = niceCeil(maxV);
    ctx.font = '11px "Segoe UI"'; ctx.textAlign = 'left';
    for (let i = 0; i <= 4; i++) {
      const y = h - 8 - ((h - 26) * i) / 4;
      ctx.strokeStyle = 'rgba(56,72,116,.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(36, y); ctx.lineTo(w - 4, y); ctx.stroke();
      ctx.fillStyle = '#8b98b8';
      ctx.fillText(fmtSpeed((niceMax * i) / 4), 2, y + 4);
    }
    if (n < 2) return;
    const x = i => 38 + ((w - 46) * i) / (n - 1);
    const y = v => h - 8 - ((h - 26) * v) / niceMax;
    for (let i = 1; i < n; i++) {
      const a = this.data[i - 1], b = this.data[i];
      ctx.strokeStyle = b.phase === 'up' ? '#a78bfa' : '#22d3ee';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x(i - 1), y(a.v)); ctx.lineTo(x(i), y(b.v)); ctx.stroke();
    }
  }
}

/* ============ UI 引用 ============ */
const gauge = new Gauge($('gauge'));
const chart = new Chart($('chart'));
const startBtn = $('startBtn');
let running = false;

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}
function setMetric(id, v) { $(id).textContent = v; }

function resetUI() {
  ['mDown', 'mUp', 'mPing', 'mJitter', 'mLoss', 'mBloat'].forEach(id => setMetric(id, '--'));
  $('cardDown').classList.remove('pop', 'active');
  $('cardUp').classList.remove('pop', 'active');
  gauge.set(0); gauge.setPhase('idle');
  chart.reset();
  $('resultPanel').hidden = true;
}

/* ============ 网络信息 ============ */
async function fetchInfo() {
  const set = (id, v) => { $(id).textContent = v; };
  let who = null;
  try { const r = await fetch(IPINFO_URL, { cache: 'no-store' }); who = await r.json(); } catch (e) { /* 离线或接口不可用 */ }
  let trace = {};
  try {
    const r = await fetch(TRACE_URL, { cache: 'no-store' });
    const text = await r.text();
    trace = Object.fromEntries(text.trim().split('\n').filter(l => l.includes('=')).map(l => l.split('=')));
  } catch (e) { /* CORS 或离线 */ }

  set('infoIp', trace.ip || (who && who.ip) || '未知');
  if (who && who.success) {
    const c = who.connection || {};
    set('infoIsp', [c.isp || c.org, c.asn ? 'AS' + c.asn : ''].filter(Boolean).join(' · ') || '未知');
    set('infoLoc', [who.city, who.region, who.country].filter(Boolean).join(' · ') || '未知');
    set('infoIpType', who.type || '--');
  } else {
    set('infoIsp', '获取失败'); set('infoLoc', '获取失败'); set('infoIpType', '--');
  }
  set('infoColo', trace.colo ? trace.colo + (trace.loc ? '（属地 ' + trace.loc + '）' : '') : '未知');
  // 代理检测：出口 IP 属地时区与浏览器时区对比
  const proxyEl = $('infoProxy');
  proxyEl.classList.remove('warn');
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    // ipwho 的 timezone 可能是字符串或 {id: "..."} 对象
    const wtzRaw = who && who.timezone;
    const wtz = wtzRaw ? (typeof wtzRaw === 'string' ? wtzRaw : wtzRaw.id) : '';
    if (wtz && tz) {
      if (wtz === tz) {
        proxyEl.textContent = `正常（出口属地 ${wtz} 与浏览器时区一致）`;
      } else {
        proxyEl.textContent = `疑似代理：出口属地 ${wtz} ≠ 浏览器 ${tz}`;
        proxyEl.classList.add('warn');
      }
    } else {
      proxyEl.textContent = '无法判断';
    }
  } catch (e) { proxyEl.textContent = '无法判断'; }
}

/* ============ 延迟 / 抖动 / 丢包估算 ============ */
async function pingPhase() {
  const samples = [];
  for (let i = 0; i < CFG.pingCount; i++) {
    const t = performance.now();
    try {
      await fetch(DOWN_URL + '?bytes=0&r=' + Math.random(), { cache: 'no-store' });
      samples.push(performance.now() - t);
    } catch (e) { samples.push(null); }
    await sleep(CFG.pingGap);
  }
  const body = samples.slice(1); // 首个样本含 TCP/TLS 建连，丢弃
  const ok = body.filter(v => v != null);
  if (!ok.length) throw new Error('无法连接测速节点（speed.cloudflare.com），请检查网络或代理设置');
  const min = Math.min(...ok), max = Math.max(...ok);
  const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
  let j = 0;
  for (let i = 1; i < ok.length; i++) j += Math.abs(ok[i] - ok[i - 1]);
  const jitter = ok.length > 1 ? j / (ok.length - 1) : 0;
  const lossPct = body.length ? ((body.length - ok.length) / body.length) * 100 : 0;
  return { avg, min, max, jitter, lossPct };
}

/* ============ 下载 / 上传 ============ */
async function downloadWorker(signal, onBytes) {
  while (!signal.aborted) {
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    signal.addEventListener('abort', stop, { once: true });
    try {
      const res = await fetch(DOWN_URL + '?bytes=' + CFG.chunkBytes + '&r=' + Math.random(),
        { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onBytes(value.length);
      }
    } catch (e) {
      if (signal.aborted) return;
      await sleep(400);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }
}

let UP_DATA = null;
function ensureUploadData() {
  if (UP_DATA) return;
  UP_DATA = new Uint8Array(CFG.upChunkBytes);
  for (let i = 0; i < UP_DATA.length; i += 65536) {
    crypto.getRandomValues(UP_DATA.subarray(i, Math.min(i + 65536, UP_DATA.length)));
  }
}

function uploadWorker(signal, onBytes) {
  return new Promise(resolve => {
    const go = () => {
      if (signal.aborted) return resolve();
      const xhr = new XMLHttpRequest();
      let last = 0;
      const stop = () => { try { xhr.abort(); } catch (e) { /* 已结束 */ } };
      xhr.open('POST', UP_URL + '?r=' + Math.random());
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = e => { onBytes(e.loaded - last); last = e.loaded; };
      signal.addEventListener('abort', stop, { once: true });
      xhr.onloadend = () => {
        signal.removeEventListener('abort', stop);
        if (signal.aborted) resolve(); else go();
      };
      try { xhr.send(UP_DATA); } catch (e) { resolve(); }
    };
    go();
  });
}

function loadedProbes(signal) {
  return new Promise(resolve => {
    (async () => {
      const out = [];
      while (!signal.aborted) {
        const t = performance.now();
        try {
          await fetch(DOWN_URL + '?bytes=0&r=' + Math.random(), { cache: 'no-store' });
          out.push(performance.now() - t);
        } catch (e) { /* 探测失败忽略 */ }
        await sleep(CFG.probeEvery);
      }
      resolve(out);
    })();
  });
}

function instSpeed(marks, windowMs) {
  const last = marks[marks.length - 1];
  let i = marks.length - 1;
  while (i > 0 && last.t - marks[i - 1].t < windowMs) i--;
  const a = marks[i];
  return last.t > a.t ? ((last.b - a.b) * 8) / (last.t - a.t) / 1000 : 0;
}

async function transferPhase(kind, opts = {}) {
  const ms = opts.ms || (kind === 'down' ? CFG.downMs : CFG.upMs);
  const conns = opts.connections || CFG.connections;
  const warmupMs = opts.warmupMs != null ? opts.warmupMs : CFG.warmupMs;
  const silent = !!opts.silent;
  const ac = new AbortController();
  let bytes = 0;
  const onBytes = n => { bytes += n; };
  const marks = [{ t: performance.now(), b: 0 }];
  const t0 = marks[0].t;

  const workers = [];
  for (let i = 0; i < conns; i++) {
    workers.push(kind === 'down'
      ? downloadWorker(ac.signal, onBytes)
      : uploadWorker(ac.signal, onBytes));
  }
  const probes = loadedProbes(ac.signal);

  const card = kind === 'down' ? $('cardDown') : $('cardUp');
  if (!silent) card.classList.add('active');

  const sampler = setInterval(() => {
    marks.push({ t: performance.now(), b: bytes });
    if (silent) return;
    const inst = instSpeed(marks, 1000);
    gauge.set(inst);
    chart.push({ phase: kind, v: inst });
    setMetric(kind === 'down' ? 'mDown' : 'mUp', fmtSpeed(inst));
  }, CFG.sampleEvery);

  await sleep(ms);
  ac.abort();
  clearInterval(sampler);
  if (!silent) card.classList.remove('active');
  const loaded = await probes;
  await Promise.allSettled(workers);

  marks.push({ t: performance.now(), b: bytes });
  // 稳定段速率：跳过 TCP 慢启动预热期
  const warmT = t0 + warmupMs;
  let base = marks[0];
  for (const m of marks) { if (m.t <= warmT) base = m; else break; }
  const last = marks[marks.length - 1];
  let stable = last.t > base.t + 300 ? ((last.b - base.b) * 8) / (last.t - base.t) / 1000 : 0;
  if (!isFinite(stable) || stable <= 0) {
    stable = last.t > t0 ? (last.b * 8) / (last.t - t0) / 1000 : 0;
  }
  const loadedAvg = loaded.length ? loaded.reduce((a, b) => a + b, 0) / loaded.length : null;
  return { mbps: stable, loadedAvg, bytes: last.b };
}

/* ============ 结果 ============ */
function bloatGrade(r) {
  if (r == null) return { g: '--', text: '无数据' };
  if (r < 1.05) return { g: 'A+', text: '负载下延迟几乎无变化，网络状况优秀' };
  if (r < 1.25) return { g: 'A', text: '负载下延迟轻微上升，日常使用无感' };
  if (r < 1.5) return { g: 'B', text: '负载下有一定延迟上升，视频会议偶尔受影响' };
  if (r < 2) return { g: 'C', text: '明显缓冲膨胀（Bufferbloat），满速下载时延迟明显变大' };
  if (r < 3) return { g: 'D', text: '较严重缓冲膨胀，下载时游戏/会议体验会明显恶化' };
  return { g: 'F', text: '严重缓冲膨胀，建议在路由器开启 SQM/QoS' };
}

function suitability({ d, u, ping, jitter, loss }) {
  const items = [
    { name: '4K 流媒体', ok: d >= 25, why: `需下行 ≥ 25 Mbps（实测 ${fmtSpeed(d)}）` },
    { name: '视频会议 / 直播开播', ok: d >= 10 && u >= 3.5 && ping <= 80, why: `需下行 ≥ 10、上行 ≥ 3.5 Mbps 且延迟 ≤ 80ms（实测 ${fmtSpeed(d)} / ${fmtSpeed(u)} / ${Math.round(ping)}ms）` },
    { name: '竞技网游', ok: ping <= 45 && jitter <= 10 && loss < 2, why: `需延迟 ≤ 45ms、抖动 ≤ 10ms、丢包 < 2%（实测 ${Math.round(ping)} / ${fmtMs(jitter)}ms / ${loss.toFixed(1)}%）` },
    { name: '大文件下载 / 云同步', ok: d >= 100, why: `下行 ≥ 100 Mbps 体验更佳（实测 ${fmtSpeed(d)}）` },
    { name: '日常网页 / 社交', ok: d >= 5, why: `需下行 ≥ 5 Mbps（实测 ${fmtSpeed(d)}）` },
  ];
  const box = $('suitChips');
  box.innerHTML = '';
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'chip ' + (it.ok ? 'pass' : 'fail');
    div.innerHTML = `<span class="mark">${it.ok ? '✓' : '✗'}</span><b>${it.name}</b><br><span style="color:var(--muted)">${it.why}</span>`;
    box.appendChild(div);
  }
}

function finish({ ping, down, up }) {
  setMetric('mDown', fmtSpeed(down.mbps));
  setMetric('mUp', fmtSpeed(up.mbps));
  for (const id of ['cardDown', 'cardUp']) {
    const el = $(id);
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }
  setMetric('mPing', String(fmtMs(ping.avg)));
  setMetric('mJitter', String(fmtMs(ping.jitter)));
  setMetric('mLoss', ping.lossPct.toFixed(1));

  const cand = [down.loadedAvg, up.loadedAvg].filter(v => v != null);
  const ratio = cand.length ? Math.max(...cand) / ping.avg : null;
  const bg = bloatGrade(ratio);
  setMetric('mBloat', bg.g);

  $('bloatBox').innerHTML =
    `延迟膨胀（Bufferbloat）等级 <b>${bg.g}</b>：空载延迟 ${fmtMs(ping.avg)}ms` +
    (ratio != null
      ? (ratio > 1.02
        ? `，满载时最差 ${fmtMs(Math.max(...cand))}ms（+${Math.max(0, Math.round((ratio - 1) * 100))}%）。<b>${bg.text}</b>`
        : `，满载时延迟未上升（最差 ${fmtMs(Math.max(...cand))}ms）。<b>${bg.text}</b>`)
      : `。满载数据缺失。`);

  suitability({ d: down.mbps, u: up.mbps, ping: ping.avg, jitter: ping.jitter, loss: ping.lossPct });

  saveHistory({
    ts: new Date().toISOString(),
    down: +down.mbps.toFixed(2), up: +up.mbps.toFixed(2),
    ping: Math.round(ping.avg), jitter: Math.round(ping.jitter),
    loss: +ping.lossPct.toFixed(1), bloat: bg.g,
  });

  $('resultPanel').hidden = false;
}

/* ============ 历史记录 ============ */
const HKEY = 'netscope_history';
function loadHistory() { try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch (e) { return []; } }
function saveHistory(row) {
  const h = loadHistory();
  h.unshift(row);
  localStorage.setItem(HKEY, JSON.stringify(h.slice(0, 12)));
  renderHistory();
}
function renderHistory() {
  const h = loadHistory();
  const tb = $('histBody');
  tb.innerHTML = '';
  $('histEmpty').style.display = h.length ? 'none' : '';
  for (const r of h) {
    const tr = document.createElement('tr');
    const d = new Date(r.ts);
    const pad = n => String(n).padStart(2, '0');
    tr.innerHTML = `<td>${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}</td>` +
      `<td>${fmtSpeed(r.down)}</td><td>${fmtSpeed(r.up)}</td><td>${r.ping}</td><td>${r.jitter}</td><td>${r.loss}</td><td>${r.bloat}</td>`;
    tb.appendChild(tr);
  }
}

/* ============ 主流程 ============ */
async function runTest() {
  if (running) return;
  running = true;
  startBtn.disabled = true;
  startBtn.textContent = '测试中';
  resetUI();
  try {
    Object.assign(CFG, DURATION_PRESETS[$('durationSel').value]);

    setStatus('获取 IP 与运营商信息…');
    await fetchInfo();

    setStatus('测量延迟与抖动…');
    const ping = await pingPhase();
    setMetric('mPing', String(fmtMs(ping.avg)));
    setMetric('mJitter', String(fmtMs(ping.jitter)));
    setMetric('mLoss', ping.lossPct.toFixed(1));

    setStatus('下载测速中（多连接并行）…');
    gauge.setPhase('down');
    const down = await transferPhase('down');
    if (down.mbps <= 0) throw new Error('下载测试失败：未收到数据');

    setStatus('上传测速中（多连接并行）…');
    ensureUploadData();
    gauge.setPhase('up');
    const up = await transferPhase('up');
    if (up.mbps <= 0) throw new Error('上传测试失败：数据发送未成功');

    finish({ ping, down, up });
    setStatus('测试完成', 'ok');
  } catch (e) {
    setStatus('测试失败：' + (e && e.message ? e.message : e), 'err');
  } finally {
    running = false;
    startBtn.disabled = false;
    startBtn.textContent = '开始测试';
    gauge.setPhase('idle');
  }
}

/* ============ 可选诊断服务器 ============ */
async function detectServer() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch('/api/whoami', { signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) {
      const j = await r.json();
      if (j && j.server) {
        SERVER_ON = true;
        const b = $('serverBadge');
        b.textContent = '诊断服务：已连接';
        b.classList.add('on');
        $('diagPanel').hidden = false;
      }
    }
  } catch (e) { /* 未运行 server.py，正常 */ }
}

function bindDiagnostics() {
  document.querySelectorAll('[data-diag]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.diag, host = btn.dataset.host;
      const out = $('diagOut');
      document.querySelectorAll('[data-diag]').forEach(b => (b.disabled = true));
      out.textContent = `运行中：${btn.textContent.trim()} …`;
      try {
        let url = '/api/' + kind + '?host=' + encodeURIComponent(host);
        if (btn.dataset.port) url += '&port=' + encodeURIComponent(btn.dataset.port);
        const r = await fetch(url);
        const j = await r.json();
        let head = '';
        if (kind === 'pathping' && Array.isArray(j.stats)) {
          head = j.stats.map(s => `跃点 ${s['跃点']}  ${s['地址']}  丢包 ${s['丢包%'] ?? '?'}%`)
            .join('\n') + '\n────────\n';
        } else if (kind === 'dnscompare' && Array.isArray(j.stats)) {
          head = j.stats.map(s => `${s['解析器']}：${s['耗时ms']} ms -> ${s['结果']}`).join('\n')
            + (j.verdict ? '\n结论：' + j.verdict : '') + '\n────────\n';
        } else if (j.stats) {
          head = JSON.stringify(j.stats, null, 2) + '\n────────\n';
        }
        out.textContent = head + (j.raw || j.error || '');
      } catch (e) {
        out.textContent = '诊断请求失败：' + e.message;
      } finally {
        document.querySelectorAll('[data-diag]').forEach(b => (b.disabled = false));
      }
    });
  });
}

/* ============ 多节点对比 ============ */
async function quickLatency(n = 3) {
  const v = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    try {
      await fetch(DOWN_URL + '?bytes=0&r=' + Math.random(), { cache: 'no-store' });
      v.push(performance.now() - t);
    } catch (e) { /* 忽略单次失败 */ }
  }
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function renderCompare(rows) {
  const tb = $('cmpBody');
  tb.innerHTML = '';
  const max = Math.max(1, ...rows.map(r => r.mbps || 0));
  const sorted = [...rows].sort((a, b) => (b.mbps ?? -1) - (a.mbps ?? -1));
  for (const r of sorted) {
    const tr = document.createElement('tr');
    const lineCls = r.line === '国内' ? 'dom' : r.line === '国际' ? 'intl' : 'stack';
    tr.innerHTML =
      `<td class="name"><b>${r.name}</b></td>` +
      `<td><span class="line-tag ${lineCls}">${r.line}</span></td>` +
      `<td>${r.ttfb != null ? Math.round(r.ttfb) + ' ms' : '--'}</td>` +
      `<td><b>${r.mbps != null ? fmtSpeed(r.mbps) : '--'}</b></td>` +
      `<td>${r.mbps != null
        ? `<div class="bar"><i style="width:${Math.max(3, (r.mbps / max) * 100).toFixed(1)}%"></i></div>`
        : `<span class="dead">${r.err || '不可用'}</span>`}</td>`;
    tb.appendChild(tr);
  }
  $('cmpTable').hidden = false;
}

async function runCompare() {
  if (running) return;
  running = true;
  const btn = $('compareBtn');
  btn.disabled = true; startBtn.disabled = true;
  const cStatus = t => { $('cmpStatus').textContent = t; };
  $('cmpBody').innerHTML = '';
  $('cmpTable').hidden = true;
  const rows = [];
  try {
    cStatus('国际节点（Cloudflare，浏览器直测）测速中…');
    const lat = await quickLatency(3);
    const cf = await transferPhase('down', { connections: 3, ms: 5000, warmupMs: 1000, silent: true });
    rows.push({
      name: 'Cloudflare', line: '国际', ttfb: lat,
      mbps: cf.mbps > 0 ? cf.mbps : null, err: cf.mbps > 0 ? null : '下载失败',
    });
    renderCompare(rows);

    if (SERVER_ON) {
      const names = { tencent: '腾讯 CDN', aliyun: '阿里 npmmirror', tuna: '清华 TUNA' };
      for (const id of ['tencent', 'aliyun', 'tuna']) {
        cStatus(`国内节点测速中：${names[id]} …`);
        try {
          const r = await (await fetch('/api/nodespeed?id=' + id + '&seconds=6')).json();
          if (r.ok) {
            rows.push({ name: r.stats['节点'], line: '国内', ttfb: r.stats['首字节ms'], mbps: r.stats['下载Mbps'] });
          } else {
            rows.push({ name: names[id], line: '国内', ttfb: null, mbps: null, err: (r.error || '').slice(0, 70) });
          }
        } catch (e) {
          rows.push({ name: names[id], line: '国内', ttfb: null, mbps: null, err: '请求失败' });
        }
        renderCompare(rows);
      }

      cStatus('IPv4 / IPv6 双栈检测中…');
      try {
        const r = await (await fetch('/api/dualstack?seconds=4')).json();
        rows.push({
          name: 'IPv4 通道', line: '双栈',
          ttfb: r.ipv4.ok ? r.ipv4['连接ms'] : null,
          mbps: r.ipv4.ok ? r.ipv4['下载Mbps'] : null,
          err: r.ipv4.ok ? null : (r.ipv4['错误'] || '').slice(0, 60),
        });
        rows.push({
          name: 'IPv6 通道', line: '双栈',
          ttfb: r.ipv6.ok ? r.ipv6['连接ms'] : null,
          mbps: r.ipv6.ok ? r.ipv6['下载Mbps'] : null,
          err: r.ipv6.ok ? null : (r.ipv6['错误'] || '').slice(0, 60),
        });
      } catch (e) { /* 服务器异常时跳过 */ }
      renderCompare(rows);
    } else {
      cStatus('国际节点完成。启动 python server.py 后可再对比国内节点与双栈通道 →');
    }

    const dom = rows.filter(r => r.line === '国内' && r.mbps > 0);
    const cfRow = rows.find(r => r.line === '国际' && r.mbps > 0);
    const v4 = rows.find(r => r.name === 'IPv4 通道');
    const v6 = rows.find(r => r.name === 'IPv6 通道');
    let verdict = '';
    if (cfRow && dom.length >= 2) {
      const davg = dom.reduce((a, b) => a + b.mbps, 0) / dom.length;
      const ratio = davg / cfRow.mbps;
      verdict = ratio > 1.8
        ? `国内均值 ${fmtSpeed(davg)} Mbps ≈ 国际的 ${ratio.toFixed(1)} 倍 —— 宽带本身正常，国际链路受限（出口拥塞）`
        : ratio < 0.6
          ? `国际 ${fmtSpeed(cfRow.mbps)} Mbps 高于国内均值 ${fmtSpeed(davg)} Mbps —— 国内节点或其 CDN 限速`
          : `国内 ${fmtSpeed(davg)} / 国际 ${fmtSpeed(cfRow.mbps)} Mbps 相当，链路均衡`;
    }
    if (v4 && v6 && v6.mbps != null && v4.mbps != null && v6.mbps < v4.mbps * 0.85) {
      verdict += (verdict ? '；' : '') + `IPv6 明显慢于 IPv4（${fmtSpeed(v6.mbps)} vs ${fmtSpeed(v4.mbps)}），可考虑优先 IPv4`;
    }
    if (verdict) cStatus('结论：' + verdict);
    else if (SERVER_ON) cStatus('对比完成');
  } catch (e) {
    cStatus('对比测试失败：' + e.message);
  } finally {
    running = false;
    btn.disabled = false;
    startBtn.disabled = false;
  }
}

/* ============ 启动 ============ */
startBtn.addEventListener('click', runTest);
$('retryBtn').addEventListener('click', runTest);
$('compareBtn').addEventListener('click', runCompare);
$('clearHist').addEventListener('click', () => { localStorage.removeItem(HKEY); renderHistory(); });
$('durationSel').addEventListener('change', e => Object.assign(CFG, DURATION_PRESETS[e.target.value]));
$('connSel').addEventListener('change', e => { CFG.connections = +e.target.value; });

renderHistory();
detectServer();
bindDiagnostics();
