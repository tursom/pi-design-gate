import { randomUUID } from 'node:crypto';
import type { Proposal, Review } from './schema.ts';

export const STATE_ENTRY = 'design-gate/state-v1';
export type Request = { id: string; source: 'interactive' | 'rpc'; text: string };
export type Answer = { proposalVersion: number; question: string; answer: string };
export type RepositoryBaseline = { root: string; baseline: string; baselineRef: string };
export type State = {
  schema: 1;
  version: number;
  status: 'investigate' | 'reviewing' | Review['verdict'];
  requests: Request[];
  proposal?: Proposal;
  review?: Review;
  answers: Answer[];
  dirty: boolean;
  repositories?: string[];
  baselines?: RepositoryBaseline[];
};
export const initialState = (): State => ({ schema: 1, version: 0, status: 'investigate', requests: [], answers: [], dirty: false });

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
  request(text: string, source: Request['source']): void {
    this.set({ ...this.value, version: this.value.version + 1, status: 'investigate',
      baselines: this.value.dirty ? this.value.baselines : undefined,
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
  markDirty(): void {
    // Bookkeeping does not invalidate concurrent checks of the same plan.
    this.value = { ...this.value, dirty: true };
    this.persist(this.value);
  }
  clean(): void {
    this.value = { ...this.value, dirty: false };
    this.persist(this.value);
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
      this.value = structuredClone(d);
    }
    // Interrupted reviews and forked/restored permits need a new review, not
    // another human approval. Existing answers remain evidence.
    if (this.value.status === 'reviewing' || this.value.status === 'ready') this.value.status = 'investigate';
  }
}
