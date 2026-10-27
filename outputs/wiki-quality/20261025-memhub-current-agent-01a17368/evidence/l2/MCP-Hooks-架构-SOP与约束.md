-----META-START-----
created: 2026-10-18T16:20:34.828Z
updated: 2026-10-18T16:49:16.823Z
summary: 确立 MCP Hooks 全链路直连架构 SOP：含认证/权限/去重逻辑前移要求、HTTPS 直调强制规范、重连生效机制及 76 项验证标准。
heat: 2
-----META-END-----

## 工作场景
适用于所有基于 MCP Hooks 构建的团队协作 Agent，在 Codex → 本地 MCP/Hooks → Panel HTTPS API 直连架构下，开展任务调度、状态同步与协同操作。本场景定义该架构的部署、验证、执行与运维全生命周期方法论。

## 适用条件
- Panel HTTPS API 已启用且网络可达（TLS 证书有效、域名解析正常）；
- Hooks 运行环境已配置本地权限策略与会话绑定上下文；
- 团队已停用所有旧 SSH 中继连接，统一接入 `team_assets` MCP 实例；
- 当前链路已通过全部查询类接口（`mem:get-task`/`mem:list-tasks`/`mem:ready-tasks`）实测验证；写操作类接口（create/update/comment）已加载但尚未触发实测，上线前须补全验证。

## 核心 SOP
- 架构部署必须完成三阶段：① 本地 Hooks 初始化（加载权限策略、生成会话密钥）；② 配置直连 Panel HTTPS endpoint 并验证 TLS；③ 重连 MCP 实例以刷新工具定义与指令集。
- 所有 Hooks 对 Panel 的调用必须使用 HTTPS 协议，路径为 `/api/v1/mcp/*`，禁止任何 SSH 封装或代理中转。
- 认证、会话绑定、权限校验、去重账本四大逻辑必须在本地 Hooks 或 Panel 服务端完成，不得依赖 SSH 层中间状态。
- 接口验证采用分阶段策略：首阶段必须覆盖全部查询类指令（`mem:get-*`/`mem:list-*`/`mem:ready-*`），确认直连链路基础可用；次阶段须完整覆盖创建、更新、评论等写操作指令，方可视为全功能就绪。

## 判断逻辑
直连架构是保障低延迟、可审计、强一致性的前提：SSH 中转引入不可控延迟与单点故障，且无法透传会话上下文，导致去重与权限校验失效；前移关键逻辑可使风控前置，避免事后补偿。

## 禁忌与反模式
- [经 SSH 中转调用 Panel API]：绕过权限校验与会话绑定，导致越权操作与状态覆盖；替代做法：直连 HTTPS，失败时检查 TLS 证书与网络策略。
- [跳过本地 Hooks 初始化]：缺失会话密钥与权限策略，导致 API 调用被 Panel 拒绝；替代做法：运行 `hooks init --env team_assets` 并验证日志。
- [未重连 MCP 即执行新指令]：工具定义未刷新，Agent 无法识别 `mem:*` 指令；替代做法：`mcp reconnect --instance team_assets` 后验证 `mcp list-tools` 输出。

## 关键事实依据
- 新链路已通过 76 项自动化测试（含并发冲突、去重账本、HTTPS 重试、证书过期模拟）及真实 HTTP 流量验证；
- 查询类接口（`mem:get-task`/`mem:list-tasks`/`mem:ready-tasks`）已全部实测确认走 HTTP 直连生效（revision=4）；
- 写操作类接口（create/update/comment）均已加载至 Hooks 工具集，但本轮未触发实测；
- 代码已提交至 commit `fe6b3d8`，位于分支 `feat/server_team`；
- 全体成员须立即执行重连并停用旧 SSH 连接，截止时间为 2026-10-18 24:00。

## 相关任务与资产
- 配置文档：`/agents/codex/mcp-hooks/ARCHITECTURE.md`；
- 权限策略模板：`/policies/hooks/local-permissions.yaml`；
- 测试套件：`/tests/mcp-hooks/e2e/https-direct/`。

## 演化记录
- [2026-10-18]：从 CLI 指令 SOP 升级为全链路架构 SOP，新增认证/权限/去重逻辑前移要求、HTTPS 直调强制规范及重连生效机制，原因：SSH 中继方案已被正式废弃，直连架构成为唯一合规路径。

## 待确认问题
- Panel 是否支持细粒度 API 级权限控制（当前依赖 Hooks 本地策略）？需与后端对齐。
- 写操作类接口（create/update/comment）的实测计划与验收标准是什么？是否需新增测试用例或调整权限策略？
