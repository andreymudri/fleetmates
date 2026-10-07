import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readExecutionEvents, executionDirectory } from '../scripts/execution-journal.mjs'
import { readExecutionArtifact } from '../scripts/execution-artifacts.mjs'

const retention = { maxArtifactBytes: 1024 * 1024, maxRunBytes: 8 * 1024 * 1024, maxAgeMs: 86400000 }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const fixture = `
import { readExecutionEvents } from ${JSON.stringify(new URL('../scripts/execution-journal.mjs', import.meta.url).href)};
import { dispatchPhase } from ${JSON.stringify(new URL('../scripts/driver.mjs', import.meta.url).href)};
import { composeBrief } from ${JSON.stringify(new URL('../scripts/brief.mjs', import.meta.url).href)};
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, access, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
const config = JSON.parse(process.env.FIXTURE);
const exec = promisify(execFile);
const git = async (args, opts = {}) => { try { const r = await exec('git', args, { cwd: opts.cwd ?? config.root, env: { ...process.env, ...opts.env } }); return { ...r, code: 0 }; } catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; } };
const branch = 'fleetmates/r/T1';
const cwd = path.join(config.root, 'clone');
const gitdir = path.join(config.root, 'clone-git');
const mark = async name => { await writeFile(path.join(config.root, name), 'yes'); };
const worker = async opts => {
 await mark('spawn-count-' + Date.now());
 if (config.noOutput || opts.noOutput) return { child: spawn(process.execPath, ['-e', 'process.exit(0)']), sessionId: Promise.resolve('sid') };
 const code = \`const { execFileSync } = require('node:child_process'); const fs = require('node:fs');
 const cwd = process.env.WORKER_CWD, gd = process.env.WORKER_GIT;
 const g = (...a) => execFileSync('git', ['--git-dir='+gd, '--work-tree='+cwd,...a], {cwd});
 if (!fs.existsSync(cwd+'/work.txt')) { fs.writeFileSync(cwd+'/work.txt','preserved'); g('add','work.txt'); g('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fix: fixture work'); }
 fs.writeFileSync(process.env.RESULT, JSON.stringify({status:'done',branch:'fleetmates/r/T1',filesChanged:['work.txt'],summary:'fixture',blockers:[]}));\n if (process.env.MALFORMED === 'true') fs.writeFileSync(process.env.RESULT,JSON.stringify({status:'done'}));\n if (process.env.WRONG_BRANCH === 'true') fs.writeFileSync(process.env.RESULT,JSON.stringify({status:'done',branch:'wrong',filesChanged:[],summary:'bad',blockers:[]}));\n process.exit(Number(process.env.EXIT_CODE ?? 0));\`;
 const child = spawn(process.execPath, ['-e', code], { env: { ...process.env, WORKER_CWD: cwd, WORKER_GIT: gitdir, RESULT: opts.resultPath, MALFORMED: String(config.malformed), WRONG_BRANCH: String(config.wrongBranch), EXIT_CODE: String(config.exitCode??0) }, stdio: 'ignore' });
 return { child, sessionId: Promise.resolve('sid'), flushed: Promise.resolve() };
};
const adapter = {
 name: 'fixture', supportsEffort: true,
 async makeSandbox(_git, opts) {
  try { await access(cwd); } catch {
   let r = await git(['clone','--shared','--separate-git-dir='+gitdir, config.root, cwd]); if(r.code) throw Error(r.stderr);
   r = await git(['checkout','-b',branch,'origin/run/r'], {cwd}); if(r.code) throw Error(r.stderr);
   if(config.workerWrongRef) { r=await git(['checkout','-b','wrong'],{cwd});if(r.code) throw Error(r.stderr); }
  }
  return { cwd, meta: { mode: config.mode ?? 'clone', gitdir, branch, workerEnvironment: config.preparation === 'missing' ? null : { ready:config.preparation!=='failed', workspace:'fresh', setup:{status:'pass',durationMs:7,checks:[{log:{complete:!config.incompleteSetup,output:'setup log'}}]},baseline:{status:'pass',durationMs:9,checks:[{log:{complete:true,output:'baseline log'}}]},durationMs:16 } } };
 },
 async spawn(opts) {
  if(config.linkedOutput) await symlink(opts.resultPath,opts.errPath);
  const events=await readExecutionEvents(config.execution.common,'r');
  await writeFile(path.join(config.root,'spawn-order.json'),JSON.stringify(events.some(e=>e.step==='harness'&&e.kind==='step-started'&&e.artifacts.some(a=>a.kind==='worker-setup'))));
  if(config.largeOutput) await writeFile(opts.streamPath,'x'.repeat(config.execution.retention.maxArtifactBytes+1));
  opts.sandbox.meta.workerEnvironment = { ready:!config.continuationFailed, workspace:'existing', setup:{status:'not-rerun',durationMs:null,checks:[]}, baseline:{status:'pass',checks:[]},durationMs:3 };
  return worker(opts);
 },
 async resume(opts) { return worker({...opts,noOutput:config.resumeNoOutput}); },
 async readResult({resultPath}) { if(config.virtualResult) return {status:'done',branch,filesChanged:[],summary:'virtual',blockers:[]}; try { return JSON.parse(await readFile(resultPath,'utf8')); } catch { return null; } },
 async readUsage() { return null; },
 async collect(_git, {sandbox,branch}) { const events=await readExecutionEvents(config.execution.common,'r');await writeFile(path.join(config.root,'collection-order.json'),JSON.stringify(events.some(e=>e.step==='collection'&&e.kind==='step-started'))); const r = await git(['fetch','--no-tags',sandbox.meta.gitdir,'refs/heads/'+branch+':refs/heads/'+branch]); if(r.code) throw Error(r.stderr); await mark('collected'); },
};
const args = { adapter, git, runRepo: config.root, runId:'r',runBranch:'run/r',phaseTasks:[{id:'T1',title:'fixture',files:['work.txt'],model:config.model}],maxParallel:1,sandboxMode:'clone',network:false,timeoutMinutes:1,tierModels:{},effortFor:()=> config.effort ?? 'high',personaFor:()=> config.persona ?? 'fixture persona',composeBriefFor:t=>composeBrief({task:{...t,branch},runId:'r',planPath:'plan.md',baseBranch:'old-base'}),runDir:path.join(config.root,'state'),completeEnforcement:async()=>{ await mark('verified-'+Date.now()); return config.enforcement ?? 0; },
 execution: config.legacy ? undefined : config.execution,
 executionBoundary: async name => { if(config.expireAtResult && name==='result-retained') await new Promise(resolve=>setTimeout(resolve,Math.max(1,config.execution.deadlineAt-Date.now()+5))); if(name === config.barrier) { await mark('barrier'); await new Promise(()=>{setInterval(()=>{},1000)}); } },
};
const out = await dispatchPhase(args);
await writeFile(path.join(config.root,'out.json'),JSON.stringify(out));
`

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dr-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, 'init', '-b', 'run/r')
  git(root, 'config', 'user.name', 'Fixture')
  git(root, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(path.join(root, 'seed'), 'seed')
  git(root, 'add', 'seed'); git(root, 'commit', '-m', 'test: seed')
  const commit = git(root, 'rev-parse', 'HEAD')
  return { root, execution: { version: 1, common: path.join(root, '.git'), runId:'r', executionId:'exec-r',
    inputs: { commit, plan:'a'.repeat(64),manifest:'b'.repeat(64),context:'c'.repeat(64),environment:'d'.repeat(64),verifier:'e'.repeat(64) },retention,maxAttempts:2,deadlineAt:Date.now()+60000 } }
}
async function run(config, t) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', fixture], { env: { ...process.env, FIXTURE: JSON.stringify(config) }, stdio: ['ignore','pipe','pipe'] })
  let err = ''; child.stderr.on('data', b => { err += b })
  const ended = new Promise(resolve => child.on('close', (code, signal) => resolve({code,signal,err})))
  t.after(async () => { if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended })
  return {child,ended}
}
async function until(file, child) {
  for(let n=0;n<300;n++) { try { await access(file); return } catch {} if(child.exitCode !== null) break; await new Promise(resolve => setTimeout(resolve,10)) }
  assert.fail('persisted barrier was not reached')
}
async function outcome(config,t) {
  const {ended} = await run(config,t)
  const result = await ended
  assert.equal(result.code,0,result.err)
  return JSON.parse(await readFile(path.join(config.root,'out.json'),'utf8'))
}

for (const barrier of ['spawned','result-retained','collection-started','collection-applied']) {
  test('actual child-driver loss at '+barrier+' preserves evidence and refuses duplicate model execution', async t => {
    const config = await setup(t)
    const {child,ended} = await run({...config,barrier},t)
    await until(path.join(config.root,'barrier'),child)
    child.kill('SIGKILL'); assert.equal((await ended).signal,'SIGKILL')
    await until(path.join(config.root,'state','sessions','T1.result.json'),{exitCode:null})
    const tip = git(config.root,'--git-dir='+path.join(config.root,'clone-git'),'rev-parse','refs/heads/fleetmates/r/T1')
    assert.notEqual(tip,config.execution.inputs.commit)
    const events = await readExecutionEvents(config.execution.common,'r')
    assert.ok(events.some(e=>e.kind==='step-started'&&e.task==='T1'))
    if(barrier!=='spawned') {
      const refs = events.flatMap(e=>e.artifacts)
      assert.ok(refs.length)
      for(const reference of refs) assert.ok((await readExecutionArtifact({common:config.execution.common,runId:'r',reference,retention})).length)
    }
    if(barrier==='collection-applied') { await rm(path.join(config.root,'clone'),{recursive:true,force:true}); await rm(path.join(config.root,'clone-git'),{recursive:true,force:true}) }
    const out = await outcome(config,t)
    const {readdir} = await import('node:fs/promises')
    const names = await readdir(config.root)
    assert.equal(names.filter(n=>n.startsWith('spawn-count-')).length,1)
    if(barrier==='spawned') { assert.deepEqual(out.orphaned,['T1']); assert.equal(out.results.length,0) }
    else {
      assert.equal(out.results[0]?.status,'done')
      assert.equal(git(config.root,'rev-parse','refs/heads/fleetmates/r/T1'),tip)
      assert.ok(names.some(n=>n.startsWith('verified-')))
      assert.equal(out.results[0].verifiedComplete,false)
    }
  })
}

test('strict contract rejects a legacy status-only session before spawning or completion',async t=>{
  const config=await setup(t)
  const {mkdir}=await import('node:fs/promises'); await mkdir(path.join(config.root,'state','sessions'),{recursive:true})
  await writeFile(path.join(config.root,'state','sessions','T1.json'),JSON.stringify({state:'done',result:{status:'done'}}))
  const out=await outcome(config,t)
  assert.deepEqual(out.orphaned,['T1']); assert.deepEqual(out.results,[])
})

test('result is schema validated after exit; stale output cannot satisfy a new invocation',async t=>{
  const config=await setup(t)
  const {mkdir}=await import('node:fs/promises'); await mkdir(path.join(config.root,'state','sessions'),{recursive:true})
  await writeFile(path.join(config.root,'state','sessions','T1.result.json'),JSON.stringify({status:'done',branch:'fleetmates/r/T1',filesChanged:[],summary:'stale',blockers:[]}))
  const out=await outcome({...config,noOutput:true},t)
  assert.deepEqual(out.orphaned,['T1']); assert.deepEqual(out.results,[])
})

test('required journal persistence failure refuses spawn',async t=>{
  const config=await setup(t)
  const {mkdir}=await import('node:fs/promises')
  const dir=await executionDirectory(config.execution.common,'r')
  await mkdir(dir,{recursive:true,mode:0o700}); await mkdir(path.join(dir,'.lock'),{mode:0o700})
  const out=await outcome(config,t)
  const {readdir}=await import('node:fs/promises')
  assert.deepEqual(out.orphaned,['T1']); assert.ok(!(await readdir(config.root)).some(n=>n.startsWith('spawn-count-')))
})

test('initial setup and continuation observations are retained separately with model/prompt identities',async t=>{
  const config=await setup(t); const out=await outcome(config,t)
  assert.equal(JSON.parse(await readFile(path.join(config.root,'spawn-order.json'),'utf8')),true,'harness start and setup must precede spawn')
  assert.equal(JSON.parse(await readFile(path.join(config.root,'collection-order.json'),'utf8')),true,'collection start must precede collection')
  assert.equal(out.results[0]?.status,'done')
  const events=await readExecutionEvents(config.execution.common,'r')
  const artifacts=[]
  for(const reference of events.flatMap(e=>e.artifacts)) artifacts.push({kind:reference.kind,value:JSON.parse(await readExecutionArtifact({common:config.execution.common,runId:'r',reference,retention}))})
  const setupArtifact=artifacts.find(a=>a.kind==='worker-setup')
  assert.equal(setupArtifact?.value.setup.durationMs,7)
  assert.equal(setupArtifact?.value.baseline.checks[0].log.output,'baseline log')
  assert.equal(artifacts.find(a=>a.kind==='worker-continuation')?.value.setup.status,'not-rerun')
  const binding=artifacts.find(a=>a.kind==='driver-invocation')?.value
  assert.equal(binding?.effort,'high'); assert.equal(binding?.model,null); assert.match(binding?.promptSha256??'',/^[a-f0-9]{64}$/)
})

async function pause(config,t,barrier='result-retained') {
  const handle=await run({...config,barrier},t)
  await until(path.join(config.root,'barrier'),handle.child)
  handle.child.kill('SIGKILL'); assert.equal((await handle.ended).signal,'SIGKILL')
}
async function names(config) { return (await import('node:fs/promises')).readdir(config.root) }
async function assertRefusal(config,t,reason) {
  const before=(await names(config)).filter(n=>n.startsWith('spawn-count-')).length
  const out=await outcome(config,t)
  assert.deepEqual(out.orphaned,['T1']); assert.deepEqual(out.results,[])
  assert.equal((await names(config)).filter(n=>n.startsWith('spawn-count-')).length,before)
  const session=JSON.parse(await readFile(path.join(config.root,'state','sessions','T1.json'),'utf8'))
  assert.match(session.exitReason,reason)
}

for(const field of ['plan','manifest','context','environment','verifier']) {
  test('changed strict '+field+' refuses retained result reuse',async t=>{
    const config=await setup(t); await pause(config,t)
    config.execution.inputs[field]='f'.repeat(64)
    await assertRefusal(config,t,/changed|stale/)
  })
}

test('changed model and prompt refuse retained result reuse even after disposable checkout loss',async t=>{
  for(const change of [{model:'changed-model'},{persona:'changed persona'},{effort:'low'}]) {
    const config=await setup(t); await pause(config,t,'collection-applied')
    await rm(path.join(config.root,'clone'),{recursive:true,force:true})
    await assertRefusal({...config,...change},t,/binding changed|prompt identity changed/)
  }
})

test('moved source commit refuses execution',async t=>{
  const config=await setup(t)
  git(config.root,'commit','--allow-empty','-m','test: moved source')
  await assertRefusal(config,t,/source commit changed/)
})

test('moved worker branch refuses collection without resetting its work',async t=>{
  const config=await setup(t); await pause(config,t)
  const gd=path.join(config.root,'clone-git')
  git(config.root,'--git-dir='+gd,'update-ref','refs/heads/fleetmates/r/T1',config.execution.inputs.commit)
  await assertRefusal(config,t,/lost or changed/)
})

test('changed collected host ref refuses recovery',async t=>{
  const config=await setup(t); await pause(config,t,'collection-applied')
  git(config.root,'update-ref','refs/heads/fleetmates/r/T1',config.execution.inputs.commit)
  await assertRefusal(config,t,/changed|ref|reconciliation/)
})

test('missing retained artifact refuses reuse',async t=>{
  const config=await setup(t); await pause(config,t)
  await rm(path.join(config.execution.common,'fleetmates-artifacts'),{recursive:true,force:true})
  await assertRefusal(config,t,/unavailable/)
})

test('fresh enforcement failure cannot return done from retained model output',async t=>{
  const config=await setup(t); await pause(config,t)
  await assertRefusal({...config,enforcement:4},t,/mandatory enforcement/)
  assert.ok((await names(config)).some(n=>n.startsWith('verified-')))
})

test('missing current resume result cannot reuse the first invocation result',async t=>{
  const config=await setup(t)
  const out=await outcome({...config,enforcement:3,resumeNoOutput:true},t)
  assert.deepEqual(out.orphaned,['T1']); assert.deepEqual(out.results,[])
  const events=await readExecutionEvents(config.execution.common,'r')
  assert.equal(events.filter(e=>e.step==='harness'&&e.kind==='step-started').length,2)
  assert.ok(events.some(e=>e.step==='harness'&&e.kind==='step-failed'))
})

for(const change of [{malformed:true},{exitCode:7},{wrongBranch:true}]) {
  test('actual completed child rejects '+JSON.stringify(change),async t=>{
    const config=await setup(t); const out=await outcome({...config,...change},t)
    assert.deepEqual(out.orphaned,['T1']); assert.deepEqual(out.results,[])
    assert.ok(!(await names(config)).includes('collected'))
  })
}

test('deadline and attempt bounds refuse enforcement resume',async t=>{
  const config=await setup(t); config.execution.maxAttempts=1
  const out=await outcome({...config,enforcement:3},t)
  assert.deepEqual(out.orphaned,['T1'])
  assert.equal((await names(config)).filter(n=>n.startsWith('spawn-count-')).length,1)
})

test('unknown external effect remains unresolved without query or duplicate model execution',async t=>{
  const config=await setup(t); await pause(config,t,'spawned')
  await until(path.join(config.root,'state','sessions','T1.result.json'),{exitCode:null})
  const {appendExecutionEvent}=await import('../scripts/execution-journal.mjs')
  const start=(await readExecutionEvents(config.execution.common,'r')).find(e=>e.step==='harness'&&e.kind==='step-started')
  await appendExecutionEvent(config.execution.common,{...start,id:'effect-start',kind:'effect-started',at:start.at+1,artifacts:[],effect:{id:'publication-attempt',kind:'publication',reference:null}})
  await assertRefusal(config,t,/unknown-effect/)
})

test('strict initial preparation must exist and pass before spawn',async t=>{
  for(const preparation of ['missing','failed']) {
    const config=await setup(t)
    const out=await outcome({...config,preparation},t)
    assert.deepEqual(out.orphaned,['T1']);assert.deepEqual(out.results,[])
    assert.ok(!(await names(config)).some(n=>n.startsWith('spawn-count-')))
  }
})

test('required private result/output retention refuses oversized bytes before collection',async t=>{
  const config=await setup(t)
  const out=await outcome({...config,largeOutput:true},t)
  assert.deepEqual(out.orphaned,['T1']);assert.ok(!(await names(config)).includes('collected'))
})

test('actual deadline expiration after retained result refuses collection',async t=>{
  const config=await setup(t);config.execution.deadlineAt=Date.now()+800
  const out=await outcome({...config,expireAtResult:true},t)
  assert.deepEqual(out.orphaned,['T1']);assert.ok(!(await names(config)).includes('collected'))
})

for(const changed of [{version:2},{maxAttempts:0},{deadlineAt:0},{unexpected:true},{retention:{maxArtifactBytes:1}}]) {
  test('malformed required execution contract fails closed '+JSON.stringify(changed),async t=>{
    const config=await setup(t);config.execution={...config.execution,...changed}
    const {ended}=await run(config,t);const observed=await ended
    assert.equal(observed.code,1);assert.match(observed.err,/Invalid required execution/)
    assert.ok(!(await names(config)).some(n=>n.startsWith('spawn-count-')))
  })
}

test('required recovery refuses a files checkout without Git ref reconciliation',async t=>{
  const config=await setup(t);const out=await outcome({...config,mode:'files'},t)
  assert.deepEqual(out.orphaned,['T1'])
  assert.ok(!(await names(config)).some(n=>n.startsWith('spawn-count-')))
})

test('reverification attempts are bounded without respawning a completed harness',async t=>{
  const config=await setup(t)
  assert.equal((await outcome(config,t)).results[0]?.status,'done')
  assert.equal((await outcome(config,t)).results[0]?.status,'done')
  await assertRefusal(config,t,/attempt bound/)
  assert.equal((await names(config)).filter(n=>n.startsWith('spawn-count-')).length,1)
})

test('failed continuation observation cannot establish a completed harness receipt',async t=>{
  const config=await setup(t);const out=await outcome({...config,continuationFailed:true},t)
  assert.deepEqual(out.orphaned,['T1']);assert.ok(!(await names(config)).includes('collected'))
  const events=await readExecutionEvents(config.execution.common,'r')
  assert.ok(!events.some(e=>e.step==='harness'&&e.kind==='step-completed'))
})

test('linked harness output refuses retained completion',async t=>{
  const config=await setup(t);const out=await outcome({...config,linkedOutput:true},t)
  assert.deepEqual(out.orphaned,['T1']);assert.ok(!(await names(config)).includes('collected'))
})

test('adapter-only result without retained native bytes remains unverified',async t=>{
  const config=await setup(t);const out=await outcome({...config,noOutput:true,virtualResult:true},t)
  assert.deepEqual(out.orphaned,['T1']);assert.ok(!(await names(config)).includes('collected'))
})

test('incomplete initial setup logs cannot satisfy strict preparation',async t=>{
  const config=await setup(t);const out=await outcome({...config,incompleteSetup:true},t)
  assert.deepEqual(out.orphaned,['T1']);assert.ok(!(await names(config)).some(n=>n.startsWith('spawn-count-')))
})


test('required execution never uses the unverified legacy worker fallback',async t=>{
  const config=await setup(t);const out=await outcome({...config,workerWrongRef:true},t)
  assert.deepEqual(out.orphaned,['T1']);assert.ok(!(await names(config)).some(n=>n.startsWith('spawn-count-')))
})
