// Playwright UI acceptance for model configuration. Backend is mocked by the fixture.
async (page) => {
  const checks = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
  const fixture = async (patch) => page.evaluate(async (value) => {
    return fetch('/__model_config_fixture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }).then((r) => r.json());
  }, patch);
  const requests = async () => page.evaluate(() => fetch('/__model_config_fixture').then((r) => r.json()));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByText('模型配置', { exact: true }).click();
  await page.getByTestId('model-config-panel').waitFor();
  assert(await page.getByText('Memhub Browser Instance', { exact: true }).isVisible(), 'current instance is visible');
  assert(await page.getByText('部署环境', { exact: true }).isVisible(), 'deployment source is visible before takeover');

  await page.getByPlaceholder('例如 deepseek-chat').fill('deepseek-chat');
  await page.getByPlaceholder('仅提交到服务端，不写入浏览器存储').fill('fixture-secret');
  await fixture({ createDelayMs: 350 });
  const createButton = page.getByRole('button', { name: '创建草稿' });
  await createButton.click();
  assert(await createButton.isDisabled(), 'save button is disabled while a request is in flight');
  await createButton.evaluate((button) => { button.click(); button.click(); });
  await page.getByText('草稿 · 未启用', { exact: true }).waitFor();
  const afterCreate = await requests();
  const createRequests = afterCreate.requests.filter((request) => request.path.endsWith('/meta/instance-upstream/extraction/create'));
  assert(createRequests.length === 1, 'double submission creates only one draft request');
  const createReq = createRequests[0];
  assert(createReq?.body.provider === 'deepseek' && createReq.body.api_key === 'fixture-secret', 'create request uses form provider and key');
  assert(createReq.body.draft === true && !('enabled' in createReq.body), 'create request saves a draft without activation');
  assert(afterCreate.enabled === false && afterCreate.version === 1, 'created config remains an inactive draft');
  assert(afterCreate.configured === false && afterCreate.source === 'deployment', 'draft creation leaves the active source unchanged');
  assert(afterCreate.draft?.model_id === 'deepseek-chat', 'created draft is returned for refresh and edit');
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  assert(!stored.includes('fixture-secret'), 'API key is not persisted in browser storage');
  assert((await page.getByPlaceholder('仅提交到服务端，不写入浏览器存储').count()) === 0, 'key input is cleared and hidden after save');

  await page.getByRole('button', { name: '替换密钥' }).click();
  await page.getByPlaceholder('仅提交到服务端，不写入浏览器存储').fill('replacement-secret');
  await page.getByRole('button', { name: '取消替换' }).click();
  await page.getByText('DeepSeek', { exact: true }).last().click();
  await page.getByText('GLM', { exact: true }).last().click();
  await page.getByText('我确认继续使用当前密钥访问新的供应商或地址', { exact: true }).waitFor();
  await page.getByRole('button', { name: '保存草稿' }).click();
  assert(await page.getByText('更换供应商或地址时，请确认继续使用当前密钥。', { exact: true }).isVisible(), 'client blocks unconfirmed key reuse');
  await page.getByRole('checkbox', { name: '我确认继续使用当前密钥访问新的供应商或地址' }).check();
  await page.getByPlaceholder('https://api.example.com/v1').fill('https://open.bigmodel.cn/api/paas/v4/alternate');
  await page.getByRole('button', { name: '保存草稿' }).click();
  assert(await page.getByText('更换供应商或地址时，请确认继续使用当前密钥。', { exact: true }).isVisible(), 'editing the endpoint resets key reuse confirmation');
  await page.getByRole('checkbox', { name: '我确认继续使用当前密钥访问新的供应商或地址' }).check();
  await page.getByRole('button', { name: '保存草稿' }).click();
  await page.getByText('草稿 · 未启用', { exact: true }).waitFor();
  const afterUpdate = await requests();
  const updateReq = afterUpdate.requests.filter((request) => request.path.endsWith('/meta/instance-upstream/extraction/update')).at(-1);
  assert(updateReq?.body.draft === true && updateReq.body.confirm_reuse_api_key === true, 'confirmed key reuse is sent as a draft update');
  assert(!('enabled' in updateReq.body), 'update request does not activate the config');

  await fixture({ conflictOnce: true });
  await page.getByPlaceholder('例如 deepseek-chat').fill('glm-4-plus');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await page.getByRole('button', { name: '重新读取最新配置' }).waitFor();
  assert((await page.getByPlaceholder('例如 deepseek-chat').inputValue()) === 'glm-4-plus', '409 conflict preserves local draft');
  assert(await page.getByText('提交版本 v2，服务端当前版本 v3。', { exact: true }).isVisible(), '409 exposes comparable versions');
  await page.getByRole('button', { name: '重新读取最新配置' }).click();
  await page.waitForFunction(() => document.querySelector('input[placeholder="例如 deepseek-chat"]')?.value === 'deepseek-chat');
  assert(true, 'conflict reload restores the latest server config');

  await page.getByPlaceholder('例如 deepseek-chat').fill('unsaved-value');
  await page.getByRole('button', { name: '关闭' }).click();
  await page.getByText('放弃未保存的修改？', { exact: true }).waitFor();
  assert(true, 'closing with unsaved changes asks for confirmation');
  await page.getByRole('button', { name: '取消' }).click();
  await page.getByText('权限管理', { exact: true }).click();
  await page.getByText('放弃未保存的修改？', { exact: true }).waitFor();
  await page.getByRole('button', { name: '放弃并离开' }).click();
  assert(await page.getByText('资源管理模块开关', { exact: true }).isVisible(), 'discarding changes returns to the permissions tab');

  await page.evaluate(() => localStorage.setItem('tdai-memory.lang', 'en-US'));
  await page.reload();
  await page.evaluate(() => document.documentElement.setAttribute('theme-mode', 'dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByText('Model Configuration', { exact: true }).click();
  await page.getByTestId('model-config-panel').waitFor();
  assert(await page.getByText('Memhub Browser Instance', { exact: true }).isVisible(), 'English narrow dark view renders instance context');
  assert((await page.getByPlaceholder('For example, deepseek-chat').inputValue()) === 'deepseek-chat', 'saved draft is restored after full reload');
  await page.waitForTimeout(400);
  const geometry = await page.evaluate(() => {
    const box = document.querySelector('.settings-dialog .tea-dialog__inner')?.getBoundingClientRect();
    const root = document.querySelector('.settings-dialog');
    return { left: box?.left ?? -1, right: box && root ? root.clientWidth - box.right : -1 };
  });
  assert(geometry.left >= 7 && geometry.right >= 7 && Math.abs(geometry.left - geometry.right) <= 2, 'narrow dialog is centered with balanced margins');
  const metrics = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  assert(metrics.scrollWidth <= metrics.width && metrics.bodyScrollWidth <= metrics.width, 'narrow view has no horizontal overflow');
  await page.screenshot({ path: '/Users/zj/daydayup/TencentDB-Agent-Memory/output/playwright/model-config-narrow-dark.png', fullPage: true });

  await fixture({ role: 'normal' });
  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByText('Permissions', { exact: true }).waitFor();
  assert((await page.getByText('Model Configuration', { exact: true }).count()) === 0, 'normal member cannot see the model configuration tab');
  return { checks, requests: (await requests()).requests };
}
