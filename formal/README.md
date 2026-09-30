# 形式化验证（TLA+ / TLC）

本目录用 TLA+ 对并发与安全关键协议建模，并用 TLC 穷举所有可达状态进行检查。核心并发协议（目标配置锁、连接预热去重、后台任务生命周期）与安全协议（sudo 密码信息流）均已覆盖。

## 运行

需要 Java 11+ 与 `tla2tools.jar`：

```sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar formal/run.sh
# 或
npm run verify
```

`run.sh` 逐个运行模型并断言其**预期结论**：已验证的协议必须无错误；用于对照的"反设计"必须仍然违反对应不变量（这证明模型对该性质确实敏感）。任一不符即返回非零。

## 模型清单

已建模并验证通过：

| 模型 | 对象 | 验证的性质 |
| --- | --- | --- |
| `Lock.tla` | 目标配置锁（`src/lock.js`） | `MutualExclusion`、`GateExclusion`、`NoHusk`、`TypeOK` |
| `Warmup.tla` | 连接预热去重（`src/ssh.js`） | `NoConcurrentTerminals`、`TerminalNeedsInteractive`、`NoTerminalWhileCached`、`SingleWarmup` |
| `Jobs.tla` | 后台任务生命周期（`src/jobs.py`） | `NoCleanupWhileRunning`、`NoUnreadOutputLost`、`StatusConsistent` |
| `Sudo.tla` | sudo 密码信息流（`src/sudo.js`） | `Secrecy` |

保留为反例/对照（预期被 TLC 反证）：

| 模型 + 配置 | 反证的不变量 | 说明 |
| --- | --- | --- |
| `LockHuskRace.tla` | `MutualExclusion` | 修复前的锁协议 |
| `Warmup.tla` + `WarmupNoDedup.cfg` | `NoConcurrentTerminals` | 假设"每个调用各自预热"的去重缺失 |
| `Jobs.tla` + `JobsUnsafe.cfg` | `NoUnreadOutputLost` | 假设清理不检查未读输出 |
| `Sudo.tla` + `SudoViaMcp.cfg` | `Secrecy` | 假设密码经 MCP 进程中转 |

## 锁协议：发现的竞态与修复

修复前的协议在 `mkdir(<store>.lock)` 之后才写 owner 记录，两步之间存在"规范路径已存在但无 owner"的空壳窗口。TLC 在 `Procs = {p1,p2,p3}` 下给出反例（`LockHuskRace.tla`）：

1. `p1` `mkdir` 得到空壳后停顿；
2. 空壳 mtime 超过宽限期（环境动作 `AgeLock`）；
3. `p2` 判定其 stale，在闸门下移除并在同一路径 `mkdir` 自己的空壳；
4. `p1` 恢复执行，其 `writeOwnerRecord` **按路径**写入，落进了 `p2` 的目录；
5. `p1` 读回自己的 token 进入临界区；`p2` 覆写 owner 后读回也进入临界区。

→ **两个进程同时持锁**，对目标配置读改写即丢失更新。触发条件是创建者在 `mkdir` 与写 owner 之间被停顿超过宽限期（默认 `graceMs = 5000`）。

修复：获取锁改为**私有 staging + 原子 `rename` 发布**——先在 `lockPath.staging.<token>` 写完整 owner 记录，再 `rename` 到规范路径。规范路径要么不存在、要么带着完整 owner 记录，**不存在空壳窗口**。`Lock.tla` 对修复后协议验证 `NoHusk`、`MutualExclusion`、`GateExclusion`、`TypeOK` 全部通过。

**闸门**（`<store>.lock.recover`）此前是同一类空壳窗口（`mkdir` 后再写 owner）。修复后闸门同样采用 staging + `rename` 发布；`Lock.tla` 显式建模其发布、接管（`GateMoveAside` + `GatePublish`）、对存活闸门的退避与 husk 替换，`GateExclusion` 通过。

## 连接预热去重

`Warmup.tla` 对 `src/ssh.js` 的进程内协调建模：调用方共享同一目的地的**一个**在途预热；只有交互式预热才可能打开认证终端，且不会在近期终端失败被缓存时再次打开；取消只解除该调用方，不改动共享状态。

验证的性质：

- `NoConcurrentTerminals`：任一时刻至多一个认证终端；
- `TerminalNeedsInteractive`：终端只服务于交互式预热；
- `NoTerminalWhileCached`：缓存的终端失败抑制后续终端尝试；
- `SingleWarmup`：同一目的地在途预热至多一个。

取消隔离由 `Abort(c)` 动作不写任何共享变量在结构上保证，并已由 `test/ssh-warmup.test.mjs` 覆盖；该性质是一般 action 形式的时态公式，TLC 只支持 `<>[]`/`[]<>`，故不在 `Warmup.cfg` 中列出。

## 后台任务生命周期

`Jobs.tla` 对 `src/jobs.py` 建模：启动、写输出、正常结束、崩溃、kill、记录退出码、读取、清理，以及由存活状态、退出文件、killed 标记派生的状态。

验证的性质：

- `NoCleanupWhileRunning`：进程存活时绝不删除任务目录；
- `NoUnreadOutputLost`：未读到输出末尾时绝不删除任务目录（清理要求本次读取已到达文件末尾）；
- `StatusConsistent`：`running`/`completed`/`killed` 恒与记录事实一致。

## sudo 密码信息流

`Sudo.tla` 对 `src/sudo.js` 的信息流契约建模：密码只出现在三个通道——本地终端变量、SSH stdin 管道、远端 sudo stdin；不得进入 MCP 进程状态、工具结果、任何文件、任何日志或任何进程 argv。

验证的性质：`Secrecy`（上述五类通道永不含密码）。

## 模型与代码的对应

| 模型 | 代码 | 关键对应 |
| --- | --- | --- |
| `Lock.tla` | `src/lock.js` | 锁/闸门目录与 owner 记录、staging+rename 发布、判定/恢复/释放 |
| `Warmup.tla` | `src/ssh.js` | `masterWarmers`、`recentWarmFailures`、`establishControlMaster`、`waitForWarm` |
| `Jobs.tla` | `src/jobs.py` | `start`/`state.json`/`exit`/`killed`、`alive`、output 读取与 `cleanup` |
| `Sudo.tla` | `src/sudo.js` | 终端读入、管道到 ssh、远端 `sudo -S`、结果回传 |

## 局限

形式化验证只覆盖**已建模的抽象**，不等于实现整体正确：

- 未建模文件系统原语本身（`mkdir`/`rename`/`readFile` 的原子性与错误语义按 POSIX 假设）。
- 未建模 token 生成、`pid` 存活判定（`process.kill(pid,0)`）、时钟/mtime 粒度；`Warmup.tla` 用非确定动作抽象 30s 失败缓存与跨进程 socket 锁（后者由 `Lock.tla` 单独验证）。
- `Jobs.tla` 将输出与读取建模为单字节计数，未建模 `offset`/`limit` 的任意随机访问与分页边界。
- `Sudo.tla` 验证的是**设计层面的信息流契约**，不是 bash 与 sudo 实现的证明；实现侧由 `test/sudo.test.mjs` 补充。
- 模型与代码的对应关系由人工维护，修改协议时需同步模型。
