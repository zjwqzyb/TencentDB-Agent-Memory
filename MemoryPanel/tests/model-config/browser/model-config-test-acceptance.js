// Playwright UI acceptance for the unsaved model-configuration connection test.
// Uses the shared mocked-Panel fixture (model-config-fixture.js), which serves a real
// NDJSON stream for /meta/instance-upstream/extraction/test.
async (page) => {
  const checks = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
  const fixture = async (patch) => page.evaluate(async (value) =>
    fetch('/__model_config_fixture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    }).then((r) => r.json()), patch);
  const state = async () => page.evaluate(() => fetch('/__model_config_fixture').then((r) => r.json()));
  const testRequests = async () => (await state()).requests.filter((r) => r.path.endsWith('/meta/instance-upstream/extraction/test'));
  const panel = () => page.getByTestId('model-config-test');

  await page.setViewportSize({ width: 1280, height: 980 });
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByText('模型配置', { exact: true }).click();
  await page.getByTestId('model-config-panel').waitFor();

  // 先建草稿：让"留空 Key 时复用服务端已存 Key"这条路径真实成立。
  await page.getByPlaceholder('例如 deepseek-chat').fill('deepseek-chat');
  await page.getByPlaceholder('仅提交到服务端，不写入浏览器存储').fill('fixture-secret');
  await page.getByRole('button', { name: '创建草稿' }).click();
  await page.getByText('草稿 · 未启用', { exact: true }).waitFor();

  assert(await panel().isVisible(), 'connection test section is visible on the settings tab');
  assert(await panel().getByText('连接能力测试', { exact: true }).isVisible(), 'test section has a title');
  assert(
    await panel().getByText('使用当前未保存的表单发起测试', { exact: false }).isVisible(),
    'test section states it uses the unsaved form and does not save',
  );
  assert((await panel().getByText('未运行', { exact: true }).count()) === 3, 'three capabilities start as not run');

  // ── 1. 三条能力全通过 ──
  await fixture({ testScenario: 'pass' });
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByRole('button', { name: '测试连接' }).waitFor();
  await panel().getByText('mct_fixture_0001', { exact: true }).waitFor();
  assert((await panel().getByText('通过', { exact: true }).count()) === 3, 'all three capabilities report passed');
  assert(await panel().getByText('基础调用', { exact: true }).isVisible(), 'basic capability is labelled');
  assert(await panel().getByText('JSON 输出', { exact: true }).isVisible(), 'json capability is labelled');
  assert(await panel().getByText('工具调用', { exact: true }).isVisible(), 'tools capability is labelled');
  assert(await panel().getByText('118 ms', { exact: true }).isVisible(), 'per-capability duration is shown');
  assert(await panel().getByText('271 ms', { exact: true }).isVisible(), 'tool capability duration is shown');
  assert(await panel().getByText('0123-4567-89ab', { exact: true }).isVisible(), 'config fingerprint is shown abbreviated');
  assert(await panel().getByText('面板管理', { exact: true }).isVisible(), 'test source is shown');

  const passRequests = await testRequests();
  const passReq = passRequests[passRequests.length - 1];
  assert(passRequests.length === 1, 'a single probe request is issued per run');
  assert(passReq.body.provider === 'deepseek' && passReq.body.model_id === 'deepseek-chat', 'probe request carries the unsaved form fields');
  assert(passReq.body.base_url === 'https://api.deepseek.com', 'probe request carries the form base url');
  assert(!('api_key' in passReq.body), 'blank key field omits api_key so the server reuses the stored key');
  assert(passReq.body.base_version === 1, 'probe request is bound to the visible config version');

  // ── 2. 失败能力独立展示 ──
  await fixture({ testScenario: 'fail' });
  await page.getByRole('button', { name: '测试连接' }).click();
  await panel().getByText('JSON_INVALID', { exact: false }).waitFor();
  assert((await panel().getByText('通过', { exact: true }).count()) === 1, 'only the passing capability shows passed');
  assert((await panel().getByText('失败', { exact: true }).count()) === 2, 'failing capabilities are marked failed independently');
  assert(await panel().getByText('TOOL_CALL_UNSUPPORTED', { exact: false }).isVisible(), 'tool capability surfaces its own error code');
  assert(await panel().getByText('Model output was not parseable JSON.', { exact: false }).isVisible(), 'sanitized upstream error message is shown');

  // ── 3. 取消进行中的测试 ──
  await fixture({ testScenario: 'hang' });
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByRole('button', { name: '取消测试' }).waitFor();
  assert(await panel().getByText('测试中…', { exact: true }).isVisible(), 'running state is visible while the probe is in flight');
  assert(await page.getByPlaceholder('例如 deepseek-chat').isDisabled(), 'form is locked while the probe runs');
  await page.getByRole('button', { name: '取消测试' }).click();
  await page.getByRole('button', { name: '测试连接' }).waitFor();
  await panel().getByText('已取消', { exact: true }).first().waitFor();
  assert((await panel().getByText('已取消', { exact: true }).count()) === 3, 'cancelling resolves every capability as cancelled');
  assert(!(await page.getByPlaceholder('例如 deepseek-chat').isDisabled()), 'form is editable again after cancelling');

  // ── 4. 重复点击只发一次 ──
  await fixture({ testScenario: 'pass' });
  const beforeDup = (await testRequests()).length;
  const testButton = page.getByRole('button', { name: '测试连接' });
  await testButton.evaluate((button) => { button.click(); button.click(); });
  await page.waitForTimeout(800);
  const afterDup = (await testRequests()).length;
  assert(afterDup - beforeDup === 1, 'repeated clicks issue exactly one probe request');

  // ── 5. 显式替换 Key 时会提交新 Key ──
  await page.getByRole('button', { name: '替换密钥' }).click();
  await page.getByPlaceholder('仅提交到服务端，不写入浏览器存储').fill('rotated-secret');
  await fixture({ testScenario: 'pass' });
  await page.getByRole('button', { name: '测试连接' }).click();
  await panel().getByText('118 ms', { exact: true }).waitFor();
  const rotated = await testRequests();
  assert(rotated[rotated.length - 1].body.api_key === 'rotated-secret', 'an explicit replacement key is submitted with the probe');
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  assert(!stored.includes('fixture-secret') && !stored.includes('rotated-secret'), 'probe keys never reach browser storage');

  // ── 6. 英文 + 暗色 + 窄屏 ──
  await page.evaluate(() => {
    localStorage.setItem('tdai-memory.lang', 'en-US');
    document.documentElement.setAttribute('theme-mode', 'dark');
  });
  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByText('Model Configuration', { exact: true }).click();
  await page.getByTestId('model-config-panel').waitFor();
  await fixture({ testScenario: 'pass' });
  await page.getByRole('button', { name: 'Test connection' }).click();
  await panel().getByText('118 ms', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(400);
  assert(await panel().getByText('Connection capability test', { exact: true }).isVisible(), 'English narrow dark view renders the test section');
  assert((await panel().getByText('Passed', { exact: true }).count()) === 3, 'results survive the viewport change');
  const metrics = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  assert(metrics.scrollWidth <= metrics.width && metrics.bodyScrollWidth <= metrics.width, 'test results do not overflow the narrow viewport');
  await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/model-config-test-narrow-dark.png', fullPage: true });

  return { checks };
}
