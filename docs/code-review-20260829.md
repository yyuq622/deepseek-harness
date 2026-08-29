# 深度代码审查报告（2026-08-29）

English summary: see [优先修复清单](#优先修复清单按性价比排序) for the ranked top-20; all findings below carry file:line evidence verified in source on this date.

## 范围与方法

本次审查覆盖 `packages/` 与 `native/` 中约 200 个包、1809 个 TypeScript 源文件（约 26.5 万行，不含测试与构建产物）。因仓库规模远超单次逐行审查能力，审查按风险定向：对安全关键面（命令执行、文件系统、网络入口、凭据、审批、持久化）逐文件精读，对其余包做模式扫描（同步 I/O、计时器、缓存、动态 SQL、代码执行点）加热点抽验。所有列入报告的问题都经过源码级验证，行号取自当日源文件。

审查维度按用户要求分四类：潜在 bug、安全隐患、性能瓶颈、架构问题。严重程度定义：P0 = 可利用漏洞/数据损坏/崩溃；P1 = 重要正确性缺陷或特定条件下触发的安全问题；P2 = 中等风险缺陷；P3 = 建议级改进。

**结论先行：未发现 P0 级问题。** 该代码库的关键安全面（命令注入、路径包含、SSRF、webhook 鉴权、审批 fail-closed、日志完整性）均有系统性的防御实现，与 [docs/defensive-patterns.md](defensive-patterns.md) 记录的历史 bug 类别逐条对照未发现复发。有效发现集中在平台特定语义（Windows 进程树终止）、资源生命周期（spill 文件）与可维护性上。

## 发现总览

| 严重程度 | 数量 | 代表问题 |
|---|---|---|
| P0 严重 | 0 | — |
| P1 重要 | 2 | Windows 孤儿进程树；spill 文件磁盘累积泄漏 |
| P2 一般 | 4 | 错误遮蔽；同步 taskkill 阻塞事件循环；符号链接逃逸；env 清洗过宽 |
| P3 建议 | 7 | 执行器重复、巨型文件、连接无复用、缓存头缺失、无速率限制、fsync 策略、夹具位置 |

---

## P0 严重

未发现。重点排查并确认无恙的面：命令组装（argv 逐元素传递，无 shell 字符串拼接）、凭据环境清洗（`SENSITIVE_ENV_PATTERN` 独立叠加 `DSH_*` 剥离）、web-fetch SSRF（DNS 一次性解析 + 地址钉扎 + NAT64 检查 + 跨源重定向拒绝）、GitHub webhook（bounded body + HMAC 时序安全验证 + 严格 Content-Type）、审批链（无应答器与异常一律 fail-closed）、SQLite（全部预编译参数化，表名经 `UNIT_NAME_RE` 校验后插值）、JSONL 持久化（fsync + 撕裂尾修复）、浏览器鉴权（HMAC + `timingSafeEqual`）。

---

## P1 重要

### [P1-1] Windows 上中止/超时无法终止"根进程已自然退出"的进程树后代

- 位置：[packages/subprocess/subprocess-local/src/spawn.ts:386](../packages/subprocess/subprocess-local/src/spawn.ts#L386)（`treeAlive()` 的 win32 分支）、[spawn.ts:439](../packages/subprocess/subprocess-local/src/spawn.ts#L439)（`terminate()`）、[spawn.ts:297](../packages/subprocess/subprocess-local/src/spawn.ts#L297)（`signalTree()`）
- 描述：Windows 上 `treeAlive()` 只观察直接子进程的退出状态：`return child.exitCode === null && child.signalCode === null`，注释假设"taskkill /T already took the tree with it"。该假设仅当树是**被 taskkill 杀死**时成立；若根进程自然退出（exit 0）但留下了脱离的后代（如命令执行 `Start-Process foo` 或 `start /b`），`terminate()` 在 `if (!treeAlive()) return` 处直接返回，后代进程无人终止。POSIX 侧没有此问题：进程组信号 `process.kill(-pid)` 可触达孤儿成员，且 `treeAlive()` 探测组存活。
- 影响：Windows（本仓库的一等平台）上，被取消/超时的 bash/pwsh 工具调用若启动了脱离进程，取消后这些进程继续运行——占用文件句柄（阻塞后续 fs 写入）、端口、CPU；语义上与 POSIX 行为不一致，也违反"teardown 必须到达 quiescence"的自家规约（[docs/defensive-patterns.md](defensive-patterns.md#dispose-must-reach-quiescence-not-just-request-it)）。
- 修复建议：Windows 侧复用 [windows-inspector.ts](../packages/subprocess/subprocess-local/src/windows-inspector.ts#L53) 已有的 Toolhelp32 快照 + `GetProcessTimes` 创建身份围栏原语：`terminate()` 与 grace 升级前枚举根 pid 的存活后代（按创建时间过滤 PID 复用），逐一 taskkill；或至少在 `dsh-shell` 文档中明示该平台语义差异，让工具层对取消结果如实呈现。

### [P1-2] subprocess 输出 spill 文件与临时目录永不清理（磁盘累积泄漏）

- 位置：[packages/subprocess/subprocess-local/src/spawn.ts:82](../packages/subprocess/subprocess-local/src/spawn.ts#L82)（模块级 `defaultSpillDir` 单例）、[spawn.ts:89](../packages/subprocess/subprocess-local/src/spawn.ts#L89)（`privateSpillDir()` `mkdtempSync` 后从不删除）、[spawn.ts:156](../packages/subprocess/subprocess-local/src/spawn.ts#L156)（`spillAll()` 创建 `dsh-subprocess-*.log`）
- 描述：输出超过内存上限时，`OutputCollector` 在 `mkdtempSync(join(tmpdir(), 'dsh-subprocess-'))` 目录下以 `'wx' 0o600` 创建 spill 文件；仅当总字节超过 `maxSpillBytes` 时 `discardSpill()` 会删除文件。正常路径（`finalize()`）只关闭 fd 并把 `spillPath` 透传给上层（[bash-local/src/index.ts:306](../packages/shell/bash-local/src/index.ts#L306)、[tool-bash/src/render.ts:82](../packages/shell/tool-bash/src/render.ts#L82)），全仓库没有任何 unlink 生命周期，宿主退出时也不清理 mkdtemp 目录（已确认无 `process.on('exit')` 钩子）。
- 影响：长驻进程（网关/ACP 服务器模式）下，每个超限的 stdout/stderr 流永久留存一个 ≤`maxSpillBytes` 的文件，**数量无界**；`mkdtemp` 父目录同样逐进程累积。单文件有界掩盖了总量无界，磁盘缓慢填满且难以归因。
- 修复建议：为 spill 增加保留策略——进程内记录已创建文件清单，在 handle settle 且消费方读取完成后（或会话 dispose 时）批量删除；至少注册宿主退出清理（递归删除本进程的 mkdtemp 目录）。若 spill 需要跨命令保留给模型后续读取，则应将其迁移到拥有保留策略的 `ctx.spillStore`（packages/spill），而不是留在无主的 OS tmpdir。

---

## P2 一般

### [P2-1] agent-loop 的 finally 块内 session.append 可能替换正在传播的原始错误

- 位置：[packages/core/agent-loop/src/agent.ts:299](../packages/core/agent-loop/src/agent.ts#L299)（`finally { this.session.append('step/end', …) }`）、[agent.ts:323](../packages/core/agent-loop/src/agent.ts#L323)（`turn/end` 追加 + `this.throwError(error)`）
- 描述：`turn()` 的内层 `finally` 直接调用 `session.append('step/end')`，外层 `finally` 在追加 `turn/end` 失败时调用 `throwError()` 重新抛出。当步骤体已经抛出异常（如携带完整失败事实的 `LlmError`）且此时持久化也出现故障，finally 中的 append 异常会**替换**原始异常；`turn/end` 事件里的 `reason` 将以替换后的错误记录，`agent/error` 载荷随之失真。
- 影响：持久化故障与模型/工具故障叠加时，日志中的失败原因与实际根因不一致，事后审计与错误分类（`LlmError` 保留事实 vs `UNKNOWN` 展平）被破坏；用户看到的错误信息指向次要故障。
- 修复建议：finally 中独立捕获 append 失败——原异常存在时通过 `dispatch.emit('agent/error', …)` 或日志单独记录持久化故障，不覆盖进行中的异常；仅在没有原始异常时才让 append 失败传播。

### [P2-2] Windows 进程终止与探测在事件循环上同步执行

- 位置：[packages/subprocess/subprocess-local/src/spawn.ts:281](../packages/subprocess/subprocess-local/src/spawn.ts#L281)（`spawnSync('taskkill', …)`）、[windows-inspector.ts:148](../packages/subprocess/subprocess-local/src/windows-inspector.ts#L148)、[process-inspector.ts:120](../packages/subprocess/subprocess-local/src/process-inspector.ts#L120)（`execFileSync`）
- 描述：`terminate()` 的 SIGTERM 与 grace 升级 SIGKILL 都在当前线程同步运行 `taskkill /T`（含快照枚举），POSIX 侧 `/proc` 扫描同样用 `execFileSync`。这些调用发生在工具取消路径上，即 agent 循环仍然活跃时。
- 影响：大型进程树的 `taskkill /T /F` 可达数百毫秒，期间事件循环完全停摆——SSE/流式输出、心跳、并发工具调用全部冻结；多次取消叠加时卡顿成倍放大。
- 修复建议：把 taskkill 换成异步 `spawn` 并在 teardown 路径 `await`（`done`/grace 计时器本就是异步语义，不需要同步完成保证）；`/proc` 枚举移至 worker 线程或改用 `readdir` 异步 API。

### [P2-3] 前端静态服务的路径包含仅做词法检查，dist 内符号链接可逃逸

- 位置：[packages/host/frontend-static/src/index.ts:76](../packages/host/frontend-static/src/index.ts#L76)（`resolve(normalize(join(distRoot, pathname)))` 前缀检查）、[index.ts:93](../packages/host/frontend-static/src/index.ts#L93)（`readFile(target)` 跟随符号链接）
- 描述：`serveStatic` 用 `startsWith(distRoot + sep)` 拒绝 `../` 穿越，正确覆盖了 URL 编码与 Windows 反斜杠变体；但检查是纯词法的，`readFile` 会跟随目标位置的符号链接/junction。dist 目录内的一个符号链接即可把任意主机路径映射为可 GET 的资产。
- 影响：需要攻击者已能写入 dist 目录（被入侵的构建机、供应链投毒、或用户把 `distIndex` 配置到不可信目录），因此是纵深防御缺口而非直接可利用漏洞；`webserver` 显式绑定 `0.0.0.0` 时（[webserver/src/index.ts:61](../packages/host/webserver/src/index.ts#L61)）该缺口暴露面扩大到局域网。
- 修复建议：对非 index 目标在读取前做 `realpath` 并复验仍位于 `distRoot` 之下（Windows 上注意大小写与 junction）；或在构建产物清单（manifest）校验模式下拒绝清单外文件。

### [P2-4] 凭据形状环境清洗为无锚定子串匹配，误删良性变量且无可见性

- 位置：[packages/subprocess/subprocess/src/index.ts:44](../packages/subprocess/subprocess/src/index.ts#L44)（`SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i`）、[index.ts:60](../packages/subprocess/subprocess/src/index.ts#L60)（`scrubbedParentEnv()`）
- 描述：清洗规则是大小写不敏感的**子串**匹配，会命中 `TOKENIZERS_PARALLELISM`、`MONKEYPATCH`、`KEYCLOAK_HOST`（主机名非密钥）等键名包含敏感词但值非凭据的变量，把它们从所有子进程环境中静默剥离；同时被剥离了哪些键对调用方完全不可见。
- 影响：依赖这类变量的子进程工具链行为退化且难以归因（同一条命令在 harness 内外表现不同）；无日志意味着排查时无法确认清洗是否为根因。泄露方向是安全的（宁可多删），所以定级 P2。
- 修复建议：锚定清洗模式为 `^(.*_)?(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)(_.*)?$` 之类的词边界形式，并对显式白名单（如 `TOKENIZERS_PARALLELISM`）开例外；在 debug 级日志输出被剥离的**键名列表**（不含值），使清洗可审计。

---

## P3 建议

### [P3-1] bash-local 与 pwsh-local 执行器镜像重复约 250 行

- 位置：[packages/shell/bash-local/src/index.ts:200](../packages/shell/bash-local/src/index.ts#L200) 与 [packages/shell/pwsh-local/src/index.ts:244](../packages/shell/pwsh-local/src/index.ts#L244)（`spawnSpec`/`collected`/`runArgv`/`startArgv`/`onProcessDone` 五件套逐行对应）
- 描述：两个本地 shell 执行器的生命周期、输出收集、超时/取消语义完全镜像，差异点只有 argv 构造与 `ENV_OVERRIDES` 常量。[windows-inspector.ts:50](../packages/subprocess/subprocess-local/src/windows-inspector.ts#L50) 已用 `jscpd:ignore` 承认过同类镜像。
- 影响：生命周期修复（如 P1-1、P2-2）必须双份落地，漂移风险高；duplication 门禁的 ignore 标记会持续累积。
- 修复建议：提取 `LocalShellExecutorBase`（持有 ctx.subprocess 交互与前景/背景生命周期），子类只覆盖 `argv()`/`resolve()`/env 常量；撤销对应的 jscpd ignore。

### [P3-2] 三个核心模块体积过大、职责混装

- 位置：[packages/core/tools/src/index.ts:1](../packages/core/tools/src/index.ts#L1)（1829 行：注册表 + 执行管线 + PTC + 类型渲染）、[packages/subagent/subagent/src/continuation.ts:1](../packages/subagent/subagent/src/continuation.ts#L1)（1495 行：编排与 provider 适配混装）、[packages/api/gateway/src/index.ts:1](../packages/api/gateway/src/index.ts#L1)（1144 行）
- 描述：单文件承载多个正交职责，`core/tools` 的 index 同时是 Service Definition、执行管线和两种 SDK 类型渲染入口。
- 影响：审查、并行协作与局部回归定位成本高；diff 噪音大，冲突概率上升。
- 修复建议：按已有文件内聚线索拆分（tools：registry/pipeline/ptc/ts-types-py；continuation：orchestration/provider-adapter），保持导出面不变（经 `index.ts` re-export）。

### [P3-3] web-fetch 每请求新建 Undici Agent，无连接复用

- 位置：[packages/web/web-fetch-http/src/network.ts:179](../packages/web/web-fetch-http/src/network.ts#L179)（`await import('undici')` 后每请求 `new Agent` + `close()`）
- 描述：地址钉扎要求每请求独立 dispatcher（正确），但代价是每次 fetch 全新 TCP+TLS 握手，无 keep-alive 复用。
- 影响：同一站点连续抓取（模型常见的多次 `web_fetch`）重复付出握手与慢启动成本；dispatcher 对象频繁创建销毁增加 GC 压力。
- 修复建议：以"验证后地址集 + 主机"为 key 维护短 TTL 的 Agent 池（TTL 内复用连接，TTL 过期后重建并重新钉扎）；保持 DNS 钉扎语义不变。

### [P3-4] 静态资源每请求整读内存且无缓存头

- 位置：[packages/host/frontend-static/src/index.ts:93](../packages/host/frontend-static/src/index.ts#L93)（`readFile` 整读）、[index.ts:104](../packages/host/frontend-static/src/index.ts#L104)（writeHead 无 `Cache-Control`/`ETag`）
- 描述：每个 GET/HEAD 都把文件整体读入内存返回，且不发送任何缓存协商头。
- 影响：大体积 JS 资产在每次刷新时重复整读与传输；浏览器无法利用内容哈希文件名的天然不可变性。
- 修复建议：对带内容哈希的资产发送 `Cache-Control: immutable`，index 发送 `no-cache` + ETag；可选按文件大小对流式大文件走 `createReadStream`。

### [P3-5] webhook 入口无速率限制

- 位置：[packages/webhook/webhook-github/src/handler.ts:82](../packages/webhook/webhook-github/src/handler.ts#L82)（请求处理入口）
- 描述：除 413 体积上限（[body.ts:21](../packages/webhook/webhook-github/src/body.ts#L21)）外没有请求速率限制；每个请求都要做 HMAC 验签与 UTF-8 校验。
- 影响：公网/局域网暴露时，无效签名洪泛可持续消耗 CPU（每次 ≤maxBodyBytes 的 HMAC + 解析拒绝路径）；无锁定或退避。
- 修复建议：按源地址与 `x-github-delivery` 做简单令牌桶（内存级即可），连续验证失败短暂熔断；对重复 deliveryId 做幂等短路。

### [P3-6] JSONL 会话日志每批次 fsync，高吞吐场景写入放大

- 位置：[packages/session/session-persistence-jsonl/src/index.ts:666](../packages/session/session-persistence-jsonl/src/index.ts#L666)（append 批次 fsync 与撕裂尾恢复）
- 描述：每个追加批次都 fsync（含崩溃修复语义），持久性优先于吞吐；SQLite 后端是既有的高吞吐替代，但 JSONL 路径没有可调策略。
- 影响：长会话、高频 chunk 事件（流式 token 逐条 append）下磁盘写放大明显；笔记本 SSD 场景功耗/延迟可感知。
- 修复建议：提供可选的 `sync: 'batch' | 'turn'` Config（turn 边界强制 fsync，批间依赖 OS 回写），默认保持现状；在 README 标注取舍。

### [P3-7] 3466 行测试夹具位于发布包 src 内

> 2026-08-30 修正：该项为误报，撤销。复核确认 `fixture.ts` 并非测试夹具，而是已发布的浏览器运行时能力——客户端入口在 `?fixture` URL 模式下经 `createFixtureConnectionRpc` 提供无服务器的 UI 开发态，且随 `lib/client.js` 打包发布；`apps/web` 的多个 e2e 套件（`built-boot`、`goal-bar`、`seeded-history`、`agent-team-panel` 等）与 API gateway 客户端测试均驱动该模式，包描述亦声明 "and browser fixture"。将其移出发布面会破坏构建页面上的 `?fixture` 模式与整套 e2e；若未来要裁剪，需要构建期的 dev/production 条件拆分（bundles per build condition），属产品决策。

- 位置：[packages/client/connection/src/client/fixture.ts:1](../packages/client/connection/src/client/fixture.ts#L1)
- 描述：`client/connection` 的 src 携带一个超大夹具文件（打包后进入发布面或至少进入审计/克隆范围）。
- 影响：包体积与审计噪音；夹具演进与产品代码耦合在同一个变更面上。
- 修复建议：迁至 `packages/test-support/client-runtime` 或声明为条件导出的 dev-only 入口。

---

## 验证为清洁的高风险面

以下风险面经过逐文件精读，未发现可报告缺陷（仅列结论，供后续审查者跳过已覆盖面）：

- **命令执行组装**（[bash-local/src/index.ts:211](../packages/shell/bash-local/src/index.ts#L211)、[pwsh-local/src/index.ts:217](../packages/shell/pwsh-local/src/index.ts#L217)）：命令作为单一 argv 元素传给 `bash -c`/`pwsh -Command`，无 shell 字符串二次拼接；`dshEnv`（受信）按文档顺序覆盖调用方 env。
- **SSRF 防护**（[web-fetch-http/src/network.ts](../packages/web/web-fetch-http/src/network.ts)）：完整答案集先验证后钉扎、NAT64 内嵌 IPv4 检查、IP 字面量与 URL 规范化一致（八进制/十进制整数主机经 WHATWG 归一后被回环检测拦截）、重定向跨源拒绝、逐跳重新验证。
- **GitHub webhook**（[webhook-github/src/handler.ts](../packages/webhook/webhook-github/src/handler.ts)）：Octokit 时序安全验签、严格 Content-Type 与去重 header、UTF-8 fatal 解码、`snapshotJsonValue` + `deepFreeze` 隔离投递。
- **审批链**（[user-approval/src/index.ts](../packages/interaction/user-approval/src/index.ts)）：`'never'` 在服务自身路径前置决定（防 listener 顺序绕过）、无应答器/异常/越词返回值一律 fail-closed、审计对必须 turn-enclosed。
- **工具调度**（[agent-loop/src/tool-calls.ts](../packages/core/agent-loop/src/tool-calls.ts)）：模型序提交、独占屏障、abort 后合成结果保持重放有效、调度器失败不伪造结果。
- **SQLite 层**（[storage-sqlite/src/unit.ts](../packages/storage/storage-sqlite/src/unit.ts)、session-persistence-sqlite）：全参数化、预编译复用、schema 校验 fail-loud。
- **JSONL 持久化**（[session-persistence-jsonl/src/index.ts](../packages/session/session-persistence-jsonl/src/index.ts)）：原子发布（temp+fsync+link+目录 fsync）、撕裂尾标记与修复、部分写回滚。
- **浏览器鉴权**（[client/connection/src/browser-auth.ts](../packages/client/connection/src/browser-auth.ts)）：`randomBytes` 密钥、HMAC 签名、`timingSafeEqual` 比较。
- **凭据文档**（[credentials-local/src/index.ts](../packages/credentials/credentials-local/src/index.ts)）：0600 断言拒绝外部可读文件、跨进程写锁 30s 上限、原子替换。
- **原子写工具**（[atomic-write/src/index.ts](../packages/util/atomic-write/src/index.ts)）：`wx` 独占创建拒绝符号链接植入、锁文件协议、可选 0700 目录。

## 未覆盖范围

以下区域本次仅做扫描级检查或未覆盖，结论以本次为限：`native/`（node-addon-landlock-run 的 C 源）、`packages/sandbox/sandbox-windows-acl`（Win32 ACL FFI 全量）、`packages/experimental/`（发布排除）、`packages/client/ui-*`（React UI 层）、Python SDK（`python/`）、`website/`，以及 `interaction/commands`、`identity`、`settings-file` 的完整精读。`packages/terminal` 的 PTY 路径审到就绪标记与清洗层（[terminal-bash/src/sanitize.ts](../packages/terminal/terminal-bash/src/sanitize.ts)），未覆盖完整会话状态机。

## 优先修复清单（按性价比排序）

排序依据：风险消除量 ÷ 实施成本。前三条是本次审查的核心产出，其余按同等逻辑排列。

1. **[P1-2] spill 文件与 mkdtemp 目录的清理生命周期** — 改动集中在 spawn.ts 一处；磁盘泄漏在长驻模式下持续累积，修复后风险归零。
2. **[P1-1] Windows 进程树终止覆盖自然退出根的孤儿后代** — 复用 windows-inspector 现成原语，改动局部；消除 POSIX/Windows 语义鸿沟与资源悬挂。
3. **[P2-1] agent-loop finally 错误遮蔽** — 数行改动；保证失败分类与审计事实在叠加故障下仍可信。
4. **[P2-4] env 清洗模式锚定 + 键名可见性** — 一条正则与一行 debug 日志；消除一类难排查的环境差异问题。
5. **[P2-2] taskkill/进程探测异步化** — 中等改动；消除 Windows 取消路径上的事件循环冻结。
6. **[P2-3] 静态服务 realpath 复验** — 小改动；关闭纵深防御缺口。
7. **[P3-1] 提取 LocalShellExecutorBase** — 中等重构；使 P1-1/P2-2 的修复单点化并防止漂移（建议与 2、5 同批实施）。
8. **[P3-3] web-fetch Agent 连接池** — 局部改动；直接降低模型高频抓取延迟。
9. **[P3-5] webhook 令牌桶限流** — 小改动；公网暴露配置下的成本防线。
10. **[P3-4] 静态资产缓存头** — 小改动；前端体验与带宽立竿见影。
11. **[P3-6] JSONL sync 策略 Config 化** — 小改动 + 文档；高吞吐场景可选优化。
12. **[P3-2] 拆分 core/tools、continuation、gateway 巨型模块** — 渐进重构；降低后续所有变更的审查成本。
13. ~~**[P3-7] client fixture 迁出 src**~~ — 撤销：复核确认该文件是已发布的浏览器 fixture 运行时模式（e2e 依赖），非测试夹具；见 P3-7 条目内的修正说明。
14. **为 P1-1 补 Windows 集成测试** — 在 Windows CI 上断言"根自然退出 + 后代存活"场景被 terminate 覆盖；防止修复回退。
15. **为 P1-2 补泄漏哨兵测试** — 断言 N 次超限命令后 tmpdir 中 `dsh-subprocess-*` 文件数为零（或等于保留策略允许值）。
16. **spill 保留策略 Config 化**（随 1 实施）— `spillRetention: 'session' | 'command' | 'manual'`，默认 session，README 记录取舍。
17. **env 清洗例外白名单机制**（随 4 实施）— 允许部署显式放行特定良性键，避免未来再出现 `TOKENIZERS_PARALLELISM` 类误伤。
18. **webserver README 标注 dist 目录信任前提**（随 6 实施）— 一句文档；明确符号链接逃逸的信任边界归谁所有。
19. **`experimental/` 与 `client/ui-*` 纳入下一轮定向审查** — 本次扫描未发现红旗但未精读；建议按同样的风险定向方法补齐。
20. **`native/` 与 sandbox-windows-acl 全量安全审查** — 沙箱是安全模型的地基，当前仅有扫描级覆盖；建议独立安全审查任务。
