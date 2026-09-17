# PI Design Gate

PI 专用的设计必要性门禁。AI 必须先提交当前目标、依据和新增机制的取舍，独立审查通过后才能实施；需要用户决定的问题由插件对话框处理。

这是流程约束，不是操作系统沙箱。它针对跳过审查、无依据扩项和过期批准，不能隔离拥有同一宿主机权限的任意代码。

## 使用

要求 Node.js 22.19+、PI `0.84.4`、Git、ripgrep。当前工作目录需要是 Git 仓库，空仓库也支持。

```bash
cd /root/dev/work/pi-design-gate
npm ci --ignore-scripts
npm run check
```

先在独立 PI 会话试用，不影响其他会话：

```bash
cd /path/to/project
pi -e /root/dev/work/pi-design-gate/src/index.ts
```

确认适合自己的使用方式后，可以注册为全局 PI 包：

```bash
pi install /root/dev/work/pi-design-gate
```

启动新会话，或在支持重载的客户端执行 `/reload`。本项目的开发过程不会自动修改全局 PI 配置，也不会重启 PI WEB 的服务。

插件启用后默认关闭实施入口。用户照常描述任务；AI 使用 `design_context` 获取用户输入的引用 ID，调查后调用 `design_review`。不需要每次手动输入审批指令。

- `/design status`：查看当前状态、版本和待处理事项。
- `/design review`：重新打开被取消或关闭的待确认问题。
- 没有 `/design approve`，也没有模型可调用的批准工具。

TUI 和 PI WEB 使用 `ctx.ui.select/input`。PI WEB 已有该扩展对话框的服务端处理。无 UI 模式仍能自动审查，但遇到产品决策会保持 `ask_user`，不会自动同意。

## 工作流程

1. 插件在 `input` 中记录 interactive/rpc 输入及引用 ID，忽略 extension 注入的输入。
2. 调查只开放已适配的读取工具，以及 `design_inspect` 的结构化查询。
3. `design_review(action="submit")` 提交必要性方案。文件引用会读取实际内容；伪造或找不到的请求引用被拒绝。
4. 插件使用当前模型另建上下文执行审查，不提供工具，也不使用主模型的思维过程作为证据。
5. 审查结果决定后续行为。
6. 放行后，每次已适配的实施调用还会独立检查是否符合方案。内建写工具在 `execute` 入口再次核对版本和参数，并使用 sequential 执行模式；执行前记录工作区待审状态。
7. `agent_end` 自动核对 Git 基线与当前差异，包含暂存、未暂存及未跟踪文件。范围偏离会关闭后续实施，通知主模型处理。

| 结果 | 主模型下一步 | 实施权限 |
| --- | --- | --- |
| `ready` | 在已审方案内实现 | 开放，仍检查具体调用 |
| `revise` | 删除无依据机制或简化方案 | 关闭 |
| `investigate` | 查询缺失事实，或根据已确认决定更新方案 | 关闭 |
| `ask_user` | 等待插件对话框中的用户决定 | 关闭 |

用户选择只解决具体决策，不直接发放无限写权限。主模型需按回答更新方案，再次自动审查；已有回答作为证据复用，不要求用户重复确认。窗口关闭、取消或没有 UI 都不代表批准。每个已回答问题立即保存，取消后续问题不会丢失此前回答。

## 必要性方案

```json
{
  "action": "submit",
  "proposal": {
    "goal": "批量审核",
    "acceptance": ["处理选中的记录，返回逐项结果"],
    "changes": ["分页读取，有限并发调用现有单条 RPC"],
    "evidence": [{"kind": "request", "reference": "design_context 返回的请求 ID"}],
    "mechanisms": []
  }
}
```

简单局部修复可以 `mechanisms: []`。准备新增表、持久任务、配置、依赖、认证、重试、缓存或兼容路径时，应记录：

- `purpose`：当前解决什么问题。
- `evidence`：用户请求或项目文件依据。
- `failureCost`：不做的具体后果。
- `responsibility`：由哪个组件负责，是否已有承担者。
- `simplestAlternative`：现有能力或最小方案。
- `whyAlternativeInsufficient`：最小方案缺少什么；无依据时为 null。
- `uncertainty`：未解决取舍；无则为 null。

文件证据使用项目相对路径与 `startLine/endLine`；文件正文是待分析数据，不是人类批准。审查读取全部已捕获请求、已回答问题和实际证据，而不是仅相信方案里“用户已批准”的描述。

## 工具边界

- 读取：read/grep/find/ls、codex_memory、已适配的 OpenProject 和飞书读取 action，以及会话状态查询。
- 实施：edit/write/bash（Windows 另含 powershell）。必须先 ready，再通过当前调用的独立审查，最后在内建工具包装器的执行入口复核一次性许可。插件会覆盖这些内建工具，沿用原有参数和渲染。
- 外部写入：OpenProject 和飞书写入 action 暂不开放。当前 PI 的 `getAllTools()` 不提供其他扩展的 execute 函数，尚未接入执行时复核；只提供读取适配。
- 结构化调查：`design_inspect` 的 files/search/status/diff/log，不执行模型拼接的 shell 字符串。
- 委派：本版阻止 spawn_session/spawn_subsession/subagent/delegate_task。父会话的 hook 不会自动继承到子进程，尚未接入子会话权限继承。
- 未知工具：阻断，需增加明确的 action 适配；不会根据工具描述猜测只读。
- edit/write 路径必须在当前项目内，解析符号链接后检查；不开放 `.git` 和 `.pi` 内部路径。
- `ask_user` 可用于普通询问，但其文本结果不会改变插件审批状态。

`design_review` 必须独立于实施工具调用。即使旧状态 ready，同一 assistant 消息里同时提交新设计并写入，也会拦下写入，不会假定并行工具已经完成审批。execute 入口还会检查预检后到达的新输入，以及被后续扩展修改过的参数；已经开始执行的副作用不能通过撤销许可回滚。

新用户消息会撤销旧实施状态，但保留需求和已确认回答。PI 重载或分支导航从 `getBranch()` 恢复当前分支，不拿其他分支的批准放行；恢复时 ready 也需要重新自动审查。异步模型结果和对话框回答绑定运行期 epoch，不能覆盖新输入或新分支。

## 限制与成本

- **必要性是语义判断。** 状态门禁是确定性的，审查模型的判断仍可能误判。不能把测试通过理解为所有过度工程都能识别。
- **当前每次实施工具调用都会增加一次模型审查。** 这是第一版为覆盖 Bash 和隐式扩项采用的明确代价，可能明显增加延迟与费用；没有暗设宽松跳过路径。适合先在限定任务试用。
- 初次方案审查、每次实施检查使用当前会话模型，45 秒超时；失败、无效 JSON、截断或任务变更都不放行相应调用。
- 提交审查与操作审查的模型用量进入工具结果。自动终审的用量保存为 `design-gate/automatic-audit-usage` 会话条目，目前不并入 PI 原生工具用量总计。
- 审查在 `agent_end` 执行，可能晚于最后一段正文的展示，不能收回已经展示的“完成”，也不回滚文件。Git 终审只覆盖工作区；外部写入工具暂不开放。
- Git 基线保存固定 commit OID（空仓库使用空树），保留已有改动；正常 commit 不会清除本阶段的审查范围。审查者负责对比新增差异，不自动 stash、提交、回滚或清理用户文件。差异过大、未跟踪二进制文件或无法完整读取时，审查失败而不是截断后批准。
- 终审没有覆盖 Git 忽略的文件或仓库之外的 shell 副作用。Bash 放行依赖语义审查，不是完整 shell 安全分析。
- `appendEntry` 提供会话持久化，不是防篡改存储。其他扩展、手动 `!` 命令、同权限进程、工具执行后的参数改写均不属于本插件的隔离保证。
- 输入来源区分依赖 PI/PI WEB 的正常事件分发；能直接控制宿主 RPC 或文件系统的程序不属于不可信隔离域。
- 全部捕获输入会保存在当前会话并交给当前配置的模型。不要把凭据粘贴进设计依据。插件不维护另一个外部审批服务。

## 与 Stop That Shit 的关系

核对版本：[lennney/stop-that-shit @ 7f3dc86](https://github.com/lennney/stop-that-shit/tree/7f3dc86f268437c3d2f18ba026311d9ab40d0db9)。其已有 PI Adapter，不只是 Skill。

| 方面 | Stop That Shit | PI Design Gate |
| --- | --- | --- |
| 核心职责 | 显式任务契约与动作边界 | 强制必要性方案与独立语义审查 |
| 必要性判断 | Skill 中的工程规则 | 插件发起独立模型调用 |
| 启用 | 默认观察，显式任务模式后 armed | 加载后关闭实施，待自动审查 |
| 典型限制 | 只读、files、deps、hash、agent 预算 | 未审方案、待确认决策、过期审查、方案偏离 |
| 人工决定 | 显式契约及参数 | 插件 UI 回答绑定方案版本 |
| 宿主 | 多宿主 | 仅 PI |

该仓库的 `ARCHITECTURE.md` 明确将工程语义交给 Skill；Guard 不从机制名称推断业务必要性。两者目标重叠，执行层也都使用 PI 的 `tool_call`，但它不能替代本项目的必要性审查流程。

本项目没有复制或打包 STS 源码。暂不建议同时启用两个拦截器，以免出现相互独立的批准和阻断状态。

## 开发与验证

```bash
npm run check
# 可选真实模型测试，只修改临时Git目录，使用已有模型配置
node scripts/smoke-live.mjs provider/model
# 可选：五个历史模式的语义审查评估（不会修改项目）
pi --no-extensions -e ./scripts/eval-review.ts --no-skills --no-context-files \
  --model provider/model -p /evaluate-design-gate
```

离线测试注入审查结果，验证状态与工具阻断，不声称验证模型语义质量。真实测试会产生模型费用；遇到产品决策只取消，不自动替用户批准。

代码：`schema.ts` 定义契约，`state.ts` 管理版本与异步结果，`review.ts` 执行模型审查，`context.ts` 读取证据和 Git 差异，`gate.ts` 分类工具，`index.ts` 连接 PI 事件与 UI。
