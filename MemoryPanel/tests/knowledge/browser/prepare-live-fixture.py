"""Build a transient Playwright fixture from the running local server metadata."""
import json
import sys
from pathlib import Path

metadata = json.loads(Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/codegraph-live-browser.json').read_text())
output = Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/code-graph-live-fixture.js')
source = Path(__file__).with_name('code-graph-fixture.js').read_text()
source = source.replace('  const context = page.context();', '  const context = page.context();\n  const live = ' + json.dumps(metadata, separators=(',', ':')) + ';')
start = source.index('  const asset = id =>')
end = source.index('\n  const shapes =', start)
source = source[:start] + '  const asset = () => live.asset;' + source[end:]
source = source.replace("['cg-browser-a', 'cg-browser-b']", "['cg-browser-a']")
start = source.index('      const snapshot = { ...state };')
end = source.index('\n    } else {', start)
source = source[:start] + '''      const response = await route.fetch({ url: live.panelBaseUrl + path, headers: live.headers, postData: route.request().postData() });
      await route.fulfill({ response }); return;''' + source[end:]
source = source.replace("fixture: 'mock API / real CodePage'", "fixture: 'real SDK / Knowledge HTTP / Panel HTTP; identity and catalog fixtures'")
output.write_text(source)
print(output)
