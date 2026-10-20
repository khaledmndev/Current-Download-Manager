"""Live public YouTube verification through Current's actual native bridge, isolated from user data."""
from pathlib import Path
import subprocess,json,os,struct,time,uuid,hashlib,argparse
parser=argparse.ArgumentParser();parser.add_argument('--bin-dir',default='target/x86_64-pc-windows-msvc/release');args=parser.parse_args()
root=Path(__file__).resolve().parent.parent;bins=(root/args.bin_dir).resolve();data=root/'.test-data'/('youtube-'+uuid.uuid4().hex[:8]);data.mkdir(parents=True)
origin='chrome-extension://'+(root/'extensions/chromium/EXTENSION_ID.txt').read_text().strip()+'/'
env=dict(os.environ,CURRENT_DATA_DIR=str(data/'state'),CURRENT_EXTENSION_ORIGIN=origin)
def call(op,payload=None):
 raw=json.dumps({'operation':op,'payload':payload}).encode();result=subprocess.run([str(bins/'current-native-host.exe'),origin],input=struct.pack('<I',len(raw))+raw,capture_output=True,env=env,timeout=20,creationflags=0x08000000)
 assert result.returncode==0,result.stderr.decode();length=struct.unpack('<I',result.stdout[:4])[0];reply=json.loads(result.stdout[4:4+length]);assert reply['ok'],reply
 return reply.get('job',reply.get('data'))
report=[]
try:
 assert call('status')['media']['youtube'],'Media runtime or FFmpeg missing'
 for mode in ['video','audio','mp3']:
  job=call('youtube',{'url':'https://www.youtube.com/watch?v=jNQXAC9IVRw','media':{'mode':mode,'max_height':360},'folder':str(data/'output'),'description':'Current YouTube '+mode+' verification'})
  deadline=time.monotonic()+180;last=None
  while time.monotonic()<deadline:
   status=call('job',{'id':job['id']})
   if status['status']!=last:print(mode,status['status'],status['downloaded'],flush=True);last=status['status']
   if status['status'] in ['completed','failed']:break
   time.sleep(.5)
  assert status['status']=='completed',status
  output=data/'output'/job['filename'];assert output.is_file();assert hashlib.sha256(output.read_bytes()).hexdigest()==status['sha256']
  probe=subprocess.run(['ffprobe','-v','error','-show_entries','stream=codec_type,codec_name:format=duration','-of','json',str(output)],capture_output=True,text=True,timeout=15,creationflags=0x08000000);assert probe.returncode==0,probe.stderr;info=json.loads(probe.stdout)
  types=[s['codec_type'] for s in info['streams']];assert 'audio' in types
  if mode=='video':assert 'video' in types
  else:assert 'video' not in types
  if mode=='mp3':assert any(s.get('codec_name')=='mp3' for s in info['streams'])
  assert 15<float(info['format']['duration'])<23
  report.append({'mode':mode,'status':'passed','job':status,'streams':types,'duration':info['format']['duration']});print('PASS live YouTube',mode,'download, media streams and SHA-256',flush=True)
finally:
 subprocess.run([str(bins/'current-cli.exe'),'shutdown'],env=env,capture_output=True,timeout=20,creationflags=0x08000000)
 (data/'report.json').write_text(json.dumps({'source':'https://www.youtube.com/watch?v=jNQXAC9IVRw','tests':report},indent=2))
print('Report:',data/'report.json',flush=True)
