'use strict';

const M = globalThis.NetScopeMetrics;
const DOWN_URL = 'https://speed.cloudflare.com/__down';
const UP_URL = 'https://speed.cloudflare.com/__up';
const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const IPINFO_URL = 'https://ipwho.is/';
const DURATION_PRESETS = {
  fast: { downMs: 5000, upMs: 4000, warmupMs: 1200 },
  std: { downMs: 10000, upMs: 8000, warmupMs: 1500 },
};
const CFG = {
  connections: 4, pingCount: 12, pingGap: 120,
  chunkBytes: 25 * 1024 * 1024, upChunkBytes: 8 * 1024 * 1024,
  probeEvery: 400, sampleEvery: 200, ...DURATION_PRESETS.std,
};
const COMPARE_CFG = { connections: 3, ms: 5000, warmupMs: 1000 };
const TOKEN = document.querySelector('meta[name="netscope-token"]')?.content || '';
const $ = id => document.getElementById(id);
let SERVER_ON = false;
let activeTask = null;
let UP_DATA = null;
let lastReport = null;
const HKEY = 'netscope_history_v2';

function abortError() { return new DOMException('操作已取消', 'AbortError'); }
function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', stop); resolve(); }
    function stop() { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(abortError()); }
    signal?.addEventListener('abort', stop, { once: true });
  });
}
function linkAbort(parent, child) {
  if (!parent) return () => {};
  if (parent.aborted) child.abort();
  const stop = () => child.abort();
  parent.addEventListener('abort', stop, { once: true });
  return () => parent.removeEventListener('abort', stop);
}
async function fetchResource(url, { timeout = 8000, signal, method = 'GET', api = false } = {}) {
  const ctrl = new AbortController();
  const unlink = linkAbort(signal, ctrl);
  const timer = setTimeout(() => ctrl.abort('timeout'), timeout);
  try {
    const headers = api ? { 'X-NetScope-Token': TOKEN } : undefined;
    return await fetch(url, { method, headers, cache: 'no-store', signal: ctrl.signal });
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (ctrl.signal.aborted) throw new Error('请求超时或连接已中断');
    throw e;
  } finally {
    clearTimeout(timer);
    unlink();
  }
}
async function apiRequest(path, signal, timeout = 15000, method = 'POST') {
  const response = await fetchResource(path, { timeout, signal, method, api: true });
  let data;
  try { data = await response.json(); } catch (e) { throw new Error('诊断服务返回了无效响应'); }
  if (!response.ok) throw new Error(data.error || `诊断服务 HTTP ${response.status}`);
  return data;
}

/* ============ 任务与取消 ============ */
function setBusy(busy) {
  $('startBtn').disabled = busy;
  $('retryBtn').disabled = busy;
  $('compareBtn').disabled = busy;
  $('connSel').disabled = busy;
  $('durationSel').disabled = busy;
  $('cancelBtn').hidden = !busy;
  document.querySelectorAll('[data-diag]').forEach(b => { b.disabled = busy; });
}
function beginTask(label, usesServer = false) {
  if (activeTask) return null;
  const task = { label, usesServer, controller: new AbortController() };
  activeTask = task;
  setBusy(true);
  $('cancelBtn').disabled = false;
  $('cancelBtn').textContent = '取消当前任务';
  return task;
}
function endTask(task) {
  if (activeTask !== task) return;
  activeTask = null;
  setBusy(false);
}
async function cancelActive() {
  const task = activeTask;
  if (!task) return;
  task.controller.abort();
  $('cancelBtn').disabled = true;
  $('cancelBtn').textContent = '正在取消…';
  if (task.usesServer && SERVER_ON) {
    try { await apiRequest('/api/cancel', undefined, 2500); } catch (e) { /* 前端任务已取消 */ }
  }
  if (activeTask === task) $('cancelBtn').disabled = false;
}
function errorText(e) { return e?.name === 'AbortError' ? '已取消当前任务' : (e?.message || String(e)); }

/* ============ 仪表盘与曲线 ============ */
class Gauge {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 320 * dpr; canvas.height = 320 * dpr;
    this.ctx.scale(dpr, dpr);
    this.disp = 0; this.target = 0; this.phase = 'idle'; this.frame = 0;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  frac(v) { return v > 0 ? Math.min(1, Math.max(0, (Math.log10(v) - Math.log10(0.1)) / 4)) : 0; }
  set(v) { this.target = v || 0; this.schedule(); }
  setPhase(p) { this.phase = p; this.schedule(); }
  schedule() { if (!this.frame) this.frame = requestAnimationFrame(() => this.loop()); }
  loop() {
    this.frame = 0;
    this.disp = this.reduced ? this.target : this.disp + (this.target - this.disp) * 0.14;
    if (Math.abs(this.disp - this.target) < 0.01) this.disp = this.target;
    this.draw();
    if (this.disp !== this.target) this.schedule();
  }
  draw() {
    const ctx = this.ctx, cx = 160, cy = 160, R = 126;
    ctx.clearRect(0, 0, 320, 320);
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    ctx.lineCap = 'round'; ctx.lineWidth = 12; ctx.strokeStyle = 'rgba(148,163,184,.12)';
    ctx.beginPath(); ctx.arc(cx, cy, R, a0, a1); ctx.stroke();
    const f = this.frac(this.disp);
    if (f > 0.002) {
      const colors = this.phase === 'up' ? ['#c4b5fd', '#7c3aed'] : this.phase === 'down' ? ['#67e8f9', '#2563eb'] : ['#94a3b8', '#475569'];
      const grad = ctx.createLinearGradient(40, 40, 280, 280);
      grad.addColorStop(0, colors[0]); grad.addColorStop(1, colors[1]);
      ctx.strokeStyle = grad; ctx.shadowColor = colors[0]; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(cx, cy, R, a0, a0 + (a1 - a0) * f); ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.font = '11px "Segoe UI"'; ctx.textAlign = 'center';
    for (const tv of [0.1, 1, 10, 100, 1000]) {
      const a = a0 + (a1 - a0) * this.frac(tv);
      ctx.strokeStyle = 'rgba(148,163,184,.35)'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (R - 12), cy + Math.sin(a) * (R - 12));
      ctx.lineTo(cx + Math.cos(a) * (R - 21), cy + Math.sin(a) * (R - 21)); ctx.stroke();
      const rl = (tv === 0.1 || tv === 1000) ? R - 35 : R - 40;
      ctx.fillStyle = '#8290ad';
      ctx.fillText(tv >= 1 ? String(tv) : tv.toFixed(1), cx + Math.cos(a) * rl, cy + Math.sin(a) * rl + 4);
    }
    ctx.fillStyle = '#f1f5ff'; ctx.font = '700 34px "Segoe UI"';
    ctx.fillText(M.fmtSpeed(this.disp), cx, cy - 82);
    ctx.fillStyle = '#8290ad'; ctx.font = '11px "Segoe UI"'; ctx.fillText('Mbps', cx, cy - 60);
    this.cv.setAttribute('aria-label', `当前${this.phase === 'up' ? '上传' : '下载'}速率 ${M.fmtSpeed(this.disp)} Mbps`);
  }
}
class Chart {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.data = [];
    this.resize();
    if ('ResizeObserver' in window) new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    else window.addEventListener('resize', () => this.resize());
  }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.cv.clientWidth || this.cv.parentElement.clientWidth || 800;
    this.h = 180;
    this.cv.width = this.w * dpr; this.cv.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 1, 0);
    this.draw();
  }
  reset() { this.data = []; this.draw(); }
  push(sample) { this.data.push(sample); this.draw(); }
  draw() {
    const ctx = this.ctx, w = this.w, h = this.h;
    ctx.clearRect(0, 0, w, h);
    const maxV = Math.max(1, ...this.data.map(d => d.v));
    const pow = 10 ** Math.floor(Math.log10(maxV));
    const niceMax = [1, 2, 5, 10].find(m => maxV <= m * pow) * pow;
    ctx.font = '11px "Segoe UI"'; ctx.textAlign = 'left';
    for (let i = 0; i <= 4; i++) {
      const y = h - 22 - ((h - 42) * i / 4);
      ctx.strokeStyle = 'rgba(148,163,184,.09)';
      ctx.beginPath(); ctx.moveTo(42, y); ctx.lineTo(w - 8, y); ctx.stroke();
      ctx.fillStyle = '#71809f'; ctx.fillText(M.fmtSpeed(niceMax * i / 4), 2, y + 4);
    }
    if (this.data.length < 2) return;
    const t0 = this.data[0].t, t1 = this.data[this.data.length - 1].t;
    const x = t => 42 + (w - 50) * (t - t0) / Math.max(1, t1 - t0);
    const y = v => h - 22 - (h - 42) * v / niceMax;
    for (let i = 1; i < this.data.length; i++) {
      const a = this.data[i - 1], b = this.data[i];
      ctx.strokeStyle = b.phase === 'up' ? '#a78bfa' : '#22d3ee';
      ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(x(a.t), y(a.v)); ctx.lineTo(x(b.t), y(b.v)); ctx.stroke();
    }
    ctx.fillStyle = '#71809f'; ctx.fillText('0 s', 42, h - 4);
    ctx.textAlign = 'right'; ctx.fillText(`${((t1 - t0) / 1000).toFixed(1)} s`, w - 8, h - 4);
  }
}
const gauge = new Gauge($('gauge'));
const chart = new Chart($('chart'));
gauge.draw();
function setStatus(text, cls = '') { $('status').textContent = text; $('status').className = `status ${cls}`; }
function setMetric(id, value) { $(id).textContent = value; }
function resetUI() {
  ['mDown', 'mUp', 'mPing', 'mJitter', 'mLoss', 'mBloat'].forEach(id => setMetric(id, '--'));
  $('cardDown').classList.remove('pop', 'active'); $('cardUp').classList.remove('pop', 'active');
  gauge.set(0); gauge.setPhase('idle'); chart.reset(); $('resultPanel').hidden = true;
}

/* ============ 网络信息与探测 ============ */
async function fetchInfo(signal) {
  const ipPromise = (async () => {
    const r = await fetchResource(IPINFO_URL, { timeout: 5000, signal });
    if (!r.ok) throw new Error('IP 信息服务不可用');
    return r.json();
  })();
  const tracePromise = (async () => {
    const r = await fetchResource(TRACE_URL, { timeout: 5000, signal });
    if (!r.ok) throw new Error('Cloudflare 环境信息不可用');
    const text = await r.text();
    return Object.fromEntries(text.trim().split('\n').filter(l => l.includes('=')).map(l => l.split('=')));
  })();
  const [whoResult, traceResult] = await Promise.allSettled([ipPromise, tracePromise]);
  throwIfAborted(signal);
  const who = whoResult.status === 'fulfilled' ? whoResult.value : null;
  const trace = traceResult.status === 'fulfilled' ? traceResult.value : {};
  $('infoIp').textContent = trace.ip || who?.ip || '未知';
  const conn = who?.connection || {};
  $('infoIsp').textContent = who ? [conn.isp || conn.org, conn.asn ? `AS${conn.asn}` : ''].filter(Boolean).join(' · ') || '未知' : '获取失败';
  $('infoLoc').textContent = who ? [who.city, who.region, who.country].filter(Boolean).join(' · ') || '未知' : '获取失败';
  $('infoIpType').textContent = who?.type || '--';
  $('infoColo').textContent = trace.colo ? trace.colo + (trace.loc ? `（属地 ${trace.loc}）` : '') : '未知';
  const proxyEl = $('infoProxy'); proxyEl.classList.remove('warn');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const raw = who?.timezone;
  const wtz = raw ? (typeof raw === 'string' ? raw : raw.id) : '';
  if (wtz && tz) {
    proxyEl.textContent = wtz === tz ? `时区一致（${tz}）` : `时区不同：出口 ${wtz} / 浏览器 ${tz}`;
    proxyEl.classList.toggle('warn', wtz !== tz);
  } else proxyEl.textContent = '无法判断';
}
async function pingPhase(signal) {
  const samples = [];
  for (let i = 0; i < CFG.pingCount; i++) {
    throwIfAborted(signal);
    const t = performance.now();
    try {
      const r = await fetchResource(`${DOWN_URL}?bytes=0&r=${Math.random()}`, { timeout: 5000, signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      samples.push(performance.now() - t);
    } catch (e) {
      throwIfAborted(signal);
      samples.push(null);
    }
    if (i < CFG.pingCount - 1) await sleep(CFG.pingGap, signal);
  }
  const body = samples.slice(1);
  const ok = body.filter(v => v != null);
  if (!ok.length) throw new Error('无法连接 speed.cloudflare.com，请检查网络或代理');
  return {
    avg: M.mean(ok), median: M.median(ok), min: Math.min(...ok), max: Math.max(...ok),
    jitter: M.jitter(body), lossPct: (body.length - ok.length) / body.length * 100,
  };
}

/* ============ 下载 / 上传 ============ */
async function downloadWorker(signal, onBytes, state) {
  while (!signal.aborted) {
    const ctrl = new AbortController();
    const unlink = linkAbort(signal, ctrl);
    try {
      const res = await fetch(`${DOWN_URL}?bytes=${CFG.chunkBytes}&r=${Math.random()}`, { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      state.accepted++;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onBytes(value.length);
      }
    } catch (e) {
      if (signal.aborted) return;
      state.failed++;
      try { await sleep(Math.min(2000, 300 + state.failed * 100), signal); } catch (err) { return; }
    } finally { unlink(); }
  }
}
function ensureUploadData() {
  if (UP_DATA) return;
  UP_DATA = new Uint8Array(CFG.upChunkBytes);
  for (let i = 0; i < UP_DATA.length; i += 65536) crypto.getRandomValues(UP_DATA.subarray(i, Math.min(i + 65536, UP_DATA.length)));
}
function uploadOnce(signal, onBytes, size) {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    const started = performance.now();
    let last = 0, settled = false;
    const cleanup = () => { signal.removeEventListener('abort', stop); };
    const done = ok => { if (settled) return; settled = true; cleanup(); resolve({ ok, status: xhr.status, duration: performance.now() - started }); };
    const stop = () => { try { xhr.abort(); } catch (e) {} done(false); };
    xhr.open('POST', `${UP_URL}?r=${Math.random()}`);
    xhr.timeout = 15000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => { const delta = Math.max(0, e.loaded - last); last = e.loaded; onBytes(delta); };
    xhr.onloadend = () => done(!signal.aborted && xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => done(false);
    xhr.ontimeout = () => done(false);
    signal.addEventListener('abort', stop, { once: true });
    try { xhr.send(UP_DATA.subarray(0, size)); } catch (e) { done(false); }
  });
}
async function uploadWorker(signal, onBytes, state) {
  let size = 256 * 1024;
  while (!signal.aborted) {
    const result = await uploadOnce(signal, onBytes, size);
    if (signal.aborted) return;
    state.lastStatus = result.status;
    if (result.ok) {
      state.accepted++; state.failures = 0;
      if (result.duration < 1500) size = Math.min(CFG.upChunkBytes, size * 2);
      else if (result.duration > 5000) size = Math.max(256 * 1024, Math.floor(size / 2));
    } else {
      state.failed++; state.failures = (state.failures || 0) + 1;
      try { await sleep(Math.min(2000, 300 + state.failures * 200), signal); } catch (e) { return; }
    }
  }
}
async function loadedProbes(signal) {
  const out = [];
  while (!signal.aborted) {
    const t = performance.now();
    try {
      const r = await fetchResource(`${DOWN_URL}?bytes=0&r=${Math.random()}`, { timeout: 5000, signal });
      if (r.ok) out.push(performance.now() - t);
    } catch (e) { if (signal.aborted) break; }
    try { await sleep(CFG.probeEvery, signal); } catch (e) { break; }
  }
  return out;
}
async function transferPhase(kind, opts = {}) {
  const parent = opts.signal;
  const ac = new AbortController();
  const unlink = linkAbort(parent, ac);
  const ms = opts.ms || (kind === 'down' ? CFG.downMs : CFG.upMs);
  const conns = opts.connections || CFG.connections;
  const warmupMs = opts.warmupMs ?? CFG.warmupMs;
  const silent = !!opts.silent;
  const useProbes = opts.probes !== false;
  let bytes = 0;
  const state = { accepted: 0, failed: 0, failures: 0 };
  const marks = [{ t: performance.now(), b: 0 }];
  const onBytes = n => { bytes += n; };
  const workers = Array.from({ length: conns }, () => kind === 'down' ? downloadWorker(ac.signal, onBytes, state) : uploadWorker(ac.signal, onBytes, state));
  const probes = useProbes ? loadedProbes(ac.signal) : Promise.resolve([]);
  const card = kind === 'down' ? $('cardDown') : $('cardUp');
  if (!silent) card.classList.add('active');
  const sampler = setInterval(() => {
    marks.push({ t: performance.now(), b: bytes });
    if (silent) return;
    const inst = M.instSpeed(marks, 1000);
    gauge.set(inst); chart.push({ phase: kind, v: inst, t: performance.now() });
    setMetric(kind === 'down' ? 'mDown' : 'mUp', M.fmtSpeed(inst));
  }, CFG.sampleEvery);
  try { await sleep(ms, ac.signal); } catch (e) { /* 取消后仍先清理工作线程 */ }
  ac.abort(); clearInterval(sampler);
  if (!silent) card.classList.remove('active');
  const loaded = await probes;
  await Promise.allSettled(workers);
  unlink();
  throwIfAborted(parent);
  marks.push({ t: performance.now(), b: bytes });
  let result = M.stableSpeed(marks, warmupMs);
  if (result.mbps <= 0) result = M.stableSpeed(marks, 0);
  return {
    mbps: result.mbps, bytes, accepted: state.accepted, failed: state.failed, lastStatus: state.lastStatus,
    loadedMedian: M.median(loaded), loadedP90: M.percentile(loaded, 0.9), loadedSamples: loaded.length,
  };
}

/* ============ 结果、历史与报告 ============ */
function renderBloat(downGrade, upGrade) {
  const order = ['--', 'A+', 'A', 'B', 'C', 'D', 'F'];
  const worst = order.indexOf(downGrade.g) >= order.indexOf(upGrade.g) ? downGrade : upGrade;
  setMetric('mBloat', worst.g);
  const detail = (name, g) => `${name}：${g.g}，满载中位延迟 ${g.delta == null ? '无样本' : `增加约 ${M.fmtMs(g.delta)} ms`}；${g.text}`;
  $('bloatBox').innerHTML = `<strong>Bufferbloat 参考等级 ${worst.g}</strong><span>${detail('下载满载', downGrade)}</span><span>${detail('上传满载', upGrade)}</span><small>同时使用绝对增量与相对增幅，结果仅描述本次到 Cloudflare 的 HTTP 探测。</small>`;
  return worst.g;
}
function finish({ ping, down, up }) {
  setMetric('mDown', M.fmtSpeed(down.mbps)); setMetric('mUp', M.fmtSpeed(up.mbps));
  for (const id of ['cardDown', 'cardUp']) { const el = $(id); el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  setMetric('mPing', M.fmtMs(ping.median)); setMetric('mJitter', M.fmtMs(ping.jitter)); setMetric('mLoss', ping.lossPct.toFixed(1));
  const downGrade = M.bloatGrade(ping.median, down.loadedMedian);
  const upGrade = M.bloatGrade(ping.median, up.loadedMedian);
  const grade = renderBloat(downGrade, upGrade);
  const items = M.suitability({ d: down.mbps, u: up.mbps, ping: ping.median, jitter: ping.jitter, loss: ping.lossPct });
  const box = $('suitChips'); box.replaceChildren();
  for (const item of items) {
    const div = document.createElement('div'); div.className = `chip ${item.ok ? 'pass' : 'fail'}`;
    const title = document.createElement('strong'); title.textContent = `${item.ok ? '较适合' : '可能不佳'} · ${item.name}`;
    const why = document.createElement('span'); why.textContent = item.why;
    div.append(title, why); box.appendChild(div);
  }
  const row = {
    ts: new Date().toISOString(), down: +down.mbps.toFixed(2), up: +up.mbps.toFixed(2),
    ping: Math.round(ping.median), jitter: Math.round(ping.jitter), loss: +ping.lossPct.toFixed(1), bloat: grade,
    connections: CFG.connections, duration: $('durationSel').value, node: $('infoColo').textContent,
  };
  saveHistory(row);
  lastReport = { ...row, pingAvg: Math.round(ping.avg), downLoaded: down.loadedMedian, upLoaded: up.loadedMedian, downSamples: down.loadedSamples, upSamples: up.loadedSamples };
  $('resultPanel').hidden = false;
}
function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HKEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(r => r && typeof r === 'object' && Number.isFinite(r.down) && Number.isFinite(r.up)).slice(0, 50) : [];
  } catch (e) { return []; }
}
function saveHistory(row) {
  try { localStorage.setItem(HKEY, JSON.stringify([row, ...loadHistory()].slice(0, 50))); }
  catch (e) { setStatus('测试完成，但浏览器禁止保存历史记录', 'warn'); }
  renderHistory();
}
function renderHistory() {
  const rows = loadHistory(), tb = $('histBody'); tb.replaceChildren();
  $('histEmpty').hidden = rows.length > 0; $('exportHist').disabled = !rows.length;
  for (const row of rows) {
    const tr = document.createElement('tr'), date = new Date(row.ts);
    const values = [date.toLocaleString('zh-CN', { hour12: false }), M.fmtSpeed(row.down), M.fmtSpeed(row.up), row.ping, row.jitter, row.loss, row.bloat];
    for (const value of values) { const td = document.createElement('td'); td.textContent = value ?? '--'; tr.appendChild(td); }
    tb.appendChild(tr);
  }
}
function downloadBlob(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportHistory() {
  const rows = loadHistory();
  if (!rows.length) return;
  const esc = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const lines = ['时间,下载 Mbps,上传 Mbps,延迟 ms,抖动 ms,HTTP失败率 %,Bufferbloat,连接数,时长,节点'];
  rows.forEach(r => lines.push([r.ts, r.down, r.up, r.ping, r.jitter, r.loss, r.bloat, r.connections, r.duration, r.node].map(esc).join(',')));
  downloadBlob(`netscope-history-${new Date().toISOString().slice(0, 10)}.csv`, '\ufeff' + lines.join('\n'), 'text/csv;charset=utf-8');
}
function exportReport() {
  if (!lastReport) return;
  const r = lastReport;
  const text = `# NetScope 一次性网络检测报告\n\n- 时间：${new Date(r.ts).toLocaleString('zh-CN')}\n- 下载：${r.down} Mbps\n- 上传：${r.up} Mbps\n- 空载延迟中位数：${r.ping} ms（均值 ${r.pingAvg} ms）\n- 抖动：${r.jitter} ms\n- HTTP 探测失败率：${r.loss}%\n- Bufferbloat 参考等级：${r.bloat}\n- 下载满载中位延迟：${M.fmtMs(r.downLoaded)} ms（${r.downSamples} 个样本）\n- 上传满载中位延迟：${M.fmtMs(r.upLoaded)} ms（${r.upSamples} 个样本）\n- 并发连接：${r.connections}\n- Cloudflare 节点：${r.node}\n- 公网 IP：${$('infoIp').textContent}\n- 运营商：${$('infoIsp').textContent}\n- 位置：${$('infoLoc').textContent}\n\n> 本报告是一次性 HTTP 测量快照，不代表长期网络质量，也不能单独证明故障原因。\n`;
  downloadBlob(`netscope-report-${Date.now()}.md`, text, 'text/markdown;charset=utf-8');
}

/* ============ 主流程 ============ */
async function runTest() {
  const task = beginTask('主测速'); if (!task) return;
  const signal = task.controller.signal;
  startBtnText('测试中'); resetUI();
  try {
    Object.assign(CFG, DURATION_PRESETS[$('durationSel').value]);
    setStatus('获取网络环境信息…'); await fetchInfo(signal);
    setStatus('测量 Cloudflare 空载延迟、抖动与 HTTP 失败率…');
    const ping = await pingPhase(signal);
    setMetric('mPing', M.fmtMs(ping.median)); setMetric('mJitter', M.fmtMs(ping.jitter)); setMetric('mLoss', ping.lossPct.toFixed(1));
    setStatus('下载测速中 · 多连接并行'); gauge.setPhase('down');
    const down = await transferPhase('down', { signal });
    if (down.mbps <= 0 || !down.accepted) throw new Error('下载测试失败：没有成功的测速响应');
    ensureUploadData();
    setStatus('验证上传通道…');
    const uploadCheck = await uploadOnce(signal, () => {}, 256);
    if (!uploadCheck.ok) throw new Error(`上传通道验证失败${uploadCheck.status ? `（HTTP ${uploadCheck.status}）` : '（连接失败或被拦截）'}`);
    setStatus('上传测速中 · 多连接并行'); gauge.setPhase('up');
    const up = await transferPhase('up', { signal });
    if (up.mbps <= 0) throw new Error('上传测试失败：没有统计到有效发送数据');
    finish({ ping, down, up });
    if (!$('status').classList.contains('warn')) setStatus('测试完成 · 已生成本次检测快照', 'ok');
  } catch (e) { setStatus(errorText(e), e?.name === 'AbortError' ? '' : 'err'); }
  finally { endTask(task); startBtnText('开始测试'); gauge.setPhase('idle'); }
}
function startBtnText(text) { $('startBtn').querySelector('span').textContent = text; }

/* ============ 本地诊断服务 ============ */
function setServerState(on) {
  SERVER_ON = on;
  const badge = $('serverBadge');
  badge.textContent = on ? '诊断服务已连接' : '基础浏览器模式';
  badge.classList.toggle('on', on);
  $('diagPanel').hidden = !on;
}
async function detectServer(signal) {
  try {
    const data = await apiRequest('/api/whoami', signal, 1800, 'GET');
    setServerState(!!data.server);
  } catch (e) { if (e?.name !== 'AbortError') setServerState(false); }
}
function bindDiagnostics() {
  document.querySelectorAll('[data-diag]').forEach(btn => btn.addEventListener('click', async () => {
    const task = beginTask('系统诊断', true); if (!task) return;
    const signal = task.controller.signal;
    const kind = btn.dataset.diag, host = btn.dataset.host;
    const out = $('diagOut'); out.textContent = `运行中：${btn.textContent.trim()} …`;
    try {
      let url = `/api/${kind}?host=${encodeURIComponent(host)}`;
      if (btn.dataset.port) url += `&port=${encodeURIComponent(btn.dataset.port)}`;
      const timeout = kind === 'pathping' ? 130000 : kind === 'traceroute' ? 70000 : 30000;
      const data = await apiRequest(url, signal, timeout);
      let head = '';
      if (kind === 'pathping' && Array.isArray(data.stats)) head = data.stats.map(s => `跃点 ${s['跃点']}  ${s['地址']}  丢包 ${s['丢包%'] ?? '?'}%`).join('\n') + '\n────────\n';
      else if (kind === 'dnscompare' && Array.isArray(data.stats)) head = data.stats.map(s => `${s['解析器']}：${s['耗时ms']} ms -> ${s['结果']}`).join('\n') + `\n说明：${data.verdict || ''}\n────────\n`;
      else if (data.stats) head = JSON.stringify(data.stats, null, 2) + '\n────────\n';
      out.textContent = head + (data.raw || data.error || '');
    } catch (e) { out.textContent = errorText(e); }
    finally { endTask(task); }
  }));
}

/* ============ 多节点参考对比 ============ */
async function quickLatency(signal, n = 3) {
  const values = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    try {
      const r = await fetchResource(`${DOWN_URL}?bytes=0&r=${Math.random()}`, { timeout: 5000, signal });
      if (r.ok) values.push(performance.now() - t);
    } catch (e) { throwIfAborted(signal); }
  }
  return M.mean(values);
}
function renderCompare(rows) {
  const tb = $('cmpBody'); tb.replaceChildren();
  const max = Math.max(1, ...rows.map(r => r.mbps || 0));
  const sorted = [...rows].sort((a, b) => (b.mbps ?? -1) - (a.mbps ?? -1));
  for (const row of sorted) {
    const tr = document.createElement('tr');
    const values = [row.name, row.line, row.ttfb != null ? `${Math.round(row.ttfb)} ms` : '--', row.mbps != null ? M.fmtSpeed(row.mbps) : '--'];
    values.forEach((value, index) => { const td = document.createElement('td'); td.textContent = value; if (index === 3) td.className = 'speed-cell'; tr.appendChild(td); });
    const td = document.createElement('td');
    if (row.mbps != null) {
      const bar = document.createElement('div'); bar.className = 'bar';
      const fill = document.createElement('i'); fill.style.width = `${Math.max(3, row.mbps / max * 100).toFixed(1)}%`;
      bar.appendChild(fill); td.appendChild(bar);
    } else { const span = document.createElement('span'); span.className = 'dead'; span.textContent = row.err || '不可用'; td.appendChild(span); }
    tr.appendChild(td); tb.appendChild(tr);
  }
  $('cmpTable').hidden = false;
}
async function runCompare() {
  const task = beginTask('节点对比', true); if (!task) return;
  const signal = task.controller.signal, rows = [];
  $('cmpBody').replaceChildren(); $('cmpTable').hidden = true;
  const status = text => { $('cmpStatus').textContent = text; };
  try {
    status('Cloudflare 参考节点测速中…');
    const latency = await quickLatency(signal);
    const cf = await transferPhase('down', { ...COMPARE_CFG, silent: true, probes: false, signal });
    rows.push({ name: 'Cloudflare', line: '公共节点', ttfb: latency, mbps: cf.mbps > 0 ? cf.mbps : null, err: '下载失败' });
    renderCompare(rows);
    await detectServer(signal);
    if (SERVER_ON) {
      const names = { tencent: '腾讯 CDN', aliyun: '阿里 npmmirror', tuna: '清华 TUNA' };
      for (const id of ['tencent', 'aliyun', 'tuna']) {
        status(`国内参考节点测速中：${names[id]}…`);
        try {
          const data = await apiRequest(`/api/nodespeed?id=${id}&seconds=5&conns=3&warmup=1`, signal, 30000);
          rows.push(data.ok
            ? { name: data.stats['节点'], line: '国内节点', ttfb: data.stats['首字节ms'], mbps: data.stats['下载Mbps'] }
            : { name: names[id], line: '国内节点', ttfb: null, mbps: null, err: (data.error || '').slice(0, 70) });
        } catch (e) {
          throwIfAborted(signal);
          rows.push({ name: names[id], line: '国内节点', ttfb: null, mbps: null, err: e.message.slice(0, 70) });
        }
        renderCompare(rows);
      }
      status('IPv4 / IPv6 顺序测速中…');
      try {
        const data = await apiRequest('/api/dualstack?seconds=5&conns=3&warmup=1', signal, 45000);
        for (const [key, name] of [['ipv4', 'IPv4 通道'], ['ipv6', 'IPv6 通道']]) {
          const item = data[key];
          rows.push({ name, line: '协议栈', ttfb: item.ok ? item['连接ms'] : null, mbps: item.ok ? item['下载Mbps'] : null, err: item.ok ? null : (item['错误'] || '').slice(0, 60) });
        }
      } catch (e) { throwIfAborted(signal); status('双栈测量未完成：' + e.message); }
      renderCompare(rows);
    } else status('Cloudflare 测量完成。启动本地诊断服务后可对比更多节点与协议栈。');
    const domestic = rows.filter(r => r.line === '国内节点' && r.mbps > 0);
    const cfRow = rows.find(r => r.name === 'Cloudflare' && r.mbps > 0);
    const v4 = rows.find(r => r.name === 'IPv4 通道' && r.mbps != null);
    const v6 = rows.find(r => r.name === 'IPv6 通道' && r.mbps != null);
    const notes = [];
    if (cfRow && domestic.length >= 2) {
      const avg = M.mean(domestic.map(r => r.mbps)), ratio = avg / cfRow.mbps;
      notes.push(`本次国内节点均值 ${M.fmtSpeed(avg)} Mbps，Cloudflare ${M.fmtSpeed(cfRow.mbps)} Mbps（比值 ${ratio.toFixed(1)}）。差异可能来自链路、节点调度或测速实现，不能单独归因于宽带或出口。`);
    }
    if (v4 && v6) notes.push(`本次 IPv4 ${M.fmtSpeed(v4.mbps)} / IPv6 ${M.fmtSpeed(v6.mbps)} Mbps；协议栈顺序测量可避免相互抢占带宽。`);
    if (notes.length) status('参考结论：' + notes.join(' '));
    else if (SERVER_ON && !signal.aborted) status('对比完成。不同实现与公共节点仍可能造成结果差异。');
  } catch (e) { status(errorText(e)); }
  finally { endTask(task); }
}

/* ============ 启动 ============ */
$('startBtn').addEventListener('click', runTest);
$('retryBtn').addEventListener('click', runTest);
$('compareBtn').addEventListener('click', runCompare);
$('cancelBtn').addEventListener('click', cancelActive);
$('clearHist').addEventListener('click', () => { try { localStorage.removeItem(HKEY); } catch (e) {} renderHistory(); });
$('exportHist').addEventListener('click', exportHistory);
$('exportReportBtn').addEventListener('click', exportReport);
$('durationSel').addEventListener('change', e => Object.assign(CFG, DURATION_PRESETS[e.target.value]));
$('connSel').addEventListener('change', e => { CFG.connections = +e.target.value; });
renderHistory(); bindDiagnostics(); setServerState(false); detectServer();
