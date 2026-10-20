import test from 'node:test';
import assert from 'node:assert/strict';
import {strToU8,zipSync} from 'fflate';
import {parseStyleFiles} from '../src/client/style-import.ts';

function zipFile(entries:Record<string,string>,name='styles.zip'){
  const bytes=zipSync(Object.fromEntries(Object.entries(entries).map(([path,text])=>[path,strToU8(text)])));
  return new File([Uint8Array.from(bytes).buffer],name,{type:'application/zip'});
}
test('ZIP style import decodes Chinese metadata and preserves the actual Markdown preference',async()=>{
  const markdown='# 明亮拼贴\n米白底、珊瑚橘大字，采用错位排版与剪纸运动。';
  const styles=await parseStyleFiles([zipFile({'bright/STYLE.md':markdown,'bright/style.json':JSON.stringify({cn:'中文暖纸',summary:'明亮杂志'}),'bright/demo/ignored.md':'# 不应导入','bright/code.js':'throw Error("Never run")'})]);
  assert.equal(styles.length,1);assert.equal(styles[0]!.name,'中文暖纸');
  assert.equal(styles[0]!.description,'明亮杂志');assert.equal(styles[0]!.prompt,markdown);
  assert.equal(styles[0]!.sourceFormat,'zip');
});
test('Markdown, JSON and folder imports remain usable alongside ZIP imports',async()=>{
  const markdown=await parseStyleFiles([new File(['# 自然纪录\n暖绿与日光'],'natural.md')]);
  assert.equal(markdown[0]!.name,'自然纪录');assert.equal(markdown[0]!.sourceFormat,'markdown');
  const json=await parseStyleFiles([new File([JSON.stringify({name:'鲜亮波普',prompt:'黄底洋红大字'})],'style.json')]);
  assert.equal(json[0]!.prompt,'黄底洋红大字');assert.equal(json[0]!.sourceFormat,'json');
  const folder=new File(['# 手绘风格\n蜡笔质感'],'STYLE.md');
  Object.defineProperty(folder,'webkitRelativePath',{value:'styles/crayon/STYLE.md'});
  assert.equal((await parseStyleFiles([folder]))[0]!.sourceFormat,'folder');
});
test('broken ZIPs, archives without preferences and unsupported documents fail explicitly',async()=>{
  await assert.rejects(parseStyleFiles([new File(['not a zip'],'broken.zip')]),/不是有效 ZIP/);
  await assert.rejects(parseStyleFiles([zipFile({'code.js':'alert(1)','image.png':'image'})]),/没有找到可导入/);
  await assert.rejects(parseStyleFiles([new File(['document'],'style.docx')]),/暂不支持/);
});
