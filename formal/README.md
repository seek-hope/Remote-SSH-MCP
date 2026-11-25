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
| `Lock.tla` | 目标配置锁（`src/lock.js`） | `MutualExclusion`、`GateExclusion`、`NoOwnedHusk`、`TypeOK` |
| `Warmup.tla` | 连接预热去重（`src/ssh.js`） | `NoConcurrentTerminals`、`TerminalNeedsInteractive`、`NoTerminalWhileCached`、`SingleWarmup` |
| `Jobs.tla` | 后台任务生命周期（`src/jobs.py`） | `NoCleanupWhileRunning`、`NoUnreadOutputLost`、`StatusConsistent`（定义性） |
| `Sudo.tla` | sudo 密码信息流与内存缓存（`src/sudo.js`、`src/sudocache.js`） | `ObservableSecrecy`、`CacheBounded`、`TypeOK` |

保留为反例/对照（预期被 TLC 反证）：

| 模型 + 配置 | 反证的不变量 | 说明 |
| --- | --- | --- |
| `LockHuskRace.tla` | `MutualExclusion` | 修复前的锁协议 |
| `Lock.tla` + `LockNoHusk.cfg` | `NoHuskEver` | 可达性对照：环境注入空壳确实可达，保证 `NoOwnedHusk` 非空洞 |
| `Warmup.tla` + `WarmupNoDedup.cfg` | `NoConcurrentTerminals` | 假设"每个调用各自预热"的去重缺失 |
| `Jobs.tla` + `JobsUnsafe.cfg` | `NoUnreadOutputLost` | 假设清理不检查未读输出 |
| `Sudo.tla` + `SudoLeak.cfg` | `ObservableSecrecy` | 假设密码被写入工具结果、磁盘、日志或 argv |

## 锁协议：发现的竞态与修复

修复前的协议在 `mkdir(<store>.lock)` 之后才写 owner 记录，两步之间存在"规范路径已存在但无 owner"的空壳窗口。TLC 在 `Procs = {p1,p2,p3}` 下给出反例（`LockHuskRace.tla`）：

1. `p1` `mkdir` 得到空壳后停顿；
2. 空壳 mtime 超过宽限期（环境动作 `AgeLock`）；
3. `p2` 判定其 stale，在闸门下移除并在同一路径 `mkdir` 自己的空壳；
4. `p1` 恢复执行，`writeOwnerRecord` 按路径写入，落进了 `p2` 的目录；
5. `p1` 读回自己的 token 进入临界区；`p2` 覆写 owner 后读回也进入临界区。

结果是两个进程同时持锁，对目标配置做读改写就会丢失更新。触发条件是创建者在 `mkdir` 与写 owner 之间被停顿超过宽限期（默认 `graceMs = 5000`）。

修复方式：获取锁改为私有 staging + 原子 `rename` 发布——先在 `lockPath.staging.<token>` 写完整 owner 记录，再 `rename` 到规范路径。协议不会发布空壳；规范路径要么不存在、要么带着完整 owner 记录。模型允许环境注入遗留空壳（仅在路径为空时），使替换/恢复动作可达；`Lock.tla` 验证 `NoOwnedHusk`（空壳永远没有 owner 记录）、`MutualExclusion`、`GateExclusion`、`TypeOK` 全部通过。`LockNoHusk.cfg` 额外反证 `NoHuskEver`（无空壳），证明空壳注入确实可达，避免 `NoOwnedHusk` 因注入被移除而空洞通过。模型把非空死锁/遗弃锁的恢复抽象为 `JudgeLock = stale` 后的 move-aside；普通文件或非空 husk 的具体清理由 `test/store-lock.test.mjs` 覆盖，不在 TLC 的 husk 注入路径内。另有一个实现层的窄窗口不在模型内：`enterGate` 的第二次存活检查与 `rename` 之间，另一进程可能发布 gate；`recoverLock` 的 judge 与 rename 之间也可能插入新持锁者。该交错要求毫秒级时序且测试无法稳定复现，但属于已知的 TOCTOU 边界；不要把配置更新当作无需重试的强事务。

闸门（`<store>.lock.recover`）此前也有同样的空壳窗口（`mkdir` 后再写 owner）。修复后同样改为 staging + `rename` 发布；`Lock.tla` 显式建模其发布、接管（`GateMoveAside` + `GatePublish`）、对存活闸门的退避与遗留 husk 替换（环境注入后 `GateReplaceHusk` 可达），`GateExclusion` 通过。

## 连接预热去重

`Warmup.tla` 对 `src/ssh.js` 的进程内协调建模：调用方共享同一目的地的一个在途预热；只有交互式预热才可能打开认证终端，且不会在近期终端失败被缓存时再次打开；取消只解除该调用方，不改动共享状态。

验证的性质：

- `NoConcurrentTerminals`：任一时刻至多一个认证终端；
- `TerminalNeedsInteractive`：终端只服务于交互式预热；
- `NoTerminalWhileCached`：缓存的终端失败抑制后续终端尝试；
- `SingleWarmup`：同一目的地在途预热至多一个。

`Abort(c)` 动作不写任何共享变量，从结构上保证了取消隔离，另由 `test/ssh-warmup.test.mjs` 覆盖。该性质是一般 action 形式的时态公式，而 TLC 只支持 `<>[]`/`[]<>`，因此未列入 `Warmup.cfg`。

## 后台任务生命周期

`Jobs.tla` 对 `src/jobs.py` 建模：启动、写输出、正常结束、崩溃、kill、记录退出码、读取、清理，以及由存活状态、退出文件、killed 标记派生的状态。

模型中的 `running` 表示 worker 存活。worker 会保持到进程组/会话内非僵尸成员全部退出，并由 worker 自身在 TERM 宽限期后升级为 KILL（`job_kill` 请求进程中断不影响升级）。实现侧要求 v3 worker 在连续两次扫描确认无成员后写 `done` 收尾标记；对 v3 任务，没有 `done` 的 `killed`/`completed` 一律报告 `lost` 并拒绝清理（v1/v2 旧任务沿用旧规则）。`Jobs.tla` 是简化抽象：模型中的 `lost` 只表示崩溃且无退出记录，不表示 v3 的 `done` 规则；`StatusConsistent` 是定义性一致性检查（`Status` 的分支本身即蕴含其取值），不能检测实现的 v3 派生；session 成员与清理拒绝也未建模。v3 规则由 `test/jobs.test.mjs` 覆盖。

验证的性质：

- `NoCleanupWhileRunning`：进程存活时绝不删除任务目录；
- `NoUnreadOutputLost`：未读到输出末尾时绝不删除任务目录（清理要求本次读取已到达文件末尾）；
- `StatusConsistent`：模型内的定义性一致性检查（`Status` 的分支本身即蕴含其取值）；不覆盖实现的 v3 `done`/`lost` 派生。

## sudo 密码信息流

`Sudo.tla` 对 `src/sudo.js` 与 `src/sudocache.js` 的信息流契约建模。密码的允许通道：本地终端变量、交付给 MCP 的本机私有 Unix socket、MCP 进程内存缓存（自输入起至多 `TTL` 个时钟拍）、SSH stdin 管道、远端 sudo stdin。

内存缓存是一项显式的、有界的取舍：MCP 进程可以持有密码副本，但 `CacheBounded` 要求它在绝对截止时间到达后不再可读；实现侧由每条目的到期定时器与读取时的截止检查共同清零，逻辑上以截止时间为准（清零动作可能晚于截止时间几毫秒）；TTL 超过约 24.8 天时没有定时器，只有读取时的惰性清零。`LeakTo*`（由 `SudoLeak.cfg` 打开）建模一个把密码复制到工具结果、磁盘、日志或 argv 的错误设计，TLC 会反证 `ObservableSecrecy`。模型覆盖 `TTL >= 1`；`REMOTE_SSH_SUDO_CACHE_MS=0` 的关闭模式不缓存，未在模型中表示。

验证的性质：

- `ObservableSecrecy`：密码不出现在工具结果、任何文件、任何日志或任何进程 argv 中；
- `CacheBounded`：截止时间之后缓存不再持有密码（定时器与惰性检查）。

实现侧另有模型未覆盖的通道细节，由 `test/sudo.test.mjs` 覆盖：密码只发给 `sudo -S -v`（不执行用户命令），未被 sudo 读取的残留行在命令启动前由短生命周期 `bash` 消费；命令通过 `sudo -n` 与 `/dev/null` stdin 执行，因此无法从祖先进程的 stdin 管道读回密码。单次调用持有的临时副本在 SSH 接受 stdin 后清零，也不在 `CacheBounded` 的范围内。

## 模型与代码的对应

| 模型 | 代码 | 关键对应 |
| --- | --- | --- |
| `Lock.tla` | `src/lock.js` | 锁/闸门目录与 owner 记录、staging+rename 发布、判定/恢复/释放 |
| `Warmup.tla` | `src/ssh.js` | `masterWarmers`、`recentWarmFailures`、`establishControlMaster`、`waitForWarm` |
| `Jobs.tla` | `src/jobs.py` | `start`/`state.json`/`exit`/`killed`、`alive`、output 读取与 `cleanup` |
| `Sudo.tla` | `src/sudo.js`、`src/sudocache.js` | 终端读入、Unix socket 交付、内存缓存与到期、`sudo -S -v` 认证、`sudo -n` 执行、结果回传 |

## 局限

形式化验证只覆盖**已建模的抽象**，不等于实现整体正确：

- 未建模文件系统原语本身（`mkdir`/`rename`/`readFile` 的原子性与错误语义按 POSIX 假设）。
- 未建模 token 生成、`pid` 存活判定（`process.kill(pid,0)`）、时钟/mtime 粒度；`Warmup.tla` 用非确定动作抽象 30s 失败缓存与跨进程 socket 锁（后者由 `Lock.tla` 单独验证）。
- `Jobs.tla` 将输出与读取建模为单字节计数，未建模 `offset`/`limit` 的任意随机访问与分页边界；也未建模 worker 在终止宽限期后的信号升级、进程组枚举与 PID 复用防护。
- 文件工具的远端完整性校验（`src/files.py`）与连接保活策略未建立独立 TLA+ 模型；前者由临时目录集成测试覆盖，后者由 `ssh -G` 兼容性测试覆盖。
- `Sudo.tla` 验证的是设计层面的信息流契约（含缓存的有界生命周期），不是 bash、sudo、socket、stdin 管道拓扑、ppid 票据键、drain、固定包装标记与缓存解析身份的证明；实现侧由 `test/sudo.test.mjs` 与 `test/sudocache.test.mjs` 补充。模型不表示 `TTL=0` 的关闭模式、单次调用的临时副本，以及认证探测与命令执行分属两次 SSH 调用的流程。
- `Lock.tla` 的 `GateExclusion` 对应理想化的闸门接管。实现中 `enterGate` 的“判断存活 → rename 移走”是两次独立的异步操作，不是原子的：另一个恢复者可能在这两步之间发布新闸门并被移走。互斥仍由锁发布后等待存活闸门并重新确认 owner token 保证（`acquireStoreLock`），但模型没有表示这个具体交错。owner 记录只含 `{token, pid, at}`，重启后 PID 复用可能让一个陈旧锁看起来仍被持有；这是有意的保守规则（活 PID 不按年龄抢占），需要人工清理。
- 未建模一次 SSH 调用内部的进程/文件描述符拓扑；sudo 密码在远端 stdin 管道中的残留是否可被命令读回由 `test/sudo.test.mjs` 的本地真实包装脚本回归覆盖。
- 模型与代码的对应关系由人工维护，修改协议时需同步模型。
