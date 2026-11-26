# 团队原型资产与版本管理

## 背景

团队需要在 MemoryPanel 中共享原型配置，并让 Codex 通过 MCP 读取精确版本。首期目标是把一次成功保存的配置作为不可变版本管理，支持页面、组件契约和恢复操作。

## 决策

- 新增 `prototype` 资产类型。
- 原型资产使用独立的项目、页面、版本和契约存储。
- 保存、恢复和契约发布走 `prototype/*` API。
- MCP 只提供 `read_prototype_page` 和 `read_prototype_contract` 两个只读工具。
- MemoryPanel 增加 `Prototypes` 页面和 `/prototype-editor` 静态挂载。

## 边界

- 首期只管理配置快照，不管理业务单据、附件、凭据或浏览器会话。
- 不做实时协同编辑、自动合并或自动需求修改。
- 公开仓库只提交合成样例；企业数据和私有验收证据不进入版本库。
