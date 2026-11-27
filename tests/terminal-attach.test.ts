import assert from'node:assert/strict'
import test from'node:test'
import{TerminalOutput}from'../cli/attach.ts'
import{Frame,paneLayout,PaneScreen}from'../cli/screen.ts'

test('direct terminal output streams native drawing and contains fragmented host-side control strings',()=>{
 const filter=new TerminalOutput()
 assert.equal(filter.write('hello\x1b[31mred\x1b[0m'),'hello\x1b[31mred\x1b[0m')
 assert.equal(filter.write('\x1b]52;c;secret'),'')
 assert.equal(filter.write('\x07safe\x1b]0;title\x1b'),'safe')
 assert.equal(filter.write('\\\x1b[8;50;180t\x1b[?1049h'),'\x1b[?1049h')
 assert.equal(filter.write('\x1bPprivate\x1b\\good'),'good')
 assert.equal(filter.write('\x1b[200~paste\x1b[201~'),'\x1b[200~paste\x1b[201~')
})
test('dashboard animation writes only changed rows and no bytes for an unchanged frame',()=>{
 const before=new Frame(180,54);before.text(0,0,'Idle ◴');before.text(30,8,'Research space')
 const next=new Frame(180,54);next.text(0,0,'Idle ◷');next.text(30,8,'Research space')
 const full=next.ansi(),delta=next.ansi(before)
 assert.ok(delta.length<full.length/20);assert.doesNotMatch(delta,/Research space/)
 assert.equal(next.ansi(next),'')
 assert.ok(next.ansi(new Frame(80,24)).length>=full.length)
})
test('zero through four created sessions fill only their own panes, including the three-pane reference arrangement',()=>{
 const area={x:30,y:7,w:149,h:41}
 for(let count=0;count<=4;count++){
  const panes=paneLayout(area,count),cells=new Set<string>();assert.equal(panes.length,count)
  for(const pane of panes)for(let y=pane.y;y<pane.y+pane.h;y++)for(let x=pane.x;x<pane.x+pane.w;x++){assert.ok(x>=area.x&&x<area.x+area.w&&y>=area.y&&y<area.y+area.h);const key=x+','+y;assert.ok(!cells.has(key));cells.add(key)}
  assert.equal(cells.size,count?area.w*area.h:0)
 }
 const panes=paneLayout(area,3);assert.equal(panes[0]!.h,area.h);assert.equal(panes[1]!.x,panes[2]!.x)
})
test('idle pane animations reuse parsed terminal cells and a typed character emits only its changed cells',async()=>{
 const pane=new PaneScreen(60,12,()=>{}),before=new Frame(80,24),after=new Frame(80,24)
 try{
  await new Promise<void>(done=>pane.write('\x1b[2J\x1b[Hhello',done));pane.draw(before,{x:5,y:4,w:60,h:12})
  const reader=pane.terminal.buffer.active.getLine.bind(pane.terminal.buffer.active);let reads=0
  pane.terminal.buffer.active.getLine=(line)=>{reads++;return reader(line)}
  pane.draw(after,{x:5,y:4,w:60,h:12});assert.equal(reads,0);assert.equal(after.ansi(before),'')
  await new Promise<void>(done=>pane.write('!',done));pane.draw(after,{x:5,y:4,w:60,h:12});assert.ok(reads>0)
  const delta=after.ansi(before);assert.match(delta,/!/);assert.doesNotMatch(delta,/hello/);assert.ok(delta.length<180)
  await new Promise<void>(done=>pane.write('\x1b[?25l',done));assert.equal(pane.cursorVisible,false)
  await new Promise<void>(done=>pane.write('\x1b[?25h',done));assert.equal(pane.cursorVisible,true)
 }finally{pane.dispose()}
})
