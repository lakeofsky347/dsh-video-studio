import { useEffect, useRef, type ReactNode } from 'react';

export function Dialog({label,onClose,busy=false,className='',children}:{label:string;onClose:()=>void;busy?:boolean;className?:string;children:ReactNode}) {
  const panel=useRef<HTMLElement>(null),previous=useRef(typeof document==='undefined'?null:document.activeElement as HTMLElement|null),closing=useRef({busy,onClose});closing.current={busy,onClose};
  useEffect(()=>{
    const controls=()=>Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')||[]).filter(item=>item.getClientRects().length>0);
    (panel.current?.querySelector<HTMLElement>('[data-dialog-autofocus],[autofocus]')||controls()[0]||panel.current)?.focus();
    function key(event:KeyboardEvent){
      if(event.key==='Escape'&&!closing.current.busy){event.preventDefault();closing.current.onClose();}
      if(event.key!=='Tab')return;const items=controls(),first=items[0],last=items.at(-1);
      if(!first){event.preventDefault();panel.current?.focus();return;}
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel.current)){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
    document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);if(previous.current?.isConnected)previous.current.focus();};
  },[]);
  return <div className="vs-modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><section ref={panel} tabIndex={-1} className={`vs-modal ${className}`} role="dialog" aria-modal="true" aria-label={label}>{children}</section></div>;
}
