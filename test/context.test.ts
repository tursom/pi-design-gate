import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspect, evidencePath } from '../src/context.ts';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const exec = promisify(execFile);
test('optional Git inspection works for an unborn repository and committed changes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-design-inspect-'));
  await exec('git', ['init', '-q', cwd]);
  const ctx = { cwd } as ExtensionContext;
  const pi = { exec: async (cmd: string, args: string[]) => {
    try { return { ...await exec(cmd, args, { cwd }), code: 0, killed: false }; }
    catch (e: any) { return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code, killed: false }; }
  } } as unknown as ExtensionAPI;
  assert.equal(await inspect(pi, ctx, 'diff'), '');
  await writeFile(join(cwd, 'app.txt'), 'initial\n');
  await exec('git', ['add', '.'], { cwd });
  assert.match(await inspect(pi, ctx, 'diff'), /initial/);
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test'], { cwd });
  await writeFile(join(cwd, 'app.txt'), 'changed\n');
  assert.match(await inspect(pi, ctx, 'diff'), /changed/);
});

test('evidence paths follow session-relative and absolute paths without a project boundary', () => {
  assert.equal(evidencePath('/workspace/session', '../service/a.ts'), '/workspace/service/a.ts');
  assert.equal(evidencePath('/workspace/session', '@/other/a.ts'), '/other/a.ts');
});
