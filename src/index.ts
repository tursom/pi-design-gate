import { Type } from 'typebox';
import { createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition, createPowerShellToolDefinition, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { inspect, evidencePath, readEvidence, type ResolvedEvidence } from './context.ts';
import { classify, preliminaryGate, type Call } from './gate.ts';
import { ProposalSchema, validateProposal, type Review } from './schema.ts';
import { reviewWithModel, type Reviewer } from './review.ts';
import { GateState, STATE_ENTRY } from './state.ts';
import { branchRequests, selectedRequests } from './history.ts';

const textResult = (text: string, details: unknown = {}) => ({ content: [{ type: 'text' as const, text }], details });
const failureText = (error: unknown) => error instanceof Error ? error.message : '设计审查失败。';

export function registerDesignGate(pi: ExtensionAPI, reviewer: Reviewer = reviewWithModel): void {
  const state = new GateState(value => pi.appendEntry(STATE_ENTRY, value));
  const permits = new Map<string, { epoch: number; input: string }>();
  let dialogOpen = false;

  // PI can preflight siblings before executing them. Recheck the current plan
  // and exact arguments at execute, without another model call.
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
        if (!state.value.armed) {
          signal?.throwIfAborted();
          return factory(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
        }
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
  function feedback(review: Review): void {
    const discussion = review.questions.length ? '\n\n待讨论的问题：\n' + review.questions.map((q, i) =>
      `${i + 1}. ${q.question}\n可选做法：${q.options.join('；')}\n建议：${q.recommendation}`
    ).join('\n\n') + '\n\n可以直接追问含义、原因或其他方案，理解后再决定；也可用 /design review 打开快捷选择。' : '';
    pi.sendMessage({ customType: 'design-gate-review', display: true,
      content: `设计审查：${review.verdict}\n\n${review.reason}${review.findings.length ? '\n\n' + review.findings.map(f => `- ${f}`).join('\n') : ''}${discussion}`,
    }, { triggerTurn: false });
  }
  async function questions(ctx: ExtensionContext): Promise<'answered' | 'discussion' | undefined> {
    if (dialogOpen || !ctx.hasUI || !['ask_user', 'investigate'].includes(state.value.status) || state.value.review?.verdict !== 'ask_user') return;
    dialogOpen = true;
    try {
      while (['ask_user', 'investigate'].includes(state.value.status) && state.value.review?.verdict === 'ask_user' && state.value.review.questions.length) {
        const epoch = state.epoch;
        const q = state.value.review.questions[0];
        const custom = '先讨论 / 自由补充…';
        const choice = await ctx.ui.select(`${q.question}\n推荐：${q.recommendation}`, [...q.options, custom]);
        if (state.epoch !== epoch || !choice) return;
        if (choice === custom) {
          const entered = await ctx.ui.input('可以提问、补充需求，或提出其他方案', q.question);
          if (state.epoch !== epoch || !entered?.trim()) return;
          // Free text may be a question, a hypothetical or an actual decision.
          // Preserve the original input for dialogue, never record it as a
          // selected option or remove the unresolved question here.
          state.request(`关于待讨论问题「${q.question}」，用户补充：\n${entered.trim()}`, ctx.mode === 'tui' ? 'interactive' : 'rpc');
          permits.clear();
          status(ctx);
          return 'discussion';
        }
        const answer = choice;
        const remaining = state.value.review!.questions.slice(1);
        state.set({ ...state.value,
          status: remaining.length ? 'ask_user' : 'investigate',
          answers: [...state.value.answers, { proposalVersion: state.value.version, question: q.question, answer }],
          review: { ...state.value.review!, verdict: remaining.length ? 'ask_user' : 'investigate', questions: remaining },
        });
        status(ctx);
      }
      return 'answered';
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
  pi.on('before_agent_start', () => state.value.armed ? ({
    message: { customType: 'design-gate-context', display: false,
      content: `设计门禁当前${state.value.armed ? `已启用，状态=${state.value.status}` : '未启用'}。普通任务无需启动门禁；需要必要性审查时先运行 /design start，再调用design_context和design_review。启动后必须与实施工具分开调用。ask_user默认在正常对话中讨论；明确决定后更新方案并重新审查。通过后按方案实施，范围改变需重新启动审查。`,
    },
  }) : undefined);

  pi.registerTool({
    name: 'design_context', label: 'Design Context',
    description: '获取当前分支的用户请求、历史决定、方案与审查状态。query搜索历史，offset/limit分页；session:entryId可作为request证据引用。只读。',
    parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: 1000 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const requests = branchRequests(ctx.sessionManager.getBranch(), state.value.requests);
      const query = params.query?.toLocaleLowerCase();
      const matching = query ? requests.filter(r => `${r.text}\n${r.context?.map(c => c.text).join('\n') ?? ''}`.toLocaleLowerCase().includes(query)) : requests;
      const limit = params.limit ?? 20;
      const offset = params.offset ?? Math.max(0, matching.length - limit);
      const page = matching.slice(offset, offset + limit).map(r => ({ id: r.id, source: r.source, entryId: r.entryId,
        text: r.text.slice(0, 1500), ...(r.text.length > 1500 ? { truncated: true } : {}),
        context: r.context?.map(c => ({ ...c, text: c.text.slice(0, 500), ...(c.text.length > 500 ? { truncated: true } : {}) })),
      }));
      const value = JSON.stringify({ ...state.value, requests: page, totalRequests: requests.length,
        matchedRequests: matching.length, offset, nextOffset: offset + limit < matching.length ? offset + limit : null,
        note: '只展示当前分支的请求索引；引用ID时读取完整原文。历史assistant仅用于解释简短回答，不作为用户授权。' }, null, 2);
      return textResult(value.length > 48_000 ? value.slice(0, 48_000) + '\n[输出截断，请用query或较小limit缩小范围]' : value);
    },
  });
  pi.registerTool({
    name: 'design_inspect', label: 'Design Inspect',
    description: '设计阶段的结构化只读查询：files/search/status/diff/log。path可为绝对路径或相对会话目录路径；search使用pattern。不执行shell字符串，输出最多约40KB。仅Git查询需要仓库。',
    parameters: Type.Object({ action: Type.String({ enum: ['files', 'search', 'status', 'diff', 'log'] }), pattern: Type.Optional(Type.String({ maxLength: 1000 })), path: Type.Optional(Type.String({ minLength: 1 })) }),
    async execute(_id, params, signal, _update, ctx) {
      const cwd = evidencePath(ctx.cwd, params.path ?? '.');
      return textResult(await inspect(pi, { ...ctx, cwd }, params.action, params.pattern, signal));
    },
  });

  pi.registerTool({
    name: 'design_review', label: 'Design Review',
    description: '实施前提交必要性方案并独立审查；产品取舍交由用户决定。单独调用，不能与实施工具并行。',
    parameters: Type.Object({ action: Type.String({ enum: ['submit'] }), proposal: ProposalSchema }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      if (params.action !== 'submit') throw new Error('design_review仅支持submit；不再执行工作区终审。');
      if (!state.value.armed) throw new Error('设计门禁未启动，请先运行 /design start。普通任务无需启动设计门禁。');
      if (state.value.status === 'reviewing') throw new Error('已有设计审查正在进行。');
      // Resubmitting alone cannot erase a pending decision. Real user input is
      // captured by the input hook and can supply an answer for the next review.
      if (state.value.status === 'ask_user') {
        return textResult(JSON.stringify({ currentStatus: 'ask_user', review: state.value.review,
          next: '待决问题留在对话中。先解释用户不理解的内容，允许追问和调整选项；等真实用户决定后再提交方案，不要重复弹窗或把问题当作已回答。' }));
      }
      const proposal = params.proposal;
      const priorReview = state.value.review;
      // Revoke old permits immediately, but preserve pending questions until
      // valid evidence is ready for an actual model review.
      state.set({ ...state.value, status: 'investigate' });
      const validationEpoch = state.epoch;
      permits.clear();
      status(ctx);
      const requests = branchRequests(ctx.sessionManager.getBranch(), state.value.requests);
      let evidence: ResolvedEvidence[];
      try {
        validateProposal(proposal);
        evidence = await readEvidence(ctx.cwd, proposal, { ...state.value, requests });
      } catch (error) {
        throw new Error(`证据参数需要修正，尚未调用审查模型：${failureText(error)}`);
      }
      signal?.throwIfAborted();
      if (state.epoch !== validationEpoch) throw new Error('证据校验期间任务已变化，尚未调用审查模型，请重新提交。');
      const epoch = state.begin(proposal);
      status(ctx);
      try {
        const references = [...proposal.evidence, ...proposal.mechanisms.flatMap(m => m.evidence)]
          .filter(e => e.kind === 'request').map(e => e.reference);
        if (state.epoch !== epoch) throw new Error('任务已变化，请重新提交。');
        const result = await reviewer(ctx, {
          mode: 'proposal', capturedRequests: selectedRequests(requests, references), proposal,
          projectDirectory: ctx.cwd, answers: state.value.answers, priorReview, evidence,
        }, signal);
        signal?.throwIfAborted();
        if (!state.finish(epoch, result.review)) throw new Error('任务已变化，审查结果已丢弃。');
        feedback(result.review);
        status(ctx);
        const fileEvidence = evidence.filter(e => e.actualRange).map(e => ({ reference: e.reference, actualRange: e.actualRange }));
        return { ...textResult(JSON.stringify({ review: result.review, currentStatus: state.value.status, answers: state.value.answers, fileEvidence }), { ...result.review, fileEvidence }), usage: result.usage };
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
      if (!state.value.armed) return;
      const epoch = state.epoch;
      const reason = await preliminaryGate(call, state, ctx);
      if (reason) return block(reason);
      if (classify(call) !== 'mutation') return;
      if (state.epoch !== epoch || state.value.status !== 'ready') return block('初步检查期间任务已变化，未放行。');
      permits.set(call.toolCallId, { epoch, input: JSON.stringify(call.input) });
    } catch (error) {
      return block(`设计门禁检查失败，未放行：${failureText(error)}`);
    }
  });

  pi.registerCommand('design', {
    description: '使用 /design start 启动必要性审查流程；/design stop 恢复普通任务直通；/design review 打开待决问题快捷选择。',
    async handler(args, ctx) {
      const command = args.trim();
      if (command === 'start') {
        state.start();
        permits.clear();
        status(ctx);
        pi.sendMessage({ customType: 'design-gate-status', display: true,
          content: '设计门禁已启动。请调用 design_context 调查当前任务，再提交 design_review。' }, { triggerTurn: false });
        return;
      }
      if (command === 'stop') {
        state.stop();
        permits.clear();
        status(ctx);
        pi.sendMessage({ customType: 'design-gate-status', display: true,
          content: '设计门禁已停止，普通任务恢复直通。' }, { triggerTurn: false });
        return;
      }
      if (command === 'review') {
        const outcome = await questions(ctx);
        if (outcome) pi.sendMessage({ customType: 'design-gate-answer', display: true,
          content: outcome === 'discussion'
            ? '用户提供了自由补充。请读取design_context，区分追问、假设与明确决定：追问时先回应疑问、解释具体影响，不要立即重抛原选择题，也不要把问题记作选择；如果已经明确决定，则按决定更新方案并审查，无需再作形式确认。'
            : '用户已明确选择。请读取design_context，按已有决定更新方案并提交design_review；尚未回答的问题可以继续讨论。' }, { triggerTurn: true, deliverAs: 'followUp' });
      } else {
        pi.sendMessage({ customType: 'design-gate-status', display: true,
          content: `状态：${state.value.status}；门禁${state.value.armed ? '已启动' : '未启动'}；方案 v${state.value.version}\n${state.value.review?.reason ?? '等待必要性方案。'}\n待确认：${state.value.review?.questions.length ?? 0}` }, { triggerTurn: false });
      }
    },
  });
}

export default registerDesignGate;
