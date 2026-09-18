import { STATE_ENTRY, type Request } from './state.ts';

// Historical evidence is read from the active branch, never imported from an
// arbitrary file or copied into another approval database.
export type HistoryEntry = { id?: string; type?: string; customType?: string; content?: unknown; details?: unknown;
  data?: { requests?: Request[] }; message?: { role?: string; content?: unknown } };
export type RequestContext = { entryId: string; role: 'user' | 'assistant'; text: string; truncated?: boolean };
export type ContextRequest = Request & { entryId?: string; context?: RequestContext[] };

export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
}

// PI WEB records accepted browser submissions as custom_message entries. The
// ordinary ask_user tool result only says questions were posted, not answered.
export function webAnswerText(entry: HistoryEntry): string | undefined {
  if (entry.type !== 'custom_message' || entry.customType !== 'pi-web.ask.answers') return;
  const outcome = entry.details as { reason?: string; questions?: unknown[] } | undefined;
  if (outcome?.reason !== 'submitted' || !Array.isArray(outcome.questions)) return;
  const lines: string[] = [];
  let answered = false;
  for (const raw of outcome.questions) {
    const r = raw as { answered?: boolean; values?: unknown[]; otherText?: string;
      question?: { question?: string; options?: { value: string; label: string }[] } };
    if (!r?.question || typeof r.question.question !== 'string') continue;
    if (r.answered !== true) { lines.push(`${r.question.question}\n未回答。`); continue; }
    const values = (Array.isArray(r.values) ? r.values : []).filter((v): v is string => typeof v === 'string');
    const selections = values.map(v => r.question!.options?.find(o => o.value === v)?.label ?? v);
    if (typeof r.otherText === 'string' && r.otherText.trim()) selections.push(r.otherText.trim());
    if (!selections.length) continue;
    answered = true;
    lines.push(`${r.question.question}\n用户回答：${selections.join('；')}`);
  }
  return answered ? lines.join('\n\n') : undefined;
}

export function branchRequests(entries: ReadonlyArray<unknown>, captured: Request[]): ContextRequest[] {
  const result: ContextRequest[] = [];
  const seen = new Set<string>();
  const capturedById = new Map(captured.map(r => [r.id, r]));
  let recordingInputs = false;
  const nearby: RequestContext[] = [];
  const add = (r: ContextRequest) => { if (!seen.has(r.id)) { seen.add(r.id); result.push(r); } };
  for (const raw of entries) {
    const e = raw as HistoryEntry;
    if (e.type === 'custom' && e.customType === STATE_ENTRY) {
      recordingInputs = true;
      for (const r of (Array.isArray(e.data?.requests) ? e.data.requests : [])) {
        const actual = capturedById.get(r.id);
        if (actual) add({ ...actual });
      }
    }
    if (!e.id) continue;
    const form = webAnswerText(e);
    if (form) add({ id: `session:${e.id}`, entryId: e.id, source: 'history', text: form });
    if (e.type !== 'message' || !['user', 'assistant'].includes(e.message?.role ?? '')) continue;
    const text = messageText(e.message?.content);
    if (!text.trim()) continue;
    if (e.message!.role === 'user') {
      if (!recordingInputs) {
        add({ id: `session:${e.id}`, entryId: e.id, source: 'history', text,
          context: nearby.slice(-2).map(c => ({ ...c })) });
      } else {
        const capturedRequest = result.findLast(r => r.source !== 'history' && !r.entryId && r.text === text);
        if (capturedRequest) {
          capturedRequest.entryId = e.id;
          capturedRequest.context = nearby.slice(-2).map(c => ({ ...c }));
        }
      }
    }
    nearby.push({ entryId: e.id, role: e.message!.role as 'user' | 'assistant',
      text: text.length > 8000 ? text.slice(0, 3900) + '\n[上下文中段省略]\n' + text.slice(-3900) : text,
      ...(text.length > 8000 ? { truncated: true } : {}) });
    if (nearby.length > 2) nearby.shift();
  }
  // Captured input may be visible to a hook before its session entry is saved.
  for (const r of captured) add({ ...r });
  return result;
}

export function selectedRequests(requests: ContextRequest[], references: string[]): ContextRequest[] {
  const selected = new Set(references);
  let earliest = requests.findIndex(r => selected.has(r.id));
  if (earliest < 0) earliest = Math.max(0, requests.length - 1);
  if (earliest === requests.length - 1 && requests[earliest]?.text.trim().length < 80) {
    earliest = Math.max(0, earliest - 5);
  }
  // Later user corrections must accompany an old authorization. Do not send
  // the entire assistant transcript or unrelated history preceding evidence.
  return requests.slice(earliest).map(r => selected.has(r.id) || r.text.trim().length < 80 ? r : { ...r, context: undefined });
}
