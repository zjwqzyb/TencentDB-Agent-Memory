async (page) => {
  const checks = [];
  const assert = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const control = patch => page.evaluate(async value => fetch('/__codegraph-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }).then(r => r.json()), patch);
  const defaults = { version: 'v1', responseState: 'ready', actionState: {}, httpStatus: 200, delayByNode: {}, delayByAsset: {}, delayByAction: {}, sourceUnavailable: false, truncated: false, sparseSearch: false, emptyContinuation: false, clearRequests: true };
  const root = page.getByRole('button', { name: 'entry function src/main.ts:2', exact: true });
  const source = page.getByTestId('code-graph-source');
  const search = async query => { await page.getByLabel('搜索符号', { exact: true }).fill(query); await page.getByLabel('搜索符号', { exact: true }).press('Enter'); };
  const reset = async patch => { await control({ ...defaults, ...patch }); await page.getByRole('button', { name: '重置', exact: true }).click(); await page.getByRole('button', { name: 'main.ts file src/main.ts:1', exact: true }).waitFor(); };
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    if (await page.getByRole('button', { name: 'call-fixture-alpha', exact: true }).isVisible()) await page.getByRole('button', { name: 'call-fixture-alpha', exact: true }).click();
    await page.getByRole('tab', { name: '关系图', exact: true }).click();
    await reset(); await search('entry'); await root.waitFor();
    await control({ version: 'v2', delayByAction: { 'graph-tree': 900 }, clearRequests: true });
    await page.getByRole('button', { name: '重置', exact: true }).click();
    assert(await root.count() === 0, 'reset immediately removes stale selectable catalog while fresh tree is pending');
    await page.waitForTimeout(200);
    assert((await control({})).requests.every(r => !r.path.endsWith('/graph')), 'pending reset cannot dispatch graph from stale results');
    await page.getByRole('button', { name: 'main.ts file src/main.ts:1', exact: true }).waitFor();
    await search('entry'); await root.click(); await source.locator('pre').filter({ hasText: '@v2:a' }).waitFor();
    const request = (await control({})).requests.find(r => r.path.endsWith('/graph')).body;
    assert(request.indexVersion === 'v2' && request.nodeId.includes('@v2:'), 'reset selects only fresh version node IDs and indexVersion');
    for (const [state, text] of Object.entries({ empty: '当前范围没有匹配结果。', unindexed: '尚未建立索引，请同步仓库。', building: '索引正在构建，请稍后刷新。', failed: '索引构建失败，请查看仓库错误并重试同步。', unsupported: '当前索引或语言不支持此关系视图。', not_found: '资源已删除或节点不在当前索引中。' })) {
      await control({ ...defaults, responseState: state }); await page.getByRole('button', { name: '重置', exact: true }).click();
      await page.getByText(text, { exact: false }).first().waitFor();
      assert(await source.locator('pre').count() === 0, `${state} state has explicit message and no stale source`);
    }
    for (const [status, text] of [[403, '没有读取此资产的权限，或登录已失效。'], [404, '资源已删除或节点不在当前索引中。'], [0, '请求失败，请检查网络后重试。']]) {
      await control({ ...defaults, httpStatus: status }); await page.getByRole('button', { name: '重置', exact: true }).click();
      await page.getByText(text, { exact: false }).first().waitFor();
      assert(await source.locator('pre').count() === 0, `HTTP ${status || 'network failure'} has explicit message and no stale source`);
    }
    await reset({ sourceUnavailable: true }); await search('entry'); await root.click();
    await source.getByText('该索引没有可用的同版本源码。').waitFor();
    assert(await source.locator('pre').count() === 0, 'source_unavailable never fabricates source');
    await reset({ truncated: true }); await search('entry'); await root.click();
    await page.getByText('本次扫描尚未完成，可继续加载剩余关系或证据。', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: '加载更多关系', exact: true }).isVisible(), 'truncated graph exposes budget message and continuation');
    await reset();
    await page.getByRole('tab', { name: '概览与文本查询', exact: true }).click();
    const legacy = page.getByRole('tabpanel', { name: '概览与文本查询', exact: true });
    const inputs = legacy.locator('input');
    await inputs.nth(0).fill('entry'); await inputs.nth(0).press('Enter');
    await legacy.getByText('Legacy search fixture', { exact: true }).waitFor();
    await inputs.nth(1).fill('entry calls helper'); await inputs.nth(1).press('Enter');
    await legacy.getByText('Legacy explore fixture', { exact: true }).waitFor();
    assert(true, 'legacy overview text search and explore still submit and render');
    await page.getByRole('tab', { name: '关系图', exact: true }).click();
    await search('entry'); await root.click(); await source.locator('pre').filter({ hasText: '@v1:a' }).waitFor();
    await page.getByRole('button', { name: '同步', exact: true }).click();
    await page.getByRole('button', { name: 'main.ts file src/main.ts:1', exact: true }).waitFor();
    assert(await source.locator('pre').count() === 0, 'legacy sync invalidates visible graph and source cache');
    await search('entry'); await root.click(); await source.locator('pre').filter({ hasText: '@v2:a' }).waitFor();
    assert((await source.getByRole('link').getAttribute('href')).includes('222222222222'), 'after sync source and commit link use the new version');
    await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-states-pass.png', fullPage: true });
    return { checks };
  } catch (error) { await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-states-failure.png', fullPage: true }); throw new Error(JSON.stringify({ checks, error: String(error) })); }
}
