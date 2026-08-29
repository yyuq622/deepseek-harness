# Agent Note: Static cache headers and streamed large files

Status: implemented

[English](2026-08-29-static-cache-headers.md) | 中文

## 问题

静态席位提供的每个响应都是裸的：没有任何缓存指令。浏览器每次访问都重新下载完全相同的哈希 bundle，index 无法再验证（每次访问都完整重下），达到兆级的文件在每个并发请求中都整体缓冲进内存。

## 决策

缓存跟随 dist 的命名方式，大文件不再整体缓冲：

- 内容哈希形状的资产名——扩展名前恰好 8 个 base64 字符的 Vite 风格 `-hash` 分段——以 `Cache-Control: public, max-age=31536000, immutable` 提供。在内容哈希化的 dist 中，同名即同内容，浏览器永不重验。其他文件不携带指令（启发式的代价：名称碰巧形似哈希的未哈希文件在变更后会被当作过期——Vite dist 中不存在这样的名称）。
- index 以 `Cache-Control: no-cache` 提供并携带在渲染正文上计算的弱 ETag——注入行与 taps 都参与，页面变化即 ETag 变化。匹配的 If-None-Match 以 304 应答并附带 ETag 与缓存指令。
- 达到 1 MiB 的文件经 `createReadStream` 流式提供并带显式 content length，bundle 不再整体缓冲；流中失败会销毁响应而不是在头已写出后抛出，客户端断开会销毁流（无 fd 泄漏）。HEAD 请求跳过流且不做任何读取。

realpath 包含栅栏在每次文件读取（流式或缓冲）之前运行；已解析路径上的 `stat` 为流定长。

## 备选方案

**对每个响应做内容哈希并跳过名称启发式。** 否决：index 正文按请求渲染（注入行与 taps），对每个文件做内容哈希会把名称到缓存策略的映射变成逐文件哈希——对未哈希名称做纯内容哈希会在重建后提供过期内容。

**服务端缓存渲染后的 index 并省去 ETag。** 否决：注入行按设计在每次渲染时新鲜收集（启动 payload 因部署而异）；ETag 提供了再验证，而无需发明失效协议。

**为 TTL/阈值提供配置。** 暂缓：一年 immutable 与 1 MiB 流式阈值是未观察到部署差异的标准边界；出现差异时再升级为受校验的配置。

## 后果

浏览器不再重复下载相同的哈希 bundle，并改为对 index 再验证；达到阈值的 bundle 流式提供。启发式的误报成本受 dist 是构建产物这一事实约束（同名即同内容）。index ETag 按渲染计算——每个 index 请求对一个小正文做一次 SHA-256。

## 测试

真实 Loader 组合套件断言响应头：哈希形状的资产以 `immutable` 提供、未哈希资产不携带指令、index 以 `no-cache` 提供并携带可再验证至 304、且随 tap 改变正文而变化的 ETag，以及 1.5 MiB 文件以 content length 与完整正文服务。
