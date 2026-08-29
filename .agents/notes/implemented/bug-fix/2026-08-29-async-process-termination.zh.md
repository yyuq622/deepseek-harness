# Agent Note: Asynchronous process termination and probing

Status: implemented

[English](2026-08-29-async-process-termination.md) | 中文

## 问题

每个终止档位与探测都会在同步进程操作上阻塞事件循环。在 Windows 上，每个 `terminate()` 档位经 `spawnSync` 运行 `taskkill /T /F`——其树遍历会让事件循环停摆数十至数百毫秒，一次工具取消便会拖住流式输出、心跳与并发工作。在 Linux 上，退出观察器每个 tick 的 `/proc` 遍历在拆卸等待内运行 `readdirSync` 加每条目一次 `readFileSync`。

## 决策

凡调用方能够观察结果之处，投递与探测一律异步；不存在 await 之处保持同步：

- Windows 清扫的 taskkill 投递改为异步 spawn（`taskkillTreeAsync`），清扫在其投递完成后 resolve。`terminate()` 的档位触发清扫，并在 Windows 上依据档位结果、于在飞闩锁之下武装 grace 后重扫；abort 路径触发而不等待。结果依旧通过 `done` 与退出观察器可观测——取消契约未变，改变的只是投递不再阻塞。
- 清扫保留同步形式（`sweepSync`）仅供无法 await 的宿主退出阶段：同样的身份围栏目标，经同步 taskkill 投递，符合宿主退出"无 Promise、无定时器"的契约。
- Linux 的 `/proc` 遍历改为异步读取（`readDirAsync`/`readFileAsync` internals）；退出观察器经异步探测轮询并保留僵尸细化语义。`treeAlive()`——POSIX `kill()` 档位与 Windows 路径使用的廉价守卫——去掉了逐调用扫描：对仅含僵尸的组发信号是被包含的空操作（僵尸忽略信号），因此守卫的结果在无扫描的情况下不变。
- 终端检查器的 `signalGroup`/`signalProcess` 在可用时触发异步投递；终端拆卸的重扫观察真实消失，这就是 quiescence await。

internals 接口以可选成员接纳异步操作（`taskkillAsync`，以及 /proc 路径上的异步 fs 读取），因此同步测试 fake 继续有效——清扫与检查器回退到同步形式，其在 fake 中的投递是即时的。

## 备选方案

**在所有调用方 await 清扫。** 否决：`terminate()` 与 grace 定时器回调运行在同步取消上下文中；将其异步化会把 await 波及每个消费方，却没有可观测收益——`done` 与退出观察器观察的已是真实结果（进程死亡），比等待 taskkill 进程自身的退出更强。

**把同步 taskkill 与 /proc 遍历卸载到 worker 线程。** 否决：spawn 出的 taskkill 本就是独立的 OS 进程，`spawn` 返回的瞬间投递就离开了事件循环；worker 只会带来 koffi/序列化表面，而可观察结果不变。

**把 Linux 僵尸细化也从退出观察器中去掉。** 否决：仅含僵尸的组应答 `kill(0)` 但永远无法达到 quiescence，观察器必须把它读作不存在，否则拆卸等待会挂起；细化被移入异步探测而非删除。

## 后果

Windows 取消档位不再因 taskkill 的树遍历冻结事件循环，Linux 退出观察器逐 tick 的 `/proc` 遍历不再阻塞。grace 后重扫在首次投递完成之后武装，而非档位发起之时——这是一个有界的偏移，让 grace 从击杀真正送达处起算。宿主退出阶段保留其同步、身份围栏的清扫；quiescence 与等待边界均无变化。

## 测试

清扫契约测试 await 现已异步的 `sweep`；spawn 接线测试经 `vi.waitFor` 观察档位投递与武装（第 1 档、恰好一次 grace 后重扫、缺席树不武装、等待观察到无活体时释放）；Linux 探测测试经异步遍历 resolve；旧有注入平台测试保留同步回退边界。
