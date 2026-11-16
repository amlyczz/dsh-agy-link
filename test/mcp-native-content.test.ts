import test from 'node:test'
import assert from 'node:assert/strict'
import { startMcpBridge } from '../src/host/mcp-bridge.ts'
import { toMcpContent, createImageLimiter, type McpAttachments } from '../src/host/mcp-content.ts'
test('concurrent callers reserve distinct call IDs before async resolution', async () => {
 const ids: string[] = []
 let arrivals = 0
 let release!: () => void
 const gate = new Promise<void>((done) => { release = done })
 const bridge = await startMcpBridge({ bridgeScript:'unused', allowlist:()=>'', resolveAgent:async()=>{ if (++arrivals === 2) release(); await gate; return {} }, tools:()=>({ schemas:()=>[{name:'read',description:'',parameters:{}}], execute:async(input)=>{ const call = input.calls[0]; assert.ok(call); ids.push(call.id); assert.equal(input.callId,call.id); return {text:'ok'} } }) })
 const call=()=>fetch(bridge.url+'/call',{method:'POST',headers:{authorization:'Bearer '+bridge.token,'x-dsh-session':'fixture','content-type':'application/json'},body:JSON.stringify({dshName:'read'})}).then(r=>r.json())
 try { await Promise.all([call(),call()]); assert.equal(ids.length,2); assert.equal(new Set(ids).size,2) } finally { await bridge.close() }
})
test('maximum inline image fits response budget without legacy binary duplication', async () => {
 const data = Buffer.alloc(8*1024*1024,7).toString('base64')
 let result: unknown = {content:[{type:'image',data,mimeType:'image/png'}]}
 const bridge = await startMcpBridge({bridgeScript:'unused',allowlist:()=>'',tools:()=>({schemas:()=>[{name:'read',description:'',parameters:{}}],execute:async()=>result})})
 const call=()=>fetch(bridge.url+'/call',{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify({dshName:'read'})})
 try {
  const response=await call(); const raw=await response.text(); assert.ok(Buffer.byteLength(raw)<16*1024*1024)
  const body=JSON.parse(raw); assert.equal(body.text,''); assert.deepEqual(body.content,[{type:'image',data,mimeType:'image/png'}])
  result={text:'legacy text'}; const legacy=await (await call()).json() as any; assert.equal(legacy.text,'legacy text'); assert.deepEqual(legacy.content,[{type:'text',text:'legacy text'}])
  result={content:[{type:'text',text:'native text'},{type:'image',data:'AQID',mimeType:'image/png'}]};const mixed=await (await call()).json() as any;assert.equal(mixed.text,'native text');assert.equal(mixed.content[1].data,'AQID')
 } finally { await bridge.close() }
})
const signal = () => new AbortController().signal
const image = (attachmentId: string, bytes?: number) => ({ type:'image', attachment:{attachmentId,mediaType:'image/png',bytes} })
test('native batch failures retain content, error, structuredContent and failure audit', async()=>{
 const logs:string[]=[]
 const native={isError:true,error:{code:'fixture'},structuredContent:{retry:false},content:[{type:'text',text:'failed natively'}]}
 const bridge=await startMcpBridge({bridgeScript:'unused',allowlist:()=>'',log:(s)=>logs.push(s),tools:()=>({schemas:()=>[{name:'read',description:'',parameters:{}}],execute:async(input)=>({results:[{callId:input.callId,result:native}]})})})
 try{const r=await fetch(bridge.url+'/call',{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify({dshName:'read'})});const b=await r.json() as any;assert.equal(b.ok,false);assert.equal(b.isError,true);assert.deepEqual(b.error,native.error);assert.deepEqual(b.structuredContent,native.structuredContent);assert.deepEqual(b.content,native.content);assert.ok(logs.some(s=>s.includes('failed: native')));assert.ok(!logs.some(s=>s.includes('[ok')))}finally{await bridge.close()}
})
test('attachment and inline images keep native blocks with MIME and byte bounds',async()=>{
 let reads=0
 const attachments:McpAttachments={readImage:async(ref)=>{reads++;return {ref,data:Uint8Array.of(1,2,3)}}}
 const out=await toMcpContent({content:[{type:'text',text:'hello'},image('one'),{type:'image',data:'AQID',mimeType:'image/png'}]},attachments,signal())
 assert.deepEqual(out,[{type:'text',text:'hello'},{type:'image',data:'AQID',mimeType:'image/png'},{type:'image',data:'AQID',mimeType:'image/png'}])
 const rejected=await toMcpContent({content:[image('oversized',8*1024*1024+1),{type:'image',data:'AQID',mimeType:'text/html'},{type:'image',data:'***',mimeType:'image/png'}]},attachments,signal())
 assert.equal(reads,1);assert.ok(rejected.every(b=>b.type==='text'))
 const total=await toMcpContent({content:[{type:'image',data:Buffer.alloc(5*1024*1024),mimeType:'image/png'},{type:'image',data:Buffer.alloc(4*1024*1024),mimeType:'image/png'}]},undefined,signal())
 assert.equal(total.filter(b=>b.type==='image').length,1)
})
test('attachment limiter caps concurrent calls at two and aborts queued reads',async()=>{
 const limit=createImageLimiter();let active=0,peak=0,reads=0
 const attachments:McpAttachments={readImage:async(ref)=>{reads++;active++;peak=Math.max(peak,active);await new Promise(done=>setTimeout(done,8));active--;return {ref,data:Uint8Array.of(1)}}}
 await Promise.all(Array.from({length:6},(_,i)=>toMcpContent({content:[image(String(i))]},attachments,signal(),limit)))
 assert.equal(peak,2);assert.equal(reads,6)
 const controller=new AbortController();controller.abort();await assert.rejects(toMcpContent({content:[image('aborted')]},attachments,controller.signal,limit));assert.equal(reads,6)
})
