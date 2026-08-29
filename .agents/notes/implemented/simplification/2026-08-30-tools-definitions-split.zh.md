# Agent Note: Tools contract split

Status: implemented

[English](2026-08-30-tools-definitions-split.md) | 中文

## 问题

`dsh-tools` 的 `index.ts` 已膨胀到约 1.9k 行，承载三个不相关关注点：带注册表与执行管线的 `ToolRuntime` 服务、公共契约词汇（25 个导出的工具/执行类型、规范代码与两个错误类），以及该词汇依赖的纯快照/规范化辅助。契约表面——每个工具作者与消费方最先阅读的内容——被埋在服务实现里。

## 决策

契约词汇迁至 `definitions.ts`：全部 25 个公共工具/执行类型与代码、两个错误类，以及它们使用的纯辅助（`errorMessage`、`errorInfo`、`failureMessageFromContent`、`materializePresentation`、`projectionError`、`snapshotProjection`、`snapshotToolValue`、`createExecutionToken`）。`index.ts` 原样再导出每个被迁移的公共名称——包的导出面完全一致——而运行时直接从 `definitions.ts` 导入其词汇。`ToolRuntime`、`ToolLayer`、插件配置与管线本地的辅助（`fuseToolSignals`、`toolErrorResult`、各 aborted 结果构建器）留在 `index.ts`；`ptc`/`ts-types`/`py-types`/`presentation`/`json-schema` 模块本就是独立文件。

`definitions.ts` 是叶子模块：它不从本包导入任何东西，因此 `ptc.ts`、`schema.ts`、`testing.ts` 与 `invariant.ts` 继续像从前一样经 `index.ts` 导入被迁移的名称。

## 备选方案

**拆分 `ToolRuntime` 类本身（注册表 vs 管线文件）。** 暂缓：该类约 1.1k 行共享私有的分发状态与瀑布接线；类拆分是对最核心包的设计变更，需要独立的经验证流程，而非机械移动。

**把词汇并入既有 `types.ts`。** 否决：`types.ts` 拥有持久化的 `tool/code-dispatch` 事件 payload 类型；把契约词汇并进去会把公共 API 与线上事件内部细节混在一起。

**经包 index 导出这些辅助。** 否决：这些辅助此前是模块私有的；再导出它们会在一个不得改变导出面的重构中扩大包表面。

## 后果

契约表面可以在一个 470 行的文件里通读，服务实现也甩掉了词汇负担。包的导出面、生成目录与所有消费方导入均不变。本包剩余的大模块：没有了——本次拆分是最后一个 index 级关注点；`ToolRuntime` 类的体量未变，仍是已知的集中点。

## 测试

没有新增测试：这是导出面不变的机械移动。本包的套件（注册表、管线、PTC、schema、presentation）经 `@deepseek-ai/dsh-tools` 导入被迁移的名称并原样通过；`definitions.ts` 经同一批套件获得覆盖（其辅助与类型被每个管线与 schema 测试调用）。
