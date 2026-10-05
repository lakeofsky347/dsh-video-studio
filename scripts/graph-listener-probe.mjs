// Test-only instrumentation. This module does not run in the product bundle.
export async function installGraphListenerProbe(context){
 await context.addInitScript(()=>{
  const nativeAdd=EventTarget.prototype.addEventListener,nativeRemove=EventTarget.prototype.removeEventListener;
  const registry=[];let sequence=0;
  function capture(options){return typeof options==='boolean'?options:Boolean(options?.capture);}
  EventTarget.prototype.addEventListener=function(type,listener,options){
   if(this instanceof HTMLCanvasElement||this instanceof HTMLElement&&this.classList.contains('vs-graph-shell')||this===document&&type==='keyup'&&listener?.name==='bound processKey'){
    if(!registry.some(item=>item.target===this&&item.type===type&&item.listener===listener&&item.capture===capture(options)&&item.active))registry.push({target:this,type,listener,capture:capture(options),active:true,id:++sequence});
   }
   return nativeAdd.call(this,type,listener,options);
  };
  EventTarget.prototype.removeEventListener=function(type,listener,options){
   for(const item of registry)if(item.target===this&&item.type===type&&item.listener===listener&&item.capture===capture(options))item.active=false;
   return nativeRemove.call(this,type,listener,options);
  };
  window.__graphListenerReport=()=>registry.map(item=>({id:item.id,type:item.type,capture:item.capture,active:item.active,target:item.target===document?'document':item.target.className,connected:item.target===document||item.target.isConnected,listener:item.listener?.name||'anonymous'}));
  window.__graphCanvases=()=>[...new Set(registry.map(item=>item.target))].filter(target=>target instanceof HTMLCanvasElement).map(canvas=>({connected:canvas.isConnected,isRendering:canvas.data?.is_rendering,eventBound:canvas.data?._events_binded,nodes:canvas.data?.graph?._nodes?.length,active:registry.filter(item=>item.target===canvas&&item.active).map(item=>({type:item.type,capture:item.capture}))}));
 });
}
