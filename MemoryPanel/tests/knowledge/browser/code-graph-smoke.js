// Run after code-graph-fixture.js with Playwright CLI run-code --filename.
async (page) => {
  const checks = [];
  const assert = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const work = page.getByTestId('code-graph-workspace');
  const relations = page.getByTestId('code-graph-relations');
  const source = page.getByTestId('code-graph-source');
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    if (await page.getByRole('button', { name: 'call-fixture-alpha', exact: true }).isVisible()) await page.getByRole('button', { name: 'call-fixture-alpha', exact: true }).click();
    if (!await work.isVisible()) await page.getByText('关系图', { exact: true }).click();
    await page.getByLabel('搜索符号', { exact: true }).fill('entry');
    await page.getByLabel('搜索符号', { exact: true }).press('Enter');
    const main = page.getByRole('button', { name: 'entry function src/main.ts:2', exact: true });
    await main.waitFor();
    assert(await page.getByRole('button', { name: 'entry method src/other.ts:12', exact: true }).isVisible(), 'same-name results preserve kind/path/line');
    await main.focus(); await page.keyboard.press('Enter');
    await source.locator('pre').waitFor();
    assert((await source.innerText()).includes('cg-browser-a@v1:a'), 'keyboard selection loads same-version source');
    await page.getByRole('button', { name: '关系列表', exact: true }).click();
    assert(await relations.locator('table').nth(1).locator('tbody tr').count() === 5, 'self loop, reverse call and parallel calls retain five distinct rows');
    assert((await relations.innerText()).includes('递归'), 'self recursion has a textual label');
    await relations.locator('table').first().getByRole('button', { name: 'helper', exact: true }).click();
    await page.getByRole('button', { name: '下游展开', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="code-graph-relations"] table:nth-of-type(2) tbody')?.children.length === 6);
    await page.getByRole('button', { name: '上游展开', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="code-graph-relations"] table:nth-of-type(2) tbody')?.children.length === 7);
    await page.getByRole('button', { name: '双向展开', exact: true }).click();
    await page.getByRole('button', { name: '撤销展开', exact: true }).click();
    await page.getByRole('button', { name: '撤销展开', exact: true }).click();
    await page.getByRole('button', { name: '撤销展开', exact: true }).click();
    assert(await relations.locator('table').nth(1).locator('tbody tr').count() === 5, 'in/out/both expansion and three undos restore original graph');
    await page.getByRole('button', { name: '双向展开', exact: true }).click();
    await work.getByRole('combobox', { name: '节点类型' }).selectOption('method');
    assert(await relations.locator('table').first().locator('tbody tr').count() === 1, 'node-kind filter preserves method node');
    await work.getByRole('combobox', { name: '节点类型' }).selectOption('');
    await relations.locator('table').first().getByRole('button', { name: 'helper', exact: true }).click();
    await page.getByRole('button', { name: '以此为焦点', exact: true }).click();
    await source.locator('pre').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '返回焦点' && !button.disabled));
    assert(await page.getByRole('button', { name: '返回焦点', exact: true }).isEnabled(), 'neighbor detail -> focus preserves prior graph focus history');
    await page.getByRole('button', { name: '返回焦点', exact: true }).click();
    await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-calls-desktop.png', fullPage: true });
    return { checks, browser: await page.context().browser().version() };
  } catch (error) {
    await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-smoke-failure.png', fullPage: true });
    throw new Error(JSON.stringify({ checks, error: String(error) }));
  }
}
