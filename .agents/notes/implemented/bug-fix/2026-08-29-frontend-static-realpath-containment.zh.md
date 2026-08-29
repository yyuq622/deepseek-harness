# Agent Note: Frontend-static realpath containment

Status: implemented

[English](2026-08-29-frontend-static-realpath-containment.md) | 中文

## 问题

静态席位的遍历栅栏是纯词法的：请求的 pathname 拼接到 dist 根目录后做前缀检查，但 `readFile` 会跟随符号链接与 junction。一个植入 dist 目录内部、指向主机任意位置的链接，就能把 dist 之外的文件提供给任何能到达服务器的浏览器，且无需认证（非 index 资产是公开的）。

## 决策

文件目标先用 `realpath` 解析到最终位置，并在读取任何字节之前对照 dist 根目录的真实位置再次核验。真实根目录在激活时解析一次（对 `dirname(distIndex)` 做 `realpathSync`），因此比较基准在符号链接的安装路径下依然成立，而缺失的 dist 在加载时即响亮失败、而非首个请求时；SPA index 锚定到同一真实根。包含比较在 Windows 上折叠路径大小写——realpath 在那里报告的磁盘大小写可能与配置大小写不同——且 realpath 解析 junction 的方式与解析符号链接相同，两种链接形状都被围住。词法前缀检查仍是第一道栅栏；realpath 再核验在其后关闭链接形状的缺口。

## 备选方案

**服务词法校验过的配置路径，跳过 realpath。** 直接否决——这正是缺陷本身：该检查校验的是 pathname 的形状，而不是文件系统实际交回的内容。

**用 `O_NOFOLLOW` 打开并按 fd 服务。** 否决：Node 在 Windows 上没有 nofollow 打开方式，且被服务的树本就合法地不含链接，因此接受了打开后链接替换的窗口期，而不是携带按平台分裂的读取路径。能在 dist 内替换链接的攻击者本就能替换 dist 服务的每个文件。

**在构建期预留并校验（dist manifest）。** 暂缓：它把栅栏转移到构建管线，并会破坏请求间文件实时出现的 live-rebuild 工作流。若 dist 未来在构造上即不可信，再重新评估。

## 后果

植入 dist 内部的链接以 403 应答，而不是提供外部文件；栅栏在 Windows（junction、大小写折叠）与 `/tmp` 本身是符号链接的 macOS 安装路径上都成立。成本：每个非 index 请求一次 realpath，激活时一次 `realpathSync`——激活现在会在配置的 dist 缺失时响亮失败，这是配置错误而非运行时条件。残余窗口是 realpath 检查与读取之间被替换的链接；关闭它需要平台分裂不提供的 nofollow 读取，且拥有该写权限的攻击者本就控制着 dist 的内容。

## 测试

真实 Loader 组合套件新增植入链接场景：Windows 上的 junction（无需特权）或其他平台上的符号链接，从 dist 内部指向外部 secret，必须以 403 应答，同时合法资产继续服务。
