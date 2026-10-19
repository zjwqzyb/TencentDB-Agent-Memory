async (page) => {
  const checks = [];
  const assert = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const control = patch => page.evaluate(async value => fetch('/__codegraph-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }).then(r => r.json()), patch);
  const defaults = { version: 'v1', responseState: 'ready', actionState: {}, httpStatus: 200, delayByNode: {}, delayByAsset: {}, delayByAction: {}, sourceUnavailable: false, truncated: false, sparseSearch: false, emptyContinuation: false, clearRequests: true };
  const source = page.getByTestId('code-graph-source');
  const relations = page.getByTestId('code-graph-relations');
  const root = page.getByRole('button', { name: 'entry function src/main.ts:2', exact: true });
  const expired = page.getByText('索引版本已变化，旧图与源码已清除，请重新加载。', { exact: false });
  async function search(query) { await page.getByLabel('搜索符号', { exact: true }).fill(query); await page.getByLabel('搜索符号', { exact: true }).press('Enter'); }
  async function prepare(patch = {}) {
    await control({ ...defaults, ...patch });
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await page.getByRole('button', { name: 'main.ts file src/main.ts:1', exact: true }).waitFor();
    await search('entry'); await root.waitFor();
  }
  const waitGraph = () => page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '双向展开' && !button.disabled));
  try {
    if (await page.getByRole('button', { name: 'call-fixture-alpha', exact: true }).isVisible()) await page.getByRole('button', { name: 'call-fixture-alpha', exact: true }).click();
    if (!await page.getByTestId('code-graph-workspace').isVisible()) await page.getByRole('tab', { name: '关系图', exact: true }).click();
    await prepare();
    await control({ delayByAction: { graph: 900 } });
    await root.click();
    await control({ actionState: { 'graph-search': 'version_expired' } });
    await search('helper'); await expired.waitFor();
    await page.waitForTimeout(1100);
    assert(await source.locator('pre').count() === 0 && await page.getByTestId('code-graph-canvas').count() === 0, 'catalog expiry cancels pending graph/source; late graph cannot revive');

    await prepare();
    await control({ actionState: { 'graph-source': 'version_expired' } });
    await root.click(); await expired.waitFor();
    assert(await source.locator('pre').count() === 0 && await page.getByRole('button', { name: '双向展开', exact: true }).isDisabled(), 'source-only expiry invalidates graph and selection');

  } catch (error) {
    await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-race-failure.png', fullPage: true }); throw new Error(JSON.stringify({ checks, error: String(error) }));
  }
  try {
    await control({ ...defaults, sparseSearch: true });
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await page.getByRole('button', { name: 'main.ts file src/main.ts:1', exact: true }).waitFor();
    await search('entry');
    await page.getByRole('button', { name: '继续查找', exact: true }).waitFor();
    assert(await root.count() === 0, 'sparse first search page contains no fabricated result');
    await page.getByRole('button', { name: '继续查找', exact: true }).click(); await root.waitFor();
    assert(await root.isVisible(), 'sparse empty page can continue to matching symbols');

    await prepare({ truncated: true });
    await root.click(); await waitGraph();
    const listButton = page.getByRole('button', { name: '关系列表', exact: true });
    if (await listButton.isVisible()) await listButton.click();
    await relations.locator('table').first().getByRole('button', { name: 'helper', exact: true }).click();
    await page.getByRole('button', { name: '下游展开', exact: true }).click(); await waitGraph();
    await page.getByRole('button', { name: '撤销展开', exact: true }).click();
    await control({ clearRequests: true, emptyContinuation: true });
    await page.getByRole('button', { name: '加载更多关系', exact: true }).click(); await waitGraph();
    const recorded = await control({});
    const more = recorded.requests.filter(r => r.path.endsWith('/code-graph/graph')).at(-1).body;
    assert(more.nodeId.endsWith(':a') && more.direction === 'both' && more.cursor === 'fixture-next', 'undo restores original focus/direction request for continuation');
    assert(await relations.locator('table').first().locator('tbody tr').count() === 3 && await relations.locator('table').nth(1).locator('tbody tr').count() === 5, 'empty appended graph page preserves existing nodes/relations');

    await prepare();
    const slowId = 'cg-browser-a@v1:a';
    await control({ delayByNode: { [slowId]: 900 } });
    await root.click();
    await page.getByRole('button', { name: 'entry method src/other.ts:12', exact: true }).click();
    await source.locator('pre').filter({ hasText: 'v1:d' }).waitFor(); await page.waitForTimeout(1100);
    assert((await source.innerText()).includes('src/other.ts'), 'late previous focus response cannot overwrite new focus/source');

    await prepare();
    await control({ delayByAsset: { 'cg-browser-a': 900 } }); await root.click();
    await page.getByRole('button', { name: 'Code 图谱', exact: true }).click();
    await page.getByRole('button', { name: 'call-fixture-beta', exact: true }).click();
    await page.getByText('关系图', { exact: true }).click();
    await search('entry'); await root.click(); await source.locator('pre').filter({ hasText: 'cg-browser-b' }).waitFor();
    await page.waitForTimeout(1100);
    assert(!(await source.innerText()).includes('cg-browser-a'), 'late previous asset response cannot overwrite another repository');
    await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-races-pass.png', fullPage: true });
    return { checks };
  } catch (error) {
    await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-race-failure.png', fullPage: true });
    throw new Error(JSON.stringify({ checks, error: String(error) }));
  }
}
