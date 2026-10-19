async (page) => {
  const checks = [];
  const assert = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  await page.evaluate(() => { localStorage.removeItem('codegraph-test-no-webgl'); localStorage.setItem('tdai-memory.lang', 'en-US'); });
  await page.setViewportSize({ width: 1600, height: 1000 }); await page.reload();
  await page.getByRole('button', { name: 'call-fixture-alpha', exact: true }).click();
  await page.getByRole('tab', { name: 'Repository graph', exact: true }).click();
  await page.getByLabel('Search symbols', { exact: true }).fill('entry'); await page.getByLabel('Search symbols', { exact: true }).press('Enter');
  await page.getByRole('button', { name: 'entry function src/main.ts:2', exact: true }).click();
  await page.getByTestId('code-graph-source').locator('pre').waitFor();
  await page.evaluate(() => {
    window.__cgThemeDraw = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
      if (this.canvas.className === 'sigma-labels' || this.canvas.className === 'sigma-hovers') window.__cgThemeDraw.push({ text, color: this.fillStyle, cls: this.canvas.className });
      return original.call(this, text, x, y, ...rest);
    };
  });
  for (const [element, mode] of [['html', 'dark'], ['html', 'light'], ['body', 'dark'], ['body', 'light']]) {
    await page.evaluate(({ element, mode }) => { window.__cgThemeDraw = []; document.querySelector(element).setAttribute('theme-mode', mode); }, { element, mode });
    await page.waitForTimeout(150);
    const colors = await page.evaluate(() => {
      const token = getComputedStyle(document.querySelector('canvas.sigma-labels')).getPropertyValue('--tea-color-text-primary').trim();
      const canvas = document.createElement('canvas'); const context = canvas.getContext('2d'); context.fillStyle = token;
      return { expected: context.fillStyle, actual: window.__cgThemeDraw.filter(item => item.cls === 'sigma-labels').map(item => item.color) };
    });
    assert(colors.actual.length > 0 && colors.actual.every(value => value === colors.expected), `${element} theme-mode=${mode} refreshes canvas labels to effective Tea token`);
  }
  await page.evaluate(() => { document.body.removeAttribute('theme-mode'); document.documentElement.setAttribute('theme-mode', 'dark'); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-english-dark.png', fullPage: true });
  return { checks };
}
