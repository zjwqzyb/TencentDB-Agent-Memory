# 当前 Agent 知识资产质量评估

总体状态：**FAIL（可见生成记忆作为执行依据的可靠性）**。这是一轮定向诊断，不代表全部团队知识库、其他项目或本机技能库的全量评价。

原始材料保留了可复查的事实，抽查的项目说明与验收文档也有具体契约和适用边界；自动提炼的 L1/L2/L3 已出现规则失真、时序冲突及无依据补充，现阶段应作为待核验线索使用。

## 范围与实际检查

- 项目：TencentDB-Agent-Memory；团队 TencentDBMemory；Agent 开发助手。沿用已初始化、暂不绑定任务的当前会话。
- 在线来源：原生 team_assets API。真实会话标识、资产索引、读取时间与内容指纹见 manifest.json。
- 当前挂载：0 个 Wiki、0 个 Skill、1 个 Code Graph、1 个记忆块。这里的 0 仅指当前 Agent 的可读挂载，不表示全团队没有资产。
- 完整取回：108 条 L0、23 条 L1、4 篇 L2 场景、1 篇 L3 汇总。语义为定向抽查：主审 12 条条款；独立子 Agent 对 L3/MCP 场景另做 6 类风险复核，存在重叠，不合并为 18 个独立缺陷。
- 比较材料：冻结的当前工作树 11 份文档/源码/测试文件。HEAD 为 f88e5e7e99f5adc57f7312313f66eac0b287bf0e，但快照包含已有未提交变更，不能用 HEAD 代替文件指纹。另有子 Agent 补读的 4 份文件及哈希，见 audit-sidecar.json。
- 用途：判断资料能否支持实际任务操作。检索前冻结 4 个案例及预期来源；本次未把小样本建立为全库考核标准。
- 无前次同口径指纹基线；不声明内容未变。生成模型、在线检索模型与索引版本未知。
- 原始材料中的发布与测试结果属于历史记录；本轮没有复跑产品测试或重新验证生产部署。

## 分项结论

| 维度 | 状态 | 依据与限制 |
|---|---|---|
| 当前挂载盘点及可读性 | PASS | 资产索引和独立 Skill 列表一致；各记忆层已分页/按路径完整取回。索引返回的记忆计数为占位值，不用于本次统计。 |
| 生成内容忠实度 | FAIL | 发现命令有效性、并发恢复、协议路径等关键失真。 |
| 组织与版本一致性 | FAIL | L1 有同条自相矛盾及重复；L2 仍混用历史操作与现行行为。 |
| 记忆检索 | PARTIAL | 4/4 实际执行；预期 L0 证据 Hit@3 为 3/4，MRR@3 为 0.625。仅为风险定向样本。 |
| Wiki 原文与页面评估 | NOT_APPLICABLE | 当前未挂载 Wiki，未调用不在权限范围内的 Wiki，也未用本地文档冒充在线 Wiki。 |
| Skill 内容与执行质量 | NOT_RUN | 当前没有可读的挂载 Skill；本机已安装技能不在本轮范围。 |
| 隔离的端到端问答 | NOT_RUN | 没有独立目标助手调用；评审者已看过标准答案，不能用自答充当测试结果。 |
| Code Graph 索引和生产 UI | NOT_RUN | 本轮评价知识内容，没有复验索引、图查询或线上界面。 |

## 最重要的发现

### 1. P1：L3 把正确的任务操作规则改错

长期汇总称 mem:update-task 已废弃，并建议改为 mem:claim / mem:complete。原始对话是修复 update-task；冻结的 TASK-COMMANDS.md 第 17、20、21 行仍明确提供 update-task、claim-task、complete-task。

同一汇总建议“客户端自动重试最新 revision”。正式契约第 100 行要求重新读取、比较他人修改，再决定补丁，禁止自动更换版本覆盖。照汇总执行会引入并发覆盖风险。

证据：evidence/l3.json；evidence/l0-selected.json；sources/agents/codex/mcp-hooks/TASK-COMMANDS.md；semantic-review.jsonl 的 S01–S03。独立复核见 audit-sidecar.json。

### 2. P1：场景文档补出了错误的接口和不可满足的操作门槛

MCP 场景称必须 HTTPS、路径为 /api/v1/mcp/*。项目说明实际允许内网 HTTP；任务接口是 /api/v1/meta/issue/*。

L3 要求工具清单包含全部 mem:*。项目中 mem:* 是助手工作流文本，实际工具入口为 manage_project_task；反复重连也不会把这些文本变成独立工具。

场景还引用了当前项目不存在的 ARCHITECTURE.md、policies/hooks/local-permissions.yaml、tests/mcp-hooks/e2e/https-direct 等路径。命令无据的结论限定在已检索的本项目，不能据此断言外部客户端不存在同名命令。

证据：evidence/l2/MCP-Hooks-架构-SOP与约束.md；sources/agents/codex/mcp-hooks/README.md 第 43、140–165 行；sources/docs/agents/issue-tracker.md 第 65 行；audit-sidecar.json。

### 3. P1：L1 将不同阶段合成同一“当前状态”

m_1792349110434_47591437 同时写“当前已完成全部开发与验收”和“当前仅完成任务规划与建模，尚未启动功能代码修改”。另两条摘要也保留同类矛盾。

L0 能区分 2026-10-18 17:24 UTC 的规划完成，以及 18:43 UTC 的开发验收完成；摘要合并后丢失了先后及取代关系。

23 条 L1 中发现两组全文完全相同的记录，每组各 2 条；此外有一条很接近的 CodeGraph 长摘要。这里只报告文本重复，不把近似记录计为完全重复。R01 的前两条 L1 结果正是同一段重复内容，R03 的前三条 L1 也高度近似，浪费上下文。

证据：evidence/l1.json；evidence/l0-selected.json；evidence/probes/R01.json、R03.json；semantic-review.jsonl 的 S05。

### 4. P2：一次具体问题被扩写成长期强制规范

原始部署回复是“提供 SSH 主机或别名、部署目录，或现有部署配置的位置”，L2 却扩成“三项必须全部提供，否则不得进入验收”的通用门禁。

任务绑定场景保留了“列表末尾显示暂不绑定任务”这一有效要求，同时添加了“依赖前端组件库 v2.4+”，本次已读原始记录和项目说明没有提供支撑。

CodeGraph 场景把五种视图与接口/验收两项工作统称“七类视图”，又把一次测试数量和耗时扩成后端≥200项、前端≥120项、p95≤120ms 等固定门槛。L3 也把历史“68项测试通过”扩成所有上线必须通过的“68项E2E”。

证据：evidence/l2/后端交付-部署准入-SOP.md；evidence/l2/任务绑定-UX-SOP与交互原则.md；evidence/l2/CodeGraph-图形化升级-交付方法.md；semantic-review.jsonl 的 S04、S08、S11、S12；audit-sidecar.json。

### 5. P2：检索会召回旧阶段，来源指向也有错配

R03 搜索 SvcClaim 是否还需反复继续，L0 前三条均来自修复完成前：旧使用说明、修复方案、旧问题定位；2026-10-19 10:23 UTC 的最终完成说明未进入前三。

L1/L2 保留“用户必须主动继续”的旧叙述，同时也写已支持自动续检索，没有说明自动续扫和预算暂停后手动继续的条件区别。不能据此简单删除所有手动继续说明；正式验收报告明确仍有预算暂停与继续状态。

CodeGraph 场景把 SvcClaim 的验收挂到 java-release-2026-10-19.md；该文档全文没有 SvcClaim，对应证据实际在 search-release-2026-10-19.md。

证据：evidence/probes/R03.json；sources/docs/qa/codegraph/search-release-2026-10-19.md 第 18–30 行；sources/docs/qa/codegraph/java-release-2026-10-19.md；semantic-review.jsonl 的 S06–S07。

## 保留下来的价值

- 可回到 L0 核查用户原话、回复时间和版本变化，修复资料仍有依据。
- “暂不绑定任务在列表末尾显示”及本地直连 Panel 的核心方向得到保留。
- 抽查的项目源说明有明确 API、revision、幂等与结果不明处理；验收文档区分 fixture、真实生产、推断及未覆盖范围。它们比所见自动摘要更便于审计。
- R01/R04 能召回修复 update-task、任务绑定交互的原始完成说明，检索链并非整体失效。

这些正面结果不足以抵消关键执行规则失真。主审的 12 条是风险抽查，不将其判定比例换算为全库准确率。

## 4 次记忆检索结果

| 案例 | 主题 | 预期 L0 证据 Hit@3 | 观察 |
|---|---|---|---|
| R01 | update-task 是否仍可用 | 是，第二位 | L0/L1保留修复事实，但同次附带的 L3 宣称已废弃。 |
| R02 | 调用 API 是否必须 SSH | 是，第一位 | 能命中“不需要SSH”的方案说明；迁移完成记录未进前三，当前实施状态仍需补读。 |
| R03 | SvcClaim 是否仍需反复继续 | 否 | 前三均为修复完成前记录；L1/L2有阶段混合。 |
| R04 | 暂不绑定选项位置 | 是，第一位 | 直接命中末尾固定显示的完成说明。 |

评分对象仅是 L0 原始证据的前 3 名，不混入 L1/L2 进行人为重排。4 次查询均附带 L3；因此即使命中正确原文，助手仍可能同时接收到错误汇总。没有测实际助手是否被误导，不能把这个风险写成已发生的错误回答。

原始输入在 cases.jsonl 与 memory-probe-cases.json；原始检索结果在 evidence/probes；确定性评分在 retrieval-metrics.json。评分脚本成功仅证明记录完整及指标计算成功。

## 建议的处理顺序

1. 先审核 L3 的命令、revision、工具可见性等高风险规则；将未审核的生成结论明确作为历史参考，避免直接作为执行依据。
2. 抽取时分开记录用户明确要求、已核实事实、模型建议、待核验判断；每条保留来源消息、时间、适用项目与版本。
3. 合并时处理“提出→实施→验证→发布”的状态取代关系；重复记录合并保留来源，历史做法标明已被何版本取代。
4. 场景和 Skill 采用实际前置条件、步骤、输入输出、失败路径及验收方式；缺少来源时保留缺口，避免为填满模板补写命令、版本或测试门槛。
5. 检索兼顾相关性、来源权威性与时效性，用本次失败题及关键命令问题做回归。需要比较模型时固定原始资料、题库及生成配置，再评估增益。

这些是本次建议，没有作为新企业规则写回知识库。抽取、合并和长期汇总都出现了失真迹象；具体应归因于模型、提示词还是实现逻辑，尚未做生成链路根因定位，不能把问题全部归结为模型能力。

## 产物与复核

- report.md：本报告。
- manifest.json、source-manifest.json：范围、读取完整性、版本限制与指纹。
- semantic-review.jsonl：12条主审证据矩阵，含两条正确保留示例。
- audit-sidecar.json：独立子 Agent 的6类风险复核。
- evidence：在线读取快照与选取的原始消息。
- cases.jsonl、runs.jsonl、retrieval-metrics.json：冻结案例、实际运行与评分。

复算检索指标：

```sh
python3 /Users/zj/.codex/skills/validating-wiki-quality/scripts/score_retrieval.py \
  --cases /Users/zj/daydayup/TencentDB-Agent-Memory/outputs/wiki-quality/20261025-memhub-current-agent-01a17368/cases.jsonl \
  --runs /Users/zj/daydayup/TencentDB-Agent-Memory/outputs/wiki-quality/20261025-memhub-current-agent-01a17368/runs.jsonl \
  --k 3 \
  --out /Users/zj/daydayup/TencentDB-Agent-Memory/outputs/wiki-quality/20261025-memhub-current-agent-01a17368/retrieval-metrics.json
```

本轮仅写入本地评估产物，没有修改在线知识、Skill、记忆、模型配置或任务。

