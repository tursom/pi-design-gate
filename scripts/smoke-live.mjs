import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// Explicit opt-in live test. Uses the user's existing provider configuration;
// never prints credentials or changes global PI settings.
const model = process.argv[2];
if (!model) throw new Error('Usage: node scripts/smoke-live.mjs provider/model');
const project = resolve(import.meta.dirname, '..');
const cwd = await mkdtemp(join(tmpdir(), 'pi-design-gate-live-'));
const nested = process.argv.includes('--nested');
const target = nested ? 'service/hello.txt' : 'hello.txt';
if (nested) execFileSync('git', ['init', '-q', join(cwd, 'service')]);
const child = spawn(resolve(project, 'node_modules/.bin/pi'), [
  '--mode', 'rpc', '--no-session', '--offline', '--no-extensions',
  '-e', resolve(project, 'src/index.ts'), '--no-skills', '--no-prompt-templates',
  '--no-context-files', '--model', model,
], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_TELEMETRY: '0' } });
const events = [];
let buffer = '';
let stderr = '';
let done = false;
let settled;
const completion = new Promise(resolve => { settled = resolve; });
const timer = setTimeout(() => { child.kill('SIGTERM'); settled('timeout'); }, 150_000);
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    events.push(event);
    if (event.type === 'extension_ui_request' && ['confirm', 'select', 'input'].includes(event.method)) {
      // Do not auto-approve new business decisions during a smoke test.
      child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true }) + '\n');
    }
    if (event.type === 'agent_settled') { done = true; settled('settled'); }
  }
});
child.on('error', error => settled(error.message));
child.on('exit', code => { if (!done) settled(`exit ${code}`); });
child.stdin.write(JSON.stringify({ type: 'prompt', id: 'smoke', message:
  `在当前临时项目创建 ${target}，内容恰好为 hello 加一个换行。当前会话目录不是Git仓库。${nested ? '目标在service子目录的Git仓库内，不需要声明repositories。' : '本任务不需要Git仓库。'}只需要这个文件，不新增依赖、配置或测试。请使用设计门禁的正常流程完成；不要提交或推送。` }) + '\n');
const outcome = await completion;
clearTimeout(timer);
child.kill('SIGTERM');
await writeFile(join(cwd, 'rpc-events.json'), JSON.stringify(events, null, 2));
await writeFile(join(cwd, 'rpc-stderr.txt'), stderr);
const result = await readFile(join(cwd, target), 'utf8').catch(() => null);
const errors = events.filter(e => e.type === 'extension_error');
const tools = events.filter(e => e.type === 'tool_execution_end').map(e => ({ tool: e.toolName, error: e.isError }));
const verdicts = events.filter(e => e.type === 'message_end' && e.message?.customType === 'design-gate-review').map(e => e.message.content);
const summary = { outcome, nested, fileCorrect: result === 'hello\n', extensionErrors: errors.length, tools, verdicts, artifacts: cwd };
console.log(JSON.stringify(summary, null, 2));
if (outcome !== 'settled' || result !== 'hello\n' || errors.length || !tools.some(t => t.tool === 'design_review' && !t.error)) process.exitCode = 1;
