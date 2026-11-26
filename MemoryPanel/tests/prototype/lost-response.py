"""Drop one committed batch response in transit, advance both heads, then retry the original key."""
import http.client
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys
from threading import Thread
from urllib.request import Request, urlopen
from uuid import uuid4

fixture = json.loads(Path(sys.argv[1]).read_text())
scope = {"team_id":fixture["team"],"asset_id":fixture["asset"]}
headers = {"content-type":"application/json","x-tdai-service-id":fixture["instanceId"],
           "x-tdai-user-key":fixture["editor"]["userKey"]}
def post(action, body):
    url = fixture["baseUrl"] + "/api/v1/meta/prototype/" + action
    with urlopen(Request(url,json.dumps({**scope,**body}).encode(),headers),timeout=10) as res:
        envelope = json.load(res)
    assert envelope["code"] == 0, envelope
    return envelope["data"]

class DropCommittedResponse(BaseHTTPRequestHandler):
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        # The forwarder observes the upstream acknowledgement and closes the client
        # connection without forwarding response headers or a success envelope.
        self.server.receipt = post("page/save",payload)
        self.close_connection = True
    def log_message(self, *args):
        pass

run = uuid4().hex
snapshot = {"format_version":1,"views":["list"],"components":[]}
pages = [{"page_key":f"{run}-{key}","base_version":None,"snapshot":snapshot} for key in ["list","form"]]
original = {"request_id":run,"pages":pages}
with HTTPServer(("127.0.0.1",0),DropCommittedResponse) as proxy:
    dispatch = Thread(target=proxy.handle_request)
    dispatch.start()
    downstream = http.client.HTTPConnection("127.0.0.1",proxy.server_port,timeout=10)
    downstream.request("POST","/",json.dumps(original),{"Content-Type":"application/json"})
    try:
        downstream.getresponse()
        raise AssertionError("Expected transport failure")
    except http.client.RemoteDisconnected:
        pass
    finally:
        downstream.close()
        dispatch.join(10)
    first = proxy.receipt
assert set(first["versions"].values()) == {1}
advanced = post("page/save",{"request_id":uuid4().hex,"pages":[{**p,"base_version":1} for p in pages]})
assert set(advanced["versions"].values()) == {2}
retried = post("page/save",original)
assert retried == first
for p in pages:
    history = post("page/history",{"page_key":p["page_key"]})["items"]
    assert sorted(row["version"] for row in history) == [1,2]
print("PASS",fixture.get("backend","SQLite"),"response lost after durable commit; retry after V2 returns the original two V1 receipts and adds no history")
