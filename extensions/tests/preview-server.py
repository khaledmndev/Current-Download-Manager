"""Local popup/DOM QA harness. Browser APIs are simulated; native requests use the real host.
Never included in the installable extension. No browser profiles or registry are modified.
"""
from pathlib import Path
import http.server,json,subprocess,os,struct,uuid,urllib.parse
ROOT=Path(__file__).resolve().parents[2];EXT=ROOT/'extensions/chromium';PORT=1422
STATE=ROOT/'.test-data'/('extension-preview-'+uuid.uuid4().hex[:8]);STATE.mkdir(parents=True)
ORIGIN='chrome-extension://'+(EXT/'EXTENSION_ID.txt').read_text().strip()+'/'
ENV=dict(os.environ,CURRENT_DATA_DIR=str(STATE/'state'),CURRENT_EXTENSION_ORIGIN=ORIGIN)
BIN=Path(os.environ.get('CURRENT_PREVIEW_BIN',str(ROOT/'target/x86_64-pc-windows-msvc/release')))
def native(operation,payload):
 if operation in ['add','youtube']:payload={**payload,'folder':str(STATE/'output')}
 if operation=='add_many':payload=[{**p,'folder':str(STATE/'output')} for p in payload]
 raw=json.dumps({'operation':operation,'payload':payload}).encode()
 result=subprocess.run([str(BIN/'current-native-host.exe'),ORIGIN],input=struct.pack('<I',len(raw))+raw,capture_output=True,env=ENV,timeout=90 if operation=='youtube_formats' else 20,creationflags=0x08000000)
 if result.returncode:return {'ok':False,'error':result.stderr.decode()}
 size=struct.unpack('<I',result.stdout[:4])[0];return json.loads(result.stdout[4:4+size])
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*_):pass
 def respond(self,data,mime='text/html'):
  if isinstance(data,str):data=data.encode()
  self.send_response(200);self.send_header('Content-Type',mime+'; charset=utf-8' if mime.startswith('text/') or mime=='application/javascript' else mime);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def do_GET(self):
  path=urllib.parse.urlsplit(self.path).path
  if path=='/youtube-menu.js':
   data=(EXT/'content.js').read_text(encoding='utf-8').replace('new URL(location.href)', 'new URL("https://www.youtube.com/watch?v=jNQXAC9IVRw")')
   return self.respond(data,'application/javascript')
  if path=='/youtube-menu.html':return self.respond('''<!doctype html><meta charset="utf-8"><title>Current quality menu fixture</title><style>body{margin:30px;font:16px Segoe UI;background:#f7f7f2}video{width:640px;height:360px;background:#172318}</style><h1>Current video quality and audio menu</h1><p>UI TEST FIXTURE / simulated YouTube location and Chrome APIs, real native engine.</p><video controls title="Me at the zoo - QA" src="/clip.mp4"></video><script src="/overlay-api.js"></script><script src="/youtube-menu.js"></script>''')
  if path=='/overlay.html':return self.respond('''<!doctype html><title>Current overlay fixture</title><style>body{margin:30px;font:16px Segoe UI;background:#f7f7f2}.player{position:relative;width:640px;height:360px;background:#171d18}video{width:640px;height:360px}.controls{position:absolute;inset:0;color:#fff;display:grid;place-items:center;pointer-events:auto;background:#17231844}</style><h1>Overlay test: player controls cover the video</h1><p>Real Current engine. Test browser API adapter. No hover is needed.</p><div class="player"><video controls title="Visible video" src="/clip.mp4"></video><div class="controls">Simulated player controls</div></div><script src="/overlay-api.js"></script><script src="/content.js"></script>''')
  if path=='/overlay-api.js':return self.respond("window.chrome={runtime:{onMessage:{addListener(){}},async sendMessage(message){if(message.type==='video-formats'){const r=await fetch('/native',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'youtube_formats',payload:{url:message.url}})});const result=await r.json();return result.ok?{ok:true,data:result.data}:result;}if(message.type==='send'){const r=await fetch('/native',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:message.candidate.media?'youtube':'add',payload:{url:message.candidate.url,description:message.candidate.name,media:message.candidate.media}})});const result=await r.json();return result.ok?{ok:true,data:result.job}:result;}return {ok:true,data:{overlay:true}};}}};",'application/javascript')
  if path=='/fixture.html':return self.respond('''<!doctype html><title>Current extension fixtures</title><h1>File discovery fixture</h1><a href="/design-guide.pdf" download>Design guide.pdf</a><a href="/archive.zip" download>Project archive.zip</a><a href="/stream.m3u8">Adaptive stream.m3u8</a><video controls title="Sample clip" src="/clip.mp4"></video><a href="javascript:alert(1)">Unsafe URL</a><script src="/fixture-api.js"></script><script src="/content.js"></script>''')
  if path=='/fixture-api.js':return self.respond("window.scanHandler=null;window.chrome={runtime:{onMessage:{addListener(fn){window.scanHandler=fn;}},async sendMessage(){return {ok:true,data:{overlay:false}};}}};",'application/javascript')
  if path in ['/design-guide.pdf','/archive.zip','/clip.mp4']:return self.respond(b'Current extension UI fixture.\n'*4096,'application/octet-stream')
  if path=='/preview-api.js':return self.respond((ROOT/'extensions/tests/preview-api.js').read_bytes(),'application/javascript')
  if path=='/':path='/popup.html'
  candidate=(EXT/path.lstrip('/')).resolve()
  if not candidate.is_relative_to(EXT.resolve()) or not candidate.is_file():self.send_error(404);return
  data=candidate.read_bytes()
  if path=='/popup.html':data=data.replace(b'<script type="module"',b'<script src="/preview-api.js"></script><script type="module"');data=data.replace(b'<body>',b'<body><div style="background:#fbf0d7;padding:7px 22px;font:11px Segoe UI">UI TEST PREVIEW / real native engine, simulated Chrome APIs</div>')
  mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.json':'application/json'}.get(candidate.suffix,'text/plain');self.respond(data,mime)
 def do_POST(self):
  if self.path!='/native' or self.headers.get('Origin')!=f'http://127.0.0.1:{PORT}' or self.headers.get('Content-Type')!='application/json':self.send_error(403);return
  length=int(self.headers.get('Content-Length','0'))
  if not 0<length<256*1024:self.send_error(413);return
  try:
   request=json.loads(self.rfile.read(length));operation=request['operation']
   if operation not in ['status','ping','job','add','youtube','youtube_formats','add_many','action']:raise ValueError('Unsupported preview operation')
   self.respond(json.dumps(native(operation,request.get('payload'))),'application/json')
  except Exception as error:self.respond(json.dumps({'ok':False,'error':str(error)}),'application/json')
print('Preview http://127.0.0.1:1422; isolated state:',STATE,flush=True)
try:http.server.ThreadingHTTPServer(('127.0.0.1',PORT),Handler).serve_forever()
finally:subprocess.run([str(BIN/'current-cli.exe'),'shutdown'],capture_output=True,env=ENV,timeout=20,creationflags=0x08000000)
