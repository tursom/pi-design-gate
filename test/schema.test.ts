import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReview, validateProposal } from '../src/schema.ts';
import type { Proposal, Review } from '../src/schema.ts';

const question = () => ({
  id: 'scope', question: 'Which scope should be implemented?',
  options: ['Minimal', 'Extended'], recommendation: 'Minimal',
});
const review = (): Review => ({ verdict: 'ready', reason: 'The plan meets the request', findings: [], questions: [] });
const proposal = (): Proposal => ({
  goal: 'Review changes before implementation',
  acceptance: ['A stale review cannot allow implementation'],
  changes: ['Bind review completion to the current epoch'],
  evidence: [{ kind: 'request', reference: 'request-123' }],
  mechanisms: [{
    name: 'Review epoch', purpose: 'Reject stale asynchronous results',
    evidence: [{ kind: 'file', reference: 'src/state.ts', startLine: 1, endLine: 10 }],
    failureCost: 'An old review could approve a changed request',
    responsibility: 'GateState', simplestAlternative: 'A boolean permission flag',
    whyAlternativeInsufficient: 'A flag cannot identify which review completed', uncertainty: null,
  }],
});

for (const verdict of ['ready', 'revise', 'investigate', 'ask_user'] as const) {
  test(`parseReview accepts a valid ${verdict} review`, () => {
    const value: Review = { ...review(), verdict, questions: verdict === 'ask_user' ? [question()] : [] };
    assert.deepEqual(parseReview(JSON.stringify(value)), value);
  });
}

for (const fence of ['json', '']) {
  test(`parseReview accepts a complete ${fence || 'unlabelled'} fenced JSON response`, () => {
    const value = review();
    assert.deepEqual(parseReview(` \n\`\`\`${fence}\n${JSON.stringify(value, null, 2)}\n\`\`\`\n `), value);
  });
}

for (const text of ['', '   ', '{', '{"verdict":ready}', `${JSON.stringify(review())} trailing prose`, '```json\n{}']) {
  test(`parseReview rejects invalid JSON: ${JSON.stringify(text)}`, () => {
    assert.throws(() => parseReview(text), SyntaxError);
  });
}

for (const field of ['verdict', 'reason', 'findings', 'questions'] as const) {
  test(`parseReview rejects a missing ${field}`, () => {
    const value: Record<string, unknown> = { ...review() };
    delete value[field];
    assert.throws(() => parseReview(JSON.stringify(value)), /结构化结果/);
  });
}

for (const value of [null, [], 'ready', { ...review(), verdict: 'approved' }, { ...review(), reason: ' \n ' }, { ...review(), extra: true }]) {
  test(`parseReview rejects an invalid review shape: ${JSON.stringify(value)}`, () => {
    assert.throws(() => parseReview(JSON.stringify(value)), /结构化结果/);
  });
}

test('ask_user requires at least one question', () => {
  assert.throws(() => parseReview(JSON.stringify({ ...review(), verdict: 'ask_user' })), /决策与待确认问题不一致/);
});

for (const verdict of ['ready', 'revise', 'investigate']) {
  test(`${verdict} cannot carry questions`, () => {
    assert.throws(() => parseReview(JSON.stringify({ ...review(), verdict, questions: [question()] })), /决策与待确认问题不一致/);
  });
}

test('question IDs must be unique even when the question texts differ', () => {
  const questions = [question(), { ...question(), question: 'What is the delivery scope?' }];
  assert.throws(() => parseReview(JSON.stringify({ ...review(), verdict: 'ask_user', questions })), /问题或选项重复/);
});

test('options within a question must be unique', () => {
  const questions = [{ ...question(), options: ['Minimal', 'Minimal'] }];
  assert.throws(() => parseReview(JSON.stringify({ ...review(), verdict: 'ask_user', questions })), /问题或选项重复/);
});

test('different questions may reuse option labels', () => {
  const value = { ...review(), verdict: 'ask_user', questions: [question(), { ...question(), id: 'delivery' }] };
  assert.deepEqual(parseReview(JSON.stringify(value)), value);
});

for (const field of ['id', 'question', 'options', 'recommendation']) {
  test(`a review question requires ${field}`, () => {
    const incomplete: Record<string, unknown> = { ...question() };
    delete incomplete[field];
    assert.throws(() => parseReview(JSON.stringify({ ...review(), verdict: 'ask_user', questions: [incomplete] })), /结构化结果/);
  });
}

for (const options of [[], ['Minimal'], ['A', 'B', 'C', 'D', 'E', 'F'], ['Minimal', '  ']]) {
  test(`review options reject invalid cardinality or blank text: ${JSON.stringify(options)}`, () => {
    assert.throws(() => parseReview(JSON.stringify({
      ...review(), verdict: 'ask_user', questions: [{ ...question(), options }],
    })), /结构化结果/);
  });
}

test('validateProposal accepts a complete proposal without modifying its evidence', () => {
  const value = proposal();
  const before = structuredClone(value);
  assert.doesNotThrow(() => validateProposal(value));
  assert.deepEqual(value, before);
});

test('a minimal proposal needs no additional mechanisms', () => {
  assert.doesNotThrow(() => validateProposal({ ...proposal(), mechanisms: [] }));
});

for (const field of ['goal', 'acceptance', 'changes', 'evidence', 'mechanisms']) {
  test(`validateProposal rejects a missing ${field}`, () => {
    const value: Record<string, unknown> = { ...proposal() };
    delete value[field];
    assert.throws(() => validateProposal(value), /方案字段缺失或格式不正确/);
  });
}

for (const field of ['name', 'purpose', 'evidence', 'failureCost', 'responsibility', 'simplestAlternative', 'whyAlternativeInsufficient', 'uncertainty']) {
  test(`a proposal mechanism requires ${field}`, () => {
    const value = proposal();
    const mechanism: Record<string, unknown> = { ...value.mechanisms[0] };
    delete mechanism[field];
    assert.throws(() => validateProposal({ ...value, mechanisms: [mechanism] }), /方案字段缺失或格式不正确/);
  });
}

for (const evidence of [
  [],
  [{ kind: 'request' }],
  [{ kind: 'request', reference: '' }],
  [{ kind: 'request', reference: ' \n ' }],
  [{ kind: 'user', reference: 'request-123' }],
  [{ kind: 'request', reference: 'request-123', startLine: 0 }],
]) {
  test(`validateProposal rejects missing or malformed request evidence: ${JSON.stringify(evidence)}`, () => {
    assert.throws(() => validateProposal({ ...proposal(), evidence }), /方案字段缺失或格式不正确/);
  });
}

test('file evidence alone cannot substitute for a user request reference', () => {
  assert.throws(() => validateProposal({
    ...proposal(), evidence: [{ kind: 'file', reference: 'src/state.ts' }],
  }), /方案必须引用至少一条插件记录的用户请求/);
});

test('mentioning a request ID in prose does not supply request evidence', () => {
  assert.throws(() => validateProposal({
    ...proposal(), goal: 'Implement request-123',
    evidence: [{ kind: 'file', reference: 'request-123' }],
  }), /方案必须引用至少一条插件记录的用户请求/);
});

test('a mechanism request reference does not replace the proposal request reference', () => {
  const value = proposal();
  value.evidence = [{ kind: 'file', reference: 'src/state.ts' }];
  value.mechanisms[0]!.evidence = [{ kind: 'request', reference: 'request-123' }];
  assert.throws(() => validateProposal(value), /方案必须引用至少一条插件记录的用户请求/);
});
