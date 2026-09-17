import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { reviewWithModel } from '../src/review.ts';

// Only loaded by an explicit -e flag. This evaluates the reviewer with historical
// patterns and never grants implementation permissions or performs project writes.
export default function (pi: ExtensionAPI): void {
  pi.registerCommand('evaluate-design-gate', {
    description: 'Run a small live design-review evaluation without implementation tools',
    async handler(_args, ctx) {
      const cases = [
        { name: 'simple-fix', request: '修复登录失败后loading未恢复，沿用现有错误提示。',
          changes: ['finally中恢复loading，无新机制'], mechanisms: [], expected: ['ready'] },
        { name: 'duplicate-format', request: '分享模板里已有{{share.code}}，运营需要自由修改它旁边的文案。',
          changes: ['新增code_format、历史格式匹配、格式规则缓存'], mechanisms: [{ name: 'code_format',
            purpose: '配置分享码外层文案', evidence: [], failureCost: '现有模板可以直接修改文案',
            responsibility: '分享模块', simplestAlternative: '直接编辑{{share.code}}旁的文案',
            whyAlternativeInsufficient: null, uncertainty: '暂时没有发现现有模板不足' }], expected: ['revise', 'investigate'] },
        { name: 'batch-failure-cost', request: 'GVA支持跨页批量审核。失败后能否重做、是否接受部分成功还没有决定。',
          changes: ['批次表、明细表、worker租约、持久恢复状态机'], mechanisms: [{ name: '持久批量任务',
            purpose: '中断后自动恢复', evidence: [], failureCost: '部分完成后需要重新发起；用户是否接受未知',
            responsibility: 'GVA', simplestAlternative: '分页并发调用现有单条RPC，返回逐项结果',
            whyAlternativeInsufficient: null, uncertainty: '不知道用户是否要求无人值守恢复' }], expected: ['ask_user', 'revise'] },
        { name: 'unreleased-migration', request: '钱包精度扩展到5位。服务从未上线，无需兼容旧库，直接调整初始化Schema。',
          changes: ['更新初始化Schema，再新增迁移脚本、迁移测试和DBA升级流程'], mechanisms: [{ name: '旧库升级路径',
            purpose: '兼容历史生产数据库', evidence: [], failureCost: '目前没有已上线的数据库',
            responsibility: '财务服务', simplestAlternative: '修改初始化Schema',
            whyAlternativeInsufficient: null, uncertainty: null }], expected: ['revise'] },
        { name: 'authorized-compensation', request: '撤销授权失败必须保留待处理状态并重试。请使用Redis待处理集合，先写Redis，成功后清理，日志追踪。',
          changes: ['按要求实现Redis补偿及有界重试'], mechanisms: [{ name: 'Redis补偿',
            purpose: '完成用户明确要求的失败重试', evidence: [{ kind: 'request', reference: 'r1' }],
            failureCost: '失败后账号仍保持授权，明确不可接受', responsibility: '撤销服务',
            simplestAlternative: '仅发一次请求', whyAlternativeInsufficient: '不能满足明确的失败重试要求', uncertainty: null }], expected: ['ready'] },
      ];
      for (const c of cases) {
        const result = await reviewWithModel(ctx, { mode: 'proposal', capturedRequests: [{ id: 'r1', source: 'rpc', text: c.request }],
          proposal: { goal: c.request, acceptance: [c.request], changes: c.changes, evidence: [{ kind: 'request', reference: 'r1' }], mechanisms: c.mechanisms },
          evidence: [{ reference: { kind: 'request', reference: 'r1' }, content: c.request }], answers: [],
        }, ctx.signal);
        pi.sendMessage({ customType: 'design-gate-evaluation', display: true,
          content: JSON.stringify({ name: c.name, expected: c.expected, actual: result.review.verdict,
            matched: c.expected.includes(result.review.verdict), reason: result.review.reason, usage: result.usage }) }, { triggerTurn: false });
      }
    },
  });
}
