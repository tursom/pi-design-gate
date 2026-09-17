import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { projectPath } from './context.ts';
import type { GateState } from './state.ts';

export type Call = { toolName: string; toolCallId: string; input: Record<string, unknown> };
export type CallKind = 'read' | 'control' | 'mutation' | 'external-write' | 'delegation' | 'unknown';
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'codex_memory', 'notify_user', 'ask_user',
  'list_subsessions', 'check_subsession', 'read_subsession', 'yield_to_subsessions']);
const DELEGATION = new Set(['spawn_session', 'spawn_subsession', 'subagent', 'delegate_task']);
export function classify(call: Call): CallKind {
  if (call.toolName === 'design_context' || call.toolName === 'design_inspect') return 'read';
  if (call.toolName === 'design_review') return 'control';
  if (READ_TOOLS.has(call.toolName)) return 'read';
  if (DELEGATION.has(call.toolName)) return 'delegation';
  if (['edit', 'write', 'bash', 'powershell'].includes(call.toolName)) return 'mutation';
  if (call.toolName === 'openproject') {
    if (['search_work_packages', 'get_work_package_context'].includes(String(call.input.action))) return 'read';
    if (['create_work_package', 'add_comment', 'update_work_package'].includes(String(call.input.action))) return 'external-write';
  }
  if (call.toolName === 'feishu_bitable') {
    if (['tables', 'fields', 'search', 'get'].includes(String(call.input.action))) return 'read';
    if (['create', 'update'].includes(String(call.input.action))) return 'external-write';
  }
  return 'unknown';
}

export function hasSiblingReview(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch();
  const last = [...branch].reverse().find(e => e.type === 'message' && e.message.role === 'assistant');
  if (!last || last.type !== 'message' || last.message.role !== 'assistant') return false;
  return last.message.content.some(c => c.type === 'toolCall' && c.name === 'design_review');
}

export async function preliminaryGate(call: Call, state: GateState, ctx: ExtensionContext): Promise<string | undefined> {
  const kind = classify(call);
  if (kind === 'read' || kind === 'control') return;
  if (kind === 'delegation') return '设计门禁尚未接入子会话权限继承，本版不允许启动子代理。请在当前会话完成工作。';
  if (kind === 'external-write') return '本版尚未接入外部写工具的执行入口复核，保持阻断；可继续使用读取action。';
  if (kind === 'unknown') return `设计门禁尚未适配工具 ${call.toolName}，无法确定其副作用。`;
  if (hasSiblingReview(ctx)) return 'design_review 必须与实施工具分开调用；当前批次不会继承同批审查的放行结果。';
  if (call.toolName === 'powershell' && process.platform !== 'win32') return '本平台未注册受控 PowerShell 执行入口。';
  if (state.value.status !== 'ready') return `设计门禁：当前为 ${state.value.status}。先调用 design_context 获取依据，再用 design_review 提交方案；待确认问题用 /design review 处理。`;
  if ((call.toolName === 'edit' || call.toolName === 'write')) {
    if (typeof call.input.path !== 'string') return '缺少有效文件路径。';
    try { await projectPath(ctx.cwd, call.input.path); }
    catch (error) { return (error as Error).message; }
  }
}
