import assert from 'node:assert/strict';
import test from 'node:test';
import { GateState, STATE_ENTRY, initialState } from '../src/state.ts';
import type { Answer, State } from '../src/state.ts';
import type { Proposal, Review } from '../src/schema.ts';

const proposal = (requestId: string): Proposal => ({
  goal: 'Keep implementation gated until reviewed',
  acceptance: ['Only the current review can grant permission'],
  changes: ['Check the review epoch'],
  evidence: [{ kind: 'request', reference: requestId }],
  mechanisms: [],
});
const ready = (): Review => ({ verdict: 'ready', reason: 'Evidence supports the plan', findings: [], questions: [] });
const ask = (): Review => ({
  verdict: 'ask_user', reason: 'Choose the scope', findings: [],
  questions: [{ id: 'scope', question: 'Which scope?', options: ['Small', 'Large'], recommendation: 'Small' }],
});
const answer = (version: number): Answer => ({ proposalVersion: version, question: 'Which scope?', answer: 'Small' });
const entry = (state: State) => ({ type: 'custom', customType: STATE_ENTRY, data: state });
function fixture() {
  const persisted: State[] = [];
  const gate = new GateState(state => persisted.push(structuredClone(state)));
  gate.request('Require a design review', 'interactive');
  const plan = proposal(gate.value.requests[0]!.id);
  return { gate, persisted, plan };
}

for (const invalidation of ['request', 'begin', 'restore'] as const) {
  test(`a delayed ready review cannot grant permission after ${invalidation}`, async () => {
    const { gate, persisted, plan } = fixture();
    const oldEpoch = gate.begin(plan);
    let resolve!: (review: Review) => void;
    const pending = new Promise<Review>(done => { resolve = done; });
    const completion = pending.then(review => gate.finish(oldEpoch, review));
    if (invalidation === 'request') gate.request('Also handle branch changes', 'rpc');
    if (invalidation === 'begin') gate.begin({ ...plan, goal: 'Review the newer plan' });
    if (invalidation === 'restore') gate.restore([entry(initialState())]);
    const before = structuredClone(gate.value);
    const writes = persisted.length;
    resolve(ready());
    assert.equal(await completion, false);
    assert.deepEqual(gate.value, before);
    assert.equal(persisted.length, writes, 'stale completion must not be persisted');
    assert.notEqual(gate.value.status, 'ready');
  });
}

test('new user input revokes ready while retaining prior answers and request history', () => {
  const { gate, plan, persisted } = fixture();
  assert.equal(gate.finish(gate.begin(plan), ask()), true);
  const response = answer(gate.value.version);
  assert.equal(gate.answer(gate.epoch, [response]), true);
  assert.equal(gate.finish(gate.begin(plan), ready()), true);
  const version = gate.value.version;
  const epoch = gate.epoch;
  const firstRequest = structuredClone(gate.value.requests[0]);
  gate.request('Include the RPC input path', 'rpc');
  assert.equal(gate.value.status, 'investigate');
  assert.equal(gate.value.version, version + 1);
  assert.ok(gate.epoch > epoch);
  assert.deepEqual(gate.value.answers, [response]);
  assert.deepEqual(gate.value.requests[0], firstRequest);
  assert.equal(gate.value.requests[1]!.source, 'rpc');
  assert.equal(gate.value.requests[1]!.text, 'Include the RPC input path');
  assert.notEqual(gate.value.requests[1]!.id, firstRequest!.id);
  assert.deepEqual(persisted.at(-1), gate.value);
});

test('restore selects the latest state on the supplied branch and does not carry state across branches', () => {
  const { gate, plan, persisted } = fixture();
  const ancestor = structuredClone(gate.value);
  gate.request('Branch A only', 'interactive');
  const branchA = structuredClone(gate.value);
  const branchB: State = { ...ancestor, version: 9, answers: [answer(8)], dirty: true };
  gate.begin(plan);
  const writes = persisted.length;
  gate.restore([entry(ancestor), entry(branchA)]);
  assert.deepEqual(gate.value, branchA);
  gate.restore([
    entry(ancestor),
    entry(branchB),
    { type: 'message', customType: STATE_ENTRY, data: branchA },
    { type: 'custom', customType: 'another-extension/state', data: branchA },
  ]);
  assert.deepEqual(gate.value, branchB);
  assert.equal(persisted.length, writes, 'reading a branch must not append state entries');
  branchB.answers[0]!.answer = 'Changed outside the gate';
  assert.equal(gate.value.answers[0]!.answer, 'Small', 'restored evidence must be cloned');
  gate.restore([]);
  assert.deepEqual(gate.value, initialState());
});

for (const status of ['reviewing', 'ready'] as const) {
  test(`restore retains evidence but does not restore ${status} permission`, () => {
    const { gate, plan, persisted } = fixture();
    const snapshot: State = {
      ...gate.value, version: 7, status, proposal: plan,
      review: status === 'ready' ? ready() : undefined,
      answers: [answer(6)], dirty: true,
    };
    const epoch = gate.epoch;
    const writes = persisted.length;
    gate.restore([entry(snapshot)]);
    assert.deepEqual(gate.value, { ...snapshot, status: 'investigate' });
    assert.ok(gate.epoch > epoch);
    assert.equal(snapshot.status, status, 'restore must not mutate branch history');
    assert.equal(persisted.length, writes);
  });
}

test('answers bind to the post-review epoch, are consumed once, and require ask_user', () => {
  const { gate, plan, persisted } = fixture();
  const reviewEpoch = gate.begin(plan);
  assert.equal(gate.finish(reviewEpoch, ask()), true);
  const response = answer(gate.value.version);
  const writes = persisted.length;
  assert.equal(gate.answer(reviewEpoch, [response]), false, 'the completed review epoch is stale');
  assert.equal(persisted.length, writes);
  const answerEpoch = gate.epoch;
  assert.equal(gate.answer(answerEpoch, [response]), true);
  assert.equal(gate.value.status, 'investigate');
  assert.deepEqual(gate.value.answers, [response]);
  assert.equal(gate.answer(answerEpoch, [response]), false, 'a duplicate UI response is stale');
  assert.equal(gate.answer(gate.epoch, [response]), false, 'investigate does not accept answers');
  assert.deepEqual(gate.value.answers, [response]);
});

for (const invalidation of ['request', 'begin', 'restore'] as const) {
  test(`an outstanding answer cannot change the state after ${invalidation}`, () => {
    const { gate, plan, persisted } = fixture();
    gate.finish(gate.begin(plan), ask());
    const epoch = gate.epoch;
    const response = answer(gate.value.version);
    if (invalidation === 'request') gate.request('Updated scope', 'interactive');
    if (invalidation === 'begin') gate.finish(gate.begin(plan), ask());
    if (invalidation === 'restore') gate.restore([entry(structuredClone(gate.value))]);
    const before = structuredClone(gate.value);
    const writes = persisted.length;
    assert.equal(gate.answer(epoch, [response]), false);
    assert.deepEqual(gate.value, before);
    assert.equal(persisted.length, writes);
  });
}

for (const cleanBeforeFinish of [false, true]) {
  test(`dirty bookkeeping preserves a concurrent review epoch (clean=${cleanBeforeFinish})`, async () => {
    const { gate, plan, persisted } = fixture();
    const epoch = gate.begin(plan);
    const version = gate.value.version;
    const completion = Promise.resolve().then(() => gate.finish(epoch, ready()));
    gate.markDirty();
    assert.equal(gate.value.dirty, true);
    assert.equal(persisted.at(-1)!.dirty, true);
    if (cleanBeforeFinish) gate.clean();
    assert.equal(gate.epoch, epoch);
    assert.equal(gate.value.version, version);
    assert.equal(await completion, true);
    assert.equal(gate.value.status, 'ready');
    assert.equal(gate.value.dirty, !cleanBeforeFinish);
    assert.deepEqual(persisted.at(-1), gate.value);
  });
}

test('a stale failure cannot overwrite a newer successful review', () => {
  const { gate, plan, persisted } = fixture();
  const oldEpoch = gate.begin(plan);
  gate.finish(gate.begin(plan), ready());
  const before = structuredClone(gate.value);
  const writes = persisted.length;
  gate.fail(oldEpoch, 'Old reviewer timed out');
  assert.deepEqual(gate.value, before);
  assert.equal(persisted.length, writes);
});
