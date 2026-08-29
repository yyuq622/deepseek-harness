# Agent Note: Anchored credential-shaped env scrubbing

Status: implemented

[English](2026-08-29-anchored-env-scrubbing.md) | 中文

## 问题

凭据清洗会丢弃键名中 merely 包含 `KEY`、`PASSWORD`、`SECRET` 或 `TOKEN` 子串的所有环境名称。良性名称付出了代价：`TOKENIZERS_PARALLELISM`、`KEYCLOAK_HOST`，或假想中的 `MONKEYPATCH`，都会被从每个子进程环境中静默剥离，而且没有任何机制记录哪些键被丢弃了——仅凭子进程的行为无法诊断过度清洗。已知缺口在 provider README 中被记录为后续工作。

## 决策

清洗规则现在是基于形状的，并且可观测：

- `SENSITIVE_ENV_PATTERN` 把凭据词锚定为完整的下划线分段——`^(?:.*_)?(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)(?:_.*)?$/i`，并新增 `CREDENTIAL`。`DEEPSEEK_API_KEY`、`GITHUB_TOKEN` 与 `MY_SECRET_VALUE` 仍然匹配；`TOKENIZERS_PARALLELISM` 与 `KEYCLOAK_HOST` 不再匹配。
- `SCRUB_ALLOWED_ENV_KEYS` 是记录在案的白名单，在模式之前检查、大小写不敏感地匹配。它是形状规则无法表达其良性性的名称的逃生通道，并且永远不会重新放行 `DSH_*` 名称——清洗无条件丢弃它们。
- `scrubbedParentEnv()` 把被丢弃的键名——绝不包含值——打印到 `dsh-subprocess:env-scrub` Node 调试通道（`NODE_DEBUG=dsh-subprocess:env-scrub`），因此过度清洗仅凭子进程的启动环境即可诊断。

`DSH_*` 的丢弃是无条件的，且位于白名单之前：无论白名单写什么，harness 身份都不会隐式泄漏。

## 备选方案

**保留子串启发式，只加白名单。** 否决：白名单会随野外每个良性名称增长一条——子串形状本身就是缺陷，未来每个凭据形状的误报都需要改代码。

**用词边界（`\b`）锚定而非下划线分段。** 否决：`\bKEY\b` 仍会匹配 `KEYCLOAK` 中的 `KEY`（字符串边缘存在词边界），而环境名称没有空格，下划线分段才是自然的词单元；`\b` 会重新引入同样的误报。

**把白名单做成 subprocess 服务的部署配置。** 暂缓：该服务有意没有配置（每项处置都在 spec 上到达），且目前没有部署需要自定义例外。记录在案的常量让机制先行落地而不发明旋钮；当第二个部署需要不同集合时再升级为受校验的配置。

## 后果

子进程环境无需逐名例外即可保留仅包含凭据词的良性名称，且每个被丢弃的键名都可按需观测。分段内保持保守：`PASSWORD_FILE` 仍会匹配并仍被丢弃——规则倾向于丢弃任何喊出凭据形状的名称。名称不同的 secret（`*PASSPHRASE*`）仍然传递，与已文档化的启发式成本一致。

## 测试

`service.spec` 钉住形状表：仅包含凭据词的名称存活（`TOKENIZERS_PARALLELISM`、`KEYCLOAK_HOST`）、整段形状被丢弃（`GPG_KEY`、`*SECRET_VALUE`）、白名单大小写不敏感地放行，以及导出的 pattern/allowlist 组合与文档化的表一致——与既有的大小写不敏感 `DSH_*` 及凭据形状丢弃测试并存。
