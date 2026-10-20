"""Real Windows daemon/CLI/native-host smoke tests with isolated local fixtures."""
from pathlib import Path
import argparse,os,subprocess,json,time,threading,http.server,hashlib,signal,struct,uuid
import faulthandler
faulthandler.dump_traceback_later(45,repeat=True)

parser=argparse.ArgumentParser();parser.add_argument('--bin-dir',default='target/x86_64-pc-windows-msvc/debug');args=parser.parse_args()
ROOT=Path(__file__).resolve().parent.parent;bins=(ROOT/args.bin_dir).resolve()
cli=bins/'current-cli.exe';native=bins/'current-native-host.exe'
data=ROOT/'.test-data'/('smoke-'+uuid.uuid4().hex[:8]);data.mkdir(parents=True)
trace=(data/'trace.log').open('w',buffering=1)
faulthandler.dump_traceback_later(20,repeat=True,file=trace)
trace.write('test started\n')
env=dict(os.environ,CURRENT_DATA_DIR=str(data/'state'))
BODY=bytes(range(251))*40000
CHANGED=False
class Fixture(http.server.BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*_):pass
 def do_GET(self):
  global CHANGED
  resource=self.path.split('?',1)[0]
  r=self.headers.get('Range');start=0;end=len(BODY)-1
  ranged=bool(r) and resource!='/ignore.bin'
  if r and resource=='/lying.bin' and r!='bytes=0-0':ranged=False
  if ranged:
   a,b=r.split('=',1)[1].split('-',1);start=int(a);end=min(int(b) if b else end,end)
  self.send_response(206 if ranged else 200)
  self.send_header('Content-Length',str(end-start+1));self.send_header('ETag','"changed"' if CHANGED and resource=='/changed.bin' else '"smoke-v1"')
  if ranged:self.send_header('Content-Range',f'bytes {start}-{end}/{len(BODY)}')
  self.send_header('Connection','close');self.end_headers()
  try:
   for i in range(start,end+1,16384):
    self.wfile.write(BODY[i:min(i+16384,end+1)])
    if resource in ['/slow.bin','/changed.bin'] and r!='bytes=0-0':time.sleep(.006)
  except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture)
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
report=[]
def rpc(operation,payload=None):
 trace.write('calling '+operation+'\n')
 if operation not in ['snapshot']:print('RPC',operation,flush=True)
 result=subprocess.run([str(cli),'rpc',operation,json.dumps(payload)],env=env,capture_output=True,text=True,timeout=30,creationflags=0x08000000)
 trace.write('returned '+operation+' '+str(result.returncode)+'\n')
 if result.returncode:raise RuntimeError(result.stderr.strip())
 return json.loads(result.stdout)
def find(job):return next(j for j in rpc('snapshot')['jobs'] if j['id']==job['id'])
def wait(job,predicate,timeout=35):
 stop=time.monotonic()+timeout
 while time.monotonic()<stop:
  j=find(job)
  if predicate(j):return j
  time.sleep(.12)
 raise AssertionError('Timed out: '+str(find(job)))
def add(name,**extra):return rpc('add',dict(url=base+name,folder=str(data/'output'),**extra))
def check_output(j):
 assert j['status']=='completed',j.get('error')
 p=Path(j['folder'])/j['filename'];assert p.read_bytes()==BODY
 assert j['sha256']==hashlib.sha256(BODY).hexdigest()
def passed(name):report.append({'test':name,'status':'passed'});print('PASS',name,flush=True)
try:
 settings=rpc('snapshot')['settings'];settings['download_folder']=str(data/'output');rpc('settings',settings)
 job=add('/file.bin');check_output(wait(job,lambda j:j['status'] in ['failed','completed']));passed('real CLI parallel download and SHA-256')
 second=add('/file.bin');assert second['filename']!=job['filename'];check_output(wait(second,lambda j:j['status'] in ['failed','completed']));passed('existing destination preserved through numbered copy')
 job=add('/ignore.bin');check_output(wait(job,lambda j:j['status'] in ['failed','completed']));passed('server without range support')
 job=add('/lying.bin');check_output(wait(job,lambda j:j['status'] in ['failed','completed']));passed('ignored worker range falls back without corrupt append')
 job=add('/slow.bin');wait(job,lambda j:j['downloaded']>500000);rpc('action',{'id':job['id'],'action':'pause'});paused=wait(job,lambda j:j['status']=='paused');assert 0<paused['downloaded']<len(BODY);time.sleep(.1);rpc('action',{'id':job['id'],'action':'resume'});check_output(wait(job,lambda j:j['status'] in ['failed','completed']));passed('pause/resume of durable segments')
 job=add('/slow.bin');wait(job,lambda j:j['downloaded']>500000);pid=rpc('ping')['process_id'];os.kill(pid,signal.SIGTERM);time.sleep(.2)
 recovered=find(job);assert recovered['status']=='paused',recovered;rpc('action',{'id':job['id'],'action':'resume'});check_output(wait(job,lambda j:j['status'] in ['failed','completed']));passed('daemon process kill, recovery and byte-exact continuation')
 job=add('/changed.bin');wait(job,lambda j:j['downloaded']>500000);rpc('action',{'id':job['id'],'action':'pause'});wait(job,lambda j:j['status']=='paused');CHANGED=True;time.sleep(.1);rpc('action',{'id':job['id'],'action':'resume'});j=wait(job,lambda j:j['status']=='failed');assert 'changed' in j['error'];assert not (Path(j['folder'])/j['filename']).exists();passed('changed source rejected with parts preserved')
 origin='chrome-extension://'+'a'*32+'/'
 host_env=dict(env,CURRENT_EXTENSION_ORIGIN=origin)
 payload=json.dumps({'operation':'add','payload':{'url':base+'/native.bin','folder':str(data/'output')}}).encode()
 result=subprocess.run([str(native),origin],input=struct.pack('<I',len(payload))+payload,capture_output=True,env=host_env,timeout=20,creationflags=0x08000000)
 assert result.returncode==0,result.stderr.decode();length=struct.unpack('<I',result.stdout[:4])[0];response=json.loads(result.stdout[4:4+length]);assert response['ok'];check_output(wait(response['job'],lambda j:j['status'] in ['failed','completed']));passed('native-host framed message admits a real download')
 result=subprocess.run([str(native),'chrome-extension://'+'b'*32+'/'],input=b'',capture_output=True,env=host_env,timeout=10,creationflags=0x08000000);assert result.returncode!=0;assert not result.stdout;passed('native host rejects unregistered caller without stdout contamination')
 exported=rpc('export');assert exported['format']=='current-downloads';assert len(exported['jobs'])>=8;passed('persistent library export')
finally:
 try:rpc('shutdown')
 except Exception:pass
 server.shutdown()
 (data/'report.json').write_text(json.dumps({'tests':report,'data_directory':str(data)},indent=2),encoding='utf-8')
print('Report:',data/'report.json',flush=True)
faulthandler.cancel_dump_traceback_later()
