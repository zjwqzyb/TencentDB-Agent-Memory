// Editorial source for the first published walkthrough. A rebuilt index receives
// fresh node IDs; every citation must resolve before this edition can be used.
import { queryStructured, type StructuredContext } from './structured.js';

const gateway = {
  name: 'handleAtomicSearch',
  file: 'MemoryCore/src/gateway/v2-router.ts',
  hash: '9f59fe7b3a1de375159e138a0be92114685d4e07adef55165c4b0dc79d45dd77',
};
const search = {
  name: 'executeMemorySearch',
  file: 'MemoryCore/src/core/tools/memory-search.ts',
  hash: 'e6dc7ee33d527c4d7c2017f5a345fd4f5430f616b62d314b2c54888af3e312e8',
};
const recall = {
  name: 'recallL1Candidates',
  file: 'MemoryCore/src/core/tools/l1-candidate-recall.ts',
  hash: '1f30af090002921c2209b78a7e97166c6eb2b71ca243c29262250d432c273668',
};

export function buildL1PilotGuide(ctx: StructuredContext) {
  if (!ctx.commit) return null;
  const definitions = new Map<string, { nodeId: string; indexVersion: string }>();
  for (const symbol of [gateway, search, recall]) {
    const result = queryStructured(ctx, 'graph-search', {
      query: symbol.name,
      scopePath: symbol.file,
      nodeKinds: ['function'],
    });
    const node = result.nodes.find((n) => n.name === symbol.name && n.filePath === symbol.file);
    if (!node || !result.indexVersion) return null;
    const ref = { nodeId: node.id, indexVersion: result.indexVersion };
    const source = queryStructured(ctx, 'graph-source', ref);
    if (source.state !== 'ready' || source.source?.contentHash !== symbol.hash) return null;
    definitions.set(symbol.name, ref);
  }
  const indexVersion = definitions.get(gateway.name)!.indexVersion;
  if ([...definitions.values()].some((ref) => ref.indexVersion !== indexVersion)) return null;
  const calls = new Map<string, string>();
  for (const [caller, callee, line] of [
    [gateway, search, 1222],
    [search, recall, 135],
  ] as const) {
    const from = definitions.get(caller.name)!;
    const to = definitions.get(callee.name)!;
    const result = queryStructured(ctx, 'graph', { ...from, mode: 'calls', direction: 'out' });
    const edge = result.edges.find(
      (e) =>
        e.source === from.nodeId &&
        e.target === to.nodeId &&
        e.evidence.some((site) => site.filePath === caller.file && site.line === line),
    );
    if (!edge) return null;
    calls.set(caller.name + ':' + line, edge.id);
  }
  const cite = (symbol: typeof gateway, line: number, label: string) => ({
    nodeId: definitions.get(symbol.name)!.nodeId,
    filePath: symbol.file,
    line,
    label,
    contentHash: symbol.hash,
    edgeId: calls.get(symbol.name + ':' + line),
  });
  return {
    id: 'memhub-l1-search',
    title: '一次 L1 记忆检索怎样返回结果？',
    topic: '记忆检索',
    commit: ctx.commit,
    indexVersion,
    relations: [
      {
        from: 'request',
        to: 'capacity',
        kind: 'sequence',
        label: '校验通过后调用检索',
        fromAnchor: 2,
        toAnchor: 0,
      },
      {
        from: 'capacity',
        to: 'recall',
        kind: 'branch',
        label: '至少一种检索能力可用',
        fromAnchor: 0,
        toAnchor: 0,
      },
      {
        from: 'recall',
        to: 'empty',
        kind: 'branch',
        label: '两路都没有命中',
        fromAnchor: 2,
        toAnchor: 0,
      },
      {
        from: 'recall',
        to: 'filter',
        kind: 'sequence',
        label: '召回返回后开始筛选',
        fromAnchor: 0,
        toAnchor: 0,
      },
    ],
    steps: [
      {
        id: 'request',
        kind: 'source',
        title: '校验请求与检索范围',
        description:
          '网关校验请求，将 team、user、agent、task 条件传给检索函数。相同范围内可跨会话召回。',
        anchors: [
          cite(gateway, 1205, '校验请求'),
          cite(gateway, 1215, '组装检索范围'),
          cite(gateway, 1222, '调用 executeMemorySearch'),
        ],
      },
      {
        id: 'capacity',
        kind: 'branch',
        title: '检索能力是否可用',
        description:
          '存储可用时检查 embedding、全文检索和原生混合检索。三者均不可用会提前返回空数组、策略 none 和配置说明。',
        anchors: [cite(search, 121, '判断可用能力'), cite(search, 126, '查看返回策略与说明')],
      },
      {
        id: 'recall',
        kind: 'source',
        title: '召回候选记忆',
        description:
          '有可用能力时，按 limit 的三倍请求候选。原生混合检索可一次查询，其余路径可并行查询全文和向量。两路的完成顺序未知。',
        anchors: [
          cite(search, 135, '调用 recallL1Candidates'),
          cite(recall, 71, '原生混合检索'),
          cite(recall, 84, '并行查询'),
        ],
      },
      {
        id: 'empty',
        kind: 'branch',
        title: '检索执行后没有命中',
        description:
          '全文和向量均无命中时，候选为空，仍记录 embedding 或 fts 策略。可用策略帮助读者区分此结果和能力不足时的提前返回。',
        anchors: [cite(recall, 110, '零命中时的策略'), cite(search, 170, '传回实际召回策略')],
      },
      {
        id: 'filter',
        kind: 'source',
        title: '筛选、截取并返回',
        description: '按记忆类型和场景筛选，再按 limit 截取。total 是本次实际返回的条数。',
        anchors: [
          cite(search, 149, '类型条件'),
          cite(search, 154, '场景条件'),
          cite(search, 160, '截取结果'),
          cite(search, 169, '结果条数'),
        ],
      },
    ],
  };
}
