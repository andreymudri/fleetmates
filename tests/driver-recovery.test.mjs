import { strictTest as test } from './strict-platform.mjs'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { reconcileExecutionAttempt } from '../scripts/execution-recovery.mjs'
import { mkdtemp, readFile, writeFile, rm, access, symlink } from 'node:fs/promises'
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
import { readFile, writeFile, access, rm, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
const config = JSON.parse(process.env.FIXTURE);
const exec = promisify(execFile);
const git = async (args, opts = {}) => { try { const r = await exec('git', args, { cwd: opts.cwd ?? config.root, env: { ...process.env, ...opts.env } }); return { ...r, code: 0 }; } catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; } };
const branch = 'fleetmates/r/T1';
const cwd = path.join(config.root, 'clone');
const gitdir = path.join(config.root, 'clone-git');
// T1 keeps the original checkout paths; any other task gets its own clone and git dir.
const sandboxFor = id => id === 'T1' ? { cwd, gitdir } : { cwd: path.join(config.root, 'clone-' + id), gitdir: path.join(config.root, 'clone-git-' + id) };
let enforcementCalls = 0; const boundaries = {};
const hang = () => new Promise(()=>{});
const late = () => new Promise(resolve=>setTimeout(resolve,Math.max(1,config.execution.deadlineAt-Date.now()+20)));
const mark = async name => { await writeFile(path.join(config.root, name), 'yes'); };
const worker = async opts => {
 await mark('spawn-count-' + Date.now() + '-' + Math.random().toString(36).slice(2));
 await writeFile(path.join(config.root, 'prompt-last.txt'), String(opts.prompt ?? opts.message ?? ''));
 const freshness = {};
 for(const [key,file] of Object.entries({result:opts.resultPath,stream:opts.streamPath,stderr:opts.errPath})) { try { await access(file); freshness[key]=false } catch { freshness[key]=true } }
 await writeFile(path.join(config.root,'fresh-inputs-'+(opts.resumed?'resume':'spawn')+'.json'),JSON.stringify(freshness));
 if (config.noOutput || opts.noOutput) return { child: spawn(process.execPath, ['-e', 'process.exit(0)']), sessionId: Promise.resolve('sid') };
 const code = \`const { execFileSync } = require('node:child_process'); const fs = require('node:fs');
 const cwd = process.env.WORKER_CWD, gd = process.env.WORKER_GIT, taskBranch = process.env.TASK_BRANCH;
 const g = (...a) => execFileSync('git', ['--git-dir='+gd, '--work-tree='+cwd,...a], {cwd});
 if (process.env.RESET_WORK === 'true') { g('reset','--hard',process.env.RESET_TO); fs.writeFileSync(cwd+'/work.txt','reset'); g('add','work.txt'); g('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fix: reset work'); }
 else if (!fs.existsSync(cwd+'/work.txt')) { fs.writeFileSync(cwd+'/work.txt','preserved'); g('add','work.txt'); g('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fix: fixture work'); }
 if (process.env.FIX_COMMIT === 'true') { fs.writeFileSync(cwd+'/fix.txt','second commit');g('add','fix.txt');g('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fix: fixture continuation'); }
 fs.writeFileSync(process.env.RESULT, JSON.stringify({status:'done',branch:taskBranch,filesChanged:['work.txt'],summary:process.env.DISTINCT_FIX==='true'?'fixture fix':'fixture',blockers:[]}));\n if (process.env.MALFORMED === 'true') fs.writeFileSync(process.env.RESULT,JSON.stringify({status:'done'}));\n if (process.env.WRONG_BRANCH === 'true') fs.writeFileSync(process.env.RESULT,JSON.stringify({status:'done',branch:'wrong',filesChanged:[],summary:'bad',blockers:[]}));\n const invalid=process.env.INVALID_OUTPUT; const target=invalid?.endsWith('stream')?process.env.STREAM:process.env.RESULT;
 if(invalid) { fs.rmSync(target,{force:true}); if(invalid.startsWith('fifo')) execFileSync('mkfifo',[target]); else if(invalid.startsWith('directory')) fs.mkdirSync(target); else fs.writeFileSync(target,'x'.repeat(Number(process.env.BYTE_LIMIT)+1)); }
 if(process.env.STREAM_RESULT==='true') { fs.copyFileSync(process.env.RESULT,process.env.STREAM);fs.unlinkSync(process.env.RESULT); }
 fs.writeFileSync(process.env.WORKER_EXIT,'success');
 process.exit(Number(process.env.EXIT_CODE ?? 0));\`;
 const child = spawn(process.execPath, ['-e', code], { env: { ...process.env, WORKER_CWD: opts.sandbox.cwd, WORKER_GIT: opts.sandbox.meta.gitdir, TASK_BRANCH: opts.sandbox.meta.branch, RESET_WORK: String(!!(opts.resumed && config.resetWork)), RESET_TO: config.execution.inputs.commit, RESULT: opts.resultPath, MALFORMED: String(config.malformed), WRONG_BRANCH: String(config.wrongBranch), EXIT_CODE: String(config.exitCode??0), FIX_COMMIT:String(opts.resumed&&config.fixCommit), DISTINCT_FIX:String(opts.resumed&&config.distinctFixEvidence), INVALID_OUTPUT:config.invalidOutput??'', STREAM:opts.streamPath, BYTE_LIMIT:String(config.execution.retention.maxArtifactBytes), STREAM_RESULT:String(config.streamResult), WORKER_EXIT:path.join(config.root,'worker-exit-success') }, stdio: 'ignore' });
 await writeFile(path.join(config.root,'worker.pid'),String(child.pid));
 return { child, sessionId: config.hangStage==='session'?hang():Promise.resolve('sid'), flushed: config.hangStage==='flush'?hang():Promise.resolve() };
};
const adapter = {
 name: 'fixture', supportsEffort: true,
 async makeSandbox(_git, opts) {
  if(config.hangStage==='setup') await hang();
  const { cwd, gitdir } = sandboxFor(opts.taskId), branch = 'fleetmates/r/' + opts.taskId;
  await writeFile(path.join(config.root, 'sandbox-base-' + opts.taskId), String(opts.runBranch));
  try { await access(cwd); } catch {
   let r = await git(['clone','--shared','--separate-git-dir='+gitdir, config.root, cwd]); if(r.code) throw Error(r.stderr);
   r = await git(['checkout','-b',branch,'origin/'+opts.runBranch], {cwd}); if(r.code) throw Error(r.stderr);
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
  const handle=await worker(opts); if(config.hangStage==='spawn') await hang(); return handle;
 },
 async resume(opts) {
  if(config.distinctFixEvidence) opts.sandbox.meta.workerEnvironment = {ready:true,workspace:'existing',setup:{status:'not-rerun',durationMs:null,checks:[]},baseline:{status:'pass',durationMs:null,checks:[{log:{complete:true,output:'fix baseline'}}]},durationMs:null};
  return worker({...opts,resumed:true,noOutput:config.resumeNoOutput});
 },
 async readResult({resultPath,streamPath}) {
  await mark('parser-called');
  await writeFile(path.join(config.root,'parser-paths.json'),JSON.stringify({resultPath,streamPath,resultMode:((await stat(resultPath).catch(()=>null))?.mode??0)&0o777,dirMode:(await stat(path.dirname(resultPath))).mode&0o777}));
  if(config.hangStage==='parser') await hang();
  if(config.swapOriginal) {
   const original=path.join(config.root,'state','sessions','T1.result.json');await rm(original,{force:true});
   if(config.swapOriginal==='fifo') await exec('mkfifo',[original]); else await writeFile(original,JSON.stringify({status:'done',branch,filesChanged:[],summary:'forged',blockers:[]}));
  }
  if(config.virtualResult) return {status:'done',branch,filesChanged:[],summary:'virtual',blockers:[]}; try { return JSON.parse(await readFile(config.streamResult?streamPath:resultPath,'utf8')); } catch { return null; } },
 async readUsage() { if(config.hangStage==='usage') await hang(); return null; },
 async collect(_git, {sandbox,branch}) { if(config.hangStage==='collection') await hang(); if(config.lateCollection) await late(); const events=await readExecutionEvents(config.execution.common,'r');await writeFile(path.join(config.root,'collection-order.json'),JSON.stringify(events.some(e=>e.step==='collection'&&e.kind==='step-started'))); await writeFile(path.join(config.root,'collect-base.txt'),String(sandbox.meta.runBranch)); const r = await _git(['fetch','--no-tags',sandbox.meta.gitdir,(config.forceCollect?'+':'')+'refs/heads/'+branch+':refs/heads/'+branch]); if(r.code) throw Error(r.stderr); await mark('collected'); },
};
const args = { adapter, git, runRepo: config.root, runId:'r',runBranch:'run/r',phaseTasks:(config.tasks??['T1']).map(id=>({id,title:'fixture',files:['work.txt'],model:config.model})),maxParallel:config.maxParallel??1,fixRound:config.fixRound,sandboxMode:'clone',network:false,timeoutMinutes:1,tierModels:{},effortFor:()=> config.effort ?? 'high',personaFor:()=> config.persona ?? 'fixture persona',composeBriefFor:t=>composeBrief({task:{...t,branch:'fleetmates/r/'+t.id},runId:'r',planPath:'plan.md',baseBranch:'old-base',fixRound:config.fixRound===true}),runDir:config.runDir??path.join(config.root,'state'),completeEnforcement:async()=>{
 await mark('verified-'+Date.now());
 if(config.hangStage==='verification') await hang(); if(config.slowEnforcement) await late();
 const call=enforcementCalls++; const code=config.enforcementAnswers?.[call]??config.enforcementCodes?.[call]??config.enforcement??0;
 if(config.seedBeforeResume && code===3) for(const suffix of ['stream.jsonl','stderr.log']) await writeFile(path.join(config.root,'state','sessions','T1.'+suffix),'x'.repeat(config.execution.retention.maxArtifactBytes+1));
 return code;
 },
 execution: config.legacy ? undefined : config.execution,
 executionBoundary: async name => { boundaries[name]=(boundaries[name]??0)+1; if(config.expireAtResult && name==='result-retained') await new Promise(resolve=>setTimeout(resolve,Math.max(1,config.execution.deadlineAt-Date.now()+5))); if(name === config.barrier && boundaries[name]===(config.barrierOccurrence??1)) { await mark('barrier'); await new Promise(()=>{setInterval(()=>{},1000)}); } },
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

test('a strict dispatch whose run directory is reached through a symbolic link completes', async t => {
  // macOS temp directories live under /var, a link to /private/var: the run directory a caller hands
  // over is not canonical there, and the strict output reads refuse a path whose realpath differs.
  const config = await setup(t)
  const link = path.join(os.tmpdir(), `dr-link-${process.pid}-${Date.now()}`)
  await symlink(config.root, link)
  t.after(() => rm(link, { force: true }))
  const out = await outcome({ ...config, runDir: path.join(link, 'state') }, t)
  assert.deepEqual(out.orphaned, []); assert.equal(out.results[0]?.status, 'done')
})

test('an open agent-dispatch effect of the launching controller does not refuse the strict driver it launched',async t=>{
  const config=await setup(t)
  const {appendExecutionEvent}=await import('../scripts/execution-journal.mjs')
  const parent={version:2,runId:'r',executionId:'wf-parent',task:'profile',step:'implement-1',attempt:'implement-1.1',inputs:config.execution.inputs,
    branches:{'refs/heads/run/r':config.execution.inputs.commit},checkout:'root',artifacts:[]}
  const at=Date.now()-1000
  await appendExecutionEvent(config.execution.common,{...parent,id:'parent-start',kind:'step-started',at},{requireFreshStart:true})
  await appendExecutionEvent(config.execution.common,{...parent,id:'parent-effect',kind:'effect-started',at:at+1,effect:{id:'agent.implement-1.1',kind:'agent-dispatch',reference:null}})
  const out=await outcome(config,t)
  assert.deepEqual(out.orphaned,[]);assert.equal(out.results[0]?.status,'done')
  assert.equal((await names(config)).filter(n=>n.startsWith('spawn-count-')).length,1)
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

async function boundedOutcome(config,t,waitMs=4500) {
  const handle=await run(config,t);let timer
  let finished
  try { finished=await Promise.race([handle.ended,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),waitMs)})]) }
  finally { clearTimeout(timer) }
  assert.notEqual(finished,null,'driver remained alive beyond the bounded outcome deadline')
  assert.equal(finished.code,0,finished.err)
  const out=JSON.parse(await readFile(path.join(config.root,'out.json'),'utf8'))
  await assert.rejects(access(path.join(config.root,'state','driver.lock')),/ENOENT/)
  return out
}

async function retainedTips(config) {
  const events=await readExecutionEvents(config.execution.common,'r'),tips=[]
  for(const event of events.filter(e=>e.step==='harness'&&e.kind==='step-completed')) {
    const reference=event.artifacts.find(a=>a.kind==='driver-result')
    tips.push(JSON.parse(await readExecutionArtifact({common:config.execution.common,runId:'r',reference,retention})).sourceTip)
  }
  return tips
}

test('enforcement-fix control preserves two actual commits and verifies their collected tip',async t=>{
  const config=await setup(t)
  const out=await outcome({...config,fixCommit:true,enforcementCodes:[3,0]},t)
  assert.equal(out.results[0]?.status,'done')
  const tips=await retainedTips(config);assert.equal(tips.length,2);assert.notEqual(tips[0],tips[1])
  assert.equal(git(config.root,'rev-parse','refs/heads/fleetmates/r/T1'),tips[1])
  git(config.root,'merge-base','--is-ancestor',tips[0],tips[1])
  assert.equal((await names(config)).filter(n=>n.startsWith('spawn-count-')).length,2)
})

for(const barrier of ['result-retained','collection-started','collection-applied']) {
 test('second enforcement-fix loss at '+barrier+' collects retained fix without another model execution',async t=>{
  const config=await setup(t)
  await pause({...config,fixCommit:true,enforcementCodes:[3,0],barrierOccurrence:2},t,barrier)
  const tips=await retainedTips(config);assert.equal(tips.length,2);assert.notEqual(tips[0],tips[1])
  const hostTip=git(config.root,'rev-parse','refs/heads/fleetmates/r/T1')
  assert.equal(hostTip,barrier==='collection-applied'?tips[1]:tips[0])
  assert.equal(git(config.root,'--git-dir='+path.join(config.root,'clone-git'),'rev-parse','HEAD'),tips[1])
  const verifications=(await names(config)).filter(n=>n.startsWith('verified-')).length
  const out=await outcome(config,t)
  assert.equal(out.results[0]?.status,'done')
  assert.equal(git(config.root,'rev-parse','refs/heads/fleetmates/r/T1'),tips[1])
  git(config.root,'merge-base','--is-ancestor',tips[0],tips[1])
  assert.equal((await names(config)).filter(n=>n.startsWith('spawn-count-')).length,2)
  assert.equal((await names(config)).filter(n=>n.startsWith('verified-')).length,verifications+1)
  assert.equal(out.results[0].verifiedComplete,false)
 })
}

for(const invalidOutput of ['fifo-result','fifo-stream','directory-result','directory-stream','oversized-result','oversized-stream']) {
 test('bounded native '+invalidOutput+' refuses parsing and collection after a successful child exit',async t=>{
  const config=await setup(t);config.execution.deadlineAt=Date.now()+2500
  const out=await boundedOutcome({...config,invalidOutput},t)
  assert.deepEqual(out.orphaned,['T1']);assert.deepEqual(out.results,[])
  assert.equal(await readFile(path.join(config.root,'worker-exit-success'),'utf8'),'success')
  const files=await names(config);assert.ok(!files.includes('parser-called'));assert.ok(!files.includes('collected'))
 })
}

for(const swapOriginal of ['forged','fifo']) {
 test('parser uses exact retained bytes when original output is swapped to '+swapOriginal,async t=>{
  const config=await setup(t);config.execution.deadlineAt=Date.now()+2500
  const out=await boundedOutcome({...config,swapOriginal},t)
  assert.equal(out.results[0]?.status,'done');assert.equal(out.results[0].summary,'fixture')
  const parserPaths=JSON.parse(await readFile(path.join(config.root,'parser-paths.json'),'utf8'))
  assert.notEqual(parserPaths.resultPath,path.join(config.root,'state','sessions','T1.result.json'))
  assert.equal(parserPaths.resultMode,0o400);assert.equal(parserPaths.dirMode,0o700)
  await assert.rejects(access(parserPaths.resultPath),/ENOENT/)
  const {readdir}=await import('node:fs/promises')
  assert.ok(!(await readdir(config.execution.common)).some(n=>n.startsWith('fleetmates-driver-parse-')))
 })
}

for(const streamResult of [false,true]) {
 test('fresh successful '+(streamResult?'stream':'result')+' worker clears oversized stale stream and stderr before spawn and resume',async t=>{
  const config=await setup(t);const {mkdir}=await import('node:fs/promises')
  await mkdir(path.join(config.root,'state','sessions'),{recursive:true})
  for(const suffix of ['stream.jsonl','stderr.log']) await writeFile(path.join(config.root,'state','sessions','T1.'+suffix),'x'.repeat(retention.maxArtifactBytes+1))
  const out=await outcome({...config,streamResult,fixCommit:true,enforcementCodes:[3,0],seedBeforeResume:true},t)
  assert.equal(out.results[0]?.status,'done')
  for(const stage of ['spawn','resume']) assert.deepEqual(JSON.parse(await readFile(path.join(config.root,'fresh-inputs-'+stage+'.json'),'utf8')),{result:true,stream:true,stderr:true})
 })
}

test('late mandatory verification cannot record completion after the required deadline',async t=>{
  const config=await setup(t);config.execution.deadlineAt=Date.now()+1600
  const out=await boundedOutcome({...config,slowEnforcement:true},t)
  assert.deepEqual(out.orphaned,['T1']);assert.deepEqual(out.results,[])
  const events=await readExecutionEvents(config.execution.common,'r')
  assert.ok(events.some(e=>e.step==='verification'&&e.kind==='step-started'))
  assert.ok(!events.some(e=>e.step==='verification'&&e.kind==='step-completed'))
  const tips=await retainedTips(config);assert.equal(git(config.root,'rev-parse','refs/heads/fleetmates/r/T1'),tips[0])
})

for(const hangStage of ['setup','spawn','session','flush','parser','collection','verification','usage']) {
 test('required '+hangStage+' wait is bounded and releases the driver lock',async t=>{
  const config=await setup(t);config.execution.deadlineAt=Date.now()+1600
  const out=await boundedOutcome({...config,hangStage},t)
  assert.deepEqual(out.orphaned,['T1']);assert.deepEqual(out.results,[])
  const files=await names(config)
  if(['setup','spawn','session','flush','parser','usage','collection'].includes(hangStage)) assert.ok(!files.some(n=>n.startsWith('verified-')))
 })
}

test('collection delayed beyond the deadline cannot invoke Git or verification',async t=>{
  const config=await setup(t);config.execution.deadlineAt=Date.now()+1600
  const out=await boundedOutcome({...config,lateCollection:true},t)
  assert.deepEqual(out.orphaned,['T1']);assert.ok(!(await names(config)).includes('collected'))
  assert.throws(()=>git(config.root,'rev-parse','refs/heads/fleetmates/r/T1'))
})

test('pending collection for an earlier result cannot close as the retained fix collection',async t=>{
  const config=await setup(t);config.execution.maxAttempts=4
  await pause({...config,fixCommit:true,enforcementCodes:[3,0],barrierOccurrence:2},t,'result-retained')
  const {appendExecutionEvent}=await import('../scripts/execution-journal.mjs')
  const events=await readExecutionEvents(config.execution.common,'r')
  const old=events.find(e=>e.step==='collection'&&e.kind==='step-started')
  await appendExecutionEvent(config.execution.common,{...old,id:'earlier-pending',attempt:'earlier-pending',at:Math.max(...events.map(e=>e.at))+1})
  const out=await outcome(config,t);assert.equal(out.results[0]?.status,'done')
  const after=await readExecutionEvents(config.execution.common,'r')
  assert.ok(!after.some(e=>e.attempt==='earlier-pending'&&e.kind==='step-completed'))
  const ends=after.filter(e=>e.step==='collection'&&e.kind==='step-completed')
  for(const end of ends) {
    const start=after.find(e=>e.attempt===end.attempt&&e.kind==='step-started')
    const collection=JSON.parse(await readExecutionArtifact({common:config.execution.common,runId:'r',retention,reference:end.artifacts[0]}))
    assert.deepEqual(start.artifacts[0],collection.result)
  }
})

async function retainedFix(t) {
  const config=await setup(t);config.execution.maxAttempts=5
  await pause(config,t,'collection-applied')
  await rm(path.join(config.root,'barrier'))
  await pause({...config,fixCommit:true,distinctFixEvidence:true,enforcementCodes:[3,0],barrierOccurrence:2},t,'collection-applied')
  const tips=await retainedTips(config)
  assert.equal(tips.length,2);assert.notEqual(tips[0],tips[1])
  git(config.root,'merge-base','--is-ancestor',tips[0],tips[1])
  assert.equal(git(config.root,'rev-parse','refs/heads/fleetmates/r/T1'),tips[1])
  assert.equal(git(config.root,'--git-dir='+path.join(config.root,'clone-git'),'rev-parse','refs/heads/fleetmates/r/T1'),tips[1])
  assert.equal((await names(config)).filter(n=>n.startsWith('spawn-count-')).length,2)
  return config
}

async function deleteRetainedArtifact(config,reference) {
  const hash=value=>createHash('sha256').update(value).digest('hex')
  await rm(path.join(config.execution.common,'fleetmates-artifacts',hash('r'),hash(JSON.stringify(reference))+'.bin'))
  await assert.rejects(readExecutionArtifact({common:config.execution.common,runId:'r',reference,retention}),/ENOENT/)
}

async function reconciledArtifacts(config) {
  return reconcileExecutionAttempt({common:config.execution.common,runId:'r',inputs:config.execution.inputs,retention,
    branches:{'refs/heads/run/r':config.execution.inputs.commit,'refs/heads/fleetmates/r/T1':git(config.root,'rev-parse','refs/heads/fleetmates/r/T1')},
    checkouts:{T1:path.join(config.root,'clone')}})
}

async function assertPreservedFix(config,t,missing) {
  const before=await names(config),tips=await retainedTips(config)
  const verifications=before.filter(n=>n.startsWith('verified-')).length
  const out=await outcome(config,t)
  assert.equal((await names(config)).filter(n=>n.startsWith('spawn-count-')).length,2)
  assert.equal(git(config.root,'rev-parse','refs/heads/fleetmates/r/T1'),tips[1])
  assert.equal(git(config.root,'--git-dir='+path.join(config.root,'clone-git'),'rev-parse','refs/heads/fleetmates/r/T1'),tips[1])
  git(config.root,'merge-base','--is-ancestor',tips[0],tips[1])
  if(missing) {
    assert.deepEqual(out.orphaned,['T1']);assert.deepEqual(out.results,[])
    assert.equal((await names(config)).filter(n=>n.startsWith('verified-')).length,verifications)
  } else {
    assert.deepEqual(out.orphaned,[]);assert.equal(out.results[0]?.status,'done');assert.equal(out.results[0].summary,'fixture fix')
    assert.equal(out.results[0].verifiedComplete,false)
    assert.equal((await names(config)).filter(n=>n.startsWith('verified-')).length,verifications+1)
    const event=(await readExecutionEvents(config.execution.common,'r')).filter(e=>e.step==='verification'&&e.kind==='step-completed').at(-1)
    const receipt=JSON.parse(await readExecutionArtifact({common:config.execution.common,runId:'r',reference:event.artifacts[0],retention}))
    assert.equal(receipt.tip,tips[1]);assert.equal(receipt.code,0);assert.equal(receipt.scope,'enforcement-only');assert.equal(receipt.verifiedComplete,false)
  }
}

test('artifact reconciliation with intact fix evidence preserves commits and runs fresh enforcement',async t=>{
  const config=await retainedFix(t),report=await reconciledArtifacts(config)
  assert.ok(report.attempts.some(a=>a.state==='branch-changed'))
  assert.ok(report.attempts.every(a=>a.missingArtifacts.length===0))
  await assertPreservedFix(config,t,false)
})

for(const kind of ['worker-setup','harness-result','worker-continuation','driver-collection']) {
  test('artifact reconciliation refuses missing '+kind+' independently of moved fix refs',async t=>{
    const config=await retainedFix(t),events=await readExecutionEvents(config.execution.common,'r')
    const harnesses=events.filter(e=>e.step==='harness'&&e.kind==='step-completed')
    const source=kind==='driver-collection'?events.find(e=>e.step==='collection'&&e.kind==='step-completed')
      :kind==='worker-setup'?events.filter(e=>e.step==='harness'&&e.kind==='step-started').at(-1):harnesses.at(-1)
    const reference=source.artifacts.find(a=>a.kind===kind);assert.ok(reference)
    if(['harness-result','worker-continuation'].includes(kind)) assert.notEqual(reference.sha256,harnesses[0].artifacts.find(a=>a.kind===kind).sha256)
    const originalSetup=events.find(e=>e.step==='harness'&&e.kind==='step-started').artifacts.find(a=>a.kind==='worker-setup')
    assert.notEqual(reference.sha256,originalSetup.sha256)
    await deleteRetainedArtifact(config,reference)
    assert.equal(JSON.parse(await readExecutionArtifact({common:config.execution.common,runId:'r',reference:originalSetup,retention})).setup.status,'pass')
    const attempt=(await reconciledArtifacts(config)).attempts.find(a=>a.attempt===source.attempt)
    assert.equal(attempt.state,'branch-changed');assert.ok(attempt.missingArtifacts.some(a=>a.sha256===reference.sha256&&a.kind===kind))
    await assertPreservedFix(config,t,true)
  })
}

for(const kind of ['worker-setup','harness-result','worker-continuation']) {
  test('artifact reconciliation without a fix ref move still refuses missing '+kind,async t=>{
    const config=await setup(t);await pause(config,t,'collection-applied')
    const events=await readExecutionEvents(config.execution.common,'r')
    const source=events.find(e=>e.step==='harness'&&e.kind===(kind==='worker-setup'?'step-started':'step-completed'))
    const reference=source.artifacts.find(a=>a.kind===kind)
    await deleteRetainedArtifact(config,reference)
    const attempt=(await reconciledArtifacts(config)).attempts.find(a=>a.attempt===source.attempt)
    assert.equal(attempt.state,'missing-artifact')
    const tip=git(config.root,'rev-parse','refs/heads/fleetmates/r/T1')
    await assertRefusal(config,t,/unavailable/)
    assert.equal(git(config.root,'rev-parse','refs/heads/fleetmates/r/T1'),tip)
    assert.ok(!(await names(config)).some(n=>n.startsWith('verified-')))
  })
}

// ---- fix-round dispatch and parallel strict execution ----

const spawnCount = async config => (await names(config)).filter(n => n.startsWith('spawn-count-')).length
async function session(config, id = 'T1') { return JSON.parse(await readFile(path.join(config.root, 'state', 'sessions', id + '.json'), 'utf8')) }

test('two tasks at maxParallel 2 under one execution contract both complete without a busy storage error', async t => {
  const config = await setup(t)
  const out = await outcome({ ...config, tasks: ['T1', 'T2'], maxParallel: 2 }, t)
  assert.deepEqual(out.orphaned, [], JSON.stringify(await Promise.all(['T1', 'T2'].map(id => session(config, id).then(s => s.exitReason, () => null)))))
  assert.deepEqual(out.results.map(r => [r.taskId, r.status]), [['T1', 'done'], ['T2', 'done']])
  const events = await readExecutionEvents(config.execution.common, 'r')
  for (const id of ['T1', 'T2']) {
    assert.ok(events.some(e => e.task === id && e.step === 'verification' && e.kind === 'step-completed'), id)
    assert.notEqual(git(config.root, 'rev-parse', 'refs/heads/fleetmates/r/' + id), config.execution.inputs.commit)
  }
  assert.equal(await spawnCount(config), 2)
})

test('a legacy fix round resumes a task whose done result is recorded, builds on its tip and journals the attempt', async t => {
  const config = await setup(t)
  const first = await outcome({ ...config, legacy: true }, t)
  assert.equal(first.results[0]?.status, 'done')
  const prior = git(config.root, 'rev-parse', 'refs/heads/fleetmates/r/T1')
  const again = await outcome({ ...config, legacy: true }, t)
  assert.equal(again.results[0]?.status, 'done')
  assert.equal(await spawnCount(config), 1, 'without a fix round a recorded done result is final')
  const fixed = await outcome({ ...config, legacy: true, fixRound: true, fixCommit: true }, t)
  assert.equal(fixed.results[0]?.status, 'done')
  assert.equal(await spawnCount(config), 2, 'the fix round respawned the task')
  assert.ok((await names(config)).includes('fresh-inputs-resume.json'), 'the recorded session was resumed in its own sandbox')
  const tip = git(config.root, 'rev-parse', 'refs/heads/fleetmates/r/T1')
  assert.notEqual(tip, prior)
  git(config.root, 'merge-base', '--is-ancestor', prior, tip)
  const record = await session(config)
  assert.equal(record.fixRounds?.length, 1)
  assert.deepEqual([record.fixRounds[0].priorTip, record.fixRounds[0].tip, record.fixRounds[0].outcome], [prior, tip, 'done'])
  assert.match(record.fixRounds[0].attempt ?? '', /^[0-9a-f-]{36}$/)
})

test('a legacy fix round whose sandbox is gone is cut from the task branch, never from the run branch', async t => {
  const config = await setup(t)
  await outcome({ ...config, legacy: true }, t)
  const prior = git(config.root, 'rev-parse', 'refs/heads/fleetmates/r/T1')
  await rm(path.join(config.root, 'clone'), { recursive: true, force: true })
  await rm(path.join(config.root, 'clone-git'), { recursive: true, force: true })
  const fixed = await outcome({ ...config, legacy: true, fixRound: true }, t)
  assert.equal(fixed.results[0]?.status, 'done')
  assert.equal(await readFile(path.join(config.root, 'sandbox-base-T1'), 'utf8'), 'fleetmates/r/T1')
  assert.equal(git(config.root, 'rev-parse', 'refs/heads/fleetmates/r/T1'), prior, 'nothing reset the task branch')
  git(config.root, '--git-dir=' + path.join(config.root, 'clone-git'), 'merge-base', '--is-ancestor', prior, 'HEAD')
})

test('a legacy fix round in a files checkout is briefed and collected on the prior task tip', async t => {
  const config = await setup(t)
  await outcome({ ...config, legacy: true, mode: 'files' }, t)
  const prior = git(config.root, 'rev-parse', 'refs/heads/fleetmates/r/T1')
  assert.notEqual(prior, config.execution.inputs.commit)
  const fixed = await outcome({ ...config, legacy: true, mode: 'files', fixRound: true, fixCommit: true }, t)
  assert.equal(fixed.results[0]?.status, 'done')
  assert.equal(await readFile(path.join(config.root, 'collect-base.txt'), 'utf8'), 'fleetmates/r/T1', 'a files collection commits on the task branch')
  const prompt = await readFile(path.join(config.root, 'prompt-last.txt'), 'utf8')
  assert.ok(prompt.includes(prior), 'the brief names the prior task tip')
  assert.ok(!prompt.includes(config.execution.inputs.commit), 'the brief never names the run branch tip')
})

test('a legacy fix round that moves the task branch off its prior tip is refused and the tip is restored', async t => {
  const config = await setup(t)
  await outcome({ ...config, legacy: true }, t)
  const prior = git(config.root, 'rev-parse', 'refs/heads/fleetmates/r/T1')
  const out = await outcome({ ...config, legacy: true, fixRound: true, resetWork: true, forceCollect: true }, t)
  assert.equal(out.results[0]?.status, 'failed')
  assert.match(out.results[0].blockers.join(' '), /prior task tip/)
  assert.equal(git(config.root, 'rev-parse', 'refs/heads/fleetmates/r/T1'), prior)
  assert.equal((await session(config)).fixRounds.at(-1).outcome, 'reset-refused')
})

test('a strict fix round invokes a new journaled harness attempt over a collected done result and keeps its commits', async t => {
  const config = await setup(t)
  assert.equal((await outcome(config, t)).results[0]?.status, 'done')
  // The fix round's own prompt differs from the collected attempt's; only a reuse would compare them.
  const fixed = await outcome({ ...config, fixRound: true, fixCommit: true, persona: 'fix-round persona' }, t)
  assert.equal(fixed.results[0]?.status, 'done')
  assert.equal(await spawnCount(config), 2)
  const tips = await retainedTips(config)
  assert.equal(tips.length, 2); assert.notEqual(tips[0], tips[1])
  git(config.root, 'merge-base', '--is-ancestor', tips[0], tips[1])
  assert.equal(git(config.root, 'rev-parse', 'refs/heads/fleetmates/r/T1'), tips[1])
  const events = await readExecutionEvents(config.execution.common, 'r')
  const starts = events.filter(e => e.step === 'harness' && e.kind === 'step-started')
  const binding = JSON.parse(await readExecutionArtifact({ common: config.execution.common, runId: 'r', retention,
    reference: starts.at(-1).artifacts.find(a => a.kind === 'driver-invocation') }))
  assert.equal(binding.fixRound, true)
  assert.equal(binding.hostTip, tips[0])
})

// The strict driver's enforcement answer is { code, pendingOnly, pending }, which the CLI builds from
// the verdict `complete` computes. Exit 4 is accepted only with pendingOnly, and the receipt's scope
// names the pending kinds.
async function verificationReceipts(config) {
  const events = (await readExecutionEvents(config.execution.common, 'r')).filter(e => e.step === 'verification' && e.kind !== 'step-started')
  const receipts = []
  for (const event of events) {
    receipts.push({ kind: event.kind, receipt: JSON.parse(await readExecutionArtifact({ common: config.execution.common, runId: 'r', reference: event.artifacts[0], retention })) })
  }
  return receipts
}

test('strict enforcement exit 4 with only a pending agent check is accepted and its receipt names the pending kind', async t => {
  const config = await setup(t)
  const out = await outcome({ ...config, enforcementAnswers: [{ code: 4, pendingOnly: true, pending: ['agent'] }] }, t)
  assert.deepEqual(out.orphaned, []); assert.equal(out.results[0]?.status, 'done')
  assert.equal(out.results[0].verifiedComplete, false)
  const receipts = await verificationReceipts(config)
  assert.deepEqual(receipts.map(r => [r.kind, r.receipt.code, r.receipt.scope, r.receipt.pendingOnly]),
    [['step-completed', 4, 'enforcement-only-pending-agent', true]])
})

for (const answer of [{ code: 4, pendingOnly: false, pending: ['agent'] }, { code: 4 }, 4, { code: 2, pendingOnly: true, pending: ['agent'] },
  { code: 4, pendingOnly: 'yes', pending: ['agent'] }, { code: 4, pendingOnly: true, pending: [] }, { code: 4, pendingOnly: true, pending: ['merge'] },
  { code: 4, pendingOnly: true, pending: ['agent', 'merge'] }]) {
  test('strict enforcement answer ' + JSON.stringify(answer) + ' is refused and the task orphaned', async t => {
    const config = await setup(t)
    const out = await outcome({ ...config, enforcementAnswers: [answer] }, t)
    assert.deepEqual(out.orphaned, ['T1']); assert.deepEqual(out.results, [])
    assert.deepEqual((await verificationReceipts(config)).map(r => r.kind), ['step-failed'])
    assert.match((await session(config)).exitReason, /mandatory enforcement/)
  })
}

test('a task-scoped enforcement rejection twice orphans the task and its latest verification event is step-failed', async t => {
  const config = await setup(t); config.execution.maxAttempts = 3
  const rejected = { code: 3, pendingOnly: false, pending: [] }
  const out = await outcome({ ...config, enforcementAnswers: [rejected, rejected] }, t)
  assert.deepEqual(out.orphaned, ['T1']); assert.deepEqual(out.results, [])
  assert.deepEqual((await verificationReceipts(config)).map(r => [r.kind, r.receipt.code]), [['step-failed', 3], ['step-failed', 3]])
})

test('the legacy driver reads the code out of a structured answer and still treats only 3 as a rejection', async t => {
  const config = await setup(t)
  const pending = await outcome({ ...config, legacy: true, enforcementAnswers: [{ code: 4, pendingOnly: false, pending: ['agent'] }] }, t)
  assert.equal(pending.results[0]?.status, 'done')
  const second = await setup(t)
  const rejected = { code: 3, pendingOnly: false, pending: [] }
  const out = await outcome({ ...second, legacy: true, enforcementAnswers: [rejected, rejected] }, t)
  assert.equal(out.results[0]?.status, 'failed')
  assert.match(out.results[0].blockers.join(' '), /rejected the task twice/)
})
