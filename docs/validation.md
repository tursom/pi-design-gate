# 验证记录

验证日期：2026-09-17。

环境：Node.js 26.8.2；PI / pi-ai 0.84.4；Linux。运行命令与脚本保留在项目中。

## 确定性测试

`npm run check`：TypeScript 类型检查通过，98 个 node:test 用例全部通过，0 个跳过，0 个 TODO。

覆盖：

- 审查结果格式、方案必填项及请求引用。
- 真正从插件记录解析请求ID；伪造ID不会到达审查模型。
- 未审方案、未知工具、外部写入和未接入的委派被阻断。
- 同批 design_review 和 write 不共享放行。
- 路径校验等待时的新输入，以及模型调用期间的新输入，都会撤销旧许可。
- execute 入口复核预检许可、参数和一次性消费；预检后输入变更不能执行缓存许可。
- 对话框取消不批准、回答绑定当前版本、扩展注入的user消息不形成请求依据。
- 重载和分支恢复不重用旧放行；已确认答案保留。
- Git暂存、未暂存、未跟踪文件及固定commit基线；实施后commit不能掩盖改动。
- 自动终审不依赖主模型主动调用工具；失败后仅重提方案不能跳过实际差异复审。

这些测试验证流程和执行门禁，不代表模型对所有业务设计都判断正确。

## 真实 PI 流程

命令：

```bash
node scripts/smoke-live.mjs yym/gpt-6-astra
```

在临时Git目录中，要求仅创建内容为 `hello\n` 的 hello.txt。加载真实PI扩展，使用现有模型配置，经真实模型完成：

`design_context → design_inspect → design_review → write → bash核验 → design_review终审`

最终文件为6字节，内容正确；所有上述工具成功，扩展错误数为0，流程到达 `agent_settled`。该验证在加入 execute 包装器后重新运行通过。

测试只操作临时目录，不改全局PI设置，不安装到当前PI WEB实例。PI WEB对话框的实际浏览器交互尚未做端到端测试；当前验证包含PI文档/宿主源码核对和模拟UI集成测试。

首次真实测试暴露独立模型调用缺省发送 `reasoning.effort=none`，被当前模型拒绝；已对支持推理的审查设置 low 后重新跑通。失败期间实施保持关闭。

## 真实模型的必要性判断

命令：

```bash
pi --no-extensions -e ./scripts/eval-review.ts --no-skills --no-context-files \
  --model yym/gpt-6-astra -p /evaluate-design-gate
```

| 场景 | 实际结果 | 判断 |
| --- | --- | --- |
| 登录失败后恢复loading的局部修复 | ready | 符合预期 |
| 已有分享模板却增加code_format及缓存 | revise | 符合预期 |
| 批量审核失败容忍度未知，却设计持久恢复系统 | ask_user | 符合预期 |
| 未上线且明确不兼容旧库，仍增加升级迁移 | revise | 符合预期 |
| 用户明确要求Redis补偿与重试 | ready | 符合预期 |

5/5符合本次预设判定。样本量小且来自已知历史模式，只能证明这些例子有效，不能宣称泛化准确率。

## 独立代码审查后的修正

独立审查发现的四项问题均已处理并增加回归测试：

1. PI缓存同批预检结果：增加内建工具execute入口复核，并使用sequential调度。
2. 首次await后才获取epoch的窗口：改成进入hook即捕获epoch，并在路径检查后复核。
3. Git HEAD移动导致终审漏改动：固定初始commit或空树引用。
4. 将终审尝试计为完成：取消重复计数，仅以dirty和审查状态决定是否重审。

外部工具无法直接获取execute包装入口，因此首版关闭外部写入而保留读取。不会把仅有tool_call预检描述为完整的执行时许可复核。
