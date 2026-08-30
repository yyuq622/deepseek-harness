# 安全深审报告：native/ Landlock 启动器与 sandbox-windows-acl（2026-08-30）

English summary: one P2 (wrong-allocator free at the FFI boundary), four P3 hardening findings, no P0/P1. The Landlock launcher's C source and the Windows ACL package's fail-closed chain are verified clean — see [覆盖清单](#覆盖清单与阶段-1-对照) for what this audit newly covers over the phase-1 scan.

## 范围与方法

本报告覆盖阶段 1 审查报告（[code-review-20260829.md](code-review-20260829.md)）"未覆盖范围"中明确留白的两块安全根基：

1. **native/landlock-run**（`@deepseek-ai/node-addon-landlock-run` 家族）：自限制后 exec 的 Landlock 启动器——C 源（`packages/entry/src/main.c`，272 行，全量精读）、JS entry 包（`packages/entry/src/index.ts`，128 行，全量精读）、AGENTS 运行时安全规则与 CLI 契约文档。
2. **packages/sandbox/sandbox-windows-acl**（Win32 ACL FFI）：全部 11 个 src 文件（~1.7k 行，全量精读）——`ffi.ts`（koffi 绑定）、`acl.ts`（DACL 读改写）、`token.ts`（受限令牌构造）、`grant.ts`（授权生命周期）、`runner.ts`（argv 契约运行器）、`index.ts`（AclSandbox 编排）、`path-boundary.ts`、`workspace-sid.ts`、`spawn.ts`、`win32-abi.ts`、`invariant.ts`——外加 `verify/abi-probe.cpp`（布局探针）。

方法：逐行精读 + 与 seam 消费方（`sandbox-local` 的授权生命周期、`sandbox-policy` 的 `canonicalPath` 规范化链）交叉核对。威胁模型：被 confinement 限制的子进程是潜在攻击者；kernel/Win32 API 是受信基础；持有目录 WRITE_DAC 的目录所有者越过"目录所有者"前提需要额外前提。测试文件（12 个 spec）按其断言核实了行为声明，但不在审计范围内重审。

## 发现总览

| 严重程度 | 数量 | 代表问题 |
|---|---|---|
| P0 严重 | 0 | — |
| P1 重要 | 0 | — |
| P2 一般偏重 | 1 | FFI 分配器错配：koffi.alloc 内存经 LocalFree 释放 |
| P3 建议 | 4 | Everyone 默认 DACL 过宽；DACL 遍历缺 ACE 尺寸界；锁文件累积；Landlock fd 卫生 |

**总体结论**：两个区域的安全设计是严肃且大部分实现正确的——fail-closed 贯穿每条错误路径，受限令牌的 restricting-SID 双列表契约有真实的验证记录，Landlock C 源的内存安全面几乎为零。未发现 confined 子进程的逃逸路径。下述发现集中在宿主进程（server 侧）的 FFI 边界与清理卫生。

---

## P2 一般偏重

### [P2-1] 分配器错配：koffi.alloc 分配的 SID 缓冲经 LocalFree 释放

> 2026-08-30 已修复（方案 A）：`ffi.ts` 新增 `freeBytes`（`koffi.free` 配对 `koffi.alloc`）；`index.ts` 的 `sidAllocations` 清理（init 失败与 dispose）改经 `freeAllocatedBlockBestEffort` → `koffi.free`，`ConvertStringSidToSidW` 分配的 write/temp SID 保持 `LocalFree` 释放。测试断言两种分配器各自配对（`index-failure-paths.spec` 新增 koffi.free/LocalFree 配对用例；令牌管线失败聚合计数 5→3 反映 koffi 堆释放不再产生失败）。

- 位置：[packages/sandbox/sandbox-windows-acl/src/index.ts:141](../packages/sandbox/sandbox-windows-acl/src/index.ts#L141)（`freeSidBestEffort` 经 `api.localFree` 释放）、[index.ts:319-321](../packages/sandbox/sandbox-windows-acl/src/index.ts#L319)（init 失败路径的 `sidAllocations` 清理）、[index.ts:419-421](../packages/sandbox/sandbox-windows-acl/src/index.ts#L419)（dispose 的 `sidAllocations` 清理）；分配点在 [token.ts:72-74](../packages/sandbox/sandbox-windows-acl/src/token.ts#L72)（logon SID 副本，`allocBytes(sidLength)`）与 [token.ts:86-93](../packages/sandbox/sandbox-windows-acl/src/token.ts#L86)（Everyone SID，`allocBytes(SECURITY_MAX_SID_SIZE)`）
- 描述：`logonSid`（`CopySid` 的目标）与 `worldSid`（`CreateWellKnownSid` 的目标）都在 koffi 堆上分配（`koffi.alloc`，经 `allocBytes`），但二者进入 `sidAllocations` 后由 `freeSidBestEffort` 经 **`LocalFree`** 释放。`LocalFree` 只对 `LocalAlloc` 分配的内存有效（其内部是进程堆的 `HeapFree`），而 koffi.alloc 走的是 koffi 自己的分配器。这是教科书式的 FFI 分配器错配。对照：同包内其他 SID 分配是正确的——`ConvertStringSidToSidW`（LocalAlloc）的 SID 由 `localFree` 释放（`grant.ts`、`AclSandbox` 的 write SID），`GetNamedSecurityInfoW`/`SetEntriesInAclW` 的描述符/ACL 对亦然。
- 影响：`LocalFree` 释放外来指针时，最好情形是返回 NULL（代码的 `!isNullPtr(freed)` 检查会把它变成一次 cleanup failure + SID 内存泄漏——每次 `AclSandbox.init()` 泄漏 ~68+ 字节 × 2），最坏情形是宿主（server）进程堆损坏。作用域是宿主进程，不是被限制的子进程；泄漏量小且有界（每次 init 两个分配），但这是 dispose/init-failure 路径上的未定义行为。
- 修复建议：为 koffi 分配的内存使用 `koffi.free`（ffi.ts 增加 `freeBytes`/`freeBytesBestEffort` 辅助，与 `allocBytes` 配对），或在分配侧改用 `localAlloc` 绑定使分配/释放配对一致；`freeSidBestEffort` 按分配来源区分释放器。建议同时为 `localFree` 的失败返回增加与 `mergeAndApply` 一致的失败上报（现有代码已具备该形态）。

---

## P3 建议

### [P3-1] read-only 模式的默认 DACL ACE 对 Everyone 使用 FILE_ALL_ACCESS，超出用途所需

- 位置：[packages/sandbox/sandbox-windows-acl/src/token.ts:126-131](../packages/sandbox/sandbox-windows-acl/src/token.ts#L126)（`buildExplicitAccess(sidPtr, GRANT_ACCESS, FILE_ALL_ACCESS)`）
- 描述：受限令牌的默认 DACL 合并存在的目的是让受限子进程能创建匿名 stdio 管道等新对象（pass-2 要求对象 DACL 对某个 restricting SID 放行）。管道创建所需的访问远小于 `FILE_ALL_ACCESS`（0x1F01FF，含 `DELETE`、`WRITE_DAC` 之外的全部位——WRITE_DAC 未含于 FILE_ALL_ACCESS，但 DELETE/子对象删除等都在）。workspace-write 模式下该 ACE 名命会话私有的 temp SID，风险被会话隔离吸收；**read-only 模式下它名命 EVERYONE**：read-only 子进程在其文档化边界内（Everyone 可写位置）创建的每个新对象，其 DACL 都会授予 Everyone 完全访问——超出"父容器允许的写入"这一继承基线（默认 DACL 存在时取代继承 ACE）。
- 影响：放大 README 已文档化的 Everyone 部分边界——由边界内创建的新对象获得 DELETE 等父容器未授予的权限。
- 修复建议：read-only 模式的默认 DACL ACE 收窄到新对象实际需要的访问（管道读写：`GENERIC_READ | GENERIC_WRITE` 或对应的文件位掩码，不含 `DELETE`）；workspace-write 的 temp-SID ACE 可维持不变（会话私有）。

### [P3-2] DACL 遍历未把 SubAuthorityCount 约束在 ACE 尺寸内

- 位置：[packages/sandbox/sandbox-windows-acl/src/acl.ts:196-213](../packages/sandbox/sandbox-windows-acl/src/acl.ts#L196)（`hasExactGrant`：仅校验 `aceSize ≥ 8` 与 `offset + aceSize ≤ aclSize`）、[ffi.ts:198-218](../packages/sandbox/sandbox-windows-acl/src/ffi.ts#L198)（`sameSidAt`：`leftCount` 只受 `SID_MAX_SUB_AUTHORITIES`（15）上限约束，子授权读取 `leftOffset + 8 + index*4` 不受 ACE 剩余尺寸约束）
- 描述：`hasExactGrant` 对 DACL 的防畸形处理很到位（`aclSize` 合理性、ACE 尺寸下限、遍历越界回退到合并路径），但一个声明了 `SubAuthorityCount = 15` 而 `AceSize` 只有 8 的畸形 ACE 会让 `sameSidAt` 读取 ACE 头之外最多 ~60 字节——越出该 ACE、仍在/略出安全描述符分配块（kernel `LocalAlloc` 分配，越界方向取决于 ACE 在 ACL 中的位置）。
- 影响：需要先对受保护目录持有 `WRITE_DAC` 才能植入畸形 DACL（目录所有者前提），因此是纯加固项而非可利用缺陷；后果是 server 进程内的越界读取（信息泄露或崩溃）。
- 修复建议：在 `hasExactGrant` 匹配 SID 前校验 `8 + 4 * leftCount ≤ aceSize - 8`（即 SID 完整落在 ACE 内），畸形即走"无精确授予"回退；`sameSidAt` 增加显式的字节预算参数或在校验方传入 ACE 尾界。

### [P3-3] per-path ACL 锁文件在用户 temp 根下只增不删

- 位置：[packages/sandbox/sandbox-windows-acl/src/acl.ts:55-58](../packages/sandbox/sandbox-windows-acl/src/acl.ts#L55)（`lockFilePath`：`%TEMP%\dsh-acl-locks\<sha256 前 16 hex>.lock`）、[acl.ts:75-109](../packages/sandbox/sandbox-windows-acl/src/acl.ts#L75)（`withPathLock` 创建后从不删除）
- 描述：每个受保护目录对应一个持久锁文件（`OPEN_ALWAYS` + 无 `FILE_SHARE_DELETE` 的防置换设计是正确的），但 `withPathLock` 成功路径只解锁、从不删除锁文件。
- 影响：长期驻留的 server 在多工作区场景下累积小文件（每路径一个）；`dsh-acl-locks` 目录成为无界增长的残留面。
- 修复建议：`closeHandle` 成功后 best-effort 删除锁文件（持锁者已释放、内容为空；删除失败静默容忍），或在文档中记录该残留为已知取舍。顺带：`win32-abi.ts` 中 `LOCKFILE_FAIL_IMMEDIATELY` 常量当前无使用方（锁有意阻塞等待）——删除或留作未来 fail-fast 语义的记录。

### [P3-4] Landlock 启动器 `restrict_self` 失败路径未关闭 ruleset fd

- 位置：[native/landlock-run/packages/entry/src/main.c:257-259](../native/landlock-run/packages/entry/src/main.c#L257)
- 描述：`__NR_landlock_restrict_self` 失败时直接 `return fail(...)`，未 `close(ruleset_fd)`（成功路径 L260 有关闭）。进程随即退出，内核回收 fd——纯卫生问题，非泄漏。
- 影响：无实际影响（单次 exec-or-exit 的进程生命周期）；列出仅为完整性。
- 修复建议：失败路径统一 `close(ruleset_fd)`（与 `add_rule` 的错误路径风格一致）。

---

## 与阶段 1 报告的对照

阶段 1（code-review-20260829.md）的"未覆盖范围"明确列出：`native/`（node-addon-landlock-run 的 C 源）与 `packages/sandbox/sandbox-windows-acl`（Win32 ACL FFI 全量）"仅扫描级检查"。本次审计将两块从扫描级提升为**全量逐行精读**：

| 区域 | 阶段 1 | 本次 |
|---|---|---|
| native/landlock-run C 源（main.c，272 行） | 未覆盖 | 全量精读 + 内存安全/安全逻辑审计 |
| landlock-run entry JS（CLI 契约） | 未覆盖 | 全量精读（路径解析、探针、grants argv） |
| sandbox-windows-acl 全部 11 个 src 模块（~1.7k 行） | 未覆盖 | 全量精读 + 与 seam 调用点交叉核对 |
| verify/abi-probe.cpp（布局探针） | 未覆盖 | 核对（koffi 偏移与 C 头布局的验证机制） |
| seam 交叉面（sandbox-local 授权生命周期、canonicalPath 规范化链） | 未覆盖 | 调用点核对（grant 生命周期与 workspace-sid 的规范化前提） |

仍不在本次范围：`scripts/build.ts` 与 release/verify 脚本（供应链，仅略读）、预编译二进制内容本身（`linux-x64`/`linux-arm64` 的 musl 静态产物）、测试文件内部质量、`docs/` 契约文档的完备性。

## 覆盖清单（已精读、未见红旗的面）

**native/landlock-run（C 源与 entry）**——逐项核验：

- **内存安全**：`parse()` 的 grant 数组以 `argc` 为界 calloc 并零初始化，写入计数受 argv 槽位约束（每个 grant 消耗两槽），无越界；无 `strcpy`/`memcpy`/栈缓冲；无算术溢出（`(size_t)argc` 有 `argc > 0` 守卫）；"exec 或退出"的生命周期使无 free 成为文档化决策。
- **fail-closed 链条**：`create_ruleset` 版本探测（ENOSYS/EOPNOTSUPP → 拒绝 exec）、`restrict_self` 失败、grant 根不可打开、`-- <argv>` 缺失——全部 125 退出且**绝不 exec 未限制命令**；`PR_SET_NO_NEW_PRIVS` 在 `restrict_self` 前设置（顺序正确，且中和 setuid/setgid 升级）。
- **ABI 协商**：handled 掩码按内核 ABI 逐级收缩（REFER@2、TRUNCATE@3、IOCTL_DEV@5），文件型 grant 的访问位收敛正确，不会把未知位送入内核（`--ro` 侧 `read_side & handled`、`--rw` 侧 `handled`、文件掩码再收敛）；部分执行如实上报 stderr 且 probe 在 stdout 独立报告——两条通道不混淆。
- **TOCTOU**：`open(O_PATH)` 将规则钉在打开的对象上，后续符号链接替换不影响已建规则。
- **entry JS**：启动器路径解析绝不 cwd 相对（防 cwd 决定"哪个二进制执行限制"）；无任何环境变量覆盖（`NALR_*` 仅限构建/测试编排）；探针 2s 超时 + 非零退出一律 `unusable`（消费方 fail-closed）；`LAUNCHER_FAILURE_EXIT = 125` 的歧义（被包裹命令也可能返回 125）由"必须伴随启动器诊断"的消费者契约处理。
- **fd 卫生**：`add_rule` 成功/失败路径均关闭 `path_fd`；`restrict_self` 失败路径未关 fd 见 P3-4（进程即退，无实际影响）。

**sandbox-windows-acl**——逐项核验：

- **fail-closed 错误传播**：每个 Win32 调用（约 25 个绑定、全部调用点）均检查并携带 API 名 + 精确 Win32 码 + 受影响路径抛出；`AclSandbox.init` 失败回收全部可撤销（temp）授予与 SID 分配，常驻（workspace）ACE 有意保留并文档化为重用缓存；`AclWriteGrant.add` 先记录后授予（post-apply 抛出仍可撤销）；`mergeAndApply` 的描述符/ACL 释放顺序与 LocalAlloc 归属正确（仅 P2-1 所述的 koffi 分配除外）。
- **令牌构造**：`CreateRestrictedToken` 标志（`DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`）与双列表（logon+EVERYONE 保活组；write SID 仅 workspace-write）的每一条注释声明都有对应的实现与验证记录（README 的 Modes 边界、POC-worktree 验证标注）；workspace-write 无 write SID 时显式抛错；read-only 拒绝 write SID。
- **pass-2 默认 DACL**：合并的存在理由（匿名管道创建的 pass-2 拒绝）、temp-SID 优先的会话域隔离、`SetTokenInformation` 的拷贝语义与释放顺序——正确（Everyone ACE 的宽度见 P3-1）。
- **授权幂等与并发**：`hasExactGrant` 跳过整树重传播（`aclSize`/`aceSize` 合理性回退）；`withPathLock` 的锁文件无 `FILE_SHARE_DELETE`（防置换重建）、`OPEN_ALWAYS`、零化 OVERLAPPED（koffi 3.1.1 的 NULL 崩溃规避）；锁根固定于 `GetTempPathW`（绝不来自 argv/DSH_HOME）；锁文件名 sha256+lowercase 归一。
- **身份派生**：workspace/temp SID 的确定性派生、temp 的第三子授权域分隔（兄弟会话隔离）、`canonicalPath`（`realpathSync.native`）在 seam 侧先行规范化，满足 `workspace-sid.ts` 的规范化前提；`assertTempRootOutsideWorkspace`/`assertPrivateTempDisjoint` 用 `realpathSync.native` + `relative` 做双向包含检查。
- **runner**：argv 解析的配对校验（write/temp-write SID 必须成对且与路径派生值一致）、模式与 SID 组合的全部非法组合拒绝、`SetConsoleCtrlHandler` 保住清理路径、退出码全 32 位镜像（含 NTSTATUS）的经验验证记录、清理失败不掩盖子进程退出码。
- **布局验证**：`verify/abi-probe.cpp` 将 koffi 硬编码偏移（`EXPLICIT_ACCESS_W_SIZE=48`、`TRUSTEE_W_OFFSET=16`、`SID_AND_ATTRIBUTES_SIZE=16` 等）与真实 C 头布局核对。
- **受限边界（记录为设计而非缺陷）**：WRITE_RESTRICTED 只约束写访问（读/网络/进程可见性不受限）；console 隔离不可用；目录所有者（owner-implicit WRITE_DAC）前提；standing workspace ACE 不撤销（跨会话重用缓存）。

## 交叉面结论（Landlock / ACL / seam）

- 两平台 rung 的**降级语义一致且诚实**：Landlock 探针 `full`/`partial`/`unusable` 三态与 windows-acl 的 `partial` enforcement 映射（sandbox-local L186）都把"部分执行"如实暴露给 mode 词汇，不虚报 `full`。
- **fail-closed 对齐**：Landlock 侧"绝不 exec 未限制命令"与 ACL 侧"绝不 spawn 未限制子进程"由 seam 的失败签名（`windows-acl-run:` + exit 127；Landlock 125 + 诊断行）消费并核验，两侧的失败契约在 sandbox-local 的 fatalSignatures 表中显式登记。
- **授权生命周期跨层一致**：seam 的 `manageDacls: false` 契约（caller 持有 ACE）、standing/revocable 二分、`assertTempRootOutsideWorkspace` 的双重执行（seam 与 runner 边界各一次）在两侧实现中一致。
- **平台语义差异（记录，非缺陷）**：Landlock 是 allow-list 文件限制（读写/执行/引用全族），Windows 受限令牌是 pass-2 写交集（读/网络不受限）——两平台的 enforcement 词汇因此不同（`full` vs `partial`），与 seam 的平台映射表一致。

## 残余边界

预编译二进制（musl 静态 `landlock-run` 产物）按"审计面 = C 源 + 内核契约"的包内声明未反汇编复核；`scripts/build.ts` 的构建与发布验证脚本仅略读（供应链审计属独立任务）；12 个测试 spec 的断言质量按其存在性与覆盖声明采信，未逐个重审。
