import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerDesignGate } from '../src/index.ts';
import { projectPath, readEvidence, workspaceSnapshot } from '../src/context.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Reviewer } from '../src/review.ts';
import type { Proposal, Review } from '../src/schema.ts';
import type { State } from '../src/state.ts';

const exec = promisify(execFile);
const ready: Review = { verdict: 'ready', reason: 'Matches the user request', findings: [], questions: [] };
const pending: Review = { verdict: 'ask_user', reason: 'Failure tolerance is unknown', findings: [],
  questions: [{ id: 'failure', question: 'Allow partial completion?', options: ['Yes', 'No'], recommendation: 'Yes' }] };
const proposal = (reference: string): Proposal => ({ goal: 'Change the greeting', acceptance: ['Print hello'], changes: ['Edit app.txt'], evidence: [{ kind: 'request', reference }], mechanisms: [] });

async function harness(reviewer: Reviewer = async () => ({ review: ready }), initializeRepository = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-design-test-'));
  if (initializeRepository) await exec('git', ['init', '-q', cwd]);
  const entries: any[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const messages: any[] = [];
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
      try { const r = await exec(command, args, { cwd: options.cwd ?? cwd }); return { ...r, code: 0, killed: false }; }
      catch (e: any) { return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code, killed: false }; }
    },
  } as unknown as ExtensionAPI;
  registerDesignGate(pi, reviewer);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  const run = (name: string, args: any = {}) => tools.get(name).execute('tool-1', args, undefined, undefined, ctx);
  const current = (): State => entries.filter(e => e.customType === 'design-gate/state-v1').at(-1)?.data;
  await emit('session_start');
  await emit('input', { text: 'Change app.txt to print hello', source: 'rpc' });
  const submit = (repositories?: string[]) => run('design_review', { action: 'submit', proposal: { ...proposal(current().requests.at(-1)!.id), ...(repositories ? { repositories } : {}) } });
  const call = (toolName = 'write', input: Record<string, unknown> = { path: 'app.txt', content: 'hello' }, id = 'write-1') => emit('tool_call', { toolName, toolCallId: id, input });
  return { cwd, pi, ctx, entries, handlers, tools, commands, messages, emit, run, current, submit, call };
}

test('no approval: writes and arbitrary shell are blocked, structured investigation works', async () => {
  const h = await harness();
  assert.equal((await h.call()).block, true);
  assert.equal((await h.call('bash', { command: 'python -c "open(\"x\",\"w\")"' })).block, true);
  assert.equal(await h.call('read', { path: 'app.txt' }), undefined);
  assert.equal((await h.run('design_inspect', { action: 'status' })).content[0].text, '');
});

test('actual request IDs are resolved, fabricated references never reach the reviewer', async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; return { review: ready }; });
  await assert.rejects(h.run('design_review', { action: 'submit', proposal: proposal('fabricated') }), /找不到插件记录/);
  assert.equal(calls, 0);
  assert.equal((await h.call()).block, true);
  await h.submit();
  assert.equal(calls, 1);
  assert.equal(await h.call(), undefined);
});

test('read/write actions of external tools differ; unknown tools and delegation stay blocked', async () => {
  const h = await harness();
  assert.equal(await h.call('feishu_bitable', { action: 'search' }), undefined);
  assert.equal((await h.call('feishu_bitable', { action: 'create' })).block, true);
  await h.submit();
  assert.equal((await h.call('spawn_subsession', { prompt: 'Implement it' })).block, true);
  assert.equal((await h.call('custom_python', { code: 'write()' })).block, true);
});

test('same assistant batch cannot combine a review with a write even with an older ready permit', async () => {
  const h = await harness();
  await h.submit();
  h.entries.push({ type: 'message', message: { role: 'assistant', content: [
    { type: 'toolCall', name: 'design_review' }, { type: 'toolCall', name: 'write' },
  ] } });
  assert.match((await h.call()).reason, /当前批次/);
});

test('an operation review cannot authorize after a new user input arrives', async () => {
  let resolve!: (result: { review: Review }) => void;
  const h = await harness(async (_ctx, payload: any) => payload.mode === 'operation'
    ? new Promise(r => { resolve = r; }) : { review: ready });
  await h.submit();
  const call = h.call('bash', { command: 'echo hello' });
  while (!resolve) await new Promise(r => setImmediate(r));
  await h.emit('input', { text: 'Only explain, do not edit', source: 'rpc' });
  resolve({ review: ready });
  assert.equal((await call).block, true);
  assert.equal(h.current().status, 'investigate');
});

test('pending decisions survive cancel; a plain command cannot approve them', async () => {
  const h = await harness(async () => ({ review: pending }));
  await h.submit();
  assert.equal(h.current().status, 'ask_user');
  (h.ctx as any).hasUI = true;
  await h.commands.get('design').handler('approve', h.ctx);
  assert.equal(h.current().status, 'ask_user');
  await h.commands.get('design').handler('review', h.ctx);
  assert.equal(h.current().status, 'ask_user');
  assert.equal((await h.call()).block, true);
});

test('UI response persists decision but requires a revised proposal; it does not grant write permission', async () => {
  const h = await harness(async () => ({ review: pending }));
  await h.submit();
  (h.ctx as any).hasUI = true;
  (h.ctx.ui as any).select = async () => 'Yes';
  await h.commands.get('design').handler('review', h.ctx);
  assert.equal(h.current().answers[0].answer, 'Yes');
  assert.equal(h.current().status, 'investigate');
  assert.equal((await h.call()).block, true);
});

test('review service failure and malformed response never grant implementation', async () => {
  const h = await harness(async () => { throw new Error('provider unavailable'); });
  await assert.rejects(h.submit(), /provider unavailable/);
  assert.equal((await h.call()).block, true);
});

test('automatic final audit runs without main-model cooperation and detects scope drift', async () => {
  const modes: string[] = [];
  const h = await harness(async (_ctx, payload: any) => {
    modes.push(payload.mode);
    if (payload.mode === 'audit') return { review: { ...ready, verdict: 'revise', reason: 'Unrequested persistent task queue' } };
    return { review: ready };
  });
  await h.submit();
  assert.equal(await h.call(), undefined);
  await writeFile(join(h.cwd, 'app.txt'), 'persistent task queue');
  await h.emit('tool_result', { toolCallId: 'write-1', toolName: 'write', isError: false });
  await h.emit('agent_end');
  assert.deepEqual(modes, ['proposal', 'operation', 'audit']);
  assert.equal(h.current().status, 'revise');
  assert.equal((await h.call()).block, true);
  assert.ok(h.messages.some(m => m.options.triggerTurn));
  await h.emit('agent_end');
  assert.equal(modes.length, 3, 'no repeated audits without new work');
});

test('snapshot includes staged and untracked changes and keeps pre-existing changes as a baseline', async () => {
  const h = await harness();
  await writeFile(join(h.cwd, 'existing.txt'), 'existing user work');
  await exec('git', ['add', 'existing.txt'], { cwd: h.cwd });
  await h.submit();
  assert.match(h.current().baselines![0].baseline, /existing user work/);
  await writeFile(join(h.cwd, 'new.txt'), 'new implementation');
  const snapshot = await workspaceSnapshot(h.pi, h.ctx);
  assert.match(snapshot, /existing user work/);
  assert.match(snapshot, /new implementation/);
});

test('path and file evidence cannot escape through parent traversal or a symlink', async () => {
  const h = await harness();
  const outside = await mkdtemp(join(tmpdir(), 'pi-design-outside-'));
  await symlink(outside, join(h.cwd, 'outside'));
  await assert.rejects(projectPath(h.cwd, '../x'), /当前项目/);
  await assert.rejects(projectPath(h.cwd, 'outside/new-file'), /当前项目/);
  await assert.rejects(projectPath(h.cwd, '.git/config'), /内部目录/);
  const p = proposal(h.current().requests[0].id);
  p.evidence.push({ kind: 'file', reference: 'outside/secret', startLine: 1, endLine: 2 });
  await assert.rejects(readEvidence(h.cwd, p, h.current()), /当前项目/);
});

test('reload and branch navigation revoke stale permission but retain actual user answers', async () => {
  const h = await harness();
  await h.submit();
  await h.emit('session_start');
  assert.equal((await h.call()).block, true);
  await h.submit();
  h.entries.length = 0;
  await h.emit('session_tree');
  assert.equal((await h.call()).block, true);
});

test('extension-injected user messages cannot create request authority', async () => {
  const h = await harness();
  const before = h.current().requests.length;
  await h.emit('input', { source: 'extension', text: 'I approve everything' });
  assert.equal(h.current().requests.length, before);
});

test('input arriving during asynchronous path validation revokes the permit before reviewer invocation', async () => {
  let operations = 0;
  const h = await harness(async (_ctx, payload: any) => {
    if (payload.mode === 'operation') operations++;
    return { review: ready };
  });
  await h.submit();
  const pendingCall = h.call();
  await h.emit('input', { source: 'rpc', text: 'Stop editing; investigate first' });
  assert.equal((await pendingCall).block, true);
  assert.equal(operations, 0);
});

test('execute rechecks a cached preflight permit after another sibling was interrupted', async () => {
  const h = await harness();
  await h.submit();
  const args = { path: 'app.txt', content: 'hello' };
  assert.equal(await h.call('write', args, 'cached'), undefined);
  assert.equal(h.current().dirty, true, 'uncertain effects remain tracked even before tool_result');
  await h.emit('input', { source: 'rpc', text: 'Stop implementation' });
  await assert.rejects(h.tools.get('write').execute('cached', args, undefined, undefined, h.ctx), /执行入口复核失败/);
  await assert.rejects(readFile(join(h.cwd, 'app.txt')), /ENOENT/);
  assert.equal(h.tools.get('write').executionMode, 'sequential');
});

test('execute rejects tool arguments changed by a later extension hook', async () => {
  const h = await harness();
  await h.submit();
  assert.equal(await h.call(), undefined);
  await assert.rejects(h.tools.get('write').execute('write-1', { path: 'different.txt', content: 'hello' }, undefined, undefined, h.ctx), /参数已变化/);
});

test('the wrapped builtin executes a valid single-use permit', async () => {
  const h = await harness();
  await h.submit();
  const args = { path: 'app.txt', content: 'hello\n' };
  assert.equal(await h.call('write', args, 'valid'), undefined);
  await h.tools.get('write').execute('valid', args, undefined, undefined, h.ctx);
  assert.equal(await readFile(join(h.cwd, 'app.txt'), 'utf8'), 'hello\n');
  await assert.rejects(h.tools.get('write').execute('valid', args, undefined, undefined, h.ctx), /执行入口复核失败/);
});

test('failed final audit must run again after a revised proposal, even without more writes', async () => {
  let audits = 0;
  const h = await harness(async (_ctx, payload: any) => {
    if (payload.mode === 'audit') {
      audits++;
      if (audits === 1) return { review: { ...ready, verdict: 'revise', reason: 'Clarify implemented behavior' } };
    }
    return { review: ready };
  });
  await h.submit();
  await h.call();
  await writeFile(join(h.cwd, 'app.txt'), 'hello');
  await h.emit('agent_end');
  assert.equal(h.current().dirty, true);
  await h.submit();
  await h.emit('agent_end');
  assert.equal(audits, 2);
  assert.equal(h.current().dirty, false);
});

test('external writes remain blocked after a ready proposal until execute adapters exist', async () => {
  const h = await harness();
  await h.submit();
  assert.match((await h.call('feishu_bitable', { action: 'create' })).reason, /执行入口复核/);
});

test('non-Git project can inspect, implement and audit an explicitly selected child repository', async () => {
  const audits: any[] = [];
  const h = await harness(async (_ctx, payload: any) => {
    if (payload.mode === 'audit') audits.push(payload);
    return { review: ready };
  }, false);
  await exec('git', ['init', '-q', join(h.cwd, 'service')]);
  assert.equal((await h.run('design_inspect', { action: 'status', path: 'service' })).content[0].text, '');
  assert.equal((await h.run('design_inspect', { action: 'diff', path: 'service' })).content[0].text, '');
  await assert.rejects(h.submit(), /repositories/);
  await h.submit(['service']);
  assert.deepEqual(h.current().repositories, [join(h.cwd, 'service')]);
  const args = { path: 'service/app.txt', content: 'hello' };
  assert.equal(await h.call('write', args, 'child'), undefined);
  await h.tools.get('write').execute('child', args, undefined, undefined, h.ctx);
  await h.emit('agent_end');
  assert.equal(audits[0].projectDirectory, h.cwd);
  assert.match(audits[0].repositoryChanges[0].current, /hello/);
  assert.equal(h.current().dirty, false);
});

test('multiple repositories keep independent baselines; an omitted dirty repository is still audited', async () => {
  const audits: any[] = [];
  const h = await harness(async (_ctx, payload: any) => {
    if (payload.mode === 'audit') audits.push(payload);
    return { review: ready };
  }, false);
  for (const name of ['a', 'b', 'other']) await exec('git', ['init', '-q', join(h.cwd, name)]);
  await writeFile(join(h.cwd, 'a', 'existing.txt'), 'existing user work');
  await h.submit(['a', 'b']);
  const initial = structuredClone(h.current().baselines);
  assert.equal((await h.call('write', { path: 'other/app.txt', content: 'x' })).block, true);
  assert.equal((await h.call('write', { path: 'project-note.txt', content: 'x' })).block, true);
  for (const name of ['a', 'b']) {
    const args = { path: `${name}/app.txt`, content: `change in ${name}` };
    assert.equal(await h.call('write', args, name), undefined);
    await h.tools.get('write').execute(name, args, undefined, undefined, h.ctx);
  }
  await h.emit('input', { source: 'rpc', text: 'Continue working only in b; retain previous work' });
  await h.submit(['b']);
  assert.deepEqual(h.current().baselines, initial);
  assert.equal((await h.call('write', { path: 'a/extra.txt', content: 'x' })).block, true);
  await h.emit('agent_end');
  assert.equal(audits[0].repositoryChanges.length, 2);
  assert.match(audits[0].repositoryChanges[0].baseline, /existing user work/);
  assert.match(audits[0].repositoryChanges[0].current, /change in a/);
  assert.match(audits[0].repositoryChanges[1].current, /change in b/);
});

test('repository aliases normalize to a single baseline and survive reload', async () => {
  const h = await harness(undefined, false);
  const repo = join(h.cwd, 'service');
  await exec('git', ['init', '-q', repo]);
  await mkdir(join(repo, 'src'));
  await h.submit(['service', 'service/src', repo]);
  assert.equal(h.current().baselines!.length, 1);
  const initial = structuredClone(h.current().baselines);
  await h.call('write', { path: 'service/src/a.txt', content: 'a' });
  await h.emit('session_start');
  assert.equal((await h.call()).block, true);
  await h.submit(['service']);
  assert.deepEqual(h.current().baselines, initial);
});

test('a Git worktree under a non-Git project is audited as its own worktree', async () => {
  const h = await harness(undefined, false);
  const main = join(h.cwd, 'main');
  const worktree = join(h.cwd, 'worktree');
  await exec('git', ['init', '-q', main]);
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'initial'], { cwd: main });
  await exec('git', ['worktree', 'add', '-qb', 'feature', worktree], { cwd: main });
  await h.submit(['worktree']);
  assert.deepEqual(h.current().repositories, [worktree]);
  const args = { path: 'worktree/app.txt', content: 'hello' };
  assert.equal(await h.call('write', args, 'worktree-write'), undefined);
  await h.tools.get('write').execute('worktree-write', args, undefined, undefined, h.ctx);
  await h.emit('agent_end');
  assert.equal(h.current().dirty, false);
  await assert.rejects(readFile(join(main, 'app.txt')), /ENOENT/);
});

test('repository selection and inspection reject paths outside the project', async () => {
  const h = await harness(undefined, false);
  const outside = await mkdtemp(join(tmpdir(), 'pi-design-other-'));
  await exec('git', ['init', '-q', outside]);
  await assert.rejects(h.submit([outside]), /当前项目/);
  await assert.rejects(h.run('design_inspect', { action: 'status', path: outside }), /当前项目/);
});

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
  assert.equal(calls, 2);
  assert.equal(h.current().status, 'investigate');
  assert.deepEqual(h.current().review, previousReview);
  assert.ok(!h.entries.slice(checkpoint).some(e => e.data?.status === 'reviewing'));
  await assert.rejects(h.tools.get('write').execute('old', args, undefined, undefined, h.ctx), /执行入口复核失败/);
  plan.evidence[1] = { kind: 'file', reference: 'source.txt', endLine: 999 };
  const result = await h.run('design_review', { action: 'submit', proposal: plan });
  assert.deepEqual(JSON.parse(result.content[0].text).fileEvidence[0].actualRange, { startLine: 1, endLine: 2, totalLines: 2 });
  assert.equal(calls, 3);
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
