# 原型资产联测说明

本目录验证团队原型资产的项目、页面版本、组件契约、权限和 MCP 读取链路。测试使用合成样例，不包含企业数据。

## 数据入口

- 通用场景：由 `fixture.ts` 动态生成临时账号、团队和资产 ID
- 外部样例：如需接入企业数据，请自行提供兼容样例，不随仓库提交

## 本地运行

```sh
QA_DIR=$(mktemp -d)
MemoryPanel/node_modules/.bin/tsx MemoryPanel/tests/prototype/fixture.ts "$QA_DIR/fixture.json" sqlite
python3 MemoryPanel/tests/prototype/exact-versions.py "$QA_DIR/fixture.json"
python3 MemoryPanel/tests/prototype/lost-response.py "$QA_DIR/fixture.json"
```

本目录不包含企业私有夹具，也不包含依赖私有数据的浏览器端到端脚本。
