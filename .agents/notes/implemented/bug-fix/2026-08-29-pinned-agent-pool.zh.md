# Agent Note: Pooled pinning dispatchers for web-fetch

Status: implemented

[English](2026-08-29-pinned-agent-pool.md) | 中文

## 问题

每次 web-fetch 请求都构建一个全新的 Undici agent 并在正文消费后关闭，因此连续的同站点抓取——最常见的突发形态——每次都要付出完整的 TCP + TLS 握手，并按请求分配 dispatcher。按请求独立 dispatcher 本身是有意为之（钉扎 lookup 固化在 agent 里），但其生命周期不是。

## 决策

携带钉扎的 dispatcher 被短暂池化，以钉扎身份为键：URL 主机名加上完整的已校验地址集，排序处理使解析顺序无法拆分池。命中时复用池化 agent 的 keep-alive 连接；未命中——新主机、变化的地址集、或 TTL 过期——则以该请求自己的解析构建新 agent 并固化钉扎。过期自创建时刻起算且命中绝不延长：一枚钉最多服务 30 秒的流量即被重建，这就是安全与复用的权衡——钉本身保持精确，TTL 限制一次解析可以持续路由多久。容量（16 条）按最近最少使用驱逐 agent 并异步关闭，使在途正文继续流动（Undici 的 close 会等待未完成工作）。`PinnedResponse.close()` 变为释放空操作——池拥有 dispatcher 的生命周期——而 `closePinnedAgentPool()` 关闭全部池化 agent，供运行时拆卸与测试服务器使用，否则池化的 keep-alive socket 会拖住它们的 `server.close()`。

Linux 侧不在本次范围；POSIX 侧逐 tick 的 `/proc` 成本是 process-inspector 的事（见异步终止笔记）。

## 备选方案

**维持按请求 dispatcher（现状）。** 否决：同站点抓取的握手成本正是缺陷；钉扎并不要求按请求的 dispatcher，只要求按请求解析的地址集——池的键携带的正是它。

**共享一个无键、无 TTL 的全局 dispatcher。** 否决：全局 agent 会无限期服务过期解析，并把无关主机的 socket 混入一个无法钉扎的 agent；键钉住已校验的地址集，TTL 限制其生命周期。

**按引用计数、归零即关闭。** 否决：提供方在每次正文后释放，零占用是稳态——在那里关闭会删掉池存在的意义。空闲 socket 由 Undici 自身的 keep-alive 加 TTL 驱逐管理。

## 后果

30 秒内连续同站点抓取复用同一条 TCP/TLS 连接；变化的 DNS 地址集经键立即生效，未变化的集合至多一个 TTL 后重新钉扎。抓取后的池化 keep-alive socket 保持打开至多一个 TTL——这是复用的代价——且测试服务器必须在关闭前释放池（套件已经如此）。池为进程级并自驱逐；进程退出时剩余部分由 OS 关闭。

## 测试

`fetch-http.spec` 直接覆盖池（同键复用、TTL 重建并关闭过期条目、LRU 容量驱逐、disposal）与钉扎身份键（排序地址集、主机与地址集敏感性），并包含一个真实回环场景：连续同站点抓取复用一条 TCP 连接，TTL 过后连接数增长——重建通过服务器本身观察，而非 mock。
