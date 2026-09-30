# 形式化验证（TLA+ / TLC）

本目录用 TLA+ 对并发关键协议建模，并用 TLC 穷举所有可达状态进行检查。当前覆盖目标配置文件锁（`src/lock.js`）；其余并发/安全组件的范围与后续计划见文末。

## 运行

需要 Java 11+ 与 `tla2tools.jar`：

```sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar formal/run.sh
# 或
npm run verify
```

`run.sh` 会检查每个模型的**预期结论**（见下表），任一不符即返回非零。

| 模型 | 含义 | TLC 预期结论 |
| --- | --- | --- |
| `Lock.tla` | 修复后的锁协议 | 无错误（`NoHusk`、`MutualExclusion`、`GateExclusion` 均成立） |
| `LockHuskRace.tla` | 修复前的锁协议 | `MutualExclusion` 被违反（保留为反例证据） |

TLC 报告的状态数为有限模型下的穷举结果；扩大 `Procs` 只会增加状态数，不改变结论方向。

## 建模对象与抽象

`Lock.tla` 直接对应 `src/lock.js`：

- 锁是 `<store>.lock` 目录，内含 `owner` 记录（token + pid）；恢复在 `<store>.lock.recover` 闸门下进行。
- 有有效 owner 记录且 pid 存活 → 永不回收；无有效记录的空壳（husk）在 mtime 超过宽限期后才可回收（模型用 `lockAged` 表示）。
- 环境可在任意时刻让进程崩溃（保留其记录），也可让 husk "变老"。
- 修复后的获取路径：在私有 staging 目录中写好 owner 记录，再用 `rename` 原子发布到规范路径。

**刻意的抽象**：闸门获取在模型中视为原子（mkdir + 写记录）。闸门是仅用于恢复的互斥体，其空壳窗口与本模型发现的问题同类，但不在本次建模范围内；见"局限"。

## 发现：创建者空壳被替换导致的互斥失效

修复前的协议（`LockHuskRace.tla`）在 `mkdir(<store>.lock)` 之后才写 owner 记录，两步之间存在"规范路径已存在但无 owner"的空壳窗口。TLC 找到一个反例（`Procs = {p1,p2,p3}`）：

1. `p1` `mkdir` 得到空壳后停顿。
2. 空壳 mtime 超过宽限期（环境动作 `AgeLock`）。
3. `p2` 判定其 stale，在闸门下将其移除，并在同一路径重新 `mkdir` 出自己的空壳。
4. `p1` 恢复执行，其 `writeOwnerRecord` 是**按路径**写入的，于是写进了 `p2` 的目录。
5. `p1` 读回看到自己的 token → 进入临界区；`p2` 随后覆写 owner 再读回 → 也进入临界区。

结论：**两个进程可同时持有同一把锁**。触发条件是某个创建者在 `mkdir` 与写 owner 之间被调度器停顿超过宽限期（默认 `graceMs = 5000`），概率低但确实可达；对目标配置的读改写而言，后果是丢失更新。

该反例由 `LockHuskRace.tla` 的 TLC 运行给出，可作为回归证据长期保留。

## 修复与验证

`src/lock.js` 的获取路径改为"私有 staging + 原子 `rename` 发布"（`git` 中可见对应提交）：

- 先在 `lockPath.staging.<token>` 中写好完整 owner 记录；
- 再用 `rename(staging, lockPath)` 发布。规范路径要么不存在，要么一定带着完整 owner 记录，**不存在空壳窗口**；
- 目标被占用（非空目录 / 非目录）时 `rename` 失败，转入既有的判定/恢复流程；
- 空的陈旧 husk（只可能来自历史遗留）仍按宽限期语义处理。

`Lock.tla` 对这个协议检查：

- `MutualExclusion`：任意可达状态至多一个进程在临界区；
- `GateExclusion`：任意可达状态至多一个进程持有恢复闸门；
- `NoHusk`：规范路径从不出现"存在但无 owner"的空壳；
- `TypeOK`：状态类型不变量。

四项均通过（TLC：无错误）。`src/lock.js` 的 60+ 项并发/锁回归测试在此修复后仍全部通过。

## 局限（未验证的部分）

形式化验证只覆盖**已建模的抽象**，不等于实现整体正确：

- 闸门的空壳窗口未建模（见上）；如需，可对闸门套用同样的 staging+rename 方案并建模。
- 未建模文件系统原语本身（`mkdir`/`rename`/`readFile` 的原子性与错误语义按 POSIX 假设）。
- 未建模 token 生成、`pid` 存活判定（`process.kill(pid,0)`）、时钟与 mtime 粒度。
- 未建模 SSH 连接预热去重、后台任务生命周期、sudo 密码信息流；这些目前由 `test/` 下的常规测试覆盖。
- 本目录验证的是**协议设计**，不是 JavaScript 源码本身；模型与代码的对应关系是人工维护的，修改协议时需同步模型。

## 后续计划

按价值排序，可继续纳入形式化范围：

1. **闸门**：套用 staging+rename 并建模，消除同类窗口。
2. **连接预热去重**（`src/ssh.js`）：同一 ControlPath 至多一次认证/一次终端；调用取消不影响共享预热。
3. **后台任务生命周期**（`src/jobs.py`）：仅当进程结束且输出读尽后才允许清理；状态与退出码一致。
4. **sudo 信息流**（`src/sudo.js`）：密码只出现在终端读入、SSH stdin、远端 sudo stdin 三个通道，不进入 MCP 状态、模型可见输出或磁盘。
