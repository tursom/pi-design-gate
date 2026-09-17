import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { projectPath, workspaceReference, workspaceSnapshot } from './context.ts';
import type { RepositoryBaseline } from './state.ts';

export async function repositoryRoot(pi: ExtensionAPI, ctx: ExtensionContext, path: string, signal?: AbortSignal): Promise<string> {
  // The selected directory must be in the session project. rev-parse also
  // supports nested working directories, submodules and .git worktree files.
  const selected = await projectPath(ctx.cwd, path);
  if (!(await stat(selected)).isDirectory()) throw new Error(`工作仓库路径不是目录：${path}`);
  const result = await pi.exec('git', ['--no-optional-locks', '-C', selected, 'rev-parse', '--show-toplevel'], { cwd: ctx.cwd, timeout: 10_000, signal });
  if (result.code !== 0 || result.killed) throw new Error(`路径 ${path} 不在Git工作仓库中；请在方案 repositories 中指定实际仓库，查询使用 design_inspect.path。`);
  const root = await realpath(result.stdout.trim());
  if (!contains(root, selected)) throw new Error('Git工作仓库根目录与选定路径不一致。');
  return root;
}

export function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function resolveRepositories(pi: ExtensionAPI, ctx: ExtensionContext, paths: string[] = ['.'], signal?: AbortSignal): Promise<string[]> {
  const roots = new Set<string>();
  for (const path of paths) roots.add(await repositoryRoot(pi, ctx, path, signal));
  return [...roots].sort();
}

export async function repositoryBaselines(pi: ExtensionAPI, ctx: ExtensionContext, roots: string[], previous: RepositoryBaseline[] = [], signal?: AbortSignal): Promise<RepositoryBaseline[]> {
  // Retain unfinished baselines even when a revised proposal omits a repository.
  const baselines = [...previous];
  for (const root of roots) {
    if (baselines.some(b => b.root === root)) continue;
    const repoCtx = { ...ctx, cwd: root };
    const baselineRef = await workspaceReference(pi, repoCtx, signal);
    baselines.push({ root, baselineRef, baseline: await workspaceSnapshot(pi, repoCtx, signal, baselineRef) });
  }
  return baselines;
}

export async function repositoryChanges(pi: ExtensionAPI, ctx: ExtensionContext, baselines: RepositoryBaseline[], signal?: AbortSignal) {
  const changes = [];
  for (const b of baselines) changes.push({ ...b, current: await workspaceSnapshot(pi, { ...ctx, cwd: b.root }, signal, b.baselineRef) });
  return changes;
}

export async function checkWriteRepository(pi: ExtensionAPI, ctx: ExtensionContext, path: string, roots: string[]): Promise<void> {
  const target = await projectPath(ctx.cwd, path);
  let parent = dirname(target);
  while (true) {
    try { await stat(parent); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw error;
      parent = dirname(parent);
    }
  }
  const root = await repositoryRoot(pi, ctx, parent);
  if (!roots.includes(root)) throw new Error('目标文件不在本次方案声明的工作仓库中；请补充 repositories 后重新提交方案。');
}
