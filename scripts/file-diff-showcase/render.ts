import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { CHAPTERS, OUTPUT } from './timeline.ts';

const root = resolve(import.meta.dir, '../../_film/file-diff-showcase');
const output = join(root, 'output'); mkdirSync(output, { recursive: true });
type Cue = { t: number; kind: string; x: number; y: number };
type Meta = { width: number; height: number; start: number; end: number; frames: { t: number; file: string }[] };
const read = (device: string, name: string) => JSON.parse(readFileSync(join(root, 'takes', device, name), 'utf8'));
const takes = Object.fromEntries(['desktop', 'mobile'].map(device => [device, { meta: read(device, 'frames.json') as Meta, cues: read(device, 'cues.json') as Cue[], marks: read(device, 'marks.json') as { label: string; t: number }[] }]));
const milestone = (device: string, name: string) => {
  const value = takes[device]!.marks.find(m => m.label === name)?.t;
  assert.ok(value !== undefined, `${device}: missing ${name}`); return value;
};
const report = CHAPTERS.map(ch => ({ ...ch, devices: Object.fromEntries(['desktop', 'mobile'].map(device => {
  const start = milestone(device, `${ch.id}:start`), result = milestone(device, `${ch.id}:result`);
  assert.ok(result >= start, 'source must move forward');
  assert.ok(result - start <= ch.end - ch.start, `${device} ${ch.id}: ${(result-start).toFixed(2)} seconds exceeds ${ch.end-ch.start}s slot`);
  return [device, { start, result, active: result-start }];
})) }));
assert.equal(CHAPTERS[0].start, 0); assert.equal(CHAPTERS.at(-1)!.end, 60);
CHAPTERS.forEach((ch,i) => { if(i) assert.equal(ch.start, CHAPTERS[i-1]!.end); });
writeFileSync(join(output, 'timing.json'), JSON.stringify(report, null, 2));
if (process.argv.includes('--check')) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
const html = `<!doctype html><meta charset="utf-8"><style>*{margin:0}html,body{width:1920px;height:1080px;overflow:hidden;background:#11100f}canvas{display:block}</style><canvas width="1920" height="1080"></canvas><script>
const canvas=document.querySelector('canvas'), ctx=canvas.getContext('2d');
const cache=new Map();
async function img(src){if(cache.has(src))return cache.get(src);const image=new Image();image.src=src;await image.decode();cache.set(src,image);if(cache.size>8)cache.delete(cache.keys().next().value);return image;}
function circle(x,y,r,color,width=2){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
window.draw=async function(frame){
 const images=await Promise.all(frame.panels.map(p=>img(p.src)));
 ctx.fillStyle='#11100f';ctx.fillRect(0,0,1920,1080);
 ctx.font='600 15px Arial';ctx.fillStyle='#b6a995';ctx.fillText('HERDR WEB UI  /  FILE REVIEW',32,29);
 ctx.font='600 32px Arial';ctx.fillStyle='#f4eee5';ctx.fillText(frame.title,32,69);
 ctx.font='14px Arial';ctx.fillStyle='#ada59b';ctx.fillText('DESKTOP',32,105);ctx.fillText('MOBILE',1460,105);
 ctx.textAlign='right';ctx.fillText('Same repository. Same workflow.',1873,60);ctx.textAlign='left';
 frame.panels.forEach((p,i)=>{
  const x=i?1460:32,y=120,k=1.06,w=p.width*k,h=p.height*k;
  ctx.save();ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();ctx.drawImage(images[i],x,y,w,h);
  ctx.translate(x,y);ctx.scale(k,k);
  if(p.pointer){const a=p.pointer;ctx.save();ctx.translate(a.x,a.y);
   if(i){ctx.fillStyle='rgba(255,209,110,.3)';ctx.beginPath();ctx.arc(0,0,10,0,Math.PI*2);ctx.fill();circle(0,0,10,'#ffe2a3',2);ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(0,0,2.3,0,Math.PI*2);ctx.fill();}
   else {ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,23);ctx.lineTo(6.5,17);ctx.lineTo(11,27);ctx.lineTo(16,25);ctx.lineTo(11.5,15);ctx.lineTo(20,15);ctx.closePath();ctx.fillStyle='#fff9ed';ctx.strokeStyle='#17130e';ctx.lineWidth=1.5;ctx.fill();ctx.stroke();}ctx.restore();
  }
  p.presses.forEach(a=>{const v=a.age/.5;circle(a.x,a.y,10+v*19,'rgba(255,199,94,'+(1-v)+')',3);});
  if(p.trail.length>1){ctx.beginPath();p.trail.forEach((a,j)=>j?ctx.lineTo(a.x,a.y):ctx.moveTo(a.x,a.y));ctx.strokeStyle='rgba(255,209,110,.7)';ctx.lineWidth=5;ctx.lineCap='round';ctx.stroke();}
  ctx.restore();ctx.strokeStyle='#3d352b';ctx.lineWidth=1;ctx.strokeRect(x-.5,y-.5,w+1,h+1);
 });
 ctx.fillStyle='#6d5a3d';ctx.fillRect(32,1044,1841,2);ctx.fillStyle='#efb45e';ctx.fillRect(32,1044,1841*frame.t/60,2);
 ctx.font='13px Arial';ctx.fillStyle='#a99e8e';ctx.fillText('Browse · Compare · Comment',32,1070);ctx.textAlign='right';ctx.fillText(String(Math.floor(frame.t)).padStart(2,'0')+' / 60',1873,1070);ctx.textAlign='left';
};</script>`;
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/favicon.ico') return new Response(null, { status: 204 });
  if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
  const file = resolve(root, '.' + decodeURIComponent(path));
  if (!file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
  const body = Bun.file(file);
  return await body.exists() ? new Response(body) : new Response('Not found', { status: 404 });
} });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
let encoder: ReturnType<typeof Bun.spawn> | undefined;
function sample(device: string, t: number) {
  const ch = report.find(c => t >= c.start && t < c.end) || report.at(-1)!;
  const range = ch.devices[device]!;
  // Slow short recorded actions for readable presentation; never accelerate them.
  // Both devices reach the same chapter outcome at the same output instant.
  const active = Math.min(ch.end-ch.start-1, Math.max(...Object.values(ch.devices).map(v=>v.active))*1.7);
  const elapsed = t-ch.start;
  const source = elapsed < active ? range.start + elapsed/active*range.active : Math.min(range.result + .15, range.result + elapsed-active);
  const effectTime = elapsed < active ? source : range.result + elapsed-active;
  const take = takes[device]!;
  let lo = 0, hi = take.meta.frames.length-1;
  while (lo<hi) { const mid=Math.ceil((lo+hi)/2); if(take.meta.frames[mid]!.t<=source)lo=mid;else hi=mid-1; }
  const motion = take.cues.filter(c=>device==='desktop' ? c.kind==='move'||c.kind==='down'||c.kind==='up' : c.kind==='guide'||c.kind==='tap'||c.kind==='contact'||c.kind==='release');
  let before=motion[0],after: Cue|undefined;
  for(const c of motion){if(c.t<=source)before=c;else{after=c;break;}}
  let pointer=before?{x:before.x,y:before.y}:null;
  if(pointer&&before&&after&&after.t-before.t<.3){const f=Math.max(0,(source-before.t)/(after.t-before.t));pointer={x:before.x+(after.x-before.x)*f,y:before.y+(after.y-before.y)*f};}
  const presses=take.cues.filter(c=>(c.kind==='down'||c.kind==='tap')&&c.t<=source&&c.t<=effectTime&&effectTime-c.t<.5).map(c=>({...c,age:effectTime-c.t}));
  const recent=take.cues.filter(c=>c.t<=source&&c.t<=effectTime&&effectTime-c.t<.25&&(c.kind==='contact'||c.kind==='release'));
  const trail=recent.at(-1)?.kind==='release'?[]:recent;
  return { src:`/takes/${device}/frames/${take.meta.frames[lo]!.file}`,width:take.meta.width,height:take.meta.height,pointer,presses,trail };
}
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${server.port}`);
  const draw = async(t:number)=>{const ch=CHAPTERS.find(c=>t>=c.start&&t<c.end)||CHAPTERS.at(-1)!;await page.evaluate(async f=>{await (window as any).draw(f);},{t,title:ch.title,panels:['desktop','mobile'].map(d=>sample(d,t))});};
  const stills = process.argv.includes('--stills');
  if(stills){
    for(const t of [7,14,20,24,32,37,40,48,51,56,59]){await draw(t);await page.screenshot({path:join(output,`frame-${t}.png`)});}
    console.log('Rendered review frames');
  } else {
    encoder = Bun.spawn(['ffmpeg','-v','error','-y','-f','image2pipe','-framerate','30','-c:v','mjpeg','-i','pipe:0','-an','-c:v','libx264','-threads','4','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',join(output,'file-diff-desktop-mobile.mp4')],{stdin:'pipe',stderr:'pipe',stdout:'ignore'});
    const err=new Response(encoder.stderr as ReadableStream<Uint8Array>).text();
    for(let i=0;i<OUTPUT.duration*OUTPUT.fps;i++){
      const t=i/OUTPUT.fps;await draw(t);const frame=await page.screenshot({type:'jpeg',quality:94});
      (encoder.stdin as any).write(frame);await (encoder.stdin as any).flush();
      if(i%150===0)console.log(`Rendered ${i}/1800 frames (${t.toFixed(0)}s)`);
    }
    (encoder.stdin as any).end();
    assert.equal(await encoder.exited,0,await err);
    await draw(14);await page.screenshot({path:join(output,'poster.png')});
    const git=Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:join(import.meta.dir,'../..')});
    writeFileSync(join(output,'manifest.json'),JSON.stringify({duration:60,fps:30,width:1920,height:1080,size:statSync(join(output,'file-diff-desktop-mobile.mp4')).size,commit:new TextDecoder().decode(git.stdout).trim(),mobile:'Chromium touch emulation; fictional fixtures',chapters:CHAPTERS},null,2));
    console.log('Export complete');
  }
} finally {encoder?.kill();await browser.close();server.stop(true);}
