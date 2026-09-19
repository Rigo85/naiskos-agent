// Real shell activator, crypto verification, flock and recovery runtime.
// Only graphical hardware, HTTP peers and systemctl are simulated.
import assert from 'node:assert/strict';
import {access,copyFile,cp,mkdir,readFile,writeFile,rm,symlink,realpath,readdir} from 'node:fs/promises';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {execFile as execCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
const exec=promisify(execCallback);
await access('/.dockerenv');assert.equal(process.getuid(),0,'Container root only');
const source='/workspace-agent';
const updates='/var/lib/naiskos/updates';
const previous='20260918-previous';
const campaign='11111111-1111-4111-8111-111111111111';
const frame='22222222-2222-4222-8222-222222222222';
const expiry='2099-01-01T00:00:00.000Z';
const hash=data=>createHash('sha256').update(data).digest('hex');
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
await writeFile('/tmp/mock-central.mjs',`const original=globalThis.fetch;globalThis.fetch=(url,options)=>original(String(url).replace('https://central.test','http://127.0.0.1:8080'),options);`);
await exec('groupadd',['--system','naiskos']);
await exec('useradd',['--system','--gid','naiskos','naiskos']);
await mkdir('/opt/node24/bin',{recursive:true});await symlink(process.execPath,'/opt/node24/bin/node');
const originalActivator=await readFile(`${source}/deploy/naiskos-release-activate`,'utf8');
// Speed up probes in simulation only; deployed source retains its real deadlines.
const runtime=(await readFile(`${source}/deploy/naiskos-release-runtime.mjs`,'utf8'))
  .replaceAll('await sleep(5_000)','await sleep(5)').replace('performance.now() + 120_000','performance.now() + 1000');
let release,caseName,reports=[];
const server=createServer(async(req,res)=>{
  try {
    let body='';for await(const chunk of req)body+=chunk;
    res.setHeader('content-type','application/json');
    if(req.url.endsWith('/software')) {
      if(reports.some(r=>r.status==='activating')){res.statusCode=409;return res.end(JSON.stringify({code:'software_operation_in_progress'}));}
      return res.end(JSON.stringify({campaignId:campaign,releaseId:release,expiresAt:expiry}));
    }
    if(req.url==='/api/v1/system/release-events') {
      const event=JSON.parse(body);reports.push(event);
      if(event.status==='activating') {
        // Real unprivileged agent contends with the real root shell lock.
        const probe=caseName==='legacy-bootstrap' ? `import assert from 'node:assert/strict';
          import {readFile,rm} from 'node:fs/promises';
          const response=await fetch('http://127.0.0.1:8080/software');
          // Exact destructive branch of the legacy agent; 409 must not reach it.
          if(response.status===204)await rm('${updates}/${release}',{recursive:true,force:true});
          assert.equal(response.status,409);await readFile('${updates}/${release}/release.json');`
          : `import assert from 'node:assert/strict';
          import {SoftwareUpdateManager} from '/workspace-agent/dist/software-update.js';
          globalThis.fetch=()=>{throw Error('A lock loser must not query or clean anything');};
          const manager=new SoftwareUpdateManager({dataRoot:'/var/lib/naiskos',frameId:'${frame}',centralUrl:'https://central.test',token:'test'},async()=> 'event');
          assert.equal(await manager.check(),'none');`;
        await exec('runuser',['-u','naiskos','--',process.execPath,'--input-type=module','-e',probe]);
      }
      res.statusCode=202;return res.end(JSON.stringify({accepted:true}));
    }
    if(req.url==='/api/v1/viewer/runtime') {
      const current=(await realpath('/opt/naiskos/current')).split('/').at(-1);
      const running=(await readFile('/tmp/kiosk-state','utf8'))==='running';
      return res.end(JSON.stringify({schemaVersion:1,ready:running,agentBuildId:current,
        viewer:{connected:running,playback:{buildId:current,uiReady:running}}}));
    }
    res.statusCode=404;res.end('{}');
  } catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}
});
await new Promise(resolve=>server.listen(8080,'127.0.0.1',resolve));
const kioskStub=`import {readFile,writeFile,appendFile,rm} from 'node:fs/promises';
export async function status(){const running=(await readFile('/tmp/kiosk-state','utf8'))==='running';return {browserLive:running,launcherPresent:running};}
export async function main(command){
 if(command==='stop'){
  await appendFile('/tmp/kiosk-stops','stop\\n');
  await writeFile('/tmp/kiosk-state','stopped');
  if(process.env.DELETE_DOWNLOAD==='1')await rm(process.env.DOWNLOAD,{recursive:true,force:true});
  if(process.env.FAIL_STOP==='1' && !await readFile('/tmp/stop-failed').catch(()=>null)){
   await writeFile('/tmp/stop-failed','yes');throw Error('injected stop failure');
  }
 }else if(command==='start')await writeFile('/tmp/kiosk-state','running');
}
if(process.argv[1]?.endsWith('naiskos-kiosk-control.mjs'))main(process.argv[2]).catch(e=>{console.error(e.message);process.exitCode=1});
`;
const cases=[
  ['normal',null],
  ['download-removed-after-stop',null],
  ['missing-manifest','cp -- "$manifest" "$staging/release.json"'],
  ['list-migrations','if ! migrations=$($helper migrations "$staging/release.json"); then'],
  ['killed-during-preparation','mkdir -p -- "$staging"'],
  ['stop-failure',null],
  ['after-stop','for migration in $migrations; do'],
  ['switch-failure','mv -Tf /opt/naiskos/current.next /opt/naiskos/current'],
  ['restart-failure',null],
  ['signal-after-stop','for migration in $migrations; do'],
  ['killed-after-switch','rm -f -- "$request"'],
  ['after-migration','migration_status=${migration_result%%|*}'],
  ['killed-after-migration','migration_status=${migration_result%%|*}'],
  ['already-current','migration_status=${migration_result%%|*}'],
  ['legacy-bootstrap',null],
];
try {
for(const [name,injection] of cases) {
  caseName=name;release=`20260918-${name}`;reports=[];
  for(const target of ['/etc/naiskos','/opt/naiskos','/var/lib/naiskos','/tmp/activation-content'])await rm(target,{recursive:true,force:true});
  for(const target of ['/tmp/stop-failed','/tmp/restart-failed','/tmp/kiosk-stops'])await rm(target,{force:true});
  for(const directory of ['/etc/naiskos','/opt/naiskos/bin',`/opt/naiskos/releases/${previous}`,`${updates}/${release}`,
    '/tmp/activation-content/naiskos-agent/dist','/tmp/activation-content/browser'])await mkdir(directory,{recursive:true});
  await symlink(`/opt/naiskos/releases/${previous}`,'/opt/naiskos/current');
  await writeFile('/tmp/kiosk-state','running');
  await writeFile('/etc/naiskos/baseline.json',JSON.stringify({baselineVersion:name==='already-current'?'16':'15',hardwareProfile:'rpi4-2gb-sunfounder-ts10'}));
  await writeFile('/etc/naiskos/release-signing-public.pem',publicKey.export({type:'spki',format:'pem'}));
  await writeFile('/var/lib/naiskos/device-credentials.json',JSON.stringify({frameId:frame,agentToken:'a'.repeat(43)}));
  for(const file of ['naiskos-release-helper.mjs','naiskos-runtime-policy.mjs'])await copyFile(`${source}/deploy/${file}`,`/opt/naiskos/bin/${file}`);
  await writeFile('/opt/naiskos/bin/naiskos-release-runtime.mjs',runtime);
  await writeFile('/opt/naiskos/bin/naiskos-kiosk-control.mjs',kioskStub);
  await exec('chmod',['0755','/opt/naiskos/bin/naiskos-release-helper.mjs']);
  await writeFile('/usr/bin/systemctl',`#!/bin/sh
if [ "$FAIL_RESTART" = 1 ] && [ ! -e /tmp/restart-failed ]; then touch /tmp/restart-failed; exit 1; fi
exit 0
`,{mode:0o755});
  const files=[];
  for(const file of ['naiskos-agent/dist/main.js','browser/index.html']) {
    const data=Buffer.from('test content');await writeFile(`/tmp/activation-content/${file}`,data);
    files.push({path:file,sizeBytes:data.length,sha256:hash(data)});
  }
  const migrations=[];
  if(['after-migration','killed-after-migration','already-current'].includes(name)) {
    const migrationId='baseline-016-test';migrations.push(migrationId);
    const prefix=`migrations/${migrationId}`;
    await mkdir(`/tmp/activation-content/${prefix}/payload`,{recursive:true});
    await writeFile('/etc/naiskos/test-updater.conf',name==='already-current'?'after':'before');
    const descriptor={schemaVersion:2,migrationId,description:'Test',fromVersion:'15',toVersion:'16',
      architectures:[process.arch],hardwareProfiles:['rpi4-2gb-sunfounder-ts10'],minimumFreeBytes:0,
      reversible:true,rebootRequired:false,daemonReload:false,units:[],files:[{operation:'install',
        source:'payload/value',destination:'/etc/naiskos/test-updater.conf',sha256:hash('after'),mode:'0644',owner:'root',group:'root'}]};
    for(const [file,data] of [[`${prefix}/migration.json`,JSON.stringify(descriptor)],[`${prefix}/payload/value`,'after']]) {
      await writeFile(`/tmp/activation-content/${file}`,data);files.push({path:file,sizeBytes:Buffer.byteLength(data),sha256:hash(data)});
    }
  }
  if(name==='legacy-bootstrap') {
    const id='baseline-016-release-coordination';migrations.push(id);
    const target=`/tmp/activation-content/migrations/${id}`;
    await cp(`/workspace-provision/migrations/${id}`,target,{recursive:true});
    const descriptor=JSON.parse(await readFile(`${target}/migration.json`));
    descriptor.architectures=[process.arch];
    await writeFile(`${target}/migration.json`,JSON.stringify(descriptor));
    for(const relative of ['migration.json',...(await readdir(`${target}/payload`)).map(f=>`payload/${f}`)]) {
      const data=await readFile(`${target}/${relative}`);
      files.push({path:`migrations/${id}/${relative}`,sizeBytes:data.length,sha256:hash(data)});
    }
  }
  const archive=`${updates}/${release}/release.tar.gz`;
  await exec('tar',['-C','/tmp/activation-content','-czf',archive,'.']);
  const bytes=await readFile(archive);
  const manifest=Buffer.from(JSON.stringify({schemaVersion:1,releaseId:release,
    compatibility:{nodeMajor:24,architectures:['arm64'],minimumBaselineVersion:'15'},
    archive:{filename:'release.tar.gz',sizeBytes:bytes.length,sha256:hash(bytes)},files,migrations}));
  const manifestFile=`${updates}/${release}/release.json`;
  const signatureFile=`${updates}/${release}/release.json.sig`;
  await writeFile(manifestFile,manifest);await writeFile(signatureFile,sign(null,manifest,privateKey));
  await writeFile(`${updates}/activation-request.json`,JSON.stringify({campaignId:campaign,releaseId:release,
    manifestFile,signatureFile,archiveFile:archive,observeMinutes:60,expiresAt:expiry,maintenanceWindow:{from:'00:00',until:'06:00'}}));
  let activator=originalActivator.replace('sleep 5','true');
  if(name==='legacy-bootstrap') activator=(await readFile('/workspace-provision/migrations/baseline-013-functional-runtime/payload/naiskos-release-activate','utf8')).replace('sleep 5','true');
  if(injection) {
    assert.ok(activator.includes(injection));
    const replacement=name==='missing-manifest'?'false':name==='list-migrations'?'if ! migrations=$(false); then':
      name==='switch-failure'?'false':name==='signal-after-stop'?'kill -TERM $$\n'+injection:
      name.startsWith('killed-')?'kill -KILL $$\n'+injection:'exit 1\n'+injection;
    activator=activator.replace(injection,()=>replacement);
  }
  await writeFile('/opt/naiskos/bin/naiskos-release-activate',activator,{mode:0o755});
  await exec('chown',['-R','naiskos:naiskos','/var/lib/naiskos']);
  const env={...process.env,NODE_OPTIONS:'--import=/tmp/mock-central.mjs',NAISKOS_CENTRAL_URL:'https://central.test',NAISKOS_FRAME_ID:'',NAISKOS_AGENT_TOKEN:'',
    DELETE_DOWNLOAD:name==='download-removed-after-stop'?'1':'0',DOWNLOAD:`${updates}/${release}`,
    FAIL_STOP:name==='stop-failure'?'1':'0',FAIL_RESTART:name==='restart-failure'?'1':'0'};
  let code=0;
  let output='';
  try { const result=await exec('/opt/naiskos/bin/naiskos-release-activate',['--force'],{env,timeout:20000});output=result.stdout+result.stderr; }
  catch(e){code=e.code ?? e.signal;output=e.stdout+e.stderr;}
  console.log(name,code,output);
  if(name.startsWith('killed-')) {
    assert.notEqual(code,0);
    assert.equal(JSON.parse(await readFile(`${updates}/observation.json`)).phase,
      name==='killed-during-preparation'?'preparing':'activating');
    // Re-entry after process death/power loss owns recovery, not a duplicate install.
    await exec('/opt/naiskos/bin/naiskos-release-activate',['--force'],{env,timeout:20000});
  }
  const successful=['normal','download-removed-after-stop','legacy-bootstrap'].includes(name);
  assert.equal(code===0,successful,`${name}: exit ${code}`);
  assert.equal(await realpath('/opt/naiskos/current'),`/opt/naiskos/releases/${successful?release:previous}`,name);
  assert.equal(await readFile('/tmp/kiosk-state','utf8'),'running',name);
  if(['missing-manifest','list-migrations','killed-during-preparation'].includes(name))
    await assert.rejects(access('/tmp/kiosk-stops'));
  if(migrations.length && name!=='legacy-bootstrap') {
    assert.equal(JSON.parse(await readFile('/etc/naiskos/baseline.json')).baselineVersion,name==='already-current'?'16':'15');
    assert.equal(await readFile('/etc/naiskos/test-updater.conf','utf8'),name==='already-current'?'after':'before');
  }
  if(name==='legacy-bootstrap'){
    assert.equal(JSON.parse(await readFile('/etc/naiskos/baseline.json')).baselineVersion,'16');
    assert.equal(await readFile('/opt/naiskos/bin/naiskos-release-activate','utf8'),originalActivator);
  }
  assert.ok(reports.some(r=>r.status===(successful?'observing':name==='restart-failure'||name==='killed-after-switch'?'rolled_back':'failed')),`${name}: reports ${JSON.stringify(reports)}`);
  if(!successful){
    assert.ok(!reports.some(r=>r.status==='installed'),name);
    await assert.rejects(access(`${updates}/activation-request.json`));
    await assert.rejects(access(`${updates}/observation.json`));
  }
  // Lock is not leaked to the reopened kiosk/runtime.
  await exec('flock',['-n',`${updates}/.software-update.lock`,'true']);
  console.log(`ok: ${name}`);
}
} catch(e){console.error('CASE',caseName,'REPORTS',reports);throw e;}
finally {await new Promise(resolve=>server.close(resolve));}
