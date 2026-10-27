// Playwright UI acceptance for enabling / pausing a tested managed model config.
// Uses the shared mocked-Panel fixture (model-config-fixture.js).
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
  const requestsFor = async (suffix) => (await state()).requests.filter((r) => r.path.endsWith(suffix));

  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByText('模型配置', { exact: true }).click();
  await page.getByTestId('model-config-panel').waitFor();

  await page.getByPlaceholder('例如 deepseek-chat').fill('deepseek-chat');
  await page.getByPlaceholder('仅提交到服务端，不写入浏览器存储').fill('fixture-secret');
  await page.getByRole('button', { name: '创建草稿' }).click();
  await page.getByText('草稿 · 未启用', { exact: true }).waitFor();
  assert(true, 'draft is created and shown as not enabled');

  const enableButton = page.getByRole('button', { name: '启用配置' });
  assert(await enableButton.isDisabled(), 'enable is blocked before any connection test');
  assert(
    await page.getByText('启用前请先通过「连接能力测试」。', { exact: true }).isVisible(),
    'blocked enable explains that a connection test is required',
  );
  assert((await requestsFor('/extraction/enable')).length === 0, 'no enable request is issued while blocked');

  // 通过测试后启用
  await fixture({ testScenario: 'pass' });
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByTestId('model-config-test').getByText('118 ms', { exact: true }).waitFor();
  assert(!(await enableButton.isDisabled()), 'passing test unlocks enabling');
  assert((await page.getByText('启用前请先通过「连接能力测试」。', { exact: true }).count()) === 0, 'blocked hint disappears once evidence exists');

  await enableButton.click();
  await page.getByText('已启用', { exact: true }).first().waitFor();
  assert(true, 'configuration is shown as enabled after activation');
  assert(await page.getByRole('button', { name: '停用配置' }).isVisible(), 'disable action appears for the active config');
  const enableRequests = await requestsFor('/extraction/enable');
  assert(enableRequests.length === 1, 'enabling issues exactly one request');
  assert(enableRequests[0].body.test_id === 'mct_fixture_0001', 'enable request submits the tested test_id');
  assert(enableRequests[0].body.expected_version === 1, 'enable request submits the visible expected_version');
  assert(!('api_key' in enableRequests[0].body), 'enable request never carries the API key');
  const afterEnable = await state();
  assert(afterEnable.enabled === true && afterEnable.activeSnapshot?.snapshot_id === 'snap_fixture_1', 'active snapshot is recorded server-side');
  assert(afterEnable.draft?.model_id === 'deepseek-chat', 'draft is retained after enabling');

  // 手动重新同步知识服务（启用后 KS 对账失败时的恢复路径）
  const resyncButton = page.getByRole('button', { name: '重新同步知识服务' });
  assert(await resyncButton.isVisible(), 'manual knowledge re-sync is available for a managed config');
  await resyncButton.click();
  await page.getByText('已重新同步（ready）', { exact: true }).waitFor();
  assert(true, 'manual re-sync reports the resulting binding status');

  // 停用 -> paused，草稿保留
  await page.getByRole('button', { name: '停用配置' }).click();
  await page.getByText('已停用（受管配置）', { exact: true }).waitFor();
  assert(true, 'disabling enters the explicit paused state');
  assert(
    await page.getByText('受管模型已停用：新的生成任务不会再使用它，也不会回退到部署默认模型。重新启用需先通过连接测试。', { exact: true }).isVisible(),
    'paused state explains there is no silent fallback to the deployment model',
  );
  assert((await page.getByPlaceholder('例如 deepseek-chat').inputValue()) === 'deepseek-chat', 'draft survives pausing');
  const disableRequests = await requestsFor('/extraction/disable');
  assert(disableRequests.length === 1, 'disabling issues exactly one request');
  assert(typeof disableRequests[0].body.expected_version === 'number', 'disable request submits expected_version');
  const afterDisable = await state();
  assert(afterDisable.enabled === false && afterDisable.activeSnapshot?.snapshot_id === 'snap_fixture_1', 'pausing keeps the active snapshot');

  // 重新测试后可再次启用
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByTestId('model-config-test').getByText('118 ms', { exact: true }).waitFor();
  await page.getByRole('button', { name: '启用配置' }).click();
  await page.getByText('已启用', { exact: true }).first().waitFor();
  assert((await requestsFor('/extraction/enable')).length === 2, 'a paused config can be re-enabled after re-testing');

  // 表单有未保存改动时禁止启用
  await page.getByPlaceholder('例如 deepseek-chat').fill('deepseek-reasoner');
  assert(await page.getByRole('button', { name: '启用配置' }).isDisabled(), 'unsaved form edits block enabling');
  assert(
    await page.getByText('请先保存草稿，再启用。', { exact: true }).isVisible(),
    'blocked enable asks to save the draft first',
  );

  // 让后续浏览器验收拿到一份可用的已启用配置
  await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/model-config-enable-state.png', fullPage: true });
  return { checks };
}
