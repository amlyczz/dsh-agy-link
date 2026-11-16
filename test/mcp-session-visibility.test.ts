import test from 'node:test'
import assert from 'node:assert/strict'
import { startMcpBridge } from '../src/host/mcp-bridge.ts'
const schema = (name: string) => ({ name, description: name, parameters: {} })
test('session list and call share live native visibility, isolation and caller validation', async () => {
  const a = {}, b = {}; let unlocked = false, executed = 0, broken = false, invalid = false
  const bridge = await startMcpBridge({ bridgeScript: 'unused', allowlist: () => 'read', sessionToolPolicy: () => 'native',
    resolveAgent: (id) => id === 'session-a' ? a : id === 'b' ? b : undefined,
    visibility: (agent) => { if (broken) throw new Error('unavailable'); if (invalid) return { names: [null] as unknown as string[] }; return { names: agent === a && unlocked ? ['read','dev_tool_search','secret'] : ['read','dev_tool_search'] } },
    tools: () => ({ schemas: (agent) => (agent === a ? ['read','dev_tool_search','secret','run_code'] : ['read']).map(schema), execute: async (input) => { executed++; if (input.name === 'dev_tool_search') unlocked = true; return { content: [{ type: 'text', text: 'ok' }] } } }),
  })
  const query = async (path: string, session: string, name?: string) => {
    const response = await fetch(bridge.url + path, { method: 'POST', headers: { authorization: 'Bearer ' + bridge.token, 'x-dsh-session': session, 'content-type': 'application/json' }, body: JSON.stringify({ dshName: name }) }); return { status: response.status, body: await response.json() as any }
  }
  try {
    assert.equal((await query('/tools','')).status,403)
    assert.equal((await query('/tools','unknown')).status,403)
    assert.equal((await query('/call','unknown','read')).status,403)
    assert.deepEqual((await query('/tools','a')).body.tools.map((t: any) => t.dshName), ['read','dev_tool_search'])
    assert.equal((await query('/call','a','secret')).status,403)
    assert.equal(executed,0)
    await query('/call','a','dev_tool_search')
    assert.ok((await query('/tools','a')).body.tools.some((t: any) => t.dshName === 'secret'))
    assert.equal((await query('/call','b','secret')).status,403)
    assert.equal((await query('/call','a','secret')).body.ok,true)
    broken=true
    assert.equal((await query('/tools','a')).status,503)
    assert.equal((await query('/call','a','read')).status,503)
    broken=false; invalid=true
    assert.equal((await query('/tools','a')).status,503)
    assert.equal((await query('/call','a','read')).status,503)
  } finally { await bridge.close() }
})
test('without resolver default allowlist still caps schemas for list and call', async () => {
  let calls=0
  const bridge=await startMcpBridge({bridgeScript:'unused',allowlist:()=> 'read',tools:()=>({schemas:()=>['read','write'].map(schema),execute:async()=>{calls++;return 'ok'}})})
  const query=async(path:string,name?:string)=>{const r=await fetch(bridge.url+path,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify({dshName:name})});return {status:r.status,body:await r.json() as any}}
  try { assert.deepEqual((await query('/tools')).body.tools.map((t:any)=>t.dshName),['read']);assert.equal((await query('/call','write')).status,403);assert.equal(calls,0);assert.equal((await query('/call','read')).body.ok,true) }finally{await bridge.close()}
})
