import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

const Text = () => Type.String({ minLength: 1, maxLength: 4000, pattern: '\\S' });
const List = () => Type.Array(Text(), { minItems: 1, maxItems: 20 });
export const EvidenceSchema = Type.Object({
  kind: Type.String({ enum: ['request', 'file'] }),
  reference: Text(), // plugin-issued request ID or project-relative file
  startLine: Type.Optional(Type.Integer({ minimum: 1, description: '文件引用起始行（含），省略从第1行读取；两者都省略读取全文。' })),
  endLine: Type.Optional(Type.Integer({ minimum: 1, description: '文件引用结束行（含），省略或超过末尾读取到EOF；返回实际引用范围。' })),
}, { additionalProperties: false });
export const ProposalSchema = Type.Object({
  goal: Text(),
  acceptance: List(),
  changes: List(),
  repositories: Type.Optional(Type.Array(Text(), { minItems: 1, maxItems: 20 })),
  evidence: Type.Array(EvidenceSchema, { minItems: 1, maxItems: 20 }),
  mechanisms: Type.Array(Type.Object({
    name: Text(),
    purpose: Text(),
    evidence: Type.Array(EvidenceSchema, { maxItems: 10 }),
    failureCost: Text(),
    responsibility: Text(),
    simplestAlternative: Text(),
    whyAlternativeInsufficient: Type.Union([Text(), Type.Null()]),
    uncertainty: Type.Union([Text(), Type.Null()]),
  }, { additionalProperties: false }), { maxItems: 20 }),
}, { additionalProperties: false });
export type Proposal = Static<typeof ProposalSchema>;
export type Evidence = Static<typeof EvidenceSchema>;

export const ReviewSchema = Type.Object({
  verdict: Type.String({ enum: ['ready', 'revise', 'investigate', 'ask_user'] }),
  reason: Text(),
  findings: Type.Array(Text(), { maxItems: 15 }),
  questions: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 80 }),
    question: Text(),
    options: Type.Array(Text(), { minItems: 2, maxItems: 5 }),
    recommendation: Text(),
  }, { additionalProperties: false }), { maxItems: 5 }),
}, { additionalProperties: false });
export type Review = Static<typeof ReviewSchema>;
export type Question = Review['questions'][number];

export function parseReview(text: string): Review {
  const result: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
  if (!Check(ReviewSchema, result)) throw new Error('审查模型未返回有效的结构化结果。');
  if ((result.verdict === 'ask_user') !== (result.questions.length > 0)) {
    throw new Error('审查结果的决策与待确认问题不一致。');
  }
  if (new Set(result.questions.map(q => q.id)).size !== result.questions.length ||
      result.questions.some(q => new Set(q.options).size !== q.options.length)) {
    throw new Error('审查问题或选项重复。');
  }
  return result;
}

export function validateProposal(value: unknown): asserts value is Proposal {
  if (!Check(ProposalSchema, value)) throw new Error('方案字段缺失或格式不正确。');
  if (!value.evidence.some(e => e.kind === 'request')) throw new Error('方案必须引用至少一条插件记录的用户请求。');
}
