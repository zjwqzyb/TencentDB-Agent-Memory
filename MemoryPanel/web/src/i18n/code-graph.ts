export const codeGraphZh = {
  'code.graph.verifiedLanguages': '关系查询已验证语言：{{languages}}',
  'code.graph.noVerifiedLanguages': '暂无',
  'code.graph.chooseSymbol': '选择其他符号',
  'code.graph.openTextQuery': '使用概览与文本查询',
  'code.graph.useDirectory': '切换到目录聚合',
  'code.graph.useImports': '只查看 imports',
  'code.graph.selectCallable':
    '当前节点不适用于调用视图，请选择方法、函数或包含初始化调用的类型/字段。',
  'code.graph.unverifiedLanguage':
    '当前关系查询尚未验证 {{language}}。可继续搜索符号、查看可用源码，或使用概览与文本查询。',
  'code.graph.unverifiedSdk':
    '当前服务版本尚未通过关系查询兼容性验证。请联系管理员检查服务兼容性，或使用概览与文本查询。',
  'code.graph.unsupportedSchema':
    '当前索引格式与关系查询不兼容。请联系管理员检查索引兼容性，或使用概览与文本查询。',
  'code.graph.unsupportedView': '当前无法展示此关系视图。可选择其他视图，或使用概览与文本查询。',
  'code.graph.unsupportedGrouping': '依赖视图支持目录或文件聚合，请切换聚合层级。',
  'code.graph.selectDependencyKind': '请只选择 imports 或 calls 一种依赖关系进行查询。',
  'code.graph.selectSymbolScope': '查看真实符号前，请先选择文件范围或搜索并选择具体符号。',
  'code.graph.javaHeuristicLimit':
    '已省略索引器推断生成的 Java 调用关系，当前展示提取出的静态关系。',
  'code.graph.javaWildcardLimit': '部分星号导入无法确认目标，相关 Java 跨文件调用已省略。',
  'code.graph.javaAmbiguousLimit':
    '部分 Java 调用目标与接收者或导入不匹配，或目标无法唯一确认，相关关系已省略。',
  'code.graph.javaSourceUnverified': '部分 Java 源码或语法无法核实，相关关系已省略，结果不完整。',
  'code.graph.javaSourceBudget':
    'Java 关系验证达到本页源码读取预算，结果不完整；请缩小范围后查询。',
  'code.graph.javaSourceBudgetContinue':
    'Java 关系验证达到本页源码读取预算；可继续加载后续页或缩小范围后查询。',
  'code.graph.javaStaticLimit':
    'Java 关系来自保守静态分析，可能遗漏动态分派、反射及无法确认的调用。',
  'code.graph.diagnosticBudget':
    '未解析关系诊断达到显示上限，列表不完整；已显示的关系证据仍可查看。',
  'code.graph.distinctSites':
    '当前已核实 {{count}} 个唯一引用位置与目标文件组合；跨层级按此总数对账，请勿累加每条连线计数。',
  'code.graph.collapsedBudget':
    '部分成员因节点预算保持折叠；请搜索具体符号或缩小范围以展开，不能将此占位当作独立源码。',
  'code.graph.direction.clusters': '按目录、文件逐层展开；保留进入和离开当前范围的跨组关系。',
  'code.graph.clusterScope': '聚类范围（双向边界）',
  'code.graph.symbolLevel': '真实符号',
  'code.graph.breadcrumbs': '聚类浏览路径',
  'code.graph.repositoryRoot': '仓库根目录',
  'code.graph.collapseGroup': '折叠当前层',
  'code.graph.boundary': '跨组端点',
  'code.graph.boundaryGroup':
    '这是当前范围外的折叠端点，保留跨组入向与出向关系。可下钻查看其所在范围。',
  'code.graph.groupCounts': '{{files}} 文件 · {{symbols}} 符号',
  'code.graph.clusterHint':
    '按目录路径分组，不表示自动发现的语义模块；边界组保持折叠，统计仅覆盖当前已扫描范围。',

  'code.graph.importExtractionLimit': '统计仅覆盖索引已提取的导入；星号重导出等关系可能缺失。',
  'code.graph.importUnverified':
    '部分导入声明无法与同版本源码核对，计数不完整；请检查源码可用性并重新索引。',
  'code.graph.unknownCoverage': '外部或未解析目标的索引覆盖不可用，未知依赖可能未列出。',
  'code.graph.continueScan': '本次扫描尚未完成，可继续加载剩余关系或证据。',
  'code.graph.hardLimit':
    '已达到本次查询的节点、关系或统计容量上限。请缩小源范围，或选择更细的文件聚合后查询。',
  'code.graph.incompleteNoCursor':
    '当前结果未完整，暂无可继续加载的页面；请缩小范围或重新索引后重试。',

  'code.graph.view': '关系视图',
  'code.graph.depth': '查询跳数',
  'code.graph.relationKinds': '关系类型',
  'code.graph.aggregation': '聚合层级',
  'code.graph.directory': '目录模块',
  'code.graph.file': '文件',
  'code.graph.moduleDepth': '目录深度',
  'code.graph.dependencyScope': '依赖源范围',
  'code.graph.applyScope': '应用范围',
  'code.graph.direction.impact': '沿反向依赖查找潜在影响；箭头始终保持原始关系方向。',
  'code.graph.direction.dependencies': '依赖方 → 被依赖方；按唯一声明位置与目标文件计数。',
  'code.graph.direction.hierarchy': '子类 → 父类，实线 extends；实现类 → 接口，虚线 implements。',
  'code.graph.hierarchyExpand.in': '展开子类型',
  'code.graph.hierarchyExpand.out': '展开父类型',
  'code.graph.hierarchyExpand.both': '双向展开',
  'code.graph.impactExpand': '展开潜在影响',
  'code.graph.staticImpact': '静态分析的潜在影响，不能代表确定的运行时故障或完整影响范围。',
  'code.graph.impactSummary':
    '当前显示结果：{{symbols}} 个潜在影响符号、{{files}} 个文件；直接 {{direct}}、间接 {{indirect}}。',
  'code.graph.impactList': '当前潜在影响清单（已去重）',
  'code.graph.distance': '影响距离',
  'code.graph.direct': '直接影响',
  'code.graph.indirect': '间接影响',
  'code.graph.inspectPath': '查看 {{name}} 的证据路径',
  'code.graph.affectedFiles': '当前潜在影响文件（{{count}}）',
  'code.graph.importCountMetric':
    'imports 计数口径：唯一导入声明位置 × 目标文件；同一声明的重复解析不会累加。',
  'code.graph.callCountMetric': 'calls 计数口径：唯一调用位置 × 目标文件；与 imports 分别统计。',
  'code.graph.aggregateComplete': '当前范围的索引扫描已完成；不代表源码依赖已完整提取。',
  'code.graph.aggregatePartial': '当前索引扫描未完成或证据未核实；计数仅覆盖已验证部分。',
  'code.graph.cycles': '已证实的循环依赖',
  'code.graph.cycleGroup': '循环依赖组',
  'code.graph.noCycles': '当前范围已提取并完成扫描的索引关系中未发现循环。',
  'code.graph.noConfirmedCycles': '已加载范围尚未证实循环；查询未完成，不能据此排除循环。',
  'code.graph.partial': '部分结果',
  'code.graph.complete': '完整结果',
  'code.graph.selectType': '请选择 class 或 interface 类型；当前符号不适用于继承视图。',
  'code.graph.analysisCoverage':
    '静态解析可能遗漏动态调用、外部依赖或当前语言未支持的结构；这里只展示索引中有证据的关系。',
  'code.graph.unresolved': '外部或未解析关系（{{count}}）',
  'code.graph.unresolvedHint': '以下记录没有可验证的目标节点，不会补造节点、连线或目标源码。',
  'code.graph.sourceNode': '关系起点',
  'code.graph.targetNode': '关系终点',
  'code.graph.resolution.internal': '已索引内部关系',
  'code.graph.resolution.external': '外部依赖',
  'code.graph.resolution.unresolved': '目标未解析',
  'code.graph.aggregateCounts':
    '{{files}} 个文件 · {{symbols}} 个符号 · {{internal}} 条模块内部依赖',
  'code.graph.aggregateNoSource': '聚合节点代表目录或文件集合，没有独立源码；请下钻到真实符号。',
  'code.graph.drillFiles': '下钻到文件',
  'code.graph.drillSymbols': '查看文件内符号',
  'code.graph.evidencePath': '真实方向的证据路径',
  'code.graph.onlyPath': '仅显示此路径',
  'code.graph.cycleEvidence': '循环组成边',
  'code.graph.edgeCount': '已扫描唯一证据 {{count}} 条',
  'code.graph.inspectImportSource': '查看声明源码',
  'code.graph.evidencePartial': '证据列表未完整，可继续加载；源码片段仍遵循行数预算。',
  'code.graph.moreEvidence': '加载更多证据',
  'code.graph.distanceFilter': '显示影响层级',
  'code.graph.allDistances': '全部层级',
  'code.graph.highlightPath': '高亮证据路径',
  'code.graph.clearPath': '取消路径高亮',
  'code.graph.overview': '概览与文本查询',
  'code.graph.tab': '关系图',
  'code.graph.interfaceExtendsLimit':
    '当前索引器未提取 TypeScript 接口继承关系；可查看类继承和接口实现关系',
  'code.graph.mode.calls': '调用关系图',
  'code.graph.mode.impact': '潜在影响范围',
  'code.graph.mode.dependencies': '模块依赖',
  'code.graph.mode.clusters': '目录聚类总览',
  'code.graph.mode.hierarchy': '继承与实现',
  'code.graph.directionHint': '调用者 → 被调用者 · 默认一跳 · 单击节点查看源码',
  'code.graph.search': '目录与搜索',
  'code.graph.symbol': '搜索符号',
  'code.graph.searchHint': '函数名或类名',
  'code.graph.scope': '目录或文件范围',
  'code.graph.searchButton': '搜索',
  'code.graph.files': '浏览文件',
  'code.graph.noResults': '当前范围没有匹配结果。',
  'code.graph.partialSearch': '当前仅扫描了部分索引；可以继续加载或缩小搜索范围。',
  'code.graph.moreResults': '继续查找',
  'code.graph.details': '节点详情与源码',
  'code.graph.selectHint': '从左侧文件或符号搜索中选择一个节点，开始浏览关系。',
  'code.graph.copy': '复制位置',
  'code.graph.focus': '以此为焦点',
  'code.graph.openSource': '打开此提交源码',
  'code.graph.version': '索引版本',
  'code.graph.source': '同版本源码',
  'code.graph.sourceTruncated': '源码片段已截断，仅显示预算内的行。',
  'code.graph.camera': '画布控制',
  'code.graph.zoomIn': '放大',
  'code.graph.zoomOut': '缩小',
  'code.graph.fit': '适应画布',
  'code.graph.back': '返回焦点',
  'code.graph.collapse': '撤销展开',
  'code.graph.reset': '重置',
  'code.graph.kind': '节点类型',
  'code.graph.allKinds': '全部类型',
  'code.graph.showCanvas': '显示关系图',
  'code.graph.showList': '关系列表',
  'code.graph.retry': '重新加载',
  'code.graph.noWebGL': '当前浏览器无法显示图形，已切换到可键盘操作的关系列表。',
  'code.graph.expand.in': '上游展开',
  'code.graph.expand.out': '下游展开',
  'code.graph.expand.both': '双向展开',
  'code.graph.count': '{{nodes}} 个节点 · {{edges}} 条关系',
  'code.graph.emptyRelations': '此节点在当前查询范围内没有关系。',
  'code.graph.filteredEmpty': '没有符合当前类型筛选的节点。',
  'code.graph.nodes': '节点列表',
  'code.graph.relations': '关系列表',
  'code.graph.location': '路径与行号',
  'code.graph.caller': '调用者',
  'code.graph.callee': '被调用者',
  'code.graph.relation': '关系',
  'code.graph.evidence': '关系证据',
  'code.graph.recursive': '递归',
  'code.graph.truncated': '结果已按服务端预算截断；可继续加载或缩小范围。',
  'code.graph.budget': '已达到可见图预算（500 节点 / 1500 条关系）。请撤销展开或选择更小范围。',
  'code.graph.moreRelations': '加载更多关系',
  'code.graph.warning': '分析提示',
  'code.graph.state.ready': '可用',
  'code.graph.state.empty': '没有结果',
  'code.graph.state.unindexed': '尚未建立索引，请同步仓库。',
  'code.graph.state.building': '索引正在构建，请稍后刷新。',
  'code.graph.state.failed': '索引构建失败，请查看仓库错误并重试同步。',
  'code.graph.state.unsupported': '当前无法展示此关系视图，请选择其他视图或使用概览与文本查询。',
  'code.graph.state.version_expired': '索引版本已变化，旧图与源码已清除，请重新加载。',
  'code.graph.state.not_found': '资源已删除或节点不在当前索引中。',
  'code.graph.state.source_unavailable': '该索引没有可用的同版本源码。',
  'code.graph.state.forbidden': '没有读取此资产的权限，或登录已失效。',
  'code.graph.state.network': '请求失败，请检查网络后重试。',
};
export const codeGraphEn = {
  'code.graph.verifiedLanguages': 'Verified languages for relation queries: {{languages}}',
  'code.graph.noVerifiedLanguages': 'None',
  'code.graph.chooseSymbol': 'Choose another symbol',
  'code.graph.openTextQuery': 'Open overview and text queries',
  'code.graph.useDirectory': 'Use directory grouping',
  'code.graph.useImports': 'Show imports only',
  'code.graph.selectCallable':
    'This node is not applicable to the calls view. Choose a method, function, or a type or field with initializer calls.',
  'code.graph.unverifiedLanguage':
    'Relation queries have not been verified for {{language}}. You can still search symbols, read available source, or use overview and text queries.',
  'code.graph.unverifiedSdk':
    'The current service version has not been verified for relation queries. Ask an administrator to check compatibility, or use overview and text queries.',
  'code.graph.unsupportedSchema':
    'This index format is incompatible with relation queries. Ask an administrator to check index compatibility, or use overview and text queries.',
  'code.graph.unsupportedView':
    'This relation view is currently unavailable. Choose another view, or use overview and text queries.',
  'code.graph.unsupportedGrouping':
    'The dependencies view supports directory or file grouping. Change the aggregation level.',
  'code.graph.selectDependencyKind': 'Select exactly one dependency relation: imports or calls.',
  'code.graph.selectSymbolScope':
    'Choose a file scope, or search for a specific symbol before viewing symbols.',
  'code.graph.javaHeuristicLimit':
    'Inferred Java calls generated by the indexer were omitted. The current view shows extracted static relations.',
  'code.graph.javaWildcardLimit':
    'Some wildcard imports have unconfirmed targets; the associated cross-file Java calls were omitted.',
  'code.graph.javaAmbiguousLimit':
    'Some Java call targets did not match the receiver or import, or could not be uniquely confirmed. Those relations were omitted.',
  'code.graph.javaSourceUnverified':
    'Some Java source or syntax could not be verified. Associated relations were omitted and results are incomplete.',
  'code.graph.javaSourceBudget':
    'Java relation verification reached the source-reading budget for this page. Results are incomplete; narrow the scope and query again.',
  'code.graph.javaSourceBudgetContinue':
    'Java relation verification reached the source-reading budget for this page. Load the next page or narrow the scope.',
  'code.graph.javaStaticLimit':
    'Java relations use conservative static analysis and may omit dynamic dispatch, reflection, and unconfirmed calls.',
  'code.graph.diagnosticBudget':
    'Unresolved-relation diagnostics reached the display limit. The list is incomplete; displayed relationship evidence remains available.',
  'code.graph.distinctSites':
    '{{count}} verified unique site and target-file pairs. Compare this total across levels; do not sum individual edge counts.',
  'code.graph.collapsedBudget':
    'Some members remain collapsed within the node budget. Search a specific symbol or narrow the scope to expand them; this placeholder has no independent source.',
  'code.graph.direction.clusters':
    'Expand directories and files step by step. Incoming and outgoing cross-group relations stay visible.',
  'code.graph.clusterScope': 'Cluster scope (both boundaries)',
  'code.graph.symbolLevel': 'Real symbols',
  'code.graph.breadcrumbs': 'Cluster navigation path',
  'code.graph.repositoryRoot': 'Repository root',
  'code.graph.collapseGroup': 'Collapse current level',
  'code.graph.boundary': 'Boundary endpoint',
  'code.graph.boundaryGroup':
    'This collapsed endpoint is outside the current scope and retains incoming and outgoing cross-group relations. Drill down to inspect its scope.',
  'code.graph.groupCounts': '{{files}} files · {{symbols}} symbols',
  'code.graph.clusterHint':
    'Groups follow directory paths, not inferred semantic modules. Boundary groups remain collapsed; counts cover the scanned scope only.',

  'code.graph.importExtractionLimit':
    'Counts cover imports extracted by the index. Star re-exports and other relationships may be missing.',
  'code.graph.importUnverified':
    'Some import declarations could not be verified against the indexed source snapshot. Counts are incomplete; check source availability and reindex.',
  'code.graph.unknownCoverage':
    'Index coverage for external or unresolved targets is unavailable. Unknown dependencies may be absent.',
  'code.graph.continueScan':
    'The scan is incomplete. Load more to continue through the remaining relations or evidence.',
  'code.graph.hardLimit':
    'The query reached its node, relation, or counting capacity. Narrow the source scope or query a finer file aggregation.',
  'code.graph.incompleteNoCursor':
    'Results are incomplete and no continuation page is available. Narrow the scope or reindex before retrying.',

  'code.graph.view': 'Relation view',
  'code.graph.depth': 'Query hops',
  'code.graph.relationKinds': 'Relation types',
  'code.graph.aggregation': 'Aggregation level',
  'code.graph.directory': 'Directory modules',
  'code.graph.file': 'Files',
  'code.graph.moduleDepth': 'Directory depth',
  'code.graph.dependencyScope': 'Dependency source scope',
  'code.graph.applyScope': 'Apply scope',
  'code.graph.direction.impact':
    'Potential impact follows reverse dependencies; arrows retain the original relation direction.',
  'code.graph.direction.dependencies':
    'Dependent → dependency; counts use unique declaration locations and target files.',
  'code.graph.direction.hierarchy':
    'Subclass → parent (solid extends); class → interface (dashed implements).',
  'code.graph.hierarchyExpand.in': 'Expand subtypes',
  'code.graph.hierarchyExpand.out': 'Expand parent types',
  'code.graph.hierarchyExpand.both': 'Expand both',
  'code.graph.impactExpand': 'Expand potential impact',
  'code.graph.staticImpact':
    'Potential impact from static analysis; this is not a prediction of runtime failure or an exhaustive impact list.',
  'code.graph.impactSummary':
    'Currently displayed: {{symbols}} potentially affected symbols in {{files}} files; {{direct}} direct, {{indirect}} indirect.',
  'code.graph.impactList': 'Current potential impact (deduplicated)',
  'code.graph.distance': 'Impact distance',
  'code.graph.direct': 'Direct impact',
  'code.graph.indirect': 'Indirect impact',
  'code.graph.inspectPath': 'Inspect evidence path for {{name}}',
  'code.graph.affectedFiles': 'Currently affected files ({{count}})',
  'code.graph.importCountMetric':
    'Imports count unique import declaration locations × target files; duplicate resolutions do not add counts.',
  'code.graph.callCountMetric':
    'Calls count unique call locations × target files, separately from imports.',
  'code.graph.aggregateComplete':
    'Index scan complete for this scope; source dependency extraction may still be incomplete.',
  'code.graph.aggregatePartial':
    'Index scanning or evidence verification is incomplete. Counts cover verified evidence only.',
  'code.graph.cycleGroup': 'Dependency cycle group',
  'code.graph.cycles': 'Confirmed dependency cycles',
  'code.graph.noCycles':
    'No cycles found among the extracted, fully scanned index relations in this scope.',
  'code.graph.noConfirmedCycles':
    'No cycle has been confirmed in loaded data. The incomplete query cannot rule out cycles.',
  'code.graph.partial': 'Partial results',
  'code.graph.complete': 'Complete results',
  'code.graph.selectType':
    'Select a class or interface. The current symbol is not a type hierarchy node.',
  'code.graph.analysisCoverage':
    'Static extraction may miss dynamic calls, external dependencies or unsupported language constructs. Only indexed relationships with evidence are shown.',
  'code.graph.unresolved': 'External or unresolved relations ({{count}})',
  'code.graph.unresolvedHint':
    'These records lack a verified target node. No target nodes, edges or source are fabricated.',
  'code.graph.sourceNode': 'Source node',
  'code.graph.targetNode': 'Target node',
  'code.graph.resolution.internal': 'Indexed internal relation',
  'code.graph.resolution.external': 'External dependency',
  'code.graph.resolution.unresolved': 'Unresolved target',
  'code.graph.aggregateCounts':
    '{{files}} files · {{symbols}} symbols · {{internal}} internal dependencies',
  'code.graph.aggregateNoSource':
    'Aggregate nodes represent directories or file groups and have no independent source. Drill down to real symbols.',
  'code.graph.drillFiles': 'Drill down to files',
  'code.graph.drillSymbols': 'Browse file symbols',
  'code.graph.evidencePath': 'Evidence path in original direction',
  'code.graph.onlyPath': 'Show only this path',
  'code.graph.cycleEvidence': 'Cycle edges',
  'code.graph.edgeCount': '{{count}} unique evidence items scanned',
  'code.graph.inspectImportSource': 'Inspect declaration source',
  'code.graph.evidencePartial':
    'Evidence is incomplete. Load more to continue; source snippets remain bounded by the line budget.',
  'code.graph.moreEvidence': 'Load more evidence',
  'code.graph.distanceFilter': 'Impact layer filter',
  'code.graph.allDistances': 'All layers',
  'code.graph.highlightPath': 'Highlight evidence path',
  'code.graph.clearPath': 'Clear path highlight',
  'code.graph.overview': 'Overview & text queries',
  'code.graph.tab': 'Repository graph',
  'code.graph.interfaceExtendsLimit':
    'The current indexer does not extract TypeScript interface inheritance. Class inheritance and interface implementations are available.',
  'code.graph.mode.calls': 'Call graph',
  'code.graph.mode.impact': 'Potential impact',
  'code.graph.mode.dependencies': 'Module dependencies',
  'code.graph.mode.clusters': 'Directory overview',
  'code.graph.mode.hierarchy': 'Inheritance & implementation',
  'code.graph.directionHint':
    'Caller → callee · One hop by default · Select a node to inspect source',
  'code.graph.search': 'Files & search',
  'code.graph.symbol': 'Search symbols',
  'code.graph.searchHint': 'Function or class name',
  'code.graph.scope': 'Directory or file scope',
  'code.graph.searchButton': 'Search',
  'code.graph.files': 'Browse files',
  'code.graph.noResults': 'No matches in this scope.',
  'code.graph.partialSearch':
    'Only part of the index has been scanned. Continue loading or narrow the scope.',
  'code.graph.moreResults': 'Continue searching',
  'code.graph.details': 'Node details & source',
  'code.graph.selectHint':
    'Choose a node from the file browser or symbol search to explore its relationships.',
  'code.graph.copy': 'Copy location',
  'code.graph.focus': 'Focus this node',
  'code.graph.openSource': 'Open source at commit',
  'code.graph.version': 'Index version',
  'code.graph.source': 'Source at index version',
  'code.graph.sourceTruncated': 'Source is truncated to the line budget.',
  'code.graph.camera': 'Canvas controls',
  'code.graph.zoomIn': 'Zoom in',
  'code.graph.zoomOut': 'Zoom out',
  'code.graph.fit': 'Fit graph',
  'code.graph.back': 'Previous focus',
  'code.graph.collapse': 'Undo expansion',
  'code.graph.reset': 'Reset',
  'code.graph.kind': 'Node type',
  'code.graph.allKinds': 'All types',
  'code.graph.showCanvas': 'Show graph',
  'code.graph.showList': 'Relations table',
  'code.graph.retry': 'Reload',
  'code.graph.noWebGL':
    'Graphics are unavailable in this browser. The keyboard accessible relations table is shown instead.',
  'code.graph.expand.in': 'Expand callers',
  'code.graph.expand.out': 'Expand callees',
  'code.graph.expand.both': 'Expand both',
  'code.graph.count': '{{nodes}} nodes · {{edges}} relations',
  'code.graph.emptyRelations': 'This node has no relations within the current query.',
  'code.graph.filteredEmpty': 'No nodes match this type filter.',
  'code.graph.nodes': 'Nodes',
  'code.graph.relations': 'Relations',
  'code.graph.location': 'Path & line',
  'code.graph.caller': 'Caller',
  'code.graph.callee': 'Callee',
  'code.graph.relation': 'Relation',
  'code.graph.evidence': 'Evidence',
  'code.graph.recursive': 'recursive',
  'code.graph.truncated':
    'Results are bounded by the server budget. Continue loading or narrow the scope.',
  'code.graph.budget':
    'Visible graph budget reached (500 nodes / 1500 relations). Undo an expansion or narrow the scope.',
  'code.graph.moreRelations': 'Load more relations',
  'code.graph.warning': 'Analysis notes',
  'code.graph.state.ready': 'Ready',
  'code.graph.state.empty': 'No results',
  'code.graph.state.unindexed': 'No index is available. Sync this repository first.',
  'code.graph.state.building': 'The index is being built. Refresh later.',
  'code.graph.state.failed':
    'Indexing failed. Check the repository error and retry synchronization.',
  'code.graph.state.unsupported':
    'This relation view is unavailable. Choose another view or use overview and text queries.',
  'code.graph.state.version_expired':
    'The index changed. The previous graph and source have been cleared. Reload to continue.',
  'code.graph.state.not_found':
    'The resource was deleted or this node is not in the current index.',
  'code.graph.state.source_unavailable': 'Source at this index version is unavailable.',
  'code.graph.state.forbidden': 'You cannot read this asset, or your login has expired.',
  'code.graph.state.network': 'The request failed. Check the network and retry.',
};
