/** Deterministic offline responses shared by acceptance fixtures. No DSH runtime import. */
export function fixtureResponse(input){
    let result;
    if(input.task==='storyboard'){
      const images=input.assets.filter(asset=>asset.kind==='image'),texts=input.assets.filter(asset=>asset.kind==='text');
      const labels=['主题开场','素材与线索','展开构图','动作与节奏','落到成片'];
      result={shots:labels.map((title,i)=>({title,intent:`以${title}解释${input.topic||input.title}`,composition:'左侧清晰标题，右侧图片卡片，底部辅助信息',action:'有节奏地进入、停留与离场',durationSeconds:input.durationSeconds/5,assetIds:[...(images.length?[images[i%images.length].id]:[]),...(texts.length?[texts[0].id]:[])],referenceIds:[],transition:i?'fade':'cut',params:{text:title,subtitle:input.topic||input.title,background:'#101820',foreground:'#edf6f4',accent:'#84e1ba',imageX:74,imageY:50,imageScale:1,imageFit:'contain',fontSize:86,motion:i%2?'slide':'fade'}}))};
    }else{
      const source={html:'<div class="orb"></div><div class="headline"></div><div class="caption"></div><div class="counter"></div>',
        css:'.orb{position:absolute;border:2px solid var(--accent);border-radius:50%;width:48%;aspect-ratio:1;right:-12%;top:6%;opacity:.18}.headline{position:absolute;left:8%;top:28%;width:46%;font-weight:750;line-height:1.18;white-space:pre-wrap}.caption{position:absolute;left:8%;bottom:18%;width:44%;font-size:30px;line-height:1.5;opacity:.75}.counter{position:absolute;left:8%;top:12%;font:20px monospace;letter-spacing:.2em;opacity:.55}',
        js:`export function render(ctx){
const {root,ctx2d:c,width:w,height:h,params:p,progress:t}=ctx;
root.style.setProperty('--accent',p.accent);root.style.color=p.foreground;root.style.fontFamily='"PingFang SC", "Microsoft YaHei", sans-serif';
c.fillStyle=p.background;c.fillRect(0,0,w,h);
const image=ctx.assets.find(a=>a.image)?.image;if(image){const portrait=h>w;const maxW=portrait?w*.8:w*.37,maxH=portrait?h*.28:h*.64;let ratio=Math.min(maxW/image.width,maxH/image.height)*Number(p.imageScale);const iw=image.width*ratio,ih=image.height*ratio;const x=w*Number(p.imageX)/100,y=h*Number(p.imageY)/100;c.save();c.translate(x,y);c.rotate(Math.sin(t*Math.PI)*.018);c.globalAlpha=Math.min(1,t*8+.08);c.drawImage(image,-iw/2,-ih/2,iw,ih);c.restore();}
const headline=root.querySelector('.headline');headline.textContent=p.text;headline.style.fontSize=(h>w?Math.min(Number(p.fontSize),w*.1):Number(p.fontSize))+'px';
const caption=root.querySelector('.caption');caption.textContent=p.subtitle;
const portrait=h>w;if(portrait){headline.style.width='84%';headline.style.top='14%';caption.style.width='84%';caption.style.bottom='12%';}
const entry=ctx.helpers.easeOutCubic(Math.min(1,t*6));headline.style.opacity=String(entry);headline.style.transform='translateY('+((1-entry)*36)+'px)';root.querySelector('.orb').style.transform='rotate('+(t*48)+'deg) scale('+(1+t*.08)+')';root.querySelector('.counter').textContent='FRONTEND / '+String(ctx.localFrame).padStart(3,'0');
}`};
      result=source;
      if(input.task==='modify-scene'){
        result={...source,shotPatch:{params:{...input.shot.params,text:'已修改 · '+input.shot.title,accent:'#f5be79'}}};
        if(input.instruction?.includes('syntax'))result.js+='\nsyntax error fixture';
      }
    }
  return result;
}
async function pause(ms,signal){
  if(signal?.aborted)return;
  await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,ms);signal?.addEventListener('abort',finish,{once:true});});
}
export async function* fixtureChunks(text,{signal,delayMs=8,chunkSize=180}={}){
  yield {type:'block-start',index:0,blockType:'text'};
  for(let i=0;i<text.length;i+=chunkSize){
    if(signal?.aborted){yield {type:'finish',reason:{kind:'aborted',failure:{code:'CANCELLED',message:'Cancelled'}}};return;}
    await pause(delayMs,signal);
    if(signal?.aborted){yield {type:'finish',reason:{kind:'aborted',failure:{code:'CANCELLED',message:'Cancelled'}}};return;}
    yield {type:'text-delta',index:0,text:text.slice(i,i+chunkSize)};
  }
  yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};
}
