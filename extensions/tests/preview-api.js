// Test-only Chrome API adapter; this file is excluded from extension packages.
(() => {
 const cfg={enabled:true,autoCapture:false,overlay:true,minSize:1048576,extensions:'zip pdf mp4 mp3',excludedHosts:''};
 let items=[],handler=null;
 const iframe=document.createElement('iframe');iframe.src='/fixture.html';iframe.hidden=true;document.body.append(iframe);
 const ready=new Promise(resolve=>iframe.addEventListener('load',resolve));
 const host=async(operation,payload)=>{const r=await fetch('/native',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,payload})});return r.json();};
 window.chrome={runtime:{id:'kldaaejfimcdbooimpmjhonkghbijjlg',async sendMessage(message){
  if(message.type==='state')return {ok:true,data:{config:cfg,notice:null,pending:{},items}};
  if(message.type==='scan'){await ready;const result=await new Promise(resolve=>iframe.contentWindow.scanHandler({type:'scan',selected:message.selected},{},resolve));items=result.items.map(c=>({...c,kind:/\.(m3u8|mpd)$/.test(new URL(c.url).pathname)?'stream':/\.mp4$/.test(new URL(c.url).pathname)?'media':'file',size:0}));return {ok:true,data:{...result,items}};}
  if(message.type==='video-formats'){return host('youtube_formats',{url:message.url});}
  if(message.type==='native'){const result=await host(message.operation,message.payload);return result.ok?{ok:true,data:result.data}:result;}
  if(message.type==='send'){const result=await host(message.candidate.url.includes('youtube.com/watch')?'youtube':'add',{url:message.candidate.url,media:message.candidate.media,later:message.later,description:message.candidate.name});return result.ok?{ok:true,data:result.job}:result;}
  if(message.type==='send-many'){const result=await host('add_many',message.items.map(c=>({url:c.url,later:message.later,description:c.name})));return result.ok?{ok:true,data:result.data}:result;}
  if(message.type==='settings'){Object.assign(cfg,message.value);return {ok:true,data:cfg};}
  if(message.type==='browser-downloads')return {ok:true,data:[]};
  return {ok:true,data:true};
 }},tabs:{async query(){return [{id:1,url:'https://www.youtube.com/watch?v=jNQXAC9IVRw',title:'Me at the zoo · Current QA'}];}},permissions:{async contains(){return false;},async request(){return false;}}};
})();
