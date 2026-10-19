// Real CodePage UI with deterministic API responses, not parser/extraction evidence.
async (page) => {
  const checks = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const control = patch => page.evaluate(patch => fetch('/__codegraph-test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).then(r => r.json()), patch);
  const mode = () => page.getByRole('combobox', { name: '关系视图', exact: true });
  const work = page.getByTestId('code-graph-workspace');
  const notice = page.getByTestId('code-graph-state');
  const search = async (query, name) => {
    const input = page.getByTestId('code-graph-search');
    await page.waitForFunction(() => { const button = document.querySelector('[data-testid="code-graph-search"]')?.closest('form')?.querySelector('button[type="submit"]'); return button && !button.disabled; });
    await input.fill(query); await input.press('Enter');
    await page.getByRole('button', { name, exact: true }).click();
  };
  const defaults = { javaFixture: true, version: 'v1', responseState: 'ready', actionState: {}, actionWarnings: {}, capabilities: null, extraWarnings: [], modeWarnings: {}, extraReasons: null, httpStatus: 200, truncated: false, clearRequests: true };
  const reset = async patch => {
    await control({ ...defaults, ...patch });
    await page.getByRole('button', { name: '重置', exact: true }).click();
    await page.getByRole('button', { name: 'Service.java file src/main/java/demo/Service.java:1', exact: true }).waitFor();
  };
  const run = () => search('run', 'run method src/main/java/demo/Service.java:8');
  const rows = () => page.getByTestId('code-graph-relations').locator('table').nth(1).locator('tbody tr');
  try {
    await page.evaluate(() => localStorage.setItem('tdai-memory.lang', 'zh-CN'));
    await page.reload(); await page.setViewportSize({ width: 1500, height: 1000 });
    await page.getByRole('button', { name: 'call-fixture-alpha', exact: true }).click();
    await page.getByRole('tab', { name: '关系图', exact: true }).click();
    await reset();
    await page.getByTestId('code-graph-capabilities').getByText('关系查询已验证语言：TypeScript, JavaScript, Java', { exact: true }).waitFor();
    assert(true, 'verified-language hint renders capability languages including Java');
    await search('demo', 'demo namespace src/main/java/demo/Service.java:1');
    await notice.getByText('当前节点不适用于调用视图，请选择方法、函数或包含初始化调用的类型/字段。', { exact: true }).waitFor();
    assert(!await notice.getByRole('button', { name: '重新加载', exact: true }).count(), 'Java package focus is explained without a reload or language error');
    assert(!await work.getByText('此节点在当前查询范围内没有关系。', { exact: true }).count(), 'non-applicable package is not reported as a genuine zero-relation result');
    await notice.getByRole('button', { name: '选择其他符号', exact: true }).click();
    assert(await page.getByTestId('code-graph-search').evaluate(el => el === document.activeElement), 'desktop recovery focuses the actual symbol search');
    assert(await notice.getAttribute('role') === 'status' && await notice.getAttribute('aria-live') === 'polite', 'state explanations are in an atomic polite live region');
    await run();
    await page.getByRole('button', { name: '关系列表', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="code-graph-relations"] table:nth-of-type(2) tbody')?.children.length > 0);
    await page.getByTestId('code-graph-source').locator('pre').filter({ hasText: '@v1:a' }).waitFor();
    assert(!await notice.count(), 'Java method draws calls and retains same-snapshot source');
    await mode().selectOption('impact');
    await page.getByTestId('code-graph-impact-list').waitFor();
    assert(await rows().count() > 0, 'Java method impact view receives and renders relations');
    await mode().selectOption('hierarchy');
    await notice.getByText('请选择 class 或 interface 类型；当前符号不适用于继承视图。', { exact: true }).waitFor();
    assert(!await notice.getByRole('button', { name: '重新加载', exact: true }).count(), 'method in hierarchy is a focus mismatch with a choose-symbol recovery');
    await search('Service', 'Service class src/main/java/demo/Service.java:3');
    await page.waitForFunction(() => document.querySelector('[data-testid="code-graph-relations"] table:nth-of-type(2) tbody')?.children.length === 2);
    assert(!(await work.innerText()).includes('当前索引器未提取 TypeScript 接口继承关系'), 'Java class hierarchy has no TypeScript-only limitation');
    await search('RunnableService', 'RunnableService interface src/main/java/demo/RunnableService.java:2');
    await page.waitForFunction(() => document.querySelector('[data-testid="code-graph-relations"] table:nth-of-type(2) tbody')?.children.length === 1);
    assert(!(await work.innerText()).includes('当前索引器未提取 TypeScript 接口继承关系'), 'Java interface hierarchy is not treated as the TypeScript extraction gap');
    for (const value of ['dependencies', 'clusters']) {
      await mode().selectOption(value);
      await page.waitForFunction(() => document.querySelector('[data-testid="code-graph-relations"] table:nth-of-type(2) tbody')?.children.length === 2);
      assert(await rows().count() === 2, `Java ${value} view renders aggregate relation data`);
    }
    await control({ extraReasons: ['java_source_budget'], extraCursor: 'java-page2', modeWarnings: { calls: ['java_heuristic_relations_omitted', 'java_wildcard_relations_omitted', 'java_ambiguous_relations_omitted', 'java_relation_source_unverified', 'java_relation_source_budget', 'java_static_analysis_incomplete'] } });
    await mode().selectOption('calls'); await run();
    await work.getByText('部分星号导入无法确认目标，相关 Java 跨文件调用已省略。', { exact: true }).waitFor();
    assert(await rows().count() > 0 && !await notice.count(), 'partial Java warnings preserve verified ready relations');
    const warningText = await work.innerText();
    assert(warningText.includes('推断生成的 Java 调用关系') && warningText.includes('接收者或导入不匹配') && warningText.includes('源码或语法无法核实') && warningText.includes('源码读取预算') && !warningText.includes('java_heuristic'), 'Java coverage warnings are readable and hide internal codes');
    assert(warningText.includes('可继续加载后续页') && await page.getByRole('button', { name: '加载更多关系', exact: true }).isVisible(), 'Java source budget offers real pagination only when a continuation exists');
    await page.screenshot({ path: 'output/playwright/codegraph-java-recovery-desktop.png', fullPage: true });
    await control({ extraReasons: null, modeWarnings: {}, actionState: { graph: 'unsupported' }, actionWarnings: { graph: ['unverified_language:java'] }, truncated: true, capabilities: { languages: ['typescript', 'javascript'] } });
    await run();
    await notice.getByText(/当前关系查询尚未验证 Java/).waitFor();
    assert(!await notice.getByRole('button', { name: '重新加载', exact: true }).count(), 'unverified language has a specific explanation with no ineffective reload');
    assert(!(await notice.innerText()).includes('重新索引') && !(await notice.innerText()).includes('重建'), 'language gate never recommends an index rebuild as a fix');
    await notice.getByRole('button', { name: '使用概览与文本查询', exact: true }).click();
    await page.getByRole('tabpanel', { name: '概览与文本查询', exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'code-detail-tab-overview');
    assert(await page.getByRole('tab', { name: '概览与文本查询', exact: true }).evaluate(el => el === document.activeElement), 'text-query recovery opens the real overview tab and restores tab focus');
    await control(defaults); await page.getByRole('tab', { name: '关系图', exact: true }).click();
    for (const [warning, text] of [
      ['unverified_sdk_version', '当前服务版本尚未通过关系查询兼容性验证'],
      ['unsupported_index_schema', '当前索引格式与关系查询不兼容'],
      ['future_reason', '当前无法展示此关系视图'],
    ]) {
      await control({ truncated: false, actionState: { graph: 'unsupported' }, actionWarnings: { graph: [warning] } });
      await run(); await notice.getByText(text, { exact: false }).waitFor();
      assert(!await notice.getByRole('button', { name: '重新加载', exact: true }).count(), `${warning} exposes an honest alternative without generic reload`);
    }
    await control({ ...defaults, httpStatus: 0 }); await run();
    await notice.getByText('请求失败，请检查网络后重试。', { exact: false }).waitFor();
    assert(await notice.getByRole('button', { name: '重新加载', exact: true }).count() === 1, 'network failures retain a real reload recovery');
    await control(defaults); await notice.getByRole('button', { name: '重新加载', exact: true }).click();
    await run(); await page.getByTestId('code-graph-source').locator('pre').waitFor();
    await control({ actionState: { graph: 'version_expired' } }); await run();
    await notice.getByText('索引版本已变化', { exact: false }).waitFor();
    assert(await notice.getByRole('button', { name: '重新加载', exact: true }).count() === 1, 'snapshot expiry retains reload and clears stale graph');
    await control(defaults); await notice.getByRole('button', { name: '重新加载', exact: true }).click();
    await page.setViewportSize({ width: 375, height: 850 });
    await page.getByRole('button', { name: '目录与搜索', exact: true }).click();
    await search('demo', 'demo namespace src/main/java/demo/Service.java:1');
    await notice.getByRole('button', { name: '选择其他符号', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '目录与搜索', exact: true });
    await drawer.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'code-graph-search');
    assert(await drawer.getByTestId('code-graph-search').evaluate(el => el === document.activeElement), '375px recovery opens the accessible search drawer and focuses input');
    await run(); await page.getByRole('button', { name: '节点详情与源码', exact: true }).click();
    await page.getByRole('dialog', { name: '节点详情与源码', exact: true }).locator('pre').waitFor();
    assert(true, '375px Java method still exposes indexed source in the detail drawer');
    await page.waitForTimeout(350); // Settle the existing Tea drawer transition for visual evidence.
    await page.screenshot({ path: 'output/playwright/codegraph-java-recovery-narrow.png', fullPage: true });
    await page.keyboard.press('Escape');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '375px page does not overflow horizontally');
    await page.evaluate(() => localStorage.setItem('tdai-memory.lang', 'en-US')); await page.reload();
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.getByRole('button', { name: 'call-fixture-alpha', exact: true }).click();
    await page.getByRole('tab', { name: 'Repository graph', exact: true }).click();
    await page.getByTestId('code-graph-capabilities').getByText('Verified languages for relation queries: TypeScript, JavaScript, Java', { exact: true }).waitFor();
    await search('demo', 'demo namespace src/main/java/demo/Service.java:1');
    await notice.getByText(/Choose a method, function, or a type or field with initializer calls/).waitFor();
    assert(await notice.getByRole('button', { name: 'Choose another symbol', exact: true }).count() === 1, 'English capability and package recovery copy render translated actions');
    await control({ capabilities: { languages: ['typescript', 'javascript'] }, actionState: { graph: 'unsupported' }, actionWarnings: { graph: ['unverified_language:java'] } });
    await run(); await notice.getByText(/Relation queries have not been verified for Java/).waitFor();
    assert(await notice.getByRole('button', { name: 'Open overview and text queries', exact: true }).count() === 1, 'English unverified-language fallback has a translated text-query entry');
    await notice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/codegraph-java-recovery-english.png', fullPage: true });
    const lightColor = await page.getByTestId('code-graph-capabilities').evaluate(el => getComputedStyle(el).color);
    await page.evaluate(() => document.documentElement.setAttribute('theme-mode', 'dark'));
    await page.waitForTimeout(150);
    const darkColor = await page.getByTestId('code-graph-capabilities').evaluate(el => getComputedStyle(el).color);
    assert(lightColor !== darkColor && await notice.isVisible(), 'capability hint and recovery alert follow the existing dark theme tokens');
    await page.screenshot({ path: 'output/playwright/codegraph-java-recovery-dark.png', fullPage: true });
    return { checks, browser: page.context().browser().version(), evidence: 'real CodePage; mocked API responses, not Java parser evidence' };
  } catch (error) {
    await page.screenshot({ path: 'output/playwright/codegraph-java-recovery-failure.png', fullPage: true });
    throw new Error(JSON.stringify({ checks, error: String(error) }));
  }
}
