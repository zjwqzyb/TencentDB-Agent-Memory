// Playwright CLI run-code --filename. UI fixture only, not SDK evidence.
async (page) => {
  const context = page.context();
  const state = { version: 'v1', responseState: 'ready', actionState: {}, httpStatus: 200, delayByNode: {}, delayByAsset: {}, delayByAction: {}, requests: [], unknown: [], sourceUnavailable: false, truncated: false, sparseSearch: false, emptyContinuation: false, dependencyPartial: false, modePages: false };
  const user = { user_id: 'user-browser', username: 'browser-tester', display_name: 'Browser Tester', user_type: 'normal', status: 'active' };
  const stamp = '2026-10-19T00:00:00Z';
  const team = { team_id: 'team-browser', name: 'CodeGraph Browser Fixture', owner_user_id: user.user_id, status: 'active', created_at: stamp, updated_at: stamp };
  const agent = { agent_id: 'agent-browser', team_id: team.team_id, owner_user_id: user.user_id, name: 'Browser Agent', status: 'active', visibility: 'team', created_at: stamp, updated_at: stamp, metadata_json: '{}' };
  const asset = id => ({ knowledge_id: id, code_graph_id: id, asset_type: 'code_graph', name: id === 'cg-browser-a' ? 'call-fixture-alpha' : 'call-fixture-beta', repo_name: id === 'cg-browser-a' ? 'call-fixture-alpha' : 'call-fixture-beta', repo_url: `https://github.com/fixture/${id}.git`, branch: 'main', commit_hash: state.version === 'v1' ? '1111111111111111111111111111111111111111' : '2222222222222222222222222222222222222222', team_id: team.team_id, visibility: 'team', owner_user_id: user.user_id, meta_status: 'active', status: 'ready', version: state.version, stats: { files: 4, nodes: 6, edges: 7 }, last_sync_at: stamp, created_at: stamp, updated_at: stamp });
  const shapes = [
    ['a', 'entry', 'function', 'src/main.ts', 2],
    ['b', 'helper', 'function', 'src/helper.ts', 5],
    ['c', 'upstream', 'function', 'src/caller.ts', 8],
    ['d', 'entry', 'method', 'src/other.ts', 12],
    ['derived', 'Derived', 'class', 'src/types.ts', 21],
    ['base', 'Base', 'class', 'src/base.ts', 3],
    ['iface', 'Readable', 'interface', 'src/types.ts', 2],
    ['external', 'ExternalChild', 'class', 'src/external.ts', 3],
    ['isolated', 'Standalone', 'class', 'src/standalone.ts', 1],
    ['utility', 'utility', 'function', 'lib/utils.ts', 5],
  ];
  function graph(id, request, action, snapshot) {
    const prefix = `${id}@${snapshot.version}:`;
    const nodes = shapes.map(([key, name, kind, filePath, startLine]) => ({ id: prefix + key, name, qualifiedName: `${filePath}:${name}`, kind, filePath, language: 'typescript', startLine, endLine: startLine + 1 }));
    const edges = [['aa', 'a', 'a'], ['ab-1', 'a', 'b'], ['ab-2', 'a', 'b'], ['ba', 'b', 'a'], ['ca', 'c', 'a'], ['bd', 'b', 'd'], ['db', 'd', 'b']].map(([key, source, target], index) => ({ id: prefix + key, source: prefix + source, target: prefix + target, kind: 'calls', evidence: [{ filePath: nodes.find(node => node.id === prefix + source).filePath, line: index + 2 }] }));
    const result = { state: snapshot.responseState, assetId: id, indexVersion: snapshot.version, commit: asset(id).commit_hash, indexedAt: stamp, branch: 'main', capabilities: { sdkVersion: '1.6.2', modes: { calls: { supported: true }, impact: { supported: true }, dependencies: { supported: true }, clusters: { supported: true }, hierarchy: { supported: true, limitations: ['typescript_interface_extends_not_extracted'] } }, languages: ['typescript', 'javascript'], edgeKinds: ['calls'] }, nodes: [], edges: [], focusId: request.nodeId || null, truncated: snapshot.truncated, truncationReasons: snapshot.truncated ? ['node_budget'] : [], nextCursor: snapshot.truncated ? 'fixture-next' : null, warnings: [] };
    if (request.indexVersion && request.indexVersion !== snapshot.version) result.state = 'version_expired';
    if (snapshot.actionState[action]) result.state = snapshot.actionState[action];
    if (result.state !== 'ready') return result;
    if (action === 'graph-tree') result.nodes = [...new Set(nodes.map(node => node.filePath))].map((filePath, index) => ({ id: prefix + 'file-' + index, name: filePath.split('/').pop(), qualifiedName: filePath, kind: 'file', filePath, language: 'typescript', startLine: 1, endLine: 20 }));
    if (action === 'graph-search') result.nodes = nodes.filter(node => (!request.query || `${node.name} ${node.filePath}`.toLowerCase().includes(request.query.toLowerCase())) && (!request.scopePath || node.filePath.startsWith(request.scopePath)) && (!request.nodeKinds?.length || request.nodeKinds.includes(node.kind)));
    if (action === 'graph-search' && snapshot.sparseSearch && !request.cursor) { result.nodes = []; result.nextCursor = 'sparse-next'; result.truncated = true; result.truncationReasons = ['scan_budget']; }
    if (action === 'graph-search' && request.cursor === 'sparse-next') { result.nextCursor = null; result.truncated = false; result.truncationReasons = []; }
    if (action === 'graph-node' || action === 'graph-source') {
      result.nodes = nodes.filter(node => node.id === request.nodeId);
      if (action === 'graph-source' && result.nodes[0]) {
        const node = result.nodes[0];
        if (snapshot.sourceUnavailable) { result.state = 'source_unavailable'; result.warnings = ['source_changed_since_index']; }
        else result.source = { nodeId: node.id, filePath: node.filePath, startLine: request.sourceLine || node.startLine, endLine: (request.sourceLine || node.startLine) + 1, content: `// ${id} ${snapshot.version} ${node.name}\nfunction ${node.name}() { return "${node.id}"; }`, contentHash: '0'.repeat(64) };
      }
    }
    if (action === 'graph' && request.nodeId && (!request.mode || request.mode === 'calls')) {
      const seen = new Set([request.nodeId]);
      const chosen = new Map();
      let frontier = [request.nodeId];
      for (let depth = 0; depth < (request.depth || 1); depth++) {
        const next = [];
        for (const focus of frontier) for (const edge of edges) {
          const direction = request.direction || 'both';
          if (!((direction !== 'in' && edge.source === focus) || (direction !== 'out' && edge.target === focus))) continue;
          chosen.set(edge.id, edge);
          for (const endpoint of [edge.source, edge.target]) if (!seen.has(endpoint)) { seen.add(endpoint); next.push(endpoint); }
        }
        frontier = next;
      }
      result.nodes = nodes.filter(node => seen.has(node.id));
      result.edges = [...chosen.values()];
    }
    if (action === 'graph' && request.mode === 'impact' && request.nodeId) {
      const distance = new Map([[request.nodeId, 0]]);
      const paths = new Map([[request.nodeId, { nodeId: request.nodeId, nodeIds: [request.nodeId], edgeIds: [] }]]);
      const chosen = new Map();
      let frontier = [request.nodeId];
      for (let depth = 1; depth <= (request.depth || 2); depth++) {
        const next = [];
        for (const focus of frontier) for (const edge of edges) {
          if (edge.target !== focus || !request.edgeKinds?.includes(edge.kind)) continue;
          chosen.set(edge.id, edge);
          if (!distance.has(edge.source)) {
            distance.set(edge.source, depth); next.push(edge.source);
            const tail = paths.get(focus);
            paths.set(edge.source, { nodeId: edge.source, nodeIds: [edge.source, ...tail.nodeIds], edgeIds: [edge.id, ...tail.edgeIds] });
          }
        }
        frontier = next;
      }
      result.nodes = nodes.filter(node => distance.has(node.id)).map(node => ({ ...node, depth: distance.get(node.id) }));
      result.edges = [...chosen.values()];
      result.impactPaths = [...paths.values()];
      result.warnings = ['static_analysis_potential_impact', 'unresolved_or_dynamic_relations_not_complete'];
      if (snapshot.modePages) {
        if (!request.cursor) { result.nodes = result.nodes.filter(node => node.depth < 2); result.edges = result.edges.filter(edge => result.nodes.some(node => node.id === edge.source)); result.impactPaths = result.impactPaths.filter(path => path.edgeIds.length < 2); result.nextCursor = 'impact-page2'; result.truncated = true; }
        else { result.nodes = result.nodes.filter(node => node.depth >= 2); result.edges = result.edges.filter(edge => result.nodes.some(node => node.id === edge.source)); result.impactPaths = result.impactPaths.filter(path => path.edgeIds.length >= 2); result.nextCursor = null; result.truncated = false; }
      }
    }
    if (action === 'graph' && request.mode === 'hierarchy' && request.nodeId) {
      const focal = nodes.find(node => node.id === request.nodeId);
      if (!['class', 'interface'].includes(focal?.kind)) { result.state = 'empty'; result.warnings = ['select_a_type']; return result; }
      if (focal.kind === 'interface') result.warnings = ['typescript_interface_extends_not_extracted'];
      if (focal.name === 'ExternalChild') result.unresolved = [{ sourceId: focal.id, name: 'UnknownBase', kind: 'extends', filePath: focal.filePath, line: focal.startLine }];
      const typeEdges = [['derived-base', 'derived', 'base', 'extends'], ['derived-iface', 'derived', 'iface', 'implements']].map(([key, source, target, kind]) => ({ id: prefix + key, source: prefix + source, target: prefix + target, kind, evidence: [{ filePath: 'src/types.ts', line: 21 }] }));
      const seen = new Set([request.nodeId]), chosen = new Map();
      let frontier = [request.nodeId];
      for (let depth = 0; depth < (request.depth || 1); depth++) {
        const next = [];
        for (const focus of frontier) for (const edge of typeEdges) {
          if (!request.edgeKinds?.includes(edge.kind) || !((request.direction !== 'in' && edge.source === focus) || (request.direction !== 'out' && edge.target === focus))) continue;
          chosen.set(edge.id, edge);
          for (const endpoint of [edge.source, edge.target]) if (!seen.has(endpoint)) { seen.add(endpoint); next.push(endpoint); }
        }
        frontier = next;
      }
      result.nodes = nodes.filter(node => seen.has(node.id)); result.edges = [...chosen.values()];
      if (focal.kind === 'interface' && !result.edges.length) result.state = 'unsupported';
    }
    if (action === 'graph' && request.mode === 'dependencies') {
      const file = request.groupBy === 'file';
      const group = (key, name, path) => ({ id: prefix + 'dependency-group:' + key, name, qualifiedName: path, kind: file ? 'file' : 'module', filePath: path, language: '', startLine: 0, endLine: 0, aggregate: { path, level: file ? 'file' : 'directory', fileCount: file ? 1 : 2, symbolCount: file ? 1 : 2, complete: !snapshot.dependencyPartial, internalCount: 1, resolution: 'internal' } });
      const moduleA = group('src', file ? 'main.ts' : 'src', file ? 'src/main.ts' : 'src');
      const moduleB = group('lib', file ? 'helper.ts' : 'lib', file ? 'src/helper.ts' : 'lib');
      const root = group('root', file ? 'root.ts' : '.', file ? 'root.ts' : '.');
      const kind = request.edgeKinds?.[0] || 'imports';
      const aggregateEdges = [
        { id: prefix + 'dependency-edge:ab', source: moduleA.id, target: moduleB.id, kind, count: request.cursor ? 3 : 2, complete: !snapshot.dependencyPartial, resolution: 'internal', evidence: [{ filePath: 'src/main.ts', line: 2 }] },
        { id: prefix + 'dependency-edge:ba', source: moduleB.id, target: moduleA.id, kind, count: 1, complete: !snapshot.dependencyPartial, resolution: 'internal', evidence: [{ filePath: 'src/helper.ts', line: 5 }] },
      ];
      result.focusId = null; result.nodes = request.scopePath === '.' ? [root] : [moduleA, moduleB, root]; result.edges = request.scopePath === '.' ? [] : aggregateEdges;
      result.aggregation = { groupBy: file ? 'file' : 'directory', moduleDepth: request.moduleDepth || 1, complete: !snapshot.dependencyPartial && (!snapshot.modePages || !!request.cursor), countMetric: kind === 'imports' ? 'unique_import_site_target_file' : 'unique_call_site_target_file', merge: 'replace', distinctSiteCount: 3, scannedEdges: 4, scannedNodes: 4 };
      result.cycles = result.edges.length && !snapshot.dependencyPartial ? [{ id: prefix + 'cycle', nodeIds: [moduleA.id, moduleB.id], edgeIds: aggregateEdges.map(edge => edge.id), complete: true }] : [];
      if (snapshot.modePages) { result.nextCursor = request.cursor ? null : 'aggregate-page2'; result.truncated = !request.cursor; }
      if (request.evidenceFor) { result.nodes = []; result.edges = []; result.cycles = []; result.dependencyEvidence = [{ id: prefix + (request.cursor ? 'site2' : 'site1'), sourceId: prefix + 'a', targetId: prefix + 'b', sourceFile: 'src/main.ts', targetFile: 'src/helper.ts', line: request.cursor ? 700 : 2, kind, resolution: 'internal' }]; result.nextCursor = request.cursor ? null : 'evidence-page2'; result.truncated = !request.cursor; }
    }
    if (action === 'graph' && request.mode === 'clusters') {
      const level = request.groupBy || 'directory', scope = request.scopePath || '', kind = request.edgeKinds?.[0] || 'imports';
      const externalPath = scope.startsWith('lib') ? 'src' : 'lib';
      const aggregate = (path, groupLevel, boundary = false) => ({ id: prefix + 'cluster-group:' + groupLevel + ':' + path, name: path.split('/').pop(), qualifiedName: path, kind: groupLevel === 'file' ? 'file' : 'module', filePath: path, language: '', startLine: 0, endLine: 0, aggregate: { path, level: groupLevel, fileCount: groupLevel === 'directory' ? 2 : 1, symbolCount: groupLevel === 'directory' ? 2 : 1, complete: !boundary, boundary, resolution: 'internal', internalCount: 0 } });
      const src = aggregate('src','directory'), lib = aggregate('lib','directory'), root = aggregate('.','directory'), boundary = aggregate(externalPath,'directory',true);
      const filePath = scope.startsWith('lib') ? 'lib/utils.ts' : 'src/main.ts';
      const focus = level === 'symbol' ? nodes.find(node => node.id === request.nodeId || node.filePath === scope) : level === 'file' ? aggregate(filePath,'file') : src;
      result.nodes = level === 'directory' ? [src,lib,root] : focus ? [focus,boundary] : [];
      result.focusId = level === 'symbol' ? request.nodeId || null : null;
      const left = level === 'directory' ? src : focus, right = level === 'directory' ? lib : boundary;
      result.edges = left ? [
        { id: prefix+'cluster-edge:'+left.id+':'+right.id, source: left.id, target: right.id, kind, count: request.cursor ? 3 : 2, complete:true,resolution:'internal',evidence:[{filePath, line:2}] },
        { id: prefix+'cluster-edge:'+right.id+':'+left.id, source: right.id, target:left.id,kind,count:1,complete:true,resolution:'internal',evidence:[{filePath:'lib/utils.ts',line:5}] }
      ] : [];
      if (scope === 'empty') { result.nodes=[]; result.edges=[]; }
      if (scope === '.') { result.nodes=[aggregate('root.ts',level === 'directory' ? 'directory' : 'file')]; result.edges=[]; }
      result.aggregation = {groupBy:level,moduleDepth:request.moduleDepth||1,complete:true,countMetric:kind === 'calls' ? 'unique_call_site_target_file' : 'unique_import_site_target_file',merge:'replace',distinctSiteCount:3,scannedEdges:4,scannedNodes:4};
      const breadcrumbs=[{path:'',groupBy:'directory',label:'/'}];
      if(scope) { const directory=scope.includes('/') ? scope.slice(0,scope.lastIndexOf('/')) : scope; breadcrumbs.push({path:directory,groupBy:'file',label:directory}); if(level==='symbol')breadcrumbs.push({path:scope,groupBy:'symbol',label:scope.split('/').pop()}); }
      result.clustering={groupBy:level,scopePath:scope,moduleDepth:request.moduleDepth||1,boundaryPolicy:'both',breadcrumbs};
      if (snapshot.clusterCollapsed) { result.nodes.push({ ...aggregate(scope || 'src', level === 'symbol' ? 'file' : 'directory'), id: prefix+'cluster-collapsed', name: 'remaining', kind:'collapsed', aggregate: {path:scope,level:level === 'symbol' ? 'file' : 'directory',fileCount:20,symbolCount:100,complete:false,collapsed:true} }); result.truncated=true; result.truncationReasons=['collapsed_node_budget']; }
      if (snapshot.modePages) { result.nextCursor=request.cursor?null:'cluster-next'; result.truncated=!request.cursor; result.aggregation.complete=!!request.cursor; }
      if(request.evidenceFor) {result.nodes=[];result.edges=[];result.dependencyEvidence=[{id:prefix+'cluster-site',sourceId:prefix+'a',targetId:prefix+'utility',sourceFile:'src/main.ts',targetFile:'lib/utils.ts',line:2,kind,resolution:'internal'}];result.nextCursor=null;result.truncated=false;}
    }
    if (snapshot.extraWarnings) result.warnings.push(...snapshot.extraWarnings);
    if (snapshot.extraReasons) { result.truncated = true; result.truncationReasons = snapshot.extraReasons; result.nextCursor = snapshot.extraCursor || null; }
    if (request.cursor && snapshot.emptyContinuation) { result.nodes = []; result.edges = []; result.state = 'empty'; result.nextCursor = null; }
    if (!result.nodes.length && !result.dependencyEvidence?.length && result.state === 'ready') result.state = 'empty';
    return result;
  }
  await context.unroute('**/api/v1/**');
  await context.unroute('**/__codegraph-test');
  await context.route('**/__codegraph-test', async route => {
    if (route.request().method() === 'POST') {
      const changes = route.request().postDataJSON();
      if (changes.clearRequests) state.requests = [];
      Object.assign(state, changes);
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(state) });
  });
  await context.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let request = {};
    try { request = route.request().postDataJSON() || {}; } catch {}
    state.requests.push({ path, body: request, at: Date.now() });
    let data;
    let status = 200;
    if (path.endsWith('/auth/verify')) data = { valid: true, user };
    else if (path.endsWith('/meta/instances')) { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ instances: [{ instance_id: 'service-browser', name: 'Browser fixture', gateway_endpoint: 'http://fixture.invalid' }], capabilities: { analyticsEnabled: false } }) }); return; }
    else if (path.endsWith('/team/list')) data = { items: [team], total: 1 };
    else if (path.endsWith('/team/get')) data = team;
    else if (path.endsWith('/team-member/list')) data = { items: [{ user_id: user.user_id, team_id: team.team_id, role: 'member', status: 'active' }], total: 1 };
    else if (path.endsWith('/agent/list')) data = { items: [agent], total: 1 };
    else if (path.endsWith('/user/get')) data = user;
    else if (path.endsWith('/user/batch-get')) data = { items: [user], total: 1 };
    else if (path.endsWith('/code-graph/team-assets')) data = { items: ['cg-browser-a', 'cg-browser-b'].map(asset), total: 2 };
    else if (path.endsWith('/knowledge/agent-fixed')) data = { items: ['cg-browser-a', 'cg-browser-b'].map(id => ({ ...asset(id), agent_id: agent.agent_id })), total: 2 };
    else if (path.endsWith('/code-graph/get')) data = asset(request.code_graph_id);
    else if (path.endsWith('/code-graph/sync')) { state.version = state.version === 'v1' ? 'v2' : 'v3'; data = { queued: true }; }
    else if (path.endsWith('/code-graph/register-meta')) data = { registered: true };
    else if (path.endsWith('/code-graph/search')) data = { text: '**Legacy search fixture**\nentry src/main.ts:2', isError: false };
    else if (path.endsWith('/code-graph/explore')) data = { text: '**Legacy explore fixture**\nentry calls helper', isError: false };
    else if (/\/code-graph\/graph(?:-search|-tree|-node|-source)?$/.test(path)) {
      const snapshot = { ...state };
      const action = path.split('/').pop();
      const delay = Number(snapshot.delayByAction[action] || snapshot.delayByNode[request.nodeId] || snapshot.delayByAsset[request.code_graph_id] || 0);
      data = graph(request.code_graph_id, request, action, snapshot);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      status = snapshot.httpStatus;
      if (status === 0) { await route.abort('failed'); return; }
    } else {
      state.unknown.push(path);
      data = { items: [], total: 0 };
    }
    try { await route.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify({ code: status === 200 ? 0 : status, message: status === 200 ? 'ok' : 'fixture-error', request_id: 'browser-fixture', data: status === 200 ? data : null }) }); } catch { /* expected when a deliberately delayed request is aborted */ }
  });
  await context.addInitScript(({ user }) => {
    localStorage.setItem('tdai-panel.session', JSON.stringify({ instanceId: 'service-browser', instanceName: 'Browser fixture', userKey: 'fixture-only-no-secret', user }));
    localStorage.setItem('tdai-memory.activeTeam.v1', 'team-browser');
    localStorage.setItem('tdai-panel.onboarded.user-browser', '1');
    if (!localStorage.getItem('tdai-memory.lang')) localStorage.setItem('tdai-memory.lang', 'zh-CN');
    if (localStorage.getItem('codegraph-test-no-webgl') === '1') {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(kind, ...args) { return /webgl/i.test(kind) ? null : original.call(this, kind, ...args); };
    }
  }, { user });
  await page.goto('http://127.0.0.1:15173/#/code');
  await page.reload();
  return { ready: true, fixture: 'mock API / real CodePage', control: '/__codegraph-test' };
}
