// Playwright CLI run-code --filename. The search sequence is mocked; this tests UI behavior only.
async (page) => {
  const checks = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
    checks.push(message);
  };
  const control = (value) =>
    page.evaluate(
      async (patch) =>
        fetch("/__codegraph-test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        }).then((response) => response.json()),
      value,
    );
  const snapshot = () =>
    page.evaluate(() =>
      fetch("/__codegraph-test").then((response) => response.json()),
    );
  const completedSearchRequests = [];
  page.on("response", (response) => {
    try {
      if (new URL(response.url()).pathname.endsWith("/code-graph/graph-search") && response.ok()) {
        completedSearchRequests.push(response.request().postDataJSON());
      }
    } catch {
      // Ignore non-JSON or navigation responses in the shared browser session.
    }
  });
  const searchInput = page.getByTestId("code-graph-search");
  const waitResultCount = async (count) =>
    page.waitForFunction((expected) => {
      const results = document.querySelectorAll("._codegraph-results li");
      return results.length === expected;
    }, count);
  try {
    if (!(await page.getByTestId("code-graph-workspace").isVisible())) {
      await page
        .getByRole("button", { name: "call-fixture-alpha", exact: true })
        .click();
    }
    if (!(await page.getByTestId("code-graph-workspace").isVisible())) {
      await page.getByRole("tab", { name: "关系图", exact: true }).click();
    }
    await page.getByTestId("code-graph-workspace").waitFor();

    const sparsePages = Array.from({ length: 8 }, (_, index) => ({
      count: 0,
      reason: "scan_budget",
      nextCursor: `sparse-${index + 1}`,
    }));
    sparsePages.push({ count: 1, reason: null, nextCursor: null });
    await control({ searchPages: sparsePages, clearRequests: true });
    await searchInput.fill("needle");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page
      .getByRole("button", { name: /needle-symbol-0.*src\/search-0\.ts:1/ })
      .waitFor();
    let requests = (await snapshot()).requests.filter((request) =>
      request.path.endsWith("/code-graph/graph-search"),
    );
    assert(
      requests.length === 9,
      "empty scan_budget pages continue serially until a matching page is found",
    );
    assert(
      requests.every((request, index) =>
        index === 0
          ? !request.body.cursor
          : request.body.cursor === `sparse-${index}`,
      ),
      "each continuation uses the prior opaque cursor in order",
    );
    assert(
      (await searchInput.getAttribute("placeholder")) === "函数名或类名",
      "symbol query placeholder remains localized",
    );
    assert(
      await page.getByText("可选；留空搜索整个仓库").isVisible(),
      "blank scope is explicitly documented as whole-repository search",
    );

    const accumulating = [
      { count: 0, reason: "scan_budget", nextCursor: "acc-1" },
      { count: 0, reason: "scan_budget", nextCursor: "acc-2" },
      { count: 40, reason: "scan_budget", nextCursor: "acc-3" },
      { count: 60, reason: "node_budget", nextCursor: "acc-4" },
      { count: 0, reason: "scan_budget", nextCursor: "acc-5" },
      { count: 40, reason: "scan_budget", nextCursor: "acc-6" },
      { count: 60, reason: "node_budget", nextCursor: "acc-7" },
      { count: 100, reason: "node_budget", nextCursor: "acc-8" },
      { count: 100, reason: "node_budget", nextCursor: "acc-9" },
      { count: 100, reason: "node_budget", nextCursor: "acc-10" },
    ];
    await control({ searchPages: accumulating, clearRequests: true });
    await searchInput.fill("needle");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await waitResultCount(100);
    requests = (await snapshot()).requests.filter((request) =>
      request.path.endsWith("/code-graph/graph-search"),
    );
    assert(
      requests.length === 4,
      "hit-bearing scan_budget pages accumulate until the 100-result target or node_budget",
    );
    assert(
      await page
        .getByRole("button", { name: "加载更多结果", exact: true })
        .isVisible(),
      "node-budget result pages offer a distinct load-more action",
    );
    await page
      .getByRole("button", { name: "加载更多结果", exact: true })
      .click();
    await waitResultCount(200);
    requests = (await snapshot()).requests.filter((request) =>
      request.path.endsWith("/code-graph/graph-search"),
    );
    assert(
      requests.length === 7,
      "continuing after 100 results scans across empty and partial pages to the next 100-result target",
    );

    for (let expected = 300; expected <= 500; expected += 100) {
      await page
        .getByRole("button", { name: "加载更多结果", exact: true })
        .click();
      await waitResultCount(expected);
    }
    requests = (await snapshot()).requests.filter((request) =>
      request.path.endsWith("/code-graph/graph-search"),
    );
    assert(
      requests.length === 10,
      "manual continuation preserves query and resumes from the last successful cursor",
    );
    assert(
      await page
        .getByRole("button", { name: "加载更多结果", exact: true })
        .isDisabled(),
      "the 500-result cap disables further search",
    );

    await control({
      searchPages: [
        { count: 1, reason: "node_budget", nextCursor: "repeat-cursor" },
        { count: 0, reason: "scan_budget", nextCursor: "repeat-cursor" },
        { count: 1, reason: null, nextCursor: null },
      ],
      clearRequests: true,
    });
    await searchInput.fill("repeat");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page
      .getByRole("button", { name: /repeat-symbol-0.*src\/search-0\.ts:1/ })
      .waitFor();
    await page
      .getByRole("button", { name: "加载更多结果", exact: true })
      .click();
    await page.waitForTimeout(300);
    requests = (await snapshot()).requests.filter((request) =>
      request.path.endsWith("/code-graph/graph-search"),
    );
    assert(
      requests.length === 2,
      "a repeated continuation cursor is detected before another duplicate request is sent",
    );

    const budgetPages = Array.from({ length: 200 }, (_, index) => ({
      count: 0,
      reason: "scan_budget",
      nextCursor: `budget-${index + 1}`,
    }));
    budgetPages.push({ count: 1, reason: null, nextCursor: null });
    await control({ searchPages: budgetPages, clearRequests: true });
    completedSearchRequests.length = 0;
    await searchInput.fill("budget");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByText("扫描已暂停，尚未完成；可继续查找。").waitFor();
    requests = (await snapshot()).requests.filter((request) =>
      request.path.endsWith("/code-graph/graph-search"),
    );
    const stoppedAt = requests.length;
    const successfulPages = completedSearchRequests.length;
    assert(
      stoppedAt > 0 && stoppedAt <= 200,
      "automatic search pauses within its 200-page and 12-second budgets",
    );
    const resumePages = Array.from({ length: stoppedAt }, (_, index) => ({
      count: 0,
      reason: "scan_budget",
      nextCursor: `budget-${index + 1}`,
    }));
    resumePages.push({ count: 1, reason: null, nextCursor: null });
    await control({ searchPages: resumePages });
    await page.getByRole("button", { name: "继续查找", exact: true }).click();
    await page
      .getByRole("button", { name: /budget-symbol-0.*src\/search-0\.ts:1/ })
      .waitFor();
    requests = (await snapshot()).requests.filter((request) =>
      request.path.endsWith("/code-graph/graph-search"),
    );
    assert(
      requests.length > stoppedAt &&
        requests[stoppedAt].body.query === "budget" &&
        successfulPages > 0 &&
        requests[stoppedAt].body.cursor === `budget-${successfulPages}`,
      "continue resumes the saved cursor and can complete the search",
    );

    await control({
      actionState: { "graph-search": "building" },
      searchPages: null,
      clearRequests: true,
    });
    await searchInput.fill("terminal");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByText("索引正在构建，请稍后刷新。").waitFor();
    assert(
      (await page.locator("._codegraph-results li").count()) === 0,
      "terminal index states are shown instead of being merged into ready results",
    );
    assert(
      (await snapshot()).requests.filter((request) =>
        request.path.endsWith("/code-graph/graph-search"),
      ).length === 1,
      "terminal search responses stop automatic continuation",
    );

    await control({
      actionState: {},
      searchPages: [{ count: 0, reason: null, nextCursor: null }],
      clearRequests: true,
    });
    await searchInput.fill("absent");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByText("当前范围没有匹配结果。").waitFor();
    assert(
      (await page
        .getByText("当前仅扫描了部分索引；可以继续加载或缩小搜索范围。")
        .count()) === 0,
      "completed empty searches show no-match only after a complete scan",
    );

    await control({
      searchPages: [
        { count: 1, reason: "scan_budget", nextCursor: "scope-next" },
        { count: 1, reason: null, nextCursor: null },
      ],
      delayByCursor: { "scope-next": 900 },
      delayByAction: {},
      clearRequests: true,
    });
    await searchInput.fill("scope");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page
      .getByRole("button", { name: /scope-symbol-0.*src\/search-0\.ts:1/ })
      .waitFor();
    await page.getByLabel("目录或文件范围", { exact: true }).fill("src/");
    assert(
      (await page.locator("._codegraph-results li").count()) === 0,
      "changing scope immediately clears results from the old scope",
    );
    await page.waitForTimeout(1000);
    assert(
      (await page.locator("._codegraph-results li").count()) === 0,
      "late responses from the old scope cannot repopulate results",
    );

    await control({
      searchPages: [{ count: 1, reason: null, nextCursor: null }],
      delayByAction: { "graph-search": 900 },
      delayByCursor: {},
      clearRequests: true,
    });
    await searchInput.fill("stale");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("button", { name: "取消搜索", exact: true }).waitFor();
    await searchInput.fill("fresh");
    assert(
      (await page.locator("._codegraph-results li").count()) === 0,
      "changing the query immediately clears results from the prior query",
    );
    await page.waitForTimeout(1000);
    assert(
      (await page.locator("._codegraph-results li").count()) === 0,
      "aborted stale responses cannot repopulate results after query change",
    );
    assert(
      (await searchInput.inputValue()) === "fresh",
      "the active query remains the one shown in the input",
    );

    await control({
      searchPages: [
        { count: 1, reason: "scan_budget", nextCursor: "cancel-next" },
        { count: 1, reason: null, nextCursor: null },
      ],
      delayByCursor: { "cancel-next": 900 },
      delayByAction: {},
      clearRequests: true,
    });
    await searchInput.fill("cancel");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page
      .getByRole("button", { name: /cancel-symbol-0.*src\/search-0\.ts:1/ })
      .waitFor();
    await page.getByRole("button", { name: "取消搜索", exact: true }).waitFor();
    await page.getByRole("button", { name: "取消搜索", exact: true }).click();
    await page
      .getByRole("button", { name: /cancel-symbol-0.*src\/search-0\.ts:1/ })
      .waitFor();
    assert(
      await page.getByText("扫描已暂停，尚未完成；可继续查找。").isVisible(),
      "manual cancellation preserves partial results and marks the scan incomplete",
    );
    const cancelledCount = (await snapshot()).requests.filter((request) =>
      request.path.endsWith("/code-graph/graph-search"),
    ).length;
    await page.waitForTimeout(1100);
    assert(
      cancelledCount === 2 &&
        (await snapshot()).requests.filter((request) =>
          request.path.endsWith("/code-graph/graph-search"),
        ).length === 2,
      "manual cancellation aborts the pending cursor request and prevents any further scan",
    );

    await control({
      searchPages: [{ count: 1, reason: null, nextCursor: null }],
      delayByAction: { "graph-search": 15000 },
      delayByCursor: {},
      clearRequests: true,
    });
    await searchInput.fill("first-timeout");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page
      .getByText("搜索耗时较长，已暂停且尚未完成；可以重新搜索或缩小范围。")
      .waitFor({ timeout: 16000 });
    assert(
      await page.getByRole("button", { name: "搜索", exact: true }).isEnabled(),
      "a first-request timeout shows an incomplete state and leaves search available",
    );
    await page.waitForTimeout(4000);
    assert(
      (await page.locator("._codegraph-results li").count()) === 0,
      "a late first response cannot create results after the hard timeout",
    );

    await control({
      searchPages: [
        { count: 0, reason: "scan_budget", nextCursor: "slow-next" },
        { count: 0, reason: "scan_budget", nextCursor: "slow-third" },
      ],
      delayByCursor: { "slow-next": 15000 },
      delayByAction: {},
      clearRequests: true,
    });
    await searchInput.fill("slow");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page
      .getByText("扫描已暂停，尚未完成；可继续查找。")
      .waitFor({ timeout: 16000 });
    assert(
      await page.getByRole("button", { name: "搜索", exact: true }).isEnabled(),
      "the 12-second hard deadline aborts a hung scan and restores the search action",
    );
    await page.waitForTimeout(4000);
    assert(
      await page
        .getByText("扫描已暂停，尚未完成；可继续查找。", { exact: true })
        .isVisible(),
      "a late response after hard timeout cannot clear the incomplete state",
    );

    return { checks };
  } catch (error) {
    await page.screenshot({
      path: "output/playwright/codegraph-search-failure.png",
      fullPage: true,
    });
    throw new Error(JSON.stringify({ checks, error: String(error) }));
  }
}
