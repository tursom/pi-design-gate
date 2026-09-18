import { randomUUID } from 'node:crypto';
import type { Proposal, Review } from './schema.ts';

export const STATE_ENTRY = 'design-gate/state-v1';
export type Request = { id: string; source: 'interactive' | 'rpc' | 'history'; text: string };
export type Answer = { proposalVersion: number; question: string; answer: string };
export type State = {
  schema: 1;
  version: number;
  status: 'idle' | 'investigate' | 'reviewing' | Review['verdict'];
  requests: Request[];
  armed: boolean;
  proposal?: Proposal;
  review?: Review;
  answers: Answer[];
};
export const initialState = (): State => ({ schema: 1, version: 0, status: 'idle', requests: [], answers: [], armed: false });

// Epochs are process-local: an outstanding model/UI response can never revive
// an old state after input, /reload, branch navigation or another review.
export class GateState {
  value: State = initialState();
  epoch = 0;
  private readonly persist: (state: State) => void;
  constructor(persist: (state: State) => void) { this.persist = persist; }
  set(value: State): void {
    this.epoch++;
    this.value = structuredClone(value);
    this.persist(this.value);
  }
  start(): void {
    this.set({ ...this.value, armed: true, status: 'investigate' });
  }
  stop(): void {
    this.set({ ...this.value, armed: false, status: 'idle', proposal: undefined, review: undefined });
  }

  request(text: string, source: Request['source']): void {
    this.set({ ...this.value, version: this.value.version + 1, status: this.value.armed ? 'investigate' : 'idle',
      requests: [...this.value.requests, { id: randomUUID(), text, source }] });
  }

  begin(proposal: Proposal): number {
    this.set({ ...this.value, version: this.value.version + 1, status: 'reviewing', proposal, review: undefined });
    return this.epoch;
  }
  finish(epoch: number, review: Review): boolean {
    if (epoch !== this.epoch) return false;
    this.set({ ...this.value, status: review.verdict, review });
    return true;
  }
  fail(epoch: number, reason: string): void {
    this.finish(epoch, { verdict: 'investigate', reason, findings: [], questions: [] });
  }
  answer(epoch: number, answers: Answer[]): boolean {
    if (epoch !== this.epoch || this.value.status !== 'ask_user') return false;
    this.set({ ...this.value, status: 'investigate', answers: [...this.value.answers, ...answers] });
    return true;
  }
  restore(entries: ReadonlyArray<unknown>): void {
    this.epoch++;
    this.value = initialState();
    for (const raw of entries) {
      const e = raw as { type?: string; customType?: string; data?: State };
      if (e.type !== 'custom' || e.customType !== STATE_ENTRY) continue;
      const d = e.data;
      if (!d || d.schema !== 1 || !Number.isInteger(d.version) || !Array.isArray(d.requests) || !Array.isArray(d.answers)) {
        this.value = initialState();
        continue;
      }
      // Select the supported fields so old workspace-audit data is not carried
      // forward when resuming an existing session.
      this.value = structuredClone({ schema: d.schema, version: d.version, status: d.armed ? d.status : 'idle',
        requests: d.requests, answers: d.answers, armed: d.armed === true,
        ...('proposal' in d ? { proposal: d.proposal } : {}),
        ...('review' in d ? { review: d.review } : {}),
      });
    }
    // Interrupted reviews and forked/restored permits need a new review, not
    // another human approval. Existing answers remain evidence.
    if (this.value.status === 'reviewing' || this.value.status === 'ready') this.value.status = this.value.armed ? 'investigate' : 'idle';
  }
}
