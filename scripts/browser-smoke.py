"""Verify the real native browser protocol without registering a browser or reading its profile."""
from pathlib import Path
import argparse,subprocess,os,json,struct,uuid,http.server,threading,time,hashlib
parser=argparse.ArgumentParser();parser.add_argument('--bin-dir',default='target/x86_64-pc-windows-msvc/release');args=parser.parse_args()
root=Path(__file__).resolve().parent.parent;bins=(root/args.bin_dir).resolve()
testdir=root/'.test-data'/('browser-'+uuid.uuid4().hex[:8]);testdir.mkdir(parents=True)
origin='chrome-extension://'+(root/'extensions/chromium/EXTENSION_ID.txt').read_text().strip()+'/'
env=dict(os.environ,CURRENT_DATA_DIR=str(testdir/'state'),CURRENT_EXTENSION_ORIGIN=origin)
body=b'Current browser protocol fixture.\n'*4096
class Fixture(http.server.BaseHTTPRequestHandler):
 def log_message(self,*_):pass
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Length',str(len(body)));self.send_header('Content-Type','application/octet-stream');self.end_headers()
  try:self.wfile.write(body)
  except (BrokenPipeError,ConnectionResetError):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture);threading.Thread(target=server.serve_forever,daemon=True).start()
results=[]
def host(operation,payload=None,caller=origin):
 raw=json.dumps({'operation':operation,'payload':payload}).encode()
 result=subprocess.run([str(bins/'current-native-host.exe'),caller],input=struct.pack('<I',len(raw))+raw,capture_output=True,env=env,timeout=20,creationflags=0x08000000)
 if result.returncode:raise RuntimeError(result.stderr.decode())
 length=struct.unpack('<I',result.stdout[:4])[0];assert length<1024*1024;assert len(result.stdout)==length+4,'Unexpected stdout outside the native frame'
 return json.loads(result.stdout[4:])
def check(name):results.append({'test':name,'status':'passed'});print('PASS',name,flush=True)
try:
 assert host('ping')['ok'];check('native host starts and pings isolated engine')
 status=host('status');assert status['ok'] and status['data']['count']==0;check('bounded status and plan protocol')
 payload={'url':f'http://127.0.0.1:{server.server_port}/browser.bin','folder':str(testdir/'output'),'later':True,'expected_sha256':hashlib.sha256(body).hexdigest()}
 added=host('add',payload);assert added['ok'];job=added['job'];assert job['status']=='paused';check('browser submission can reserve a paused job')
 status=host('status')['data'];assert len(status['jobs'])==1;assert 'url' not in status['jobs'][0] and 'folder' not in status['jobs'][0];check('popup status omits source URLs and local paths')
 assert host('job',{'id':job['id']})['data']['id']==job['id'];assert host('action',{'id':job['id'],'action':'resume'})['ok']
 deadline=time.monotonic()+20
 while time.monotonic()<deadline:
  current=host('job',{'id':job['id']})['data']
  if current['status'] in ['completed','failed']:break
  time.sleep(.15)
 assert current['status']=='completed',current
 assert (testdir/'output'/job['filename']).read_bytes()==body;assert current['sha256']==hashlib.sha256(body).hexdigest();check('native resume and verified byte-exact completion')
 batch=host('add_many',[payload,payload]);assert batch['ok'] and len(batch['data']['added'])==2;check('native batch submission respects existing engine entitlement')
 assert not host('action',{'id':job['id'],'action':'remove'})['ok'];assert (testdir/'output'/job['filename']).exists();check('browser bridge refuses destructive file/library actions')
 assert not host('unexpected-operation')['ok'];check('unsupported native command is rejected')
 denied=subprocess.run([str(bins/'current-native-host.exe'),'chrome-extension://'+'a'*32+'/'],input=b'',capture_output=True,env=env,timeout=10,creationflags=0x08000000);assert denied.returncode and not denied.stdout;check('unregistered extension caller is rejected')
 oversized=subprocess.run([str(bins/'current-native-host.exe'),origin],input=struct.pack('<I',300000),capture_output=True,env=env,timeout=10,creationflags=0x08000000);assert oversized.returncode and not oversized.stdout;check('oversized native frame rejected before allocation')
finally:
 subprocess.run([str(bins/'current-cli.exe'),'shutdown'],capture_output=True,env=env,timeout=20,creationflags=0x08000000)
 server.shutdown()
 (testdir/'report.json').write_text(json.dumps({'tests':results,'data_directory':str(testdir)},indent=2))
print('Report:',testdir/'report.json',flush=True)
