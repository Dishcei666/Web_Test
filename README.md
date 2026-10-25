# NetScope · 网络环境测试台

一个本地运行、浏览器操作的**一次性网络检测工具**。它用于形成当前时刻的网络快照，帮助发现速率、延迟、节点、DNS 或本机链路差异；不是长期监控系统，也不把单次结果当作故障归属证明。

![界面预览](docs/screenshot.png)

## 快速开始

### 完整功能（推荐）

```bash
python server.py
# 或
npm run dev
```

默认打开 `http://127.0.0.1:8000`，只使用 Python 标准库，无需 `pip install` 或安装 npm 依赖。

```bash
python server.py --port 9000       # 修改端口
python server.py --no-open         # 不自动打开浏览器
npm run dev -- --host 127.0.0.1 --port 7100 --no-open
```

完整模式包括国内公共节点对比、IPv4/IPv6 双栈测量和系统级诊断。默认只监听本机；只有明确需要其他设备访问时才应修改 `--host`。

### 基础模式

直接打开 `index.html` 可测量 Cloudflare 下载、上传、延迟、抖动、HTTP 失败率、Bufferbloat 和网络环境信息。直接打开文件时，本地诊断、国内节点和双栈测量不可用。

## 功能

- **主测速**：下载、上传、空载延迟中位数、抖动、HTTP 探测失败率。
- **Bufferbloat**：分别评估下载和上传满载延迟，同时考虑绝对毫秒增量与相对增幅。
- **实时曲线**：按真实时间绘制下载和上传速率，而不是按样本编号绘制。
- **参考对比**：Cloudflare、腾讯、阿里、清华公共节点，以及 IPv4/IPv6 协议栈。对比统一使用 3 条连接、5 秒测量和 1 秒预热。
- **系统诊断**：WiFi、本机摘要、ICMP Ping、pathping、路由追踪、DNS 解析差异、TCP 端口。
- **结果导出**：导出本次 Markdown 报告或最近记录 CSV。
- **本机历史**：当前浏览器最多保存 50 次快照；可清空，不建立长期数据库。
- **任务控制**：统一任务锁，避免诊断与测速相互干扰；支持取消、超时和失败重试。

## 测量口径与边界

| 指标 | 实现 | 不能代表什么 |
|---|---|---|
| 下载 | 多连接接收 Cloudflare 数据，跳过预热后计算稳定期吞吐 | 所有网站或长期宽带速率 |
| 上传 | 先用微小请求确认服务端 HTTP 成功，再按发送进度统计；数据块从 256 KB 起按耗时自适应，最大 8 MB | 服务端永久存储或端到端应用性能 |
| 延迟 | 到 Cloudflare 的 HTTP 空载 RTT，中位数用于结果和 Bufferbloat 基准 | 游戏、会议等具体服务器的延迟 |
| 抖动 | 相邻成功 HTTP 样本差绝对值的均值 | 任意 UDP 流的真实抖动 |
| 失败率 | HTTP 探测失败占比 | ICMP 或真实业务丢包率 |
| Bufferbloat | 空载与下载/上传满载中位延迟对比 | 标准化实验室评级或长期结论 |

多节点结果仍可能受到 CDN 调度、缓存、浏览器与 Python 的协议栈差异影响。页面只给出参考描述，不使用“国内快即可证明国际出口故障”之类的确定性归因。

DNS 功能现在称为**解析差异对比**。不同解析器返回不同 CDN 地址可能完全正常；结果一致也不能单独排除污染或劫持。系统 DNS 可能命中缓存，其耗时不应与 UDP、DoH 直接排名。

## 安全与隐私

- 本地服务默认只监听 `127.0.0.1`。
- API 需要每次启动随机生成的令牌，并校验 `Host` 与 `Origin`，不开放跨域读取。
- 静态资源采用白名单，不公开 `.git`、源代码、测试或目录内的其他文件。
- 诊断使用 POST，重接口有基础频率限制；系统命令支持取消和超时。
- 页面带 CSP、禁止嵌入、MIME 嗅探保护和禁用缓存等响应头。
- 历史仅存浏览器 `localStorage`。测速与环境识别会访问 Cloudflare、ipwho.is；国内节点和 DoH 诊断会访问对应公共服务。
- 测速会消耗真实流量，高带宽和移动按量网络下请谨慎运行。

## 文件结构

```text
Web_Test/
├── index.html          # 页面与可访问性结构
├── style.css           # 响应式深色视觉系统
├── metrics.js          # 可独立测试的纯计算函数
├── app.js              # 测速、任务控制、图表、历史与报告
├── server.py           # 安全 HTTP 服务、令牌、路由与静态白名单
├── diagnostics.py      # 系统诊断、DNS 与多连接节点测量
├── tests/              # 算法、DNS、取消与本地安全测试
├── package.json        # 可选 npm 启动和测试命令
└── docs/screenshot.png
```

## 测试

```bash
npm test
# 或分别运行
node tests/test_metrics.js
python -m unittest discover -s tests -v
```

测试不需要访问公共测速节点。GitHub Actions 会对推送和拉取请求运行同一组测试。

## 兼容性

主要面向当前版本 Chrome、Edge、Firefox 和 Safari。系统诊断以 Windows 为主，Linux/macOS 的部分功能取决于系统是否提供 `ping`、`traceroute`、`iwconfig`、`ip` 或 `ifconfig` 等命令；`pathping` 仅 Windows 可用。

## 开源许可

[MIT](LICENSE)
