// Playwright UI fixture for the model-configuration settings tab. Backend is mocked.
async (page) => {
  const context = page.context();
  const stamp = '2026-10-26T00:00:00Z';
  const user = {
    user_id: 'user-admin-browser',
    username: 'admin-browser',
    display_name: 'Admin Browser',
    user_type: 'system_admin',
    status: 'active',
    created_at: stamp,
    updated_at: stamp,
  };
  const team = {
    team_id: 'team-browser',
    name: 'Browser Team',
    owner_user_id: user.user_id,
    status: 'active',
    created_at: stamp,
    updated_at: stamp,
  };
  const state = {
    configured: false,
    managed: false,
    source: 'deployment',
    config_id: null,
    enabled: false,
    version: 0,
    draft: null,
    conflictOnce: false,
    createDelayMs: 0,
    role: 'system_admin',
    // 连接测试 fixture：pass（三条全通过）/ fail（json 与 tools 失败）/ hang（永不返回，用于取消）
    testScenario: 'pass',
    test: null,
    activeSnapshot: null,
    requests: [],
  };

  await context.unroute('**/api/v1/**');
  await context.unroute('**/__model_config_fixture');
  await context.route('**/__model_config_fixture', async (route) => {
    if (route.request().method() === 'POST') Object.assign(state, route.request().postDataJSON());
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(state) });
  });
  const config = () => ({
    configured: state.configured,
    managed: state.managed,
    source: state.source,
    config_id: state.config_id,
    provider: state.configured ? state.provider : null,
    protocol: 'openai-chat',
    base_url: state.configured ? state.baseUrl : '',
    api_key_configured: state.configured ? state.apiKeyConfigured : false,
    api_key_masked: state.configured && state.apiKeyConfigured ? '••••••••' : '',
    model_id: state.configured ? state.modelId : null,
    description: state.configured ? state.description : '',
    enabled: state.config_id ? state.enabled : null,
    version: state.version,
    updated_at: state.config_id ? stamp : null,
    draft: state.draft,
    paused: Boolean(state.config_id && state.enabled === false && state.activeSnapshot),
    active_snapshot: state.activeSnapshot,
    test: state.test,
  });
  await context.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch {}
    state.requests.push({ path, body, at: Date.now() });
    let data;
    let status = 200;
    if (path.endsWith('/meta/instance-upstream/extraction/test')) {
      const testId = 'mct_fixture_0001';
      const fingerprint = 'sha256:0123456789abcdef';
      if (state.testScenario === 'hang') {
        // 故意不 fulfill：让请求保持挂起，供 UI 取消验收使用。
        const failure = route.request().failure();
        if (failure && typeof failure.catch === 'function') failure.catch(() => undefined);
        return;
      }
      const results = state.testScenario === 'fail'
        ? [
            { capability: 'basic', status: 'passed', duration_ms: 120 },
            { capability: 'json', status: 'failed', duration_ms: 140, error: { code: 'JSON_INVALID', message: 'Model output was not parseable JSON.' } },
            { capability: 'tools', status: 'failed', duration_ms: 160, error: { code: 'TOOL_CALL_UNSUPPORTED', message: 'Model did not emit the requested tool call.' } },
          ]
        : [
            { capability: 'basic', status: 'passed', duration_ms: 118 },
            { capability: 'json', status: 'passed', duration_ms: 133 },
            { capability: 'tools', status: 'passed', duration_ms: 271 },
          ];
      const doneStatus = state.testScenario === 'fail' ? 'failed' : 'completed';
      const lines = [
        { type: 'started', test_id: testId, fingerprint, source: state.draft ? 'panel' : 'deployment', instance_id: 'instance-browser', capabilities: ['basic', 'json', 'tools'] },
        ...results.map((result) => ({ type: 'result', test_id: testId, ...result })),
        { type: 'done', test_id: testId, status: doneStatus, duration_ms: 522 },
      ];
      state.test = {
        test_id: testId,
        fingerprint,
        passed: state.testScenario !== 'fail',
        tested_at: stamp,
        expires_at: '2026-10-26T00:15:00Z',
        matches_current: true,
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      });
      return;
    }
    if (path.endsWith('/auth/verify')) data = { valid: true, user: { ...user, user_type: state.role } };
    else if (path.endsWith('/auth/session')) data = { authenticated: false };
    else if (path.endsWith('/auth/methods')) data = { methods: [] };
    else if (path.endsWith('/meta/instances')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        instances: [{ instance_id: 'instance-browser', name: 'Memhub Browser Instance', gateway_endpoint: 'http://fixture.invalid' }],
        capabilities: { analyticsEnabled: false },
      }) });
      return;
    } else if (path.endsWith('/meta/team/list')) data = { items: [team], total: 1 };
    else if (path.endsWith('/meta/team/get')) data = team;
    else if (path.endsWith('/meta/team-member/list')) data = { items: [{ user_id: user.user_id, team_id: team.team_id, role: 'member', status: 'active' }], total: 1 };
    else if (path.endsWith('/meta/agent/list')) data = { items: [], total: 0 };
    else if (path.endsWith('/meta/task/list') || path.endsWith('/meta/issue/list')) data = { items: [], total: 0 };
    else if (path.endsWith('/meta/user/get')) data = { ...user, user_type: state.role };
    else if (path.endsWith('/meta/config/user/get')) data = { user_id: user.user_id, module: 'asset_type', module_description: '', items: [] };
    else if (path.endsWith('/meta/instance-upstream/extraction/get')) data = config();
    else if (path.endsWith('/meta/instance-upstream/extraction/create')) {
      if (state.createDelayMs) await new Promise((resolve) => setTimeout(resolve, state.createDelayMs));
      state.managed = true;
      state.config_id = 'ext-browser';
      state.version = 1;
      state.enabled = false;
      state.draft = {
        configured: true,
        provider: body.provider,
        protocol: 'openai-chat',
        base_url: body.base_url,
        api_key_configured: true,
        model_id: body.model_id,
        description: body.description || '',
        updated_at: stamp,
      };
      data = config();
    } else if (path.endsWith('/meta/instance-upstream/extraction/enable')) {
      if (!state.test || state.test.passed !== true || state.test.matches_current !== true) {
        status = 409;
        data = { code: 409, message: 'test_required', request_id: 'fixture', data: null };
      } else if (body.test_id !== state.test.test_id) {
        status = 409;
        data = { code: 409, message: 'test_stale', request_id: 'fixture', data: null };
      } else {
        state.version += 1;
        state.configured = true;
        state.managed = true;
        state.enabled = true;
        state.provider = state.draft.provider;
        state.baseUrl = state.draft.base_url;
        state.apiKeyConfigured = true;
        state.modelId = state.draft.model_id;
        state.description = state.draft.description;
        state.activeSnapshot = {
          snapshot_id: 'snap_fixture_1',
          version: state.version,
          provider: state.draft.provider,
          base_url: state.draft.base_url,
          api_key_configured: true,
          api_key_masked: '••••••••',
          model_id: state.draft.model_id,
          description: state.draft.description,
          activated_at: stamp,
        };
        data = config();
      }
    } else if (path.endsWith('/meta/instance-upstream/extraction/resync-knowledge')) {
      data = { status: state.enabled ? 'ready' : 'paused', config_id: 'ext-browser', config_version: state.version, outcome: 'bound' };
    } else if (path.endsWith('/meta/instance-upstream/extraction/disable')) {
      state.version += 1;
      state.enabled = false;
      data = config();
    } else if (path.endsWith('/meta/instance-upstream/extraction/update')) {
      if (state.conflictOnce) {
        state.conflictOnce = false;
        status = 409;
        data = { code: 409, message: 'WRITE_CONFLICT: version mismatch', request_id: 'fixture-conflict', data: { expected: body.expected_version, actual: state.version + 1 } };
      } else {
        state.version += 1;
        state.draft = {
          ...state.draft,
          configured: true,
          provider: body.provider,
          base_url: body.base_url,
          model_id: body.model_id,
          description: body.description || '',
          api_key_configured: Boolean(body.api_key || state.draft?.api_key_configured),
          updated_at: stamp,
        };
        data = config();
      }
    } else {
      status = 404;
      data = { code: 404, message: `unhandled fixture path: ${path}`, request_id: 'fixture' };
    }
    const isMeta = path.startsWith('/api/v1/meta/');
    const responseBody = isMeta
      ? (status === 200
          ? { code: 0, message: 'ok', request_id: 'fixture', data }
          : { code: status, message: data?.message || 'fixture-error', request_id: 'fixture', data: data?.data ?? null })
      : data;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(responseBody) });
  });

  await page.goto('http://127.0.0.1:15173/');
  await page.evaluate(({ user, instanceId }) => {
    localStorage.setItem('tdai-memory.lang', 'zh-CN');
    localStorage.setItem(`tdai-panel.onboarded.${user.user_id}`, '1');
    localStorage.setItem('tdai-panel.session', JSON.stringify({
      instanceId,
      instanceName: 'Memhub Browser Instance',
      userKey: 'fixture-only-no-secret',
      user,
    }));
  }, { user, instanceId: 'instance-browser' });
  await page.reload();
  const skipGuide = page.getByRole('button', { name: '跳过引导' });
  if (await skipGuide.count()) await skipGuide.click();
  await page.getByRole('button', { name: '设置' }).waitFor();
  return { state };
}
