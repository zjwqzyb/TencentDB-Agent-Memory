// Run after code-graph-fixture.js in an independent Playwright CLI session.
// Real Chromium/WebGL and CodePage; deterministic API fixture, no renderer mocks.
async (page) => {
  const checks = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const cdp = await page.context().newCDPSession(page);
  const setDpr = async ratio => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1100, deviceScaleFactor: ratio, mobile: false,
    });
    await page.waitForFunction(value => devicePixelRatio === value, ratio);
  };
  const probe = () => page.evaluate(() => {
    const sigma = window.__cgDprSigma;
    window.__cgDprLabels = [];
    window.__cgDprStarts = [];
    sigma.refresh(); // Read the actual GL pixels in the same task as rendering.
    const canvases = sigma.getCanvases();
    const gl = canvases.nodes.getContext('webgl2') || canvases.nodes.getContext('webgl');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const ratio = devicePixelRatio;
    const nodes = sigma.getGraph().nodes().map(id => {
      const data = sigma.getNodeDisplayData(id);
      const position = sigma.graphToViewport(sigma.getGraph().getNodeAttributes(id));
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor(position.x * ratio), gl.drawingBufferHeight - 1 - Math.floor(position.y * ratio), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return { id, label: data.label, size: sigma.scaleSize(data.size), ...position, pixel: [...pixel] };
    });
    return {
      ratio, nodes, labels: window.__cgDprLabels, starts: window.__cgDprStarts,
      viewport: [...gl.getParameter(gl.VIEWPORT)],
      dimensions: sigma.getDimensions(),
      canvases: Object.values(canvases).map(canvas => ({
        className: canvas.className, width: canvas.width, height: canvas.height,
        cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight,
      })),
    };
  });
  const aligned = async label => {
    const value = await probe();
    const { ratio, dimensions: { width, height } } = value;
    assert(value.canvases.every(c => c.width === Math.floor(width * ratio) && c.height === Math.floor(height * ratio)), `${label}: all canvas backing stores match DPR`);
    assert(value.viewport[2] === Math.floor(width * ratio) && value.viewport[3] === Math.floor(height * ratio), `${label}: GL viewport matches backing store`);
    assert(value.nodes.every(n => n.pixel[3] > 200 && n.pixel[2] > n.pixel[0]), `${label}: real blue GL pixels occupy every expected node center`);
    assert(value.labels.length > 0 && value.labels.every(l => {
      const node = value.nodes.find(n => n.label === l.text);
      return node && Math.abs(l.x - node.x - node.size - 3) < 0.1 && Math.abs(l.y - node.y - 4) < 0.1 && l.a === ratio && l.d === ratio;
    }), `${label}: label coordinates and transforms align with GL nodes`);
    assert(value.starts.some(p => value.nodes.some(n => Math.hypot(n.x - p.x, n.y - p.y) < 0.1)) && value.starts.every(p => p.a === ratio && p.d === ratio), `${label}: relation endpoints and transforms align with nodes`);
    return value;
  };
  try {
    await page.setViewportSize({ width: 1600, height: 1100 });
    await setDpr(1);
    await page.evaluate(() => localStorage.setItem('tdai-memory.lang', 'zh-CN'));
    await page.reload();
    await page.getByRole('button', { name: 'call-fixture-alpha', exact: true }).click();
    await page.getByRole('tab', { name: '关系图', exact: true }).click();
    await page.evaluate(async () => {
      window.__cgDprQueries = [];
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = (...args) => {
        const query = matchMedia(...args);
        if (args[0].startsWith('(resolution:')) window.__cgDprQueries.push(query);
        return query;
      };
      const url = performance.getEntriesByType('resource').find(item => /\/deps\/sigma\.js/.test(item.name)).name;
      const { default: Sigma } = await import(url);
      const originalRender = Sigma.prototype.render;
      Sigma.prototype.render = function(...args) {
        window.__cgDprSigma = this;
        return originalRender.apply(this, args);
      };
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) {
        if (this.canvas.className === 'sigma-labels') {
          const { a, d } = this.getTransform();
          (window.__cgDprLabels ||= []).push({ text, x, y, a, d });
        }
        return fillText.call(this, text, x, y, ...args);
      };
      const moveTo = CanvasRenderingContext2D.prototype.moveTo;
      CanvasRenderingContext2D.prototype.moveTo = function(x, y) {
        if (this.canvas.className === 'sigma-code-relations') {
          const { a, d } = this.getTransform();
          (window.__cgDprStarts ||= []).push({ x, y, a, d });
        }
        return moveTo.call(this, x, y);
      };
    });
    await page.getByLabel('搜索符号', { exact: true }).fill('entry');
    await page.getByLabel('搜索符号', { exact: true }).press('Enter');
    await page.getByRole('button', { name: 'entry function src/main.ts:2', exact: true }).click();
    await page.getByTestId('code-graph-source').locator('pre').waitFor();
    const originalSize = (await aligned('initial DPR1')).dimensions;
    for (const ratio of [2, 1, 2]) {
      await setDpr(ratio);
      if (ratio === 1) {
        // CDP does not dispatch resolution events. A normal interaction must
        // still repair the missed notification, without a test-only refresh.
        await page.getByRole('button', { name: '适应画布', exact: true }).click();
      } else {
        // Chromium CDP changes real DPR/matches but omits the OS media event.
        // Dispatch that event explicitly to test our listener, not OS delivery.
        await page.evaluate(() => {
          const query = window.__cgDprQueries.at(-1);
          query.dispatchEvent(new MediaQueryListEvent('change', { media: query.media, matches: query.matches }));
        });
      }
      await page.waitForFunction(ratio => [...document.querySelectorAll('._codegraph-canvas canvas')].every(c => c.width === Math.floor(c.clientWidth * ratio)), ratio);
      const automaticViewport = await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        const canvas = document.querySelector('canvas.sigma-nodes');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        return { backing: [canvas.width, canvas.height], viewport: [...gl.getParameter(gl.VIEWPORT)] };
      });
      assert(automaticViewport.viewport[2] === automaticViewport.backing[0] && automaticViewport.viewport[3] === automaticViewport.backing[1], `DPR${ratio}: ${ratio === 1 ? 'fit repairs omitted notification' : 'dispatched media event repaints'} without manual refresh`);
      const unchanged = await page.evaluate(() => window.__cgDprSigma.getDimensions());
      assert(unchanged.width === originalSize.width && unchanged.height === originalSize.height, `DPR${ratio}: transition preserves CSS canvas dimensions`);
      await aligned(`DPR${ratio} transition`);
      for (const name of ['放大', '缩小', '适应画布']) {
        await page.getByRole('button', { name, exact: true }).click();
        await aligned(`DPR${ratio} ${name}`);
      }
      const sample = await aligned(`DPR${ratio} before hit`);
      const helper = sample.nodes.find(n => n.label === 'helper');
      const box = await page.locator('canvas.sigma-mouse').boundingBox();
      await page.waitForTimeout(350); // Keep this node click outside the previous double-click window.
      await page.mouse.click(box.x + helper.x, box.y + helper.y);
      await page.getByTestId('code-graph-source').locator('pre').filter({ hasText: '@v1:b' }).waitFor();
      assert(true, `DPR${ratio}: clicking visible helper blue pixel selects indexed helper source`);
      const entry = (await aligned(`DPR${ratio} helper selected`)).nodes.find(n => n.label === 'entry');
      const nextBox = await page.locator('canvas.sigma-mouse').boundingBox();
      await page.waitForTimeout(350); // Sigma treats rapid clicks as a double click, even across nodes.
      await page.mouse.click(nextBox.x + entry.x, nextBox.y + entry.y);
      await page.getByTestId('code-graph-source').locator('pre').filter({ hasText: '@v1:a' }).waitFor();
    }
    await setDpr(1);
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.getByRole('button', { name: '适应画布', exact: true }).click();
    await aligned('ordinary container resize');
    await page.evaluate(() => document.documentElement.setAttribute('theme-mode', 'dark'));
    await page.waitForFunction(() => window.__cgDprSigma.getSetting('labelColor').color !== '#222');
    await aligned('dark theme');
    await page.screenshot({ path: 'output/playwright/codegraph-dpr-fixed.png', fullPage: true });
    return { checks, browser: page.context().browser().version(), evidence: 'real Chromium DPR transitions, actual WebGL pixels and pointer hits; API fixture; resolution change events explicitly dispatched because CDP omits OS notifications; missed-event recovery tested via fit' };
  } catch (error) {
    await page.screenshot({ path: 'output/playwright/codegraph-dpr-failure.png', fullPage: true });
    throw new Error(JSON.stringify({ checks, error: String(error) }));
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.detach();
  }
}
