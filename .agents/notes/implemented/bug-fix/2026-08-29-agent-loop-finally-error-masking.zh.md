# Agent Note: Agent-loop finally blocks never mask the in-flight error

Status: implemented

[English](2026-08-29-agent-loop-finally-error-masking.md) | 中文

## 问题

回合驱动器在 `finally` 块内关闭其持久边界（`step/end`、`turn/end`），因此这些块也会在步骤或回合失败正在传播时执行。此类 append 中的持久化故障会替换正在传播的错误：携带提供方事实的 `LlmError` 以 `UNKNOWN` 的 append 故障面目出现，`turn/end` 的 reason 记录了错误的原因，`agent/error` 把持久化故障当作回合的结果上报。

## 决策

`throwError` 的上报部分被拆分为 `reportError`（仅 emit）。每个边界 `finally` 包裹自己的 append 并对结果分类：

- 已有错误在传播时（由 `catch` 设置的标志），append 故障通过 `agent/error` 单独上报，原始错误继续传播——融合分发器按监听器包含故障，因此从展开路径上报不可能遮蔽任何东西。
- 没有错误在传播时，append 故障就是该边界的结果，走完整的 `throwError` 路径，与之前完全一致。

## 备选方案

**用日志而非 emit 上报被抑制的故障。** 否决：`agent/error` 是消费方已在观察的结构化表面；一行日志会让看到回合结果的同一批观察者看不到持久化故障。emit 是安全的，因为融合分发器按契约逐监听器包含故障。

**把边界 append 移出 `finally`。** 否决：边界必须在每一次退出时闭合——这正是日志格式依赖的崩溃尾保证。

## 后果

根因在持久化故障的叠加下得以保留，`agent/error` 流与 `turn/end` reason 皆然。消费方现在可能为一个回合观察到两个 `agent/error` 事件——原始失败加上边界持久化故障——这就是诚实的形态：持久日志确实缺失了该边界事件。

## 测试

`loop.spec` 通过失败的 `session.append` 驱动叠加场景：步骤失败加 `step/end` 故障时，`provider exploded` 仍是回合结果（且持久化恢复后下一回合正常持久化边界）；健康回合同时丢失两个边界时逐一上报两个故障且不留下 `turn/end`；健康回合仅丢失 `turn/end` 时，append 故障成为回合错误。
