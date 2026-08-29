# Agent Note: Subprocess spill file reclamation

Status: implemented

[English](2026-08-29-subprocess-spill-reclamation.md) | 中文

## 问题

每条超限的 `bash`/`pwsh` 输出流都会把一个永久性的 spill 文件写进进程私有的 OS 临时目录，而从来没有任何机制删除它们。单个文件受 `maxSpillBytes` 约束（默认 64 MiB），但数量没有上界：每条溢出流、每条命令都留下一个，永久累积。长驻进程——网关、ACP 服务器——会在整个运行期内持续累积，进程的 `mkdtemp` 目录本身也从不删除。provider README 把这一累积记录为已知限制。

删除不能简单地在命令结束时进行。spill 路径会宣告给模型——出现在被截断的前台结果（"full output: …"）与有损的后台读取中——模型可能在后续轮次里用 `read` 或 `grep` 工具跟随它。在结算时删除、或在执行器读完时删除，都会让已宣告的路径失效。

## 决策

spill 文件现在拥有三段式生命周期，每段由能安全做出该判断的层负责：

| 部分 | 所有者 | 机制 |
|---|---|---|
| 登记 | `dsh-subprocess-local` 运行时 | `onSpillFileCreated` 上报每个创建的文件；dispose（资源释放）时删除仍未被移除的那些 |
| 进程退出回收 | `dsh-subprocess-local` spawn 层 | 同步 `process.on('exit')` 阶段删除整个私有 spill 目录（`removeProcessSpillDir`） |
| 前台交接 | 基于 `ctx.spillStore` 的 `dsh-shell` 执行器 | `retainSpillOutput` 把原始文件持久化进所属会话的 store，然后删除它；结果宣告 store 的 locator |

前台交接：工具层从所属会话解析 spill 归属（`ShellSpillContext`——会话 id、工具名、call id）放入 `ShellExecRequest.spillContext`；执行器经 `resolve()` 原样携带，当已结算的前台流带有 spill 路径时，`retainSpillOutput` 在 `run()` resolve 之前通过 `ctx.spillStore.saveText()` 把完整文本存入会话命名空间并删除原始文件。模型看到的 locator 因此归会话所有、受 store 自身的保留策略约束（本地后端的启动清扫），而原始临时文件在同一条命令内即被删除。

后台进程与无归属的调用方（headless 插件调用、未挂载 spill store 的组合）保留执行器自管的原始文件。它们的路径随时可能出现在读取中，因此在 subprocess dispose 或进程退出阶段回收，而不是逐命令删除。交接的每一种失败——原始文件不可读、存储故障、删除失败——都被包含：执行器记录警告并继续宣告原始路径，运行时登记表仍然拥有该文件。

## 备选方案

**在 handle 结算、执行器读完输出后删除。** 否决："消费方已读完"在 subprocess 层不可观测，而模型正是一个稍后才读取的消费方。结算时删除会破坏模型尚未跟随的每一条已宣告路径。

**把 subprocess 收集器整体迁移到 `ctx.spillStore`。** 否决：收集器在活动内存上限下流式写入字节，而 spill seam 是保存完整文本的契约。执行器层的交接让流式语义留在它所属的位置，同时仍为有归属的前台输出提供会话持有的 locator。这正是[工具输出 spill 策略笔记](../architecture/2026-07-08-tool-output-spill-files.md)推迟的 bash 规范化。

**按 handle 登记 spill 文件并在 handle dispose 时删除。** 否决：后台 handle 的存活期恰好等于其路径必须保持可解析的时期，按 handle 划界会在任务运行时仍可能把文件交给模型时删除它们；进程生命周期的登记表加 dispose/退出回收，与宣告窗口一致。

## 后果

临时目录的累积现在有界于"已宣告路径仍可跟随"的文件：有归属的前台输出为零，后台与无归属运行恰为执行器自管集合，在 dispose 与进程退出时回收。运行时登记表每创建一个 spill 文件增加一个条目（一个路径字符串）——是元数据，不是文件内容。

残余暴露：在 Node 同步退出阶段之外被杀死的进程（SIGKILL、致命崩溃、断电）会留下一个私有 `mkdtemp` 目录，与 provider 既有的进程内清理限制一致；OS 的临时目录清理是兜底，与其他临时产物相同。

## 测试

- `dsh-bash-local` 端到端驱动哨兵：三条带归属的超限前台命令各自通过 store 持久化，执行器临时区域留下零个 `dsh-subprocess-*` 文件；无归属的运行保留原始文件（允许的保留）。
- `dsh-pwsh-local` 镜像该交接哨兵（一条超限命令，零残留）。
- `dsh-subprocess-local` 钉住登记表：运行时在 dispose 回收全部文件之前，每条超限命令持有一个 spill 文件；通过 internals 钩子上报每一次创建；`removeProcessSpillDir` 真正删除默认目录，而后续 spawn 会重建它。
