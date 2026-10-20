import { useEffect, useRef, useState } from 'react';
import type { VideoStyle } from '../shared/types.ts';
import { Dialog } from './Dialog.tsx';
import { parseStyleFiles } from './style-import.ts';

interface StyleLibraryProps {
  styles:VideoStyle[];onClose:()=>void;
  onSave:(style:Partial<VideoStyle>)=>Promise<VideoStyle>;
  onDelete:(id:string)=>Promise<void>;onUse:(style:VideoStyle)=>void;
}
const formats:Record<VideoStyle['sourceFormat'],string>={markdown:'Markdown',json:'JSON',zip:'ZIP 风格包',folder:'风格文件夹',custom:'自定义'};

export function StyleLibrary({styles,onClose,onSave,onDelete,onUse}:StyleLibraryProps){
  const fileInput=useRef<HTMLInputElement>(null),folderInput=useRef<HTMLInputElement>(null);
  const [editing,setEditing]=useState<Partial<VideoStyle>|null>(null),[name,setName]=useState(''),[description,setDescription]=useState(''),[prompt,setPrompt]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{folderInput.current?.setAttribute('webkitdirectory','');},[]);
  function edit(style?:VideoStyle){setEditing(style?{...style}:{sourceFormat:'custom'});setName(style?.name||'');setDescription(style?.description||'');setPrompt(style?.prompt||'');setError('');setNotice('');}
  async function save(){
    if(!name.trim()||!prompt.trim()){setError('请填写风格名称和风格描述。');return;}
    setBusy(true);setError('');setNotice('');
    try{await onSave({...editing,name:name.trim(),description:description.trim(),prompt:prompt.trim(),sourceName:editing?.sourceName||name.trim(),sourceFormat:editing?.sourceFormat||'custom'});setEditing(null);setNotice('风格已保存，可在新建影片时选择。');}
    catch(cause){setError(cause instanceof Error?cause.message:'风格保存失败');}
    finally{setBusy(false);}
  }
  async function importFiles(files:FileList|null){
    if(!files?.length)return;setBusy(true);setError('');setNotice('');
    try{const imported=await parseStyleFiles(Array.from(files));for(const style of imported)await onSave(style);setNotice(`已导入 ${imported.length} 个视频制作风格。`);}
    catch(cause){setError(cause instanceof Error?cause.message:'风格导入失败');}
    finally{setBusy(false);if(fileInput.current)fileInput.current.value='';if(folderInput.current)folderInput.current.value='';}
  }
  async function remove(style:VideoStyle){
    if(!window.confirm(`从风格库中删除「${style.name}」？已应用到影片的风格副本会保留。`))return;
    setBusy(true);setError('');setNotice('');try{await onDelete(style.id);setNotice(`已删除「${style.name}」。`);}catch(cause){setError(cause instanceof Error?cause.message:'风格删除失败');}finally{setBusy(false);}
  }
  return <Dialog label="视频制作风格库" onClose={onClose} busy={busy} className="vs-style-library">
    <div className="vs-section-header"><div><span className="vs-eyebrow">STYLE LIBRARY</span><h2>视频制作风格</h2></div><button className="vs-iconbutton" onClick={onClose} disabled={busy} aria-label="关闭风格库">×</button></div>
    <p className="vs-style-intro">创建自己的风格说明，或导入现有风格文件。应用到新影片后，风格提示会随影片保存，并用于生成分镜与镜头。</p>
    <div className="vs-style-tools"><button className="vs-primary" onClick={()=>fileInput.current?.click()} disabled={busy}>导入文件</button><button onClick={()=>folderInput.current?.click()} disabled={busy}>导入风格文件夹</button><button onClick={()=>edit()} disabled={busy}>新建自定义风格</button><span>支持 Markdown / TXT、JSON、ZIP 与文件夹</span></div>
    <input ref={fileInput} type="file" accept=".md,.markdown,.txt,.json,.zip" multiple hidden onChange={event=>void importFiles(event.currentTarget.files)}/>
    <input ref={folderInput} type="file" multiple hidden onChange={event=>void importFiles(event.currentTarget.files)}/>
    {error&&<p className="vs-inline-error" role="alert">{error}</p>}{notice&&<p className="vs-style-notice" role="status">{notice}</p>}
    {editing&&<section className="vs-style-editor" aria-label={editing.id?'编辑风格':'新建风格'}>
      <div className="vs-section-header"><h3>{editing.id?'编辑风格':'新建自定义风格'}</h3><button className="vs-iconbutton" onClick={()=>setEditing(null)} disabled={busy} aria-label="取消编辑">×</button></div>
      <label className="vs-field"><span>风格名称</span><input maxLength={100} value={name} onChange={event=>setName(event.target.value)} placeholder="例如：厚涂油画"/></label>
      <label className="vs-field"><span>简短说明（可选）</span><input maxLength={1000} value={description} onChange={event=>setDescription(event.target.value)} placeholder="适合的题材或风格特点"/></label>
      <label className="vs-field"><span>风格描述</span><textarea rows={9} maxLength={80000} value={prompt} onChange={event=>setPrompt(event.target.value)} placeholder="写下画面、色彩、镜头、节奏和声音等制作要求…"/></label>
      <div className="vs-modal-actions"><button disabled={busy} onClick={()=>setEditing(null)}>取消</button><button className="vs-primary" disabled={busy||!name.trim()||!prompt.trim()} onClick={()=>void save()}>{busy?'保存中…':'保存风格'}</button></div>
    </section>}
    <section className="vs-style-list" aria-label="已保存的视频制作风格">
      {!styles.length?<div className="vs-library-empty"><h3>风格库还是空的</h3><p>导入一个现有风格，或创建自己的制作说明。</p></div>:styles.map(style=><article className="vs-style-card" key={style.id} data-style-id={style.id}>
        <div className="vs-style-card-head"><div><h3>{style.name}</h3><p>{style.description||style.sourceName}</p></div><span>{formats[style.sourceFormat]}</span></div>
        <details><summary>查看风格描述</summary><pre>{style.prompt}</pre></details>
        <div className="vs-style-card-actions"><button className="vs-primary" disabled={busy} onClick={()=>onUse(style)}>用于新影片</button><button disabled={busy} onClick={()=>edit(style)}>编辑</button><button className="vs-danger" disabled={busy} onClick={()=>void remove(style)}>删除</button></div>
      </article>)}
    </section>
    <small className="vs-style-storage">风格保存在本机的 DSH 视频工程目录；导入只读取文本描述，不会执行风格包中的代码。</small>
    <div className="vs-modal-actions"><button onClick={onClose} disabled={busy}>完成</button></div>
  </Dialog>;
}
