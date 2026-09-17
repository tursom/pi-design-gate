import { Type } from 'typebox';
import { createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition, createPowerShellToolDefinition, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { inspect, readEvidence, workspaceReference, workspaceSnapshot } from './context.ts';
import { classify, preliminaryGate, type Call } from './gate.ts';
import { ProposalSchema, validateProposal, type Review } from './schema.ts';
import { reviewWithModel, type Reviewer } from './review.ts';
import { GateState, STATE_ENTRY } from './state.ts';

const textResult = (text: string, details: unknown = {}) => ({ content: [{ type: 'text' as const, text }], details });
const failureText = (error: unknown) => error instanceof Error ? error.message : '设计审查失败。';

export function registerDesignGate(pi: ExtensionAPI, reviewer: Reviewer = reviewWithModel): void {
  const state = new GateState(value => pi.appendEntry(STATE_ENTRY, value));
  const currentStatus = () => state.value.status;
  const permits = new Map<string, { epoch: number; input: string }>();
  let dialogOpen = false;

  // PI may preflight a batch before execution. Recheck the exact reviewed
  // arguments and epoch at execute, rather than relying on a cached allow.
  const factories: Array<(cwd: string) => ToolDefinition<any, any>> = [
    createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
    ...(process.platform === 'win32' ? [createPowerShellToolDefinition] : []),
  ];
  for (const factory of factories) {
    const definition = factory(process.cwd());
    pi.registerTool({ ...definition, executionMode: 'sequential',
      async execute(id, params, signal, onUpdate, ctx) {
        const permit = permits.get(id);
        permits.delete(id);
        if (!permit || permit.epoch !== state.epoch || state.value.status !== 'ready' || permit.input !== JSON.stringify(params)) {
          throw new Error('执行入口复核失败：方案、任务或工具参数已变化，请重新进行工具调用。');
        }
        signal?.throwIfAborted();
        return factory(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
      },
    });
  }

  function status(ctx: ExtensionContext): void {
    if (ctx.hasUI) ctx.ui.setStatus('design-gate', `设计审查：${state.value.status} · v${state.value.version}`);
  }
  const payload = (mode: string, extra: object = {}) => ({
    mode,
    capturedRequests: state.value.requests,
    proposal: state.value.proposal,
    answers: state.value.answers,
    priorReview: state.value.review,
    ...extra,
  });
  function feedback(review: Review): void {
    pi.sendMessage({ customType: 'design-gate-review', display: true,
      content: `设计审查：${review.verdict}\n\n${review.reason}${review.findings.length ? '\n\n' + review.findings.map(f => `- ${f}`).join('\n') : ''}`,
    }, { triggerTurn: false });
  }
  async function questions(ctx: ExtensionContext): Promise<void> {
    if (dialogOpen || !ctx.hasUI || state.value.status !== 'ask_user') return;
    dialogOpen = true;
    try {
      while (state.value.status === 'ask_user' && state.value.review?.questions.length) {
        const epoch = state.epoch;
        const q = state.value.review.questions[0];
        const custom = '补充其他决定…';
        const choice = await ctx.ui.select(`${q.question}\n推荐：${q.recommendation}`, [...q.options, custom]);
        if (state.epoch !== epoch || !choice) return;
        let answer = choice;
        if (choice === custom) {
          const entered = await ctx.ui.input(q.question, '输入你的决定');
          if (state.epoch !== epoch || !entered?.trim()) return;
          answer = entered.trim();
        }
        const remaining = state.value.review!.questions.slice(1);
        state.set({ ...state.value,
          status: remaining.length ? 'ask_user' : 'investigate',
          answers: [...state.value.answers, { proposalVersion: state.value.version, question: q.question, answer }],
          review: { ...state.value.review!, verdict: remaining.length ? 'ask_user' : 'investigate', questions: remaining },
        });
        status(ctx);
      }
    } finally { dialogOpen = false; }
  }

  const restore = (ctx: ExtensionContext) => {
    state.restore(ctx.sessionManager.getBranch());
    permits.clear();
    status(ctx);
  };
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', () => { state.epoch++; permits.clear(); });
  pi.on('input', (event, ctx) => {
    if (event.source !== 'extension') {
      state.request(event.text, event.source);
      permits.clear();
      status(ctx);
    }
    return { action: 'continue' };
  });
  pi.on('before_agent_start', () => ({
    message: { customType: 'design-gate-context', display: false,
      content: `设计门禁已启用，状态=${state.value.status}。实施前必须调用 design_context 获取插件记录的请求ID，再调用 design_review 提交当前目标、验收条件及新增机制的必要性判断。简单修复可用空mechanisms。使用read/grep/find/ls或design_inspect调查；未放行时Bash不可用。design_review不得和实施工具同批调用。revise先简化，investigate先调查，ask_user等待插件对话框决定；不能通过ask_user的普通文字结果自行标记批准。已确认回答复用。子代理本版不开放。实施调用还会核对方案范围。`,
    },
  }));

  pi.registerTool({
    name: 'design_context', label: 'Design Context',
    description: '获取当前任务的真实输入ID、已有方案、审查结果及用户决定。只读。',
    parameters: Type.Object({}),
    async execute() {
      const value = JSON.stringify(state.value, (key, value) => key === 'baseline' ? undefined : value, 2);
      if (value.length > 45_000) {
        return textResult(JSON.stringify({ status: state.value.status, version: state.value.version,
          requests: state.value.requests.slice(-5), proposal: state.value.proposal,
          review: state.value.review, answers: state.value.answers,
          note: '只展示最近5条输入；审查仍使用全部已捕获输入。' }, null, 2).slice(0, 48_000));
      }
      return textResult(value);
    },
  });
  pi.registerTool({
    name: 'design_inspect', label: 'Design Inspect',
    description: '设计阶段的结构化只读查询：files/search/status/diff/log。search使用pattern；不执行shell字符串，输出最多约40KB。',
    parameters: Type.Object({ action: Type.String({ enum: ['files', 'search', 'status', 'diff', 'log'] }), pattern: Type.Optional(Type.String({ maxLength: 1000 })) }),
    async execute(_id, params, signal, _update, ctx) {
      return textResult(await inspect(pi, ctx, params.action, params.pattern, signal));
    },
  });

  async function audit(ctx: ExtensionContext, signal?: AbortSignal) {
    if (!state.value.proposal || state.value.baseline === undefined) throw new Error('尚无方案和工作区基线。');
    const epoch = state.epoch;
    const current = await workspaceSnapshot(pi, ctx, signal, state.value.baselineRef);
    if (state.epoch !== epoch) throw new Error('上下文已变化，工作区审查取消。');
    if (current === state.value.baseline) { state.clean(); return textResult('工作区与审查基线一致。'); }
    const result = await reviewer(ctx, payload('audit', { baseline: state.value.baseline, current }), signal);
    if (!state.finish(epoch, result.review)) throw new Error('审查期间任务已变化，未使用过期结果。');
    if (result.review.verdict === 'ready') state.clean();
    feedback(result.review);
    status(ctx);
    return { ...textResult(JSON.stringify(result.review), result.review), usage: result.usage };
  }

  pi.registerTool({
    name: 'design_review', label: 'Design Review',
    description: '必须在实施前提交必要性方案。submit进行独立审查，ask_user由插件UI确认；audit核对最终Git差异。单独调用，不能与实施工具并行。',
    parameters: Type.Object({ action: Type.String({ enum: ['submit', 'audit'] }), proposal: Type.Optional(ProposalSchema) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      if (state.value.status === 'reviewing') throw new Error('已有设计审查正在进行。');
      if (params.action === 'audit') {
        if (state.value.status !== 'ready') throw new Error('待解决决策不能通过audit绕过，请先完成方案审查。');
        return audit(ctx, signal);
      }
      // Pending decisions cannot be erased by resubmitting the same or another
      // proposal. The user can choose the simplest option, then resubmit.
      if (state.value.status === 'ask_user') {
        await questions(ctx);
        return textResult(`当前状态：${state.value.status}。${state.value.status === 'ask_user' ? '等待用户决定，可用 /design review 重开对话框。' : '请按用户回答更新方案后重新提交。'}`);
      }
      validateProposal(params.proposal);
      const proposal = params.proposal;
      const epoch = state.begin(proposal);
      permits.clear();
      status(ctx);
      try {
        const evidence = await readEvidence(ctx.cwd, proposal, state.value);
        const baselineRef = state.value.baselineRef ?? await workspaceReference(pi, ctx, signal);
        const baseline = state.value.baseline ?? await workspaceSnapshot(pi, ctx, signal, baselineRef);
        if (state.epoch !== epoch) throw new Error('任务已变化，请重新提交。');
        // Save without advancing the epoch of this in-flight review.
        state.value = { ...state.value, baseline, baselineRef };
        pi.appendEntry(STATE_ENTRY, state.value);
        const result = await reviewer(ctx, payload('proposal', { evidence }), signal);
        if (!state.finish(epoch, result.review)) throw new Error('任务已变化，审查结果已丢弃。');
        feedback(result.review);
        status(ctx);
        if (result.review.verdict === 'ask_user') await questions(ctx);
        return { ...textResult(JSON.stringify({ review: result.review, currentStatus: state.value.status, answers: state.value.answers }), result.review), usage: result.usage };
      } catch (error) {
        state.fail(epoch, failureText(error));
        status(ctx);
        throw error;
      }
    },
  });

  pi.on('tool_call', async (event, ctx) => {
    const call = event as Call;
    const block = (reason: string) => ({ block: true as const, reason });
    try {
      const epoch = state.epoch;
      const reason = await preliminaryGate(call, state, ctx);
      if (reason) return block(reason);
      if (classify(call) !== 'mutation') return;
      if (state.epoch !== epoch || state.value.status !== 'ready') return block('初步检查期间任务已变化，未放行。');
      const result = await reviewer(ctx, payload('operation', { tool: call }), ctx.signal);
      // Persist nested usage on the eventual tool result, including blocked calls.
      usageByCall.set(call.toolCallId, result.usage);
      if (state.epoch !== epoch) return block('任务或方案已变化，未执行过期审查对应的操作。');
      if (result.review.verdict !== 'ready') {
        state.finish(epoch, result.review);
        feedback(result.review);
        status(ctx);
        return block(`设计门禁：${result.review.verdict}。${result.review.reason}`);
      }
      // Mark before execution so a crash between the side effect and tool_result
      // cannot make the next session treat unreviewed work as a clean baseline.
      state.markDirty();
      permits.set(call.toolCallId, { epoch, input: JSON.stringify(call.input) });
    } catch (error) {
      return block(`设计门禁检查失败，未放行：${failureText(error)}`);
    }
  });
  const usageByCall = new Map<string, Awaited<ReturnType<Reviewer>>['usage']>();
  pi.on('tool_result', (event) => {
    const usage = usageByCall.get(event.toolCallId);
    usageByCall.delete(event.toolCallId);
    if (!usage) return;
    if (!event.usage) return { usage };
    return { usage: {
      input: usage.input + event.usage.input, output: usage.output + event.usage.output,
      cacheRead: usage.cacheRead + event.usage.cacheRead, cacheWrite: usage.cacheWrite + event.usage.cacheWrite,
      totalTokens: usage.totalTokens + event.usage.totalTokens,
      cost: Object.fromEntries(Object.keys(usage.cost).map(k => [k, usage.cost[k as keyof typeof usage.cost] + event.usage!.cost[k as keyof typeof usage.cost]])) as typeof usage.cost,
    } };
  });

  pi.on('agent_end', async (_event, ctx) => {
    if (state.value.status === 'ask_user') {
      await questions(ctx);
      if (currentStatus() === 'investigate') pi.sendMessage({ customType: 'design-gate-answer', display: true,
        content: '用户已回答设计问题，请读取design_context并按决定更新方案。' }, { triggerTurn: true, deliverAs: 'followUp' });
      return;
    }
    if (!state.value.dirty || state.value.status !== 'ready') return;
    const epoch = state.epoch;
    try {
      // Run in the extension rather than asking the main model to remember a
      // final tool call. This audit can report drift after the final text has
      // streamed, but cannot retract that text or undo an external side effect.
      const result = await audit(ctx, ctx.signal);
      if ('usage' in result && result.usage) pi.appendEntry('design-gate/automatic-audit-usage', result.usage);
      if (currentStatus() === 'ask_user') await questions(ctx);
      if (currentStatus() !== 'ready') pi.sendMessage({ customType: 'design-gate-audit-needed', display: true,
        content: '实际改动未通过设计范围审查。请读取design_context，处理发现的问题；不要声称已完成核验。' },
        { triggerTurn: true, deliverAs: 'followUp' });
    } catch (error) {
      state.fail(epoch, failureText(error));
      status(ctx);
      pi.sendMessage({ customType: 'design-gate-audit-error', display: true,
        content: `工作区审查未完成：${failureText(error)}。写入保持关闭；请调查后重新提交方案。` }, { triggerTurn: false });
    }
  });

  pi.registerCommand('design', {
    description: '查看设计门禁状态，或用 /design review 回答待确认问题；没有模型可调用的批准入口。',
    async handler(args, ctx) {
      if (args.trim() === 'review') {
        await questions(ctx);
        if (state.value.status === 'investigate') pi.sendMessage({ customType: 'design-gate-answer', display: true,
          content: '设计问题已回答。请读取design_context，按已确认决定更新方案并提交design_review。' }, { triggerTurn: true, deliverAs: 'followUp' });
      } else {
        pi.sendMessage({ customType: 'design-gate-status', display: true,
          content: `状态：${state.value.status}；方案 v${state.value.version}\n${state.value.review?.reason ?? '等待必要性方案。'}\n待确认：${state.value.review?.questions.length ?? 0}；未完成差异审查：${state.value.dirty}` }, { triggerTurn: false });
      }
    },
  });
}

export default registerDesignGate;
