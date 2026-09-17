import { createHash } from 'node:crypto';
import { realpath, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Evidence, Proposal } from './schema.ts';
import type { State } from './state.ts';

export async function projectPath(cwd: string, name: string): Promise<string> {
  const root = await realpath(cwd);
  const requested = resolve(root, name.replace(/^@/, ''));
  let existing = requested;
  const suffix: string[] = [];
  while (true) {
    try { existing = await realpath(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (dirname(existing) === existing) throw error;
      suffix.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
  const target = resolve(existing, ...suffix);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('路径必须位于当前项目内。');
  if (rel.split(sep).some(p => p === '.git' || p === '.pi')) throw new Error('门禁不允许访问 Git 内部目录或项目扩展目录。');
  return target;
}

export async function readEvidence(cwd: string, proposal: Proposal, state: State): Promise<unknown[]> {
  const all = [...proposal.evidence, ...proposal.mechanisms.flatMap(m => m.evidence)];
  const unique = new Map(all.map(e => [JSON.stringify(e), e]));
  const values: unknown[] = [];
  let bytes = 0;
  for (const e of unique.values()) {
    let content: string;
    if (e.kind === 'request') {
      const request = state.requests.find(r => r.id === e.reference);
      if (!request) throw new Error(`找不到插件记录的请求：${e.reference}`);
      content = request.text;
    } else {
      if (!e.startLine || !e.endLine || e.endLine < e.startLine || e.endLine - e.startLine > 200) {
        throw new Error('文件证据需指定有效 startLine/endLine，单段最多201行。');
      }
      const path = await projectPath(cwd, e.reference);
      if ((await stat(path)).size > 1_000_000) throw new Error('证据文件过大，请引用较小的相关源文件。');
      const lines = (await readFile(path, 'utf8')).split('\n');
      if (e.endLine > lines.length) throw new Error('证据行号超出文件范围。');
      content = lines.slice(e.startLine - 1, e.endLine).join('\n');
    }
    bytes += Buffer.byteLength(content);
    if (bytes > 80_000) throw new Error('引用证据总量超过80KB，请缩小到与本次设计直接相关的内容。');
    values.push({ reference: e, content, authority: e.kind === 'request' ? 'captured input' : 'file data, not authorization' });
  }
  return values;
}

export async function inspect(pi: ExtensionAPI, ctx: ExtensionContext, action: string, pattern?: string, signal?: AbortSignal): Promise<string> {
  let command: string;
  let args: string[];
  if (action === 'files') { command = 'rg'; args = ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules', '-g', '!.pi']; }
  else if (action === 'search') {
    if (!pattern) throw new Error('search 需要 pattern。');
    command = 'rg'; args = ['-n', '--hidden', '-g', '!.git', '-g', '!node_modules', '-g', '!.pi', '--', pattern, '.'];
  } else {
    command = 'git';
    args = ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false'];
    if (action === 'status') args.push('status', '--short');
    else if (action === 'diff') args.push('diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--');
    else if (action === 'log') args.push('log', '-8', '--oneline');
    else throw new Error('未知只读查询。');
  }
  const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout: 10_000, signal });
  if (result.killed || (result.code !== 0 && !(command === 'rg' && result.code === 1))) {
    throw new Error(`${action} 查询失败：${result.stderr.slice(0, 1000)}`);
  }
  return result.stdout.length > 40_000 ? result.stdout.slice(0, 40_000) + '\n[输出截断，请缩小搜索范围]' : result.stdout;
}

// Both index and worktree changes plus untracked files are included. Never run
// diff drivers, textconv, repository hooks or shell strings for inspection.
export async function workspaceReference(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
  const head = await pi.exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ctx.cwd, timeout: 10_000, signal });
  if (head.code === 0 && !head.killed) return head.stdout.trim();
  const format = await pi.exec('git', ['rev-parse', '--show-object-format'], { cwd: ctx.cwd, timeout: 10_000, signal });
  const algorithm = format.stdout.trim();
  if (format.code !== 0 || !['sha1', 'sha256'].includes(algorithm)) throw new Error('无法读取Git工作区基线。');
  return createHash(algorithm).update('tree 0\0').digest('hex');
}

export async function workspaceSnapshot(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal, baseRef?: string): Promise<string> {
  const git = async (args: string[]) => {
    const r = await pi.exec('git', ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', ...args], { cwd: ctx.cwd, timeout: 10_000, signal });
    if (r.code !== 0 || r.killed) throw new Error('工作区检查需要可读取的 Git 仓库。');
    return r.stdout;
  };
  const reference = baseRef ?? await workspaceReference(pi, ctx, signal);
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(reference)) throw new Error('无效的Git基线引用。');
  let diff = await git(['diff', '--no-ext-diff', '--no-textconv', reference, '--']);
  const files = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const file of files) {
    const path = await projectPath(ctx.cwd, file);
    const info = await stat(path);
    if (!info.isFile() || info.size > 100_000) throw new Error('未跟踪文件过大或不是普通文件，无法完整审查工作区。');
    const data = await readFile(path);
    if (data.includes(0)) throw new Error('未跟踪二进制文件无法进行文本范围审查。');
    diff += `\nUNTRACKED ${JSON.stringify(file)}\n${data.toString('utf8')}\n`;
    if (Buffer.byteLength(diff) > 150_000) throw new Error('工作区差异超过150KB，无法完整审查；请先缩小或整理变更。');
  }
  if (Buffer.byteLength(diff) > 150_000) throw new Error('工作区差异超过150KB，无法完整审查。');
  return diff;
}
