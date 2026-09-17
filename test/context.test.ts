import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workspaceReference, workspaceSnapshot, projectPath } from '../src/context.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const exec = promisify(execFile);
async function repo() {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-design-snapshot-'));
  await exec('git', ['init', '-q', cwd]);
  const ctx = { cwd } as ExtensionContext;
  const pi = { exec: async (cmd: string, args: string[]) => {
    try { return { ...await exec(cmd, args, { cwd }), code: 0, killed: false }; }
    catch (e: any) { return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code, killed: false }; }
  } } as unknown as ExtensionAPI;
  const commit = async () => {
    await exec('git', ['add', '.'], { cwd });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test'], { cwd });
  };
  return { cwd, ctx, pi, commit };
}

test('a commit during implementation cannot erase the changes seen by final audit', async () => {
  const h = await repo();
  await writeFile(join(h.cwd, 'app.txt'), 'baseline\n');
  await h.commit();
  const ref = await workspaceReference(h.pi, h.ctx);
  const initial = await workspaceSnapshot(h.pi, h.ctx, undefined, ref);
  assert.equal(initial, '');
  await writeFile(join(h.cwd, 'app.txt'), 'new behavior\n');
  await h.commit();
  assert.equal(await workspaceSnapshot(h.pi, h.ctx), '', 'ordinary HEAD diff is now clean');
  assert.match(await workspaceSnapshot(h.pi, h.ctx, undefined, ref), /new behavior/);
});

test('an initially empty repository retains its baseline across the first commit', async () => {
  const h = await repo();
  const ref = await workspaceReference(h.pi, h.ctx);
  await writeFile(join(h.cwd, 'app.txt'), 'first implementation\n');
  await h.commit();
  assert.match(await workspaceSnapshot(h.pi, h.ctx, undefined, ref), /first implementation/);
});

test('an oversized or binary untracked file fails closed rather than approving a truncated diff', async () => {
  const h = await repo();
  await writeFile(join(h.cwd, 'binary'), Buffer.from([1, 0, 2]));
  await assert.rejects(workspaceSnapshot(h.pi, h.ctx), /二进制/);
  await writeFile(join(h.cwd, 'binary'), 'a'.repeat(100_001));
  await assert.rejects(workspaceSnapshot(h.pi, h.ctx), /过大/);
});

test('nonexistent files resolve to their actual in-project parent', async () => {
  const h = await repo();
  assert.equal(await projectPath(h.cwd, 'a/b/c.txt'), join(h.cwd, 'a/b/c.txt'));
});
