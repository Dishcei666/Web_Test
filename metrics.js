'use strict';

/* 纯计算函数：浏览器与 Node.js 测试共用。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.NetScopeMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function fmtSpeed(v) {
    if (v == null || !Number.isFinite(v)) return '--';
    if (v >= 100) return String(Math.round(v));
    if (v >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }
  function fmtMs(v) { return v == null || !Number.isFinite(v) ? '--' : String(Math.round(v)); }
  function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
  function median(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function percentile(values, p) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const pos = (s.length - 1) * p;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }
  function jitter(samples) {
    const ok = samples.filter(v => v != null && Number.isFinite(v));
    if (ok.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < ok.length; i++) total += Math.abs(ok[i] - ok[i - 1]);
    return total / (ok.length - 1);
  }
  function instSpeed(marks, windowMs) {
    if (!marks.length) return 0;
    const last = marks[marks.length - 1];
    let i = 0;
    while (i < marks.length - 1 && marks[i].t < last.t - windowMs) i++;
    const a = marks[i];
    return last.t > a.t ? ((last.b - a.b) * 8) / (last.t - a.t) / 1000 : 0;
  }
  function stableSpeed(marks, warmupMs) {
    if (!marks.length) return { mbps: 0, bytes: 0, durationMs: 0 };
    const warmT = marks[0].t + warmupMs;
    let base = marks[0];
    for (const mark of marks) {
      if (mark.t <= warmT) base = mark;
      else break;
    }
    const last = marks[marks.length - 1];
    const durationMs = last.t - base.t;
    const bytes = last.b - base.b;
    return { mbps: durationMs > 300 ? bytes * 8 / durationMs / 1000 : 0, bytes, durationMs };
  }
  function bloatGrade(base, loaded) {
    if (base == null || loaded == null || base <= 0) return { g: '--', text: '满载样本不足', delta: null, ratio: null };
    const delta = Math.max(0, loaded - base);
    const ratio = loaded / base;
    let g, text;
    if (delta <= 2 || (delta <= 4 && ratio < 1.05)) { g = 'A+'; text = '满载延迟变化很小'; }
    else if (delta <= 5 || (delta <= 10 && ratio < 1.25)) { g = 'A'; text = '满载延迟轻微上升'; }
    else if (delta <= 10 || (delta <= 20 && ratio < 1.50)) { g = 'B'; text = '有一定满载延迟上升'; }
    else if (delta <= 20 || (delta <= 40 && ratio < 2.00)) { g = 'C'; text = '满载延迟明显上升'; }
    else if (delta <= 50 || (delta <= 80 && ratio < 3.00)) { g = 'D'; text = '缓冲膨胀较明显'; }
    else { g = 'F'; text = '缓冲膨胀明显，可了解路由器 SQM/QoS'; }
    return { g, text, delta, ratio };
  }
  function suitability({ d, u, ping, jitter: j, loss }) {
    return [
      { name: '4K 流媒体', ok: d >= 25, why: `参考下行 ≥ 25 Mbps；本次 ${fmtSpeed(d)} Mbps` },
      { name: '视频会议', ok: d >= 10 && u >= 3.5 && ping <= 80, why: `参考下行 ≥ 10、上行 ≥ 3.5 Mbps、延迟 ≤ 80 ms` },
      { name: '竞技网游', ok: ping <= 45 && j <= 10 && loss < 2, why: '仅以 Cloudflare HTTP 延迟与失败率作粗略参考，不代表游戏服务器' },
      { name: '大文件下载', ok: d >= 100, why: `下行 ≥ 100 Mbps 通常体验更佳；本次 ${fmtSpeed(d)} Mbps` },
      { name: '日常网页', ok: d >= 5, why: `参考下行 ≥ 5 Mbps；本次 ${fmtSpeed(d)} Mbps` },
    ];
  }
  return { fmtSpeed, fmtMs, mean, median, percentile, jitter, instSpeed, stableSpeed, bloatGrade, suitability };
});
