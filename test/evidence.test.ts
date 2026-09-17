import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvidence } from '../src/context.ts';
import { initialState } from '../src/state.ts';
import type { Evidence, Proposal } from '../src/schema.ts';

async function fixture(text: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-evidence-'));
  await writeFile(join(cwd, 'source.txt'), text);
  return (range: Partial<Evidence> = {}) => {
    const evidence = { kind: 'file', reference: 'source.txt', ...range };
    const proposal: Proposal = { goal: 'test', acceptance: ['test'], changes: ['test'], evidence: [evidence], mechanisms: [] };
    return readEvidence(cwd, proposal, initialState());
  };
}

test('whole file, start-only, end-only and explicit ranges return actual line metadata', async () => {
  const read = await fixture('one\ntwo\nthree\n');
  const whole = (await read())[0];
  assert.equal(whole.content, 'one\ntwo\nthree\n');
  assert.deepEqual(whole.actualRange, { startLine: 1, endLine: 3, totalLines: 3 });
  assert.equal((await read({ startLine: 2 }))[0].content, 'two\nthree\n');
  assert.equal((await read({ endLine: 2 }))[0].content, 'one\ntwo');
  const clipped = (await read({ startLine: 2, endLine: 500 }))[0];
  assert.equal(clipped.content, 'two\nthree');
  assert.equal(clipped.reference.endLine, 500);
  assert.deepEqual(clipped.actualRange, { startLine: 2, endLine: 3, totalLines: 3 });
});

test('invalid ranges identify the file, submitted bounds and real line count', async () => {
  const read = await fixture('one\ntwo\n');
  for (const range of [{ startLine: 3 }, { startLine: 2, endLine: 1 }, { startLine: 0 }, { endLine: 0 }]) {
    await assert.rejects(read(range), /source.txt.*请求范围.*实际共 2 行/);
  }
});

test('empty files and files without a trailing newline have accurate ranges', async () => {
  const empty = await fixture('');
  assert.deepEqual((await empty())[0].actualRange, { startLine: 0, endLine: 0, totalLines: 0 });
  await assert.rejects(empty({ startLine: 1 }), /实际共 0 行/);
  const read = await fixture('one');
  assert.equal((await read())[0].content, 'one');
  assert.equal((await read())[0].actualRange?.totalLines, 1);
});

test('more than 201 lines and small excerpts of files larger than 1MB are supported', async () => {
  const read = await fixture('line\n'.repeat(300));
  assert.equal((await read({ startLine: 1, endLine: 300 }))[0].actualRange?.endLine, 300);
  const large = await fixture('excerpt\n' + 'x'.repeat(1_100_000));
  assert.equal((await large({ startLine: 1, endLine: 1 }))[0].content, 'excerpt');
  await assert.rejects(large(), /source.txt.*剩余 80000 字节.*未截断/);
});

test('evidence budget measures UTF-8 bytes and accounts for previous references', async () => {
  const read = await fixture('中'.repeat(26_666) + 'aa');
  assert.equal(Buffer.byteLength((await read())[0].content), 80_000);
  const over = await fixture('中'.repeat(26_667));
  await assert.rejects(over(), /80001 字节/);
  const cwd = await mkdtemp(join(tmpdir(), 'pi-evidence-budget-'));
  await writeFile(join(cwd, 'a'), 'a'.repeat(40_000));
  await writeFile(join(cwd, 'b'), 'b'.repeat(40_001));
  const p: Proposal = { goal: 'test', acceptance: ['test'], changes: ['test'], mechanisms: [],
    evidence: [{ kind: 'file', reference: 'a' }, { kind: 'file', reference: 'b' }] };
  await assert.rejects(readEvidence(cwd, p, initialState()), /证据 b.*40001 字节.*剩余 40000 字节/);
});
