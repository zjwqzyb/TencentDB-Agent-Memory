async (page) => {
  const checks = [];
  const assert = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const control = patch => page.evaluate(async value => fetch('/__codegraph-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }).then(r => r.json()), patch);
  async function enter(english = false) {
    await page.getByRole('button', { name: 'call-fixture-alpha', exact: true }).click();
    await page.getByRole('tab', { name: english ? 'Repository graph' : '关系图', exact: true }).click();
    const input = page.getByLabel(english ? 'Search symbols' : '搜索符号', { exact: true });
    await input.fill('entry'); await input.press('Enter');
    await page.getByRole('button', { name: 'entry function src/main.ts:2', exact: true }).click();
    await page.getByTestId('code-graph-source').locator('pre').waitFor();
  }
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await control({ version: 'v1', responseState: 'ready', actionState: {}, httpStatus: 200, delayByNode: {}, delayByAsset: {}, delayByAction: {}, sourceUnavailable: false, truncated: false, sparseSearch: false, emptyContinuation: false });
    await page.evaluate(() => { localStorage.setItem('tdai-memory.lang', 'zh-CN'); localStorage.removeItem('codegraph-test-no-webgl'); });
    await page.reload(); await enter();
    await page.evaluate(() => {
      window.__cgDraw = [];
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
        if (this.canvas.className === 'sigma-labels') window.__cgDraw.push({ text, x, y, color: this.fillStyle });
        return original.call(this, text, x, y, ...rest);
      };
    });
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await page.getByRole('button', { name: '缩小', exact: true }).click();
    await page.getByRole('button', { name: '适应画布', exact: true }).click();
    await page.waitForTimeout(150);
    const helper = await page.evaluate(() => window.__cgDraw.findLast(item => item.text === 'helper'));
    const canvas = await page.locator('canvas.sigma-labels').boundingBox();
    await page.mouse.click(canvas.x + helper.x - 10, canvas.y + helper.y - 4);
    await page.getByTestId('code-graph-source').locator('pre').filter({ hasText: '@v1:b' }).waitFor();
    assert(true, 'canvas node hit selects correct source after zoom out/in and fit');
    await page.getByRole('button', { name: '高亮证据路径', exact: true }).click();
    assert(await page.getByRole('button', { name: '取消路径高亮', exact: true }).isVisible(), 'neighbor has an evidence path highlight toggle');
    await page.getByRole('button', { name: '以此为焦点', exact: true }).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: '以此为焦点', exact: true }).click();
    assert((await page.getByTestId('code-graph-source').locator('pre').innerText()).includes('@v1:b'), 'refocusing same node preserves source');
    await page.setViewportSize({ width: 1400, height: 900 }); await page.waitForTimeout(150);
    await page.getByRole('button', { name: '适应画布', exact: true }).click();
    await page.waitForTimeout(100);
    const entry = await page.evaluate(() => window.__cgDraw.findLast(item => item.text === 'entry'));
    const resized = await page.locator('canvas.sigma-labels').boundingBox();
    await page.mouse.click(resized.x + entry.x - 10, resized.y + entry.y - 4);
    await page.getByTestId('code-graph-source').locator('pre').filter({ hasText: 'entry' }).waitFor();
    assert(true, 'resized canvas node hit still selects source');
    await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-canvas-pass.png', fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    for (const name of ['目录与搜索', '节点详情与源码']) {
      const trigger = page.getByRole('button', { name, exact: true });
      await trigger.click(); const dialog = page.getByRole('dialog', { name, exact: true }); await dialog.waitFor();
      assert(await dialog.getAttribute('aria-modal') === 'false', `${name} drawer declares nonmodal dialog semantics`);
      assert(await dialog.evaluate(el => el.contains(document.activeElement)), `${name} drawer receives keyboard focus`);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      assert(await trigger.evaluate(el => el === document.activeElement), `${name} Escape closes and restores trigger focus`);
    }
    await page.getByRole('button', { name: '目录与搜索', exact: true }).click();
    await page.getByLabel('搜索符号', { exact: true }).fill('helper'); await page.getByLabel('搜索符号', { exact: true }).press('Enter');
    await page.getByRole('button', { name: 'helper function src/helper.ts:5', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '节点详情与源码', exact: true }).click();
    await page.getByTestId('code-graph-source').locator('pre').filter({ hasText: '@v1:b' }).waitFor();
    assert(true, '375px search drawer selects node and source drawer displays source');
    await page.waitForTimeout(500); // Tea drawer transition must settle before visual evidence.
    await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-narrow-pass.png', fullPage: true });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.evaluate(() => localStorage.setItem('tdai-memory.lang', 'en-US')); await page.reload(); await enter(true);
    await page.evaluate(() => document.documentElement.setAttribute('theme-mode', 'dark'));
    await page.waitForTimeout(150);
    assert(await page.getByRole('heading', { name: 'Call graph', exact: true }).isVisible(), 'English graph heading and source/search labels render');
    await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-english-dark.png', fullPage: true });
    await page.evaluate(() => localStorage.setItem('codegraph-test-no-webgl', '1')); await page.reload(); await enter(true);
    await page.getByText('Graphics are unavailable in this browser. The keyboard accessible relations table is shown instead.').waitFor();
    const table = page.getByTestId('code-graph-relations').locator('table').first();
    const button = table.getByRole('button', { name: 'helper', exact: true });
    await button.focus(); await button.press('Enter');
    await page.getByTestId('code-graph-source').locator('pre').filter({ hasText: '@v1:b' }).waitFor();
    assert(await page.getByTestId('code-graph-canvas').count() === 0, 'no-WebGL falls back to keyboard operable table and source');
    await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-no-webgl.png', fullPage: true });
    return { checks };
  } catch (error) { await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-visual-failure.png', fullPage: true }); throw new Error(JSON.stringify({ checks, error: String(error) })); }
}
