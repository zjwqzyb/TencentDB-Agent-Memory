# CodeGraph 布局验收记录

日期：2026-10-19  
范围：CodeGraph 页面布局、关系模式可达性、窄屏抽屉和视觉状态。  
状态：生产部署及验收通过。

## 验收结果

本地 fixture 浏览器布局与关系模式检查分别通过 98 项和 30 项；另由子 Agent 完成 4 项英文及主题检查。长分析压力场景只通过 DOM 注入内容模拟 flex 布局压力，不代表后端/API 关系数据；检查确认表格高 500px、首行可命中、键盘焦点及 Enter 选择有效，主内容区滚动可达，并在场景结束时移除模拟内容。祖先裁剪检查确认常用视口的画布完整显示；1152×720 与 960×600 是 125%/150% 的等效 CSS 视口，不代表真实浏览器缩放事件。390px 窄屏在折叠全局侧栏后可滚动访问关系内容和抽屉。全局应用顶栏在窄屏仍有重叠，属于 CodeGraph 页面外壳的应用级限制。

五种关系模式的可见控件与布局空间均在 1440×900 和 1366×768 fixture 中检查；调用、影响、依赖、聚类模式画布至少 400px 且完整显示，继承模式另以受支持的类焦点检查了实际画布几何。

关系列表问题首先在基于 `23fe05b` 的首轮生产验收中发现：`._codegraph-main` 的纵向 flex 布局中，长分析区挤压了前面的关系列表。CSS 热修复固定直接关系列表子项的收缩行为；随后在真实 API 预发布中用实际分析内容验证修复，fixture 则使用独立的合成 DOM 压力块回归布局。

热修复提交 `2504bf86f73c4a4d373c6ec815bc01ae9babd6a6` 基于布局实现提交 `23fe05b77f9c549b983568bf9cb32881c250190e`。生产部署运行镜像 `sha256:4e14be68361b7aa9b3b7fb47decfcf84ab96c2603cfecaf98fa876d0838ada4f`；保留回滚镜像 `sha256:7f5a8f4bfb34febbff627dc647041adcad742918c23012aff94a3067ae906199`，回滚容器为 `tdai-memory-hub-rollback-layout-listfix-20261019-155400`，脚本位于 `/opt/tencent-agent-memory/releases/codegraph-layout-listfix-20261019/ops/rollback-codegraph-layout-listfix.sh`。

生产真实 API 验收使用索引版本 `159ad760d68321fcc17ca05ac3dbd0b2`、仓库 `cg-gvcy949i` 和方法 `accTotalBalSubtractPoolTran`，没有 mock。19 项检查全部通过：调用图 1440×900 画布 `x=465, y=283, w=644, h=472.8125`，1366×768 画布 `x=465, y=283, w=570, h=400`；影响图 1366×768 画布 `y=338, h=400`，底边 `738` 小于祖先裁剪底边 `753`。本次生产抽验的调用/影响视图控件命中正常，外层滚动范围为 0；源码行 205–255 可读并能滚到底部，源码滚动范围 249。关系列表高 500px，实际长分析高 3420.28125px，首行命中及键盘焦点有效，Enter 可选中关系节点；分析区滚动到 3586px 底部。Hub/Core 容器健康、Panel 与 Knowledge 健康端点返回成功，Core 镜像未变更，部署环境和挂载与备份基线一致。发布后的浏览器截图及结果、部署审计均已保存。

父 Agent 独立复跑通过严格布局 98 项、关系模式 30 项和 DPR 114 项（DPR 1、1.14、2 及切换）。英文/主题 4 项由子 Agent 验证通过。生产浏览器 19 项检查全部通过。

## 可追溯产物

- `output/playwright/codegraph-layout-result.json`：98 项布局检查结果，包含长分析 DOM 压力数据。
- `output/playwright/codegraph-layout-modes-result.json`：30 项关系模式回归结果。
- `output/playwright/codegraph-layout-theme-result.json`：4 项英文及深浅主题结果。
- `output/playwright/codegraph-layout-desktop.png`、`output/playwright/codegraph-layout-mobile.png`：fixture 视觉检查截图。
- `output/playwright/codegraph-layout-real-review-final-1440.png`、`output/playwright/codegraph-layout-real-impact-1366.png`：真实索引预发布截图。
- `output/playwright/codegraph-layout-production-hotfix-result.json`：真实生产索引的 19 项最终浏览器验收结果。
- `output/playwright/codegraph-layout-production-1440.png`、`output/playwright/codegraph-layout-production-1366.png`、`output/playwright/codegraph-layout-production-impact.png`、`output/playwright/codegraph-layout-production-list.png`：生产页面截图。
- `output/deployment/codegraph-layout-listfix-20261019/production-review.json`：部署镜像、容器健康、回滚镜像、挂载与运行时审计。
- `output/deployment/codegraph-layout-listfix-20261019/`：部署准备、提交清单与产物哈希记录。
- 父 Agent 独立复验记录：布局 98 项、关系模式 30 项、DPR 114 项通过；布局日志位于 `/tmp/codegraph-layout-parent-listfix.log`，模式日志位于 `/tmp/codegraph-layout-parent-modes-final.log`。

执行方式：Node.js 22，使用本仓库 fixture 和 `MemoryPanel/tests/knowledge/browser/code-graph-layout.js`。页面通过 Playwright CLI 在真实浏览器中操作；结果 JSON 记录逐项断言和采集到的几何数据。
