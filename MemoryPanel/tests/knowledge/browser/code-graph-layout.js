// Layout acceptance for the real CodePage shell with deterministic graph APIs.
// Run after code-graph-fixture.js; this focuses on viewport geometry and access,
// not SDK or server correctness.
async (page) => {
  const checks = [];
  const measurements = [];
  const assert = (condition, message, detail) => {
    if (!condition) throw new Error(JSON.stringify({ message, detail, checks, measurements }));
    checks.push(message);
  };
  const work = page.getByTestId('code-graph-workspace');
  const sample = async (name, width, height) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    const result = await page.evaluate(() => {
      const rect = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
      };
      const scrolls = [...document.querySelectorAll('body, body *')]
        .filter(el => {
          const s = getComputedStyle(el);
          return /(auto|scroll)/.test(`${s.overflowY} ${s.overflow}`) && el.scrollHeight > el.clientHeight + 4;
        }).map(el => ({
          tag: el.tagName.toLowerCase(),
          className: typeof el.className === 'string' ? el.className : '',
          testid: el.getAttribute('data-testid'),
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          delta: el.scrollHeight - el.clientHeight,
        }));
      const covered = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const pr = parent.getBoundingClientRect();
          if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) {
            clip.left = Math.max(clip.left, pr.left);
            clip.right = Math.min(clip.right, pr.right);
          }
          if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) {
            clip.top = Math.max(clip.top, pr.top);
            clip.bottom = Math.min(clip.bottom, pr.bottom);
          }
        }
        const left = Math.max(clip.left, r.left), right = Math.min(clip.right, r.right);
        const top = Math.max(clip.top, r.top), bottom = Math.min(clip.bottom, r.bottom);
        const fullyVisible = r.left >= clip.left && r.right <= clip.right &&
          r.top >= clip.top && r.bottom <= clip.bottom;
        const x = left + Math.max(0, right - left) / 2;
        const y = top + Math.max(0, bottom - top) / 2;
        const centerInViewport = x >= 0 && x < innerWidth && y >= 0 && y < innerHeight;
        const hit = document.elementFromPoint(x, y);
        return { visible: !!(right > left && bottom > top),
          inViewport: fullyVisible,
          clipRect: clip,
          centerHit: centerInViewport && !!hit && (hit === el || el.contains(hit)),
          visibleHitPoint: { x, y },
          hit: hit?.tagName.toLowerCase() + (hit?.className && typeof hit.className === 'string' ? `.${hit.className.trim().replace(/\s+/g,'.')}` : ''),
          rect: { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom } };
      };
      const controls = [...document.querySelectorAll('._codegraph-control-row select, ._codegraph-control-row button, ._codegraph-expand button')];
      return {
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        outer: rect('#root'),
        detail: rect('._codedetail-root'),
        repoHeader: rect('._codedetail-header-body'),
        tabs: rect('._codedetail-tabs'),
        workspace: rect('[data-testid="code-graph-workspace"]'),
        controlRow: rect('._codegraph-control-row'),
        modeControls: rect('._codegraph-mode-controls'),
        toolbar: rect('._codegraph-toolbar'),
        layout: rect('._codegraph-layout'),
        search: rect('._codegraph-search'),
        main: rect('._codegraph-main'),
        canvas: rect('._codegraph-canvas-wrap'),
        graphState: rect('[data-testid="code-graph-state"]'),
        mainEmpty: rect('._codegraph-empty'),
        mainText: document.querySelector('._codegraph-main')?.innerText.slice(0, 500),
        source: rect('._codegraph-source'),
        canvasCoverage: covered(document.querySelector('._codegraph-canvas-wrap')),
        controlCoverage: controls.map(covered),
        verticalScrolls: scrolls,
        pageScrollHeight: document.documentElement.scrollHeight,
      };
    });
    measurements.push({ name, ...result });
    return result;
  };
  try {
    const assetButton = page.getByRole('button', { name: 'call-fixture-alpha', exact: true });
    if (await assetButton.isVisible().catch(() => false)) await assetButton.click();
    if (!(await work.isVisible().catch(() => false))) await page.getByRole('tab', { name: '关系图', exact: true }).click();
    await work.waitFor();
    assert(await page.locator('._codegraph-main').getByText('从左侧文件或符号搜索中选择一个节点，开始浏览关系。', { exact: true }).isVisible(),
      'default empty graph provides a visible symbol-selection prompt');
    const empty = await sample('default-empty-1440x900', 1440, 900);
    assert(empty.main?.y <= 330 && empty.main.height >= 400 && empty.main.bottom <= 900,
      'default empty graph region starts in the first screen and remains fully visible', { main: empty.main });
    const scrollGrowth = await page.evaluate(async () => {
      const scrollport = document.querySelector('.tea-layout__content-body');
      const panel = document.querySelector('._codedetail-graph-panel');
      const measure = () => ({ panelTop: panel.getBoundingClientRect().top,
        panelHeight: panel.getBoundingClientRect().height, scrollHeight: scrollport.scrollHeight,
        scrollTop: scrollport.scrollTop, scrollRange: scrollport.scrollHeight - scrollport.clientHeight });
      const series = [measure()];
      for (let i=0;i<5;i++) {
        scrollport.scrollTop = scrollport.scrollHeight;
        scrollport.dispatchEvent(new Event('scroll'));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        series.push(measure());
      }
      scrollport.scrollTop = 0;
      scrollport.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { series, restored: measure() };
    });
    assert(Math.max(...scrollGrowth.series.map(x=>x.panelHeight)) - Math.min(...scrollGrowth.series.map(x=>x.panelHeight)) <= 1 &&
      Math.max(...scrollGrowth.series.map(x=>x.scrollHeight)) - Math.min(...scrollGrowth.series.map(x=>x.scrollHeight)) <= 1,
      'scrolling to the bottom repeatedly does not grow graph height or scroll range', scrollGrowth);
    await page.getByLabel('搜索符号', { exact: true }).fill('entry');
    await page.getByLabel('搜索符号', { exact: true }).press('Enter');
    const entry = page.getByRole('button', { name: 'entry function src/main.ts:2', exact: true });
    await entry.waitFor();
    await entry.click();
    await page.getByTestId('code-graph-source').locator('pre').waitFor();
    const longStress = await page.evaluate(() => {
      const title = document.querySelector('._codedetail-title');
      const resultPath = document.querySelector('._codegraph-results li small');
      const location = document.querySelector('._codegraph-location');
      const code = document.querySelector('._codegraph-code code');
      const saved = [title?.textContent, resultPath?.textContent, location?.textContent, code?.innerHTML];
      const longPath = 'backend/jinhui-cloud/services/marketing-product/src/main/java/com/company/marketing/product/settlement/processing/strategy/occupy/OccupyServiceImpl.java:205-255';
      if (title) title.textContent = 'marketing-product-department-enterprise-cloud-backend-erp-parent-with-a-long-repository-label';
      if (resultPath) resultPath.textContent = longPath;
      if (location) location.textContent = longPath;
      if (code) code.textContent = 'private boolean calculateOccupyServiceForMarketingProductWithExtremelyLongIdentifierAndArguments(String accountId, List<String> poolTypes, boolean includeHistoricalTransactions) { return accountId != null; }';
      const root = document.querySelector('._codedetail-root');
      const graph = document.querySelector('._codegraph-root');
      const snapshot = {
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        detailWidth: root?.clientWidth,
        detailScrollWidth: root?.scrollWidth,
        graphWidth: graph?.clientWidth,
        graphScrollWidth: graph?.scrollWidth,
        resultVisible: !!resultPath && resultPath.getBoundingClientRect().width > 0,
        locationVisible: !!location && location.getBoundingClientRect().width > 0,
        sourceLocalScroll: code?.parentElement?.scrollWidth > code?.parentElement?.clientWidth,
      };
      if (title && saved[0] != null) title.textContent = saved[0];
      if (resultPath && saved[1] != null) resultPath.textContent = saved[1];
      if (location && saved[2] != null) location.textContent = saved[2];
      if (code && saved[3] != null) code.innerHTML = saved[3];
      return snapshot;
    });
    assert(longStress.documentWidth <= longStress.viewportWidth + 4 &&
      longStress.detailScrollWidth <= longStress.detailWidth + 4 &&
      longStress.graphScrollWidth <= longStress.graphWidth + 4 && longStress.resultVisible && longStress.locationVisible,
    'long repository, result path and source line stay within their panels without page overflow', longStress);

    for (const [name, width, height, minimumCanvas] of [
      ['desktop-1440x900', 1440, 900, 400],
      ['desktop-1366x768', 1366, 768, 400],
      ['desktop-1920x1080', 1920, 1080, 400],
      // CSS viewport equivalents of 125% and 150% browser zoom on 1440x900.
      ['zoom125-equivalent-1152x720', 1152, 720, 250],
      ['zoom150-equivalent-960x600', 960, 600, 220],
    ]) {
      const m = await sample(name, width, height);
      assert(m.workspace?.width > 0, `${name}: workspace rendered`);
      assert(m.canvasCoverage?.visible && m.canvas?.height >= minimumCanvas,
        `${name}: graph canvas has useful visible height`, { canvas: m.canvas, coverage: m.canvasCoverage });
      assert(m.canvasCoverage.centerHit, `${name}: canvas center is not covered by an overlay`, m.canvasCoverage);
      if (['desktop-1440x900', 'desktop-1366x768', 'desktop-1920x1080'].includes(name)) {
        assert(m.canvas?.y <= 330, `${name}: canvas begins near the first screen`, m.canvas);
        assert(m.canvasCoverage.inViewport, `${name}: full canvas fits in the viewport`, m.canvasCoverage);
      }
      assert(m.controlCoverage.length > 0 && m.controlCoverage.every(c => c.visible && c.inViewport && c.centerHit),
        `${name}: all visible mode, toolbar and expansion controls fit and remain unobscured`, m.controlCoverage);
      if (width > 1100) {
        assert(m.search?.width > 0 && m.source?.width > 0,
          `${name}: search and source columns are present`, { search: m.search, source: m.source });
        assert(m.search.y >= m.layout.y && m.source.y >= m.layout.y,
          `${name}: side panels begin within the graph workspace`, { layout: m.layout, search: m.search, source: m.source });
      }
      assert(m.verticalScrolls.length <= 3,
        `${name}: vertical scrolling stays bounded to page and workspace panels`, m.verticalScrolls);
      if (name.startsWith('zoom')) {
        await page.locator('._codegraph-canvas-wrap').evaluate(el => el.scrollIntoView({ block: 'end', inline: 'nearest' }));
        await page.waitForTimeout(50);
        const scrolled = await sample(`${name}-canvas-scrolled-into-view`, width, height);
        assert(scrolled.canvasCoverage?.inViewport && scrolled.canvasCoverage.centerHit,
          `${name}: canvas is reachable and fully visible after scrolling`, { canvas: scrolled.canvas, coverage: scrolled.canvasCoverage });
      }
    }

    // All five modes and their controls must remain reachable at common desktop sizes.
    const modeSelect = page.getByLabel('关系视图', { exact: true });
    for (const [viewportName, width, height] of [['1440x900', 1440, 900], ['1366x768', 1366, 768]]) {
      await page.setViewportSize({ width, height });
      for (const [value, label] of [
        ['calls', '调用关系图'], ['impact', '潜在影响范围'], ['dependencies', '模块依赖'],
        ['clusters', '目录聚类总览'], ['hierarchy', '继承与实现'],
      ]) {
        await modeSelect.selectOption(value);
        await page.waitForFunction(expected => document.querySelector('._codegraph-control-row select')?.value === expected, value);
        assert((await modeSelect.locator('option:checked').textContent())?.trim() === label,
          `${viewportName} ${label}: mode selection remains visible and accessible`);
        const state = await page.evaluate(() => {
          const row = document.querySelector('._codegraph-control-row').getBoundingClientRect();
          const controls = [...document.querySelectorAll('._codegraph-control-row select, ._codegraph-control-row button')];
          return { row: { y:row.y,bottom:row.bottom,height:row.height },
            controls: controls.map(el => { const r=el.getBoundingClientRect(); return { y:r.y,bottom:r.bottom,w:r.width,h:r.height }; }) };
        });
        assert(state.row.y >= 0 && state.row.bottom <= height && state.controls.length > 0 &&
          state.controls.every(x => x.w > 0 && x.h > 0 && x.y >= 0 && x.bottom <= height),
          `${viewportName} ${label}: mode-specific controls fit without clipping`, state);
        const m = await sample(`${viewportName}-${value}`, width, height);
        if (m.canvas) assert(m.canvasCoverage?.inViewport && m.canvas.height >= 400 && m.canvas.y <= 400,
          `${viewportName} ${label}: canvas has >=400px and remains fully above the fold`, { canvas:m.canvas, coverage:m.canvasCoverage });
        else assert(m.graphState?.y >= 0 && m.graphState.bottom <= height && m.graphState.height > 0,
          `${viewportName} ${label}: unsupported or empty relationship state remains visible in the main panel`, { graphState:m.graphState, mainText:m.mainText });
        assert(m.controlCoverage.every(c => c.visible && c.inViewport && c.centerHit),
          `${viewportName} ${label}: controls remain unobscured`, m.controlCoverage);
      }
    }

    // Hierarchy needs a type focus; verify its real canvas with a supported class.
    await page.setViewportSize({ width: 1366, height: 768 });
    await modeSelect.selectOption('hierarchy');
    await page.getByLabel('搜索符号', { exact: true }).fill('Derived');
    await page.getByLabel('搜索符号', { exact: true }).press('Enter');
    const derived = page.getByRole('button', { name: 'Derived class src/types.ts:21', exact: true });
    await derived.waitFor();
    await derived.click();
    await page.getByTestId('code-graph-canvas').waitFor();
    const hierarchy = await sample('1366x768-hierarchy-class-canvas', 1366, 768);
    assert(hierarchy.canvasCoverage?.inViewport && hierarchy.canvas?.height >= 400,
      '1366x768 hierarchy canvas with a supported class focus is fully visible and >=400px',
      { canvas:hierarchy.canvas, coverage:hierarchy.canvasCoverage });
    assert(hierarchy.controlCoverage.every(c => c.inViewport && c.centerHit),
      '1366x768 hierarchy type controls remain unobscured while a graph is displayed', hierarchy.controlCoverage);

    // The keyboard-accessible relation list must fit into the same workspace.
    await page.setViewportSize({ width: 1440, height: 900 });
    await modeSelect.selectOption('calls');
    await page.getByLabel('搜索符号', { exact: true }).fill('entry');
    await page.getByLabel('搜索符号', { exact: true }).press('Enter');
    await page.getByRole('button', { name: 'entry function src/main.ts:2', exact: true }).click();
    await page.getByRole('button', { name: '关系列表', exact: true }).click();
    assert(await page.getByTestId('code-graph-relations').isVisible(), 'relation list can replace the canvas');
    const listRect = await page.getByTestId('code-graph-relations').evaluate(el => {
      const r=el.getBoundingClientRect(); return { top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight };
    });
    assert(listRect.height > 120 && listRect.top < 900, 'relation list receives a usable area', listRect);
    await page.getByRole('button', { name: '显示关系图', exact: true }).click();

    // Synthetic DOM pressure only: keep a long analysis section after the list,
    // reproducing flex shrink without claiming backend/API extraction evidence.
    await page.setViewportSize({ width: 1366, height: 768 });
    await modeSelect.selectOption('impact');
    await page.getByLabel('搜索符号', { exact: true }).fill('entry');
    await page.getByLabel('搜索符号', { exact: true }).press('Enter');
    await page.getByRole('button', { name: 'entry function src/main.ts:2', exact: true }).click();
    await page.locator('._codegraph-analysis').evaluate(el => {
      const stress = document.createElement('div');
      stress.dataset.testid = 'layout-long-analysis-stress';
      stress.textContent = `UI layout stress only; not backend relationship evidence. ${'Long unresolved relationship analysis text. '.repeat(80)}`;
      stress.style.cssText = 'height:3420px; flex:0 0 3420px; overflow-wrap:anywhere;';
      el.append(stress);
    });
    await page.getByRole('button', { name: '关系列表', exact: true }).click();
    const stressTable = page.getByTestId('code-graph-relations');
    const stressMetrics = await stressTable.evaluate(el => {
      const r=el.getBoundingClientRect(), main=el.closest('._codegraph-main'), mr=main.getBoundingClientRect();
      const row=el.querySelector('tbody tr'), rr=row?.getBoundingClientRect();
      const hit=rr ? document.elementFromPoint(rr.left+Math.min(20,rr.width/2),rr.top+Math.min(20,rr.height/2)) : null;
      return { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,
        main:{top:mr.top,bottom:mr.bottom,scrollHeight:main.scrollHeight,clientHeight:main.clientHeight},
        row:rr?{top:rr.top,bottom:rr.bottom,height:rr.height}:null,
        rowHit:!!hit && (hit===row || row.contains(hit)), rows:el.querySelectorAll('tbody tr').length,
        overflowY:getComputedStyle(el).overflowY, flexShrink:getComputedStyle(el).flexShrink };
    });
    assert(stressMetrics.height >= 120 && stressMetrics.width > 0 && stressMetrics.row?.height > 0 && stressMetrics.rowHit,
      'long-analysis DOM stress leaves a visible, hit-testable relation row instead of shrinking the list to zero', stressMetrics);
    const keyboardRow = stressTable.locator('tbody button').first();
    await keyboardRow.focus();
    assert(await keyboardRow.evaluate(el => document.activeElement === el),
      'relation list remains keyboard focusable under long-analysis DOM stress');
    await keyboardRow.press('Enter');
    assert(await stressTable.locator('tbody tr[aria-selected="true"]').count() === 1,
      'Enter selects a relation-list row under long-analysis DOM stress');
    await stressTable.scrollIntoViewIfNeeded();
    const scrolledStress = await stressTable.evaluate(el => {
      const r=el.getBoundingClientRect(), main=el.closest('._codegraph-main'), mr=main.getBoundingClientRect();
      return { top:r.top,bottom:r.bottom,mainTop:mr.top,mainBottom:mr.bottom,scrollTop:main.scrollTop };
    });
    measurements.push({ name:'long-analysis-relation-list-dom-stress', stressFixture:'synthetic DOM content only; not backend/API relationship data', ...stressMetrics, scrolled:scrolledStress });
    assert(scrolledStress.bottom > scrolledStress.mainTop && scrolledStress.top < scrolledStress.mainBottom,
      'relation list is reachable within its main-panel scrollport under long-analysis DOM stress', scrolledStress);
    await page.getByTestId('layout-long-analysis-stress').evaluate(el => el.remove());
    await page.getByRole('button', { name: '显示关系图', exact: true }).click();
    await modeSelect.selectOption('calls');
    await page.waitForFunction(() => document.querySelector('._codegraph-control-row select')?.value === 'calls');

    // Narrow phones intentionally use drawers, with visible openers and graph.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('img', { name: 'fold' }).click();
    await page.waitForTimeout(100);
    await page.getByRole('button', { name: '目录与搜索', exact: true }).waitFor();
    await page.getByRole('button', { name: '节点详情与源码', exact: true }).waitFor();
    const narrow = await sample('mobile-390x844', 390, 844);
    assert(narrow.canvasCoverage.visible && narrow.canvas.height >= 300,
      '390px mobile: canvas remains visible with usable height', { canvas: narrow.canvas, coverage: narrow.canvasCoverage });
    await page.getByRole('button', { name: '目录与搜索', exact: true }).click();
    const searchDialog = page.getByRole('dialog', { name: '目录与搜索' });
    await searchDialog.waitFor();
    assert(await searchDialog.getByLabel('搜索符号', { exact: true }).isVisible(), 'mobile search drawer exposes symbol search');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '节点详情与源码', exact: true }).click();
    const detailsDialog = page.getByRole('dialog', { name: '节点详情与源码' });
    await detailsDialog.waitFor();
    assert(await detailsDialog.locator('pre').isVisible(), 'mobile details drawer exposes source');
    await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-layout-mobile.png', fullPage: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await modeSelect.selectOption('calls');
    await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-layout-desktop.png', fullPage: true });
    await page.getByText('视图说明', { exact: true }).click();
    const viewDescription = page.locator('._codegraph-capabilities[open]');
    await viewDescription.waitFor();
    await page.locator('._codedetail-graph-info > summary').click();
    const fullCommit = await page.locator('._codedetail-graph-info').innerText();
    assert(fullCommit.includes('1111111111111111111111111111111111111111'),
      'expanded repository information preserves the full commit hash');
    const expanded = await page.evaluate(() => {
      const read = selector => {
        const el=document.querySelector(selector), r=el?.getBoundingClientRect();
        if (!el || !r) return { selector, found:false, fullyVisible:false };
        let clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
        for (let p=el.parentElement;p;p=p.parentElement) {
          const s=getComputedStyle(p), pr=p.getBoundingClientRect();
          if (/(hidden|clip|auto|scroll)/.test(s.overflowX)) { clip.left=Math.max(clip.left,pr.left); clip.right=Math.min(clip.right,pr.right); }
          if (/(hidden|clip|auto|scroll)/.test(s.overflowY)) { clip.top=Math.max(clip.top,pr.top); clip.bottom=Math.min(clip.bottom,pr.bottom); }
        }
        const fullyVisible=r.left>=clip.left && r.right<=clip.right && r.top>=clip.top && r.bottom<=clip.bottom;
        const hit=document.elementFromPoint(Math.max(0,r.left+8),Math.max(0,Math.min(innerHeight-1,r.top+8)));
        return { selector, found:true, fullyVisible, height:r.height, bottom:r.bottom, clip,
          hit:!!hit && (hit===el || el.contains(hit)) };
      };
      const tabs=document.querySelector('._codedetail-tabs')?.getBoundingClientRect();
      const header=document.querySelector('._codedetail-header-body')?.getBoundingClientRect();
      return { sections:['._codegraph-capabilities[open]','._codedetail-graph-info[open]'].map(read),
        headerBelowTabs:!!header && !!tabs && header.bottom<=tabs.top+1,
        header:{bottom:header?.bottom}, tabs:{top:tabs?.top} };
    });
    assert(expanded.sections.every(x => x.found && x.fullyVisible && x.hit) && expanded.headerBelowTabs,
      'expanded guidance and repository metadata remain reachable without clipping or covering the tab header', expanded);
    return { checks, measurements, browser: await page.context().browser().version() };
  } catch (error) {
    await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/codegraph-layout-failure.png', fullPage: true }).catch(() => {});
    throw error;
  }
}
