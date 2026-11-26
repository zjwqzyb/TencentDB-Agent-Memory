"""Exercise Panel, Core and stdio MCP against an isolated SQLite or MongoDB fixture."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

fixture = json.loads(Path(sys.argv[1]).read_text())
scope = dict(team_id=fixture["team"], asset_id=fixture["asset"])
second = dict(team_id=fixture["second"], asset_id=fixture["otherAsset"])
root = Path(__file__).resolve().parents[3]


def call(action, body, who="owner", expected=0):
    headers = {"content-type": "application/json", "x-tdai-service-id": fixture["instanceId"]}
    if who:
        headers["x-tdai-user-key"] = fixture[who]["userKey"]
    path = fixture["baseUrl"] + "/api/v1/meta/" + action
    request = urllib.request.Request(path, json.dumps(body).encode(), headers)
    try:
        response = urllib.request.urlopen(request, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        result = json.load(response)
    if expected is not None:
        assert result["code"] == expected, (action, who, result)
    return result


def proto(action, body, **kwargs):
    return call("prototype/" + action, {**scope, **body}, **kwargs)["data"]


# Isolate every invocation from earlier acceptance runs and the browser projects.
for project_scope, actor in [(scope, "owner"), (second, "other")]:
    asset = call("prototype/project/create", {"team_id":project_scope["team_id"],"name":"QA claims"},actor)["data"]
    project_scope["asset_id"] = asset["asset_id"]
for subject, kind, perm in [(fixture["editor"]["user_id"],"user","write"),(fixture["agent"],"agent","read")]:
    grant = call("acl/grant",dict(asset_id=scope["asset_id"],subject_id=subject,subject_type=kind,
        permission=perm,granted_by=fixture["owner"]["user_id"]))["data"]
    if kind == "agent":
        read_grant = grant["id"]

empty = {"format_version": 1, "views": ["list"], "components": []}
unit = dict(page_key="qa-list", base_version=None, snapshot=empty)
contract = dict(component_type="column", contract_version=1, definition=dict(
    properties={"label": {"type": "string", "required": True}}, slots={}, bindings=["field"], interactions=[], views=["list"]))
node = dict(id="col-1", type="column", contract_version=1, parent_id=None, slot=None, order=0,
            props={"label": "客户"}, bindings={"field": "customer.name"})
updated = {**empty, "components": [node]}
target = dict(page_key="qa-list", version=2)
proto("contract/publish", contract)
proto("page/get", {"page_key": "qa-list"}, expected=404)
first = proto("page/save", dict(request_id="blank", pages=[unit]))
assert first["versions"] == {"qa-list": 1}
assert proto("page/get",{"page_key":"qa-list","version":1})["snapshot"] == empty
edit = dict(request_id="columns",pages=[{**unit, "base_version":1,"snapshot":updated}])
assert proto("page/save",edit,who="editor")["versions"] == {"qa-list":2}
proto("contract/publish",{**contract,"contract_version":2})
assert proto("page/get",target,who="reader")["snapshot"] == updated
proto("page/save",{**edit,"request_id":"bad","pages":[{**unit,"base_version":2,"snapshot":{
    **updated,"components":[{**node,"contract_version":99}]}}]},expected=422)
proto("contract/publish",{**contract,"definition":{**contract["definition"],"bindings":[]}},expected=409)
restored = dict(page_key="qa-list",base_version=2,restore_version=1,request_id="restore")
row = proto("page/restore",restored)
assert row["version"] == 3 and row["base_version"] == 2 and row["restore_version"] == 1 and row["snapshot"] == empty
assert row["author_id"] == fixture["owner"]["user_id"] and row["created_at"]
assert proto("page/restore",restored)["version"] == 3
assert proto("page/save",edit,who="editor")["versions"] == {"qa-list":2}
assert len(proto("page/history",{"page_key":"qa-list"})["items"]) == 3
proto("page/get",{**target,"version":55},expected=404)
assert proto("project/get",{},who="reader")["can_write"] is False
for action, body in [("page/save",edit),("page/restore",restored),("contract/publish",contract)]:
    proto(action,body,who="reader",expected=403)
anonymous = call("prototype/page/get", {**scope, **target}, who=None, expected=400)
assert anonymous["message"] == "MISSING_USER_KEY" and anonymous["data"] is None
for action,body in [("project/get",{}),("page/list",{}),("page/history",target | {"version":None}),
                    ("page/get",target),("contract/get",dict(component_type="column",contract_version=1))]:
    if action=="page/history": body={"page_key":target["page_key"]}
    proto(action,body,who="other",expected=404)
visible = call("prototype/project/list",dict(team_id=fixture["second"]),"other")["data"]["items"]
assert second["asset_id"] in {x["asset_id"] for x in visible}
assert all(x["team_id"] == second["team_id"] for x in visible)
call("prototype/page/save",{**second,"request_id":"other-save","pages":[unit]},"other")
proto("page/get", {**target,"agent_id":fixture["ungranted"]}, expected=404)
proto("page/get", {**target,"agent_id":fixture["agent"]}, who="editor", expected=404)
print("PASS A1 A5 + two-team API authorization and exact contract reads")

for base in [None,1]:
    def compete(i):
        body = {**scope, "request_id":f"race-{base}-{i}", "pages":[{**unit,"page_key":"concurrent","base_version":base}]}
        return call("prototype/page/save",body,["owner","editor"][i],expected=None)["code"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(compete,[0,1])) == [0,409]
print("PASS simultaneous initial save and same-baseline updates")
same = dict(request_id="same-key", pages=[{**unit,"page_key":"retry-pair"},
                                        {**unit,"page_key":"retry-form"}])
with ThreadPoolExecutor(max_workers=2) as pool:
    left, right = list(pool.map(lambda _:proto("page/save",same),range(2)))
assert left == right and set(left["versions"].values()) == {1}
different_body = {**same,"pages":[{**unit,"page_key":"different-payload"}]}
proto("page/save",different_body,expected=409)
# The same key has an independent scope for a different authorized editor.
assert proto("page/save",different_body,who="editor")["versions"] == {"different-payload":1}
changed_bases = {**same,"pages":[{**page,"base_version":1} for page in same["pages"]]}
proto("page/save",changed_bases,expected=409)
# The conflict in the second unit must refer to durable heads, including the first unit.
reply = call("prototype/page/save",{**scope,"request_id":"stale-second","pages":[
    {**same["pages"][0],"base_version":1},same["pages"][1]]},expected=409)
assert reply["data"]["latest_versions"] == left["versions"], reply
for key in left["versions"]:
    assert len(proto("page/history",{"page_key":key})["items"]) == 1
print("PASS concurrent same-key requests, principal scope, changed fingerprints and batch conflict details")

with tempfile.TemporaryDirectory() as temp:
    state = Path(temp)
    config = dict(name="QA",team_name="Team A",base_url=fixture["baseUrl"],service_id=fixture["instanceId"],
                  user_id=fixture["owner"]["user_id"],user_key=fixture["owner"]["userKey"],
                  team_id=fixture["team"],agent_id=fixture["agent"])
    (state / "qa.json").write_text(json.dumps(config))
    env = {**os.environ,"TENCENT_MEMORY_CONFIG_DIR":temp,"TENCENT_MEMORY_STATE_DIR":temp}
    def rpc(method,params):
        request = {"jsonrpc":"2.0","id":1,"method":method,"params":params}
        proc = subprocess.run([sys.executable,str(root/"agents/codex/mcp-hooks/server/server.py"),"qa"],
            input=json.dumps(request)+"\n",env=env,text=True,check=True,capture_output=True)
        return json.loads(proc.stdout)["result"]
    def tool(name,args):
        return rpc("tools/call",{"name":name,"arguments":{"session_id":"qa-session",**args}})
    tool("project_session",{"operation":"status"})
    with sqlite3.connect(state/"runtime.sqlite3") as db:
        db.execute("update sessions set state='initialized',team_id=?,agent_id=? where sid='qa-session'",(fixture["team"],fixture["agent"]))
        db.execute("insert into bindings values('qa-session',1,?)",(json.dumps({"team_id":fixture["team"],"agent_id":fixture["agent"],"task_id":None}),))
    tools = [t for t in rpc("tools/list",{})["tools"] if "prototype" in t["name"]]
    assert len(tools)==2 and all(t["annotations"]["readOnlyHint"] for t in tools)
    def data(result):
        assert not result["isError"],result
        return json.loads(result["content"][0]["text"])
    read = dict(asset_id=scope["asset_id"],**target)
    exact = data(tool("read_prototype_page",read))
    assert exact["snapshot"] == updated and exact["team_id"] == scope["team_id"]
    args = dict(asset_id=scope["asset_id"],component_type="column",contract_version=1)
    assert data(tool("read_prototype_contract",args))["definition"] == contract["definition"]
    assert tool("read_prototype_page",{**read,"version":999})["isError"]
    assert tool("read_prototype_contract",{**args,"contract_version":999})["isError"]
    assert tool("read_prototype_page",{**read,"asset_id":second["asset_id"],"version":1})["isError"]
    assert tool("read_prototype_contract",{**args,"asset_id":second["asset_id"]})["isError"]
    # Optional payload generated by the real erp-front encoder from legacy-claim-keys.json.
    # The calling renderer can decode the MCP output and compare it with the original.
    if len(sys.argv) >= 4:
        payload = json.loads(Path(sys.argv[2]).read_text())
        for name, definition in payload["contracts"].items():
            proto("contract/publish", dict(component_type=name, contract_version=1, definition=definition))
        units = [dict(page_key=k,base_version=None,snapshot=v) for k,v in payload["pages"].items()]
        mapping = proto("page/save",dict(request_id="erp-batch",pages=units))["versions"]
        assert set(mapping) == {"claim-list","claim-form"} and set(mapping.values()) == {1}
        proto("page/save",dict(request_id="erp-second",pages=[
            {**u,"base_version":1,"snapshot":{**u["snapshot"],"components":[]}} for u in units]))
        rendered = {}
        pinned = {}
        for unit in units:
            key = unit["page_key"]
            row = data(tool("read_prototype_page",dict(asset_id=scope["asset_id"],page_key=key,version=1)))
            assert row["snapshot"] == unit["snapshot"]
            rendered[key] = row["snapshot"]
            for instance in row["snapshot"]["components"]:
                ref = instance["type"]
                if ref in pinned:
                    continue
                actual = data(tool("read_prototype_contract",dict(asset_id=scope["asset_id"],
                    component_type=ref,contract_version=instance["contract_version"])))
                assert actual["definition"] == payload["contracts"][ref]
                pinned[ref] = actual["definition"]
        Path(sys.argv[3]).write_text(json.dumps({"contracts":pinned,"pages":rendered},ensure_ascii=False))
        print("PASS stdio MCP reads both erp-front V1 pages and",len(pinned),"exact contracts after V2")
        for key, snapshot in rendered.items():
            restore_request = dict(page_key=key, base_version=2, restore_version=1,
                                   request_id="restore-legacy-" + key)
            receipt = proto("page/restore", restore_request, who="editor")
            assert receipt["snapshot"] == snapshot
            assert (receipt["version"], receipt["base_version"], receipt["restore_version"]) == (3, 2, 1)
            assert receipt["author_id"] == fixture["editor"]["user_id"] and receipt["created_at"]
            assert proto("page/restore", restore_request, who="editor") == receipt
            history = proto("page/history", {"page_key":key})["items"]
            assert [item["version"] for item in history] == [3, 2, 1]
            original = proto("page/get", {"page_key":key, "version":1})
            assert original["snapshot"] == snapshot and original["restore_version"] is None
            assert proto("page/get", {"page_key":key, "version":2})["snapshot"]["components"] == []
        print("PASS restore of populated ERP V1 preserves every component and contract reference across three immutable versions")
    # Optional cross-check for a browser-created project.
    if len(sys.argv) >= 6:
        browser_asset, output_path = sys.argv[4:6]
        browser_scope = {"team_id": fixture["team"], "asset_id": browser_asset}
        browser_grant = call("acl/grant", dict(asset_id=browser_asset, subject_type="agent",
            subject_id=fixture["agent"], permission="read", granted_by=fixture["owner"]["user_id"]))["data"]
        try:
            pinned = {}
            pages = {}
            commit_ids = set()
            for page_key in ["claim-list", "claim-form"]:
                version = {"page_key":page_key, "version":1}
                panel = call("prototype/page/get", {**browser_scope, **version}, who="reader")["data"]
                result = data(tool("read_prototype_page", {"asset_id":browser_asset, **version}))
                assert result == panel
                assert result["author_id"] == fixture["owner"]["user_id"]
                pages[page_key] = result["snapshot"]
                commit_ids.add(result["commit_id"])
                for node in pages[page_key]["components"]:
                    name = node["type"]
                    assert node["contract_version"] == 1
                    if name not in pinned:
                        ref = {"component_type":name, "contract_version":1}
                        contract = data(tool("read_prototype_contract", {"asset_id":browser_asset, **ref}))
                        pinned[name] = contract["definition"]
            assert len(commit_ids) == 1
            baseline = {"team_id":fixture["team"],"asset_id":browser_asset,"version":1,
                        "commit_id":commit_ids.pop(),"pages":pages,"contracts":pinned}
            Path(output_path).write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + "\n")
        finally:
            call("acl/revoke", {"id":browser_grant["id"]})
        print("PASS same browser project and joint commit over stdio MCP:", browser_asset, baseline["commit_id"])
    call("acl/revoke",{"id":read_grant})
    assert all(tool(name,args)["isError"] for name,args in [
        ("read_prototype_page",read),("read_prototype_contract",args)])
print("PASS exact-version MCP page and contract reads before and after revocation")
