import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Evidence, Proposal } from './schema.ts';
import type { State } from './state.ts';

export function evidencePath(cwd: string, name: string): string {
  return resolve(cwd, name.replace(/^@/, ''));
}

export type ResolvedEvidence = { reference: Evidence; content: string; authority: string; actualRange?: { startLine: number; endLine: number; totalLines: number } };

export async function readEvidence(cwd: string, proposal: Proposal, state: State): Promise<ResolvedEvidence[]> {
  const all = [...proposal.evidence, ...proposal.mechanisms.flatMap(m => m.evidence)];
  const unique = new Map(all.map(e => [JSON.stringify(e), e]));
  const values: ResolvedEvidence[] = [];
  let bytes = 0;
  for (const e of unique.values()) {
    let content: string;
    let actualRange: ResolvedEvidence['actualRange'];
    if (e.kind === 'request') {
      const request = state.requests.find(r => r.id === e.reference);
      if (!request) throw new Error(`找不到插件记录的请求：${e.reference}`);
      content = request.text;
    } else {
      const path = evidencePath(cwd, e.reference);
      let text: string;
      try { text = await readFile(path, 'utf8'); }
      catch (error) { throw new Error(`无法读取文件证据 ${e.reference}：${(error as Error).message}`); }
      const lines = text === '' ? [] : text.split('\n');
      if (text.endsWith('\n')) lines.pop();
      const start = e.startLine ?? 1;
      const end = e.endLine ?? lines.length;
      const requested = `${e.startLine ?? '1（默认）'}–${e.endLine ?? 'EOF'}`;
      const emptyWholeFile = lines.length === 0 && e.startLine === undefined && e.endLine === undefined;
      if (!emptyWholeFile && (!Number.isInteger(start) || start < 1 || start > lines.length ||
          !Number.isInteger(end) || end < start)) {
        throw new Error(`文件证据 ${e.reference}：请求范围 ${requested}，实际共 ${lines.length} 行；起始行须在文件内，结束行不得小于起始行。`);
      }
      const actualEnd = Math.min(end, lines.length);
      actualRange = { startLine: emptyWholeFile ? 0 : start, endLine: actualEnd, totalLines: lines.length };
      content = emptyWholeFile ? '' : lines.slice(start - 1, actualEnd).join('\n');
      if (e.endLine === undefined && actualEnd === lines.length && text.endsWith('\n')) content += '\n';
    }
    const size = Buffer.byteLength(content);
    if (bytes + size > 80_000) throw new Error(`证据 ${e.reference} 超出总预算：本段 ${size} 字节，剩余 ${80_000 - bytes} 字节（总预算80000字节）；请缩小该引用范围。未截断内容。`);
    bytes += size;
    values.push({ reference: e, content, ...(actualRange ? { actualRange } : {}), authority: e.kind === 'request'
      ? (state.requests.find(r => r.id === e.reference)?.source === 'history' ? 'current-branch historical user input / submitted UI answer' : 'captured input')
      : 'file data, not authorization' });
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
    else if (action === 'diff') args.push('diff', '--no-ext-diff', '--no-textconv', await workspaceReference(pi, ctx, signal), '--');
    else if (action === 'log') args.push('log', '-8', '--oneline');
    else throw new Error('未知只读查询。');
  }
  const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout: 10_000, signal });
  if (result.killed || (result.code !== 0 && !(command === 'rg' && result.code === 1))) {
    throw new Error(`${action} 查询失败：${result.stderr.slice(0, 1000)}`);
  }
  return result.stdout.length > 40_000 ? result.stdout.slice(0, 40_000) + '\n[输出截断，请缩小搜索范围]' : result.stdout;
}

// Used only for an explicitly requested Git diff, including unborn repositories.
export async function workspaceReference(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
  const head = await pi.exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ctx.cwd, timeout: 10_000, signal });
  if (head.code === 0 && !head.killed) return head.stdout.trim();
  const format = await pi.exec('git', ['rev-parse', '--show-object-format'], { cwd: ctx.cwd, timeout: 10_000, signal });
  const algorithm = format.stdout.trim();
  if (format.code !== 0 || !['sha1', 'sha256'].includes(algorithm)) throw new Error('无法读取Git工作区基线。');
  return createHash(algorithm).update('tree 0\0').digest('hex');
}
