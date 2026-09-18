import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerDesignGate } from '../src/index.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Reviewer } from '../src/review.ts';
import type { Proposal, Review } from '../src/schema.ts';
import type { State } from '../src/state.ts';

const exec = promisify(execFile);
const ready: Review = { verdict: 'ready', reason: 'Matches the user request', findings: [], questions: [] };
const pending: Review = { verdict: 'ask_user', reason: 'Failure tolerance is unknown', findings: [],
  questions: [{ id: 'failure', question: 'Allow partial completion?', options: ['Yes', 'No'], recommendation: 'Yes' }] };
const proposal = (reference: string): Proposal => ({ goal: 'Change the greeting', acceptance: ['Print hello'], changes: ['Edit app.txt'], evidence: [{ kind: 'request', reference }], mechanisms: [] });

async function harness(reviewer: Reviewer = async () => ({ review: ready }), history: any[] = [], initialInput = 'Change app.txt to print hello', start = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-design-test-'));
  const entries: any[] = [...history];
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const messages: any[] = [];
  const executions: string[] = [];
  const ctx = { cwd, hasUI: false, mode: 'json', sessionManager: { getBranch: () => entries },
    ui: { setStatus() {}, notify() {}, select: async () => undefined, input: async () => undefined },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data: structuredClone(data) }),
    sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
    exec: async (command: string, args: string[], options: { cwd?: string } = {}) => {
      executions.push(command);
      try { return { ...await exec(command, args, { cwd: options.cwd ?? cwd }), code: 0, killed: false }; }
      catch (e: any) { return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code, killed: false }; }
    },
  } as unknown as ExtensionAPI;
  registerDesignGate(pi, reviewer);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  const run = (name: string, args: any = {}) => tools.get(name).execute('tool-1', args, undefined, undefined, ctx);
  const current = (): State => entries.filter(e => e.customType === 'design-gate/state-v1').at(-1)?.data;
  await emit('session_start');
  if (start) await commands.get('design').handler('start', ctx);
  messages.length = 0;
  await emit('input', { text: initialInput, source: 'rpc' });
  const submit = () => run('design_review', { action: 'submit', proposal: proposal(current().requests.at(-1)!.id) });
  const call = (toolName = 'write', input: Record<string, unknown> = { path: 'app.txt', content: 'hello' }, id = 'write-1') => emit('tool_call', { toolName, toolCallId: id, input });
  return { cwd, ctx, entries, tools, commands, messages, executions, emit, run, current, submit, call };
}

test('evidence validation precedes reviewing, preserves pending context and revokes old permits', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; return { review: ready }; });
  await h.submit();
  const previousReview = h.current().review;
  const args = { path: 'app.txt', content: 'hello' };
  await h.call('write', args, 'old');
  const checkpoint = h.entries.length;
  await writeFile(join(h.cwd, 'source.txt'), 'one\ntwo\n');
  const plan = proposal(h.current().requests.at(-1)!.id);
  plan.evidence.push({ kind: 'file', reference: 'source.txt', startLine: 9 });
  await assert.rejects(h.run('design_review', { action: 'submit', proposal: plan }), /尚未调用审查模型.*source.txt.*实际共 2 行/);
  assert.equal(calls, 1);
  assert.equal(h.current().status, 'investigate');
  assert.deepEqual(h.current().review, previousReview);
  assert.ok(!h.entries.slice(checkpoint).some(e => e.data?.status === 'reviewing'));
  await assert.rejects(h.tools.get('write').execute('old', args, undefined, undefined, h.ctx), /执行入口复核失败/);
  plan.evidence[1] = { kind: 'file', reference: 'source.txt', endLine: 999 };
  const result = await h.run('design_review', { action: 'submit', proposal: plan });
  assert.deepEqual(JSON.parse(result.content[0].text).fileEvidence[0].actualRange, { startLine: 1, endLine: 2, totalLines: 2 });
  assert.equal(calls, 2);
});

test('invalid evidence does not discard an unresolved product question after user input', async () => {
  const h = await harness(async () => ({ review: pending }));
  await h.submit();
  await h.emit('input', { source: 'rpc', text: 'What does partial completion mean?' });
  const plan = proposal(h.current().requests.at(-1)!.id);
  plan.evidence.push({ kind: 'file', reference: 'missing.txt' });
  await assert.rejects(h.run('design_review', { action: 'submit', proposal: plan }), /尚未调用审查模型.*missing.txt/);
  assert.deepEqual(h.current().review, pending);
});

test('ordinary tasks bypass the gate until explicitly started', async () => {
  const h = await harness(async () => ({ review: ready }), [], 'Do a normal task', false);
  assert.equal(await h.call(), undefined);
  assert.equal(h.current().armed, false);
  await h.commands.get('design').handler('start', h.ctx);
  assert.equal((await h.call()).block, true);
  await h.commands.get('design').handler('stop', h.ctx);
  assert.equal(await h.call(), undefined);
});
test('unreviewed writes and shell are blocked after explicit start; non-Git structured investigation works', async () => {
  const h = await harness();
  assert.equal((await h.call()).block, true);
  assert.equal((await h.call('bash', { command: 'touch x' })).block, true);
  assert.equal(await h.call('read', { path: 'app.txt' }), undefined);
  await writeFile(join(h.cwd, 'note.txt'), 'evidence');
  assert.match((await h.run('design_inspect', { action: 'files' })).content[0].text, /note.txt/);
});

test('fabricated references never reach the reviewer', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; return { review: ready }; });
  await assert.rejects(h.run('design_review', { action: 'submit', proposal: proposal('fabricated') }), /找不到插件记录/);
  assert.equal(calls, 0);
  assert.equal((await h.call()).block, true);
  await h.submit();
  assert.equal(await h.call(), undefined);
  assert.equal(calls, 1, 'implementation needs no extra model call');
});

test('unknown tools, external writes and delegation cannot bypass execution adapters', async () => {
  const h = await harness();
  assert.equal(await h.call('feishu_bitable', { action: 'search' }), undefined);
  await h.submit();
  for (const [name, args] of [['feishu_bitable', { action: 'create' }], ['spawn_subsession', { prompt: 'Implement' }], ['custom_python', { code: 'write()' }]] as const) {
    assert.equal((await h.call(name, args)).block, true);
  }
});

test('same assistant batch cannot combine review and write even with older ready permission', async () => {
  const h = await harness();
  await h.submit();
  h.entries.push({ type: 'message', message: { role: 'assistant', content: [
    { type: 'toolCall', name: 'design_review' }, { type: 'toolCall', name: 'write' },
  ] } });
  assert.match((await h.call()).reason, /当前批次/);
});

test('delayed proposal result cannot authorize after a new user input', async () => {
  let resolve!: (result: { review: Review }) => void;
  const h = await harness(async () => new Promise(r => { resolve = r; }));
  const review = h.submit();
  while (!resolve) await new Promise(r => setImmediate(r));
  await h.emit('input', { text: 'Only explain', source: 'rpc' });
  resolve({ review: ready });
  await assert.rejects(review, /任务已变化/);
  assert.equal(h.current().status, 'investigate');
  assert.equal((await h.call()).block, true);
});

test('pending decisions survive cancel, resubmission and a plain approve command', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; return { review: pending }; });
  await h.submit();
  (h.ctx as any).hasUI = true;
  await h.commands.get('design').handler('approve', h.ctx);
  await h.commands.get('design').handler('review', h.ctx);
  await h.submit();
  await h.emit('agent_end');
  assert.equal(h.current().status, 'ask_user');
  assert.equal(calls, 1);
  assert.equal((await h.call()).block, true);
});

test('UI answer is persisted and reused in the next review, not a direct permit', async () => {
  const payloads: any[] = [];
  const h = await harness(async (_ctx, payload: any) => {
    payloads.push(payload);
    return { review: payload.answers.length ? ready : pending };
  });
  await h.submit();
  (h.ctx as any).hasUI = true;
  (h.ctx.ui as any).select = async () => 'Yes';
  await h.commands.get('design').handler('review', h.ctx);
  assert.equal(h.current().answers[0].answer, 'Yes');
  assert.equal((await h.call()).block, true);
  await h.submit();
  assert.equal(await h.call(), undefined);
  assert.equal(payloads[1].answers[0].answer, 'Yes');
});

for (const source of ['interactive', 'rpc']) {
  test(`real ${source} text can answer the pending question through a new review`, async () => {
    const payloads: any[] = [];
    const h = await harness(async (_ctx, payload: any) => {
      payloads.push(payload);
      return { review: payload.capturedRequests.at(-1).text === 'Allow partial completion' ? ready : pending };
    });
    await h.submit();
    await h.emit('input', { source, text: 'Allow partial completion' });
    assert.equal((await h.call()).block, true);
    await h.submit();
    assert.equal(await h.call(), undefined);
    assert.deepEqual(payloads[1].priorReview, pending);
  });
}

test('provider failure grants no permission', async () => {
  const h = await harness(async () => { throw new Error('provider unavailable'); });
  await assert.rejects(h.submit(), /provider unavailable/);
  assert.equal((await h.call()).block, true);
});

test('non-Git implementation requires only the proposal review, with no completion audit', async () => {
  const modes: string[] = [];
  const h = await harness(async (_ctx, payload: any) => { modes.push(payload.mode); return { review: ready }; });
  await h.submit();
  const args = { path: 'app.txt', content: 'hello\n' };
  assert.equal(await h.call('write', args, 'valid'), undefined);
  await h.tools.get('write').execute('valid', args, undefined, undefined, h.ctx);
  assert.equal(await h.call('bash', { command: 'test -f app.txt' }), undefined);
  await h.emit('agent_end');
  await h.emit('agent_end');
  assert.deepEqual(modes, ['proposal']);
  assert.deepEqual(h.executions, [], 'neither submission nor completion executes Git');
  assert.equal(await readFile(join(h.cwd, 'app.txt'), 'utf8'), 'hello\n');
  assert.equal(h.current().status, 'ready');
  await assert.rejects(h.run('design_review', { action: 'audit' }), /仅支持submit/);
});

test('large staged, unstaged and binary untracked user work is untouched and absent from review', async () => {
  let payload: any;
  const h = await harness(async (_ctx, p) => { payload = p; return { review: ready }; });
  await exec('git', ['init', '-q', h.cwd]);
  const staged = 'existing work\n'.repeat(30_000);
  await writeFile(join(h.cwd, 'existing.txt'), staged);
  await exec('git', ['add', 'existing.txt'], { cwd: h.cwd });
  await writeFile(join(h.cwd, 'existing.txt'), staged + 'unstaged user work\n');
  const binary = Buffer.alloc(500_000);
  await writeFile(join(h.cwd, 'binary'), binary);
  const index = await readFile(join(h.cwd, '.git/index'));
  const head = await readFile(join(h.cwd, '.git/HEAD'));
  await h.submit();
  assert.equal(await h.call(), undefined);
  await h.emit('agent_end');
  assert.deepEqual(h.executions, []);
  assert.ok(JSON.stringify(payload).length < 5000);
  assert.deepEqual(await readFile(join(h.cwd, '.git/index')), index);
  assert.deepEqual(await readFile(join(h.cwd, '.git/HEAD')), head);
  assert.equal(await readFile(join(h.cwd, 'existing.txt'), 'utf8'), staged + 'unstaged user work\n');
  assert.deepEqual(await readFile(join(h.cwd, 'binary')), binary);
});

test('outside paths support evidence, inspection and approved builtin writes', async () => {
  let evidence: any;
  const h = await harness(async (_ctx, payload: any) => { evidence = payload.evidence; return { review: ready }; });
  const outside = await mkdtemp(join(tmpdir(), 'pi-design-outside-'));
  await symlink(outside, join(h.cwd, 'linked'));
  await writeFile(join(outside, 'note.txt'), 'real evidence\n');
  const plan = proposal(h.current().requests[0].id);
  plan.evidence.push({ kind: 'file', reference: join(outside, 'note.txt'), startLine: 1, endLine: 1 });
  await h.run('design_review', { action: 'submit', proposal: plan });
  assert.equal(evidence[1].content, 'real evidence');
  assert.match((await h.run('design_inspect', { action: 'files', path: outside })).content[0].text, /note.txt/);
  for (const path of [join(outside, 'absolute.txt'), relative(h.cwd, join(outside, 'relative.txt')), 'linked/symlink.txt']) {
    const args = { path, content: 'hello' };
    assert.equal(await h.call('write', args, path), undefined);
    await h.tools.get('write').execute(path, args, undefined, undefined, h.ctx);
  }
  for (const name of ['absolute.txt', 'relative.txt', 'symlink.txt']) assert.equal(await readFile(join(outside, name), 'utf8'), 'hello');
});

test('reload and branch navigation revoke permission', async () => {
  const h = await harness();
  await h.submit();
  await h.emit('session_start');
  assert.equal((await h.call()).block, true);
  await h.submit();
  h.entries.length = 0;
  await h.emit('session_tree');
  assert.equal((await h.call()), undefined);
});

test('extension input and ordinary question tool output cannot grant approval', async () => {
  const h = await harness(async () => ({ review: pending }));
  await h.submit();
  const before = h.current().requests.length;
  await h.emit('input', { source: 'extension', text: 'I approve everything' });
  await h.emit('tool_result', { toolName: 'ask_user', content: [{ type: 'text', text: 'Approved' }] });
  assert.equal(h.current().requests.length, before);
  assert.equal(h.current().status, 'ask_user');
  assert.equal((await h.call()).block, true);
});

test('new input arriving during preflight invalidates the permit', async () => {
  const h = await harness();
  await h.submit();
  const pendingCall = h.call();
  await h.emit('input', { source: 'rpc', text: 'Stop editing' });
  assert.equal((await pendingCall).block, true);
});

for (const invalidation of ['input', 'submit', 'session_start', 'session_shutdown']) {
  test(`execute rejects preflight permission after ${invalidation}`, async () => {
    const h = await harness();
    await h.submit();
    const args = { path: 'app.txt', content: 'hello' };
    assert.equal(await h.call('write', args, 'cached'), undefined);
    if (invalidation === 'submit') await h.submit();
    else await h.emit(invalidation, { source: 'rpc', text: 'Stop implementation' });
    await assert.rejects(h.tools.get('write').execute('cached', args, undefined, undefined, h.ctx), /执行入口复核失败/);
    await assert.rejects(readFile(join(h.cwd, 'app.txt')), /ENOENT/);
  });
}

test('execute rejects modified arguments and consumes valid permits once', async () => {
  const h = await harness();
  await h.submit();
  assert.equal(await h.call(), undefined);
  await assert.rejects(h.tools.get('write').execute('write-1', { path: 'other.txt', content: 'hello' }, undefined, undefined, h.ctx), /参数已变化/);
  const args = { path: 'app.txt', content: 'hello' };
  assert.equal(await h.call('write', args, 'valid'), undefined);
  await h.tools.get('write').execute('valid', args, undefined, undefined, h.ctx);
  await assert.rejects(h.tools.get('write').execute('valid', args, undefined, undefined, h.ctx), /执行入口复核失败/);
  assert.equal(h.tools.get('write').executionMode, 'sequential');
});

test('product questions return to conversation without opening or reopening a blocking dialog', async () => {
  const h = await harness(async () => ({ review: pending }));
  (h.ctx as any).hasUI = true;
  let dialogs = 0;
  (h.ctx.ui as any).select = async () => { dialogs++; return undefined; };
  await h.submit();
  assert.equal(dialogs, 0);
  assert.match(h.messages[0].message.content, /Allow partial completion/);
  assert.match(h.messages[0].message.content, /直接追问/);
  await h.emit('agent_end');
  await h.submit();
  assert.equal(dialogs, 0);
  await h.commands.get('design').handler('review', h.ctx);
  assert.equal(dialogs, 1, 'only an explicit command opens the shortcut');
  await h.emit('agent_end');
  await h.submit();
  assert.equal(dialogs, 1, 'cancel does not cause another popup');
  assert.equal((await h.call()).block, true);
});

for (const text of ['What does partial completion mean?', 'If I choose Yes, what happens?', 'I understand']) {
  test(`free text remains discussion rather than a selected option: ${text}`, async () => {
    const h = await harness(async () => ({ review: pending }));
    await h.submit();
    (h.ctx as any).hasUI = true;
    (h.ctx.ui as any).select = async (_title: string, options: string[]) => options.find(o => o.includes('自由补充'));
    (h.ctx.ui as any).input = async () => text;
    await h.commands.get('design').handler('review', h.ctx);
    assert.equal(h.current().answers.length, 0);
    assert.equal(h.current().review?.questions[0].id, 'failure');
    assert.match(h.current().requests.at(-1)!.text, new RegExp(text.replace(/[?]/g, '\\?')));
    assert.equal((await h.call()).block, true);
    assert.match(h.messages.at(-1).message.content, /先回应疑问/);
    assert.equal(h.messages.at(-1).options.triggerTurn, true);
  });
}

test('discussion can return to a manual choice without losing the pending question', async () => {
  const h = await harness(async (_ctx, payload: any) => ({ review: payload.answers.length ? ready : pending }));
  await h.submit();
  (h.ctx as any).hasUI = true;
  (h.ctx.ui as any).select = async (_title: string, options: string[]) => options.find(o => o.includes('自由补充'));
  (h.ctx.ui as any).input = async () => 'Please explain this first';
  await h.commands.get('design').handler('review', h.ctx);
  assert.equal(h.current().status, 'investigate');
  (h.ctx.ui as any).select = async () => 'Yes';
  await h.commands.get('design').handler('review', h.ctx);
  assert.equal(h.current().answers[0].answer, 'Yes');
  await h.submit();
  assert.equal(await h.call(), undefined);
});

test('normal chat can clarify over multiple turns, then explicitly choose without an extra confirmation', async () => {
  const payloads: any[] = [];
  const h = await harness(async (_ctx, payload: any) => {
    payloads.push(payload);
    return { review: payload.capturedRequests.at(-1).text === 'Accept partial completion; use the simpler plan' ? ready : pending };
  });
  await h.submit();
  await h.emit('input', { source: 'rpc', text: 'What does partial completion mean?' });
  h.entries.push({ id: 'explain', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Some records succeed; failed ones can be retried manually.' }] } });
  await h.emit('agent_end');
  assert.equal(payloads.length, 1, 'an explanation does not force another review');
  assert.equal((await h.call()).block, true);
  await h.emit('input', { source: 'rpc', text: 'Can I retry only the failed records?' });
  await h.submit();
  assert.deepEqual(payloads[1].priorReview, pending);
  assert.equal(h.current().status, 'ask_user');
  h.entries.push({ id: 'explain-again', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Yes. The result identifies which records failed; those can be retried.' }] } });
  await h.emit('input', { source: 'rpc', text: 'Accept partial completion; use the simpler plan' });
  h.entries.push({ id: 'final-choice', type: 'message', message: { role: 'user', content: 'Accept partial completion; use the simpler plan' } });
  await h.submit();
  assert.equal(await h.call(), undefined);
  assert.match(JSON.stringify(payloads.at(-1).capturedRequests), /result identifies/);
});

const historyUser = (id: string, text: string) => ({ id, type: 'message', message: { role: 'user', content: text } });
const timeoutHistory = [
  historyUser('timeout', '直接修改主目录，整页超时至少半分钟。'),
  { id: 'deploy-question', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '完成测试后继续部署既定测试环境，可以吗？' }] } },
  historyUser('deployment', '可以'),
];

test('mid-session enable preserves historical authorization when latest input is only continue', async () => {
  const h = await harness(async (_ctx, payload: any) => {
    const text = JSON.stringify(payload.capturedRequests);
    assert.match(text, /至少半分钟/);
    assert.match(text, /完成测试后继续部署既定测试环境/);
    assert.match(text, /可以/);
    return { review: ready };
  }, timeoutHistory, '继续');
  const context = JSON.parse((await h.run('design_context', { query: '部署' })).content[0].text);
  assert.ok(context.requests.some((r: any) => r.id === 'session:deployment'));
  await h.submit(); // Even a proposal referencing only "continue" gets recent context.
  assert.equal(await h.call(), undefined);
  await h.emit('session_start');
  const plan = proposal('session:timeout');
  plan.evidence.push({ kind: 'request', reference: 'session:deployment' });
  await h.run('design_review', { action: 'submit', proposal: plan });
  assert.equal(await h.call(), undefined);
});

test('historical PI WEB submitted form decisions reach the reviewer without a new approval', async () => {
  const history = [...timeoutHistory.slice(0, 1), {
    id: 'deployment-form', type: 'custom_message', customType: 'pi-web.ask.answers',
    details: { reason: 'submitted', questions: [{ question: { question: '完成测试后部署测试环境？', options: [{ value: 'yes', label: '同意' }] }, answered: true, values: ['yes'] }] },
  }];
  const h = await harness(async (_ctx, payload: any) => {
    assert.match(JSON.stringify(payload.capturedRequests), /用户回答：同意/);
    assert.match(JSON.stringify(payload.evidence), /current-branch historical/);
    return { review: ready };
  }, history, '继续');
  await h.run('design_review', { action: 'submit', proposal: proposal('session:deployment-form') });
  assert.equal(await h.call(), undefined);
});

test('session evidence cannot reference another branch or an assistant assertion', async () => {
  const h = await harness(undefined, timeoutHistory);
  for (const id of ['session:another-branch', 'session:deploy-question']) {
    await assert.rejects(h.run('design_review', { action: 'submit', proposal: proposal(id) }), /找不到插件记录/);
  }
});

test('request history supports paging and searches older decisions without copying it into state', async () => {
  const history = Array.from({ length: 60 }, (_, i) => historyUser(`old-${i}`, `历史问题${i}的决定`));
  const h = await harness(undefined, history);
  const page = JSON.parse((await h.run('design_context', { offset: 0, limit: 2 })).content[0].text);
  assert.equal(page.totalRequests, 61);
  assert.equal(page.requests[0].id, 'session:old-0');
  assert.equal(page.nextOffset, 2);
  const search = JSON.parse((await h.run('design_context', { query: '历史问题3的决定' })).content[0].text);
  assert.equal(search.requests[0].id, 'session:old-3');
  assert.equal(h.current().requests.length, 1);
});
