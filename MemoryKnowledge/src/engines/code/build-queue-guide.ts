import { queryStructured, type StructuredContext } from './structured.js';

const store = 'MemoryKnowledge/src/store/';
const service = [
  store + 'code-graph-service.ts',
  '716389f206e223089fe04c205fe9714adfeaf1236e8cd53f1d2ca448d8786c99',
] as const;
const queue = [
  store + 'build-queue.ts',
  '75b8cfc1dcdba0d16d823ba3e7253f4adcd1d14cd8a0cc23a548bc4be60625a6',
] as const;
const serial = [
  store + 'serial-queue.ts',
  '71aec1e03e291cc4323ddae6e62a9828f7a862b937998203383049c9365c3a42',
] as const;
const locations = [
  {
    id: 'dispatch',
    title: '提交构建',
    file: service,
    name: 'enqueueBuild',
    line: 405,
    kind: 'async',
    description: '以资产 ID 作为队列键，提交捕获当前资产参数的闭包。',
  },
  {
    id: 'route',
    title: '按资产选择队列',
    file: queue,
    name: 'enqueue',
    line: 21,
    kind: 'async',
    description: '相同键复用同一 SerialQueue，将收到的 job 交给该队列。',
  },
  {
    id: 'queue',
    title: '保存回调',
    file: serial,
    name: 'add',
    line: 48,
    kind: 'source',
    description: '保存传入的同一回调，并尝试从队列取出下一项。',
  },
  {
    id: 'invoke',
    title: '取出并执行',
    file: serial,
    name: 'drain',
    line: 88,
    kind: 'branch',
    description: '队列正在执行、暂停或为空时返回。可以执行时取出队首并调用回调。',
  },
  {
    id: 'build',
    title: '开始构建',
    file: service,
    name: 'runBuild',
    line: 428,
    kind: 'source',
    description: '回调使用提交任务时捕获的资产参数进入 runBuild，先检查资产是否已被删除。',
  },
  {
    id: 'other',
    title: '其他资产的任务',
    file: queue,
    name: 'enqueue',
    line: 16,
    kind: 'unknown',
    description: '不同资产使用不同队列。仅凭此实现无法确定两个资产的实际开始或完成顺序。',
  },
];
export function buildQueueGuide(ctx: StructuredContext) {
  let indexVersion: string | null = null;
  const steps = [];
  for (const ref of locations) {
    const [filePath, hash] = ref.file;
    const hit = queryStructured(ctx, 'graph-search', {
      query: ref.name,
      scopePath: filePath,
      nodeKinds: ['method'],
    });
    const node = hit.nodes.find(
      (n) =>
        n.name === ref.name &&
        n.filePath === filePath &&
        n.startLine <= ref.line &&
        n.endLine >= ref.line,
    );
    if (!node || !hit.indexVersion || (indexVersion && hit.indexVersion !== indexVersion))
      return null;
    indexVersion = hit.indexVersion;
    const src = queryStructured(ctx, 'graph-source', {
      nodeId: node.id,
      indexVersion,
      sourceLine: ref.line,
    });
    if (src.state !== 'ready' || src.source?.contentHash !== hash) return null;
    steps.push({
      id: ref.id,
      kind: ref.kind,
      title: ref.title,
      description: ref.description,
      anchors: [
        { label: node.qualifiedName, nodeId: node.id, filePath, line: ref.line, contentHash: hash },
      ],
    });
  }
  return {
    id: 'memhub-build-queue',
    topic: '代码索引',
    title: '一次构建如何进入对应资产的队列？',
    commit: ctx.commit,
    indexVersion,
    steps,
    relations: [
      { from: 'dispatch', to: 'route', kind: 'async', label: '传递资产键与构建回调' },
      { from: 'route', to: 'queue', kind: 'sequence', label: 'job 作为 task 入队' },
      { from: 'queue', to: 'invoke', kind: 'branch', label: '队列可运行且队首有任务' },
      { from: 'invoke', to: 'build', kind: 'async', label: '队首回调调用 runBuild' },
      { from: 'build', to: 'other', kind: 'unknown', label: '跨资产执行次序未知' },
    ].map((edge) => ({ ...edge, fromAnchor: 0, toAnchor: 0 })),
  };
}
