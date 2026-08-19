export const OBSERVER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Software Factory Observer</title>
  <link rel="stylesheet" href="/styles.css">
  <script src="/app.js" defer></script>
</head>
<body>
  <a class="skip" href="#content">Skip to runs</a>
  <header class="topbar">
    <div>
      <p class="product">Software Factory</p>
      <h1>Run observer</h1>
    </div>
    <div id="connection" class="connection" role="status" aria-live="polite">Connecting</div>
  </header>
  <main id="content" tabindex="-1" aria-busy="true">
    <section id="run-list" aria-labelledby="runs-heading">
      <div class="section-head">
        <h2 id="runs-heading">Runs</h2>
        <p>Read-only controller telemetry</p>
      </div>
      <div id="runs" class="runs"><p class="empty">Loading runs…</p></div>
    </section>
    <section id="run-detail" class="hidden" aria-labelledby="detail-heading">
      <nav aria-label="Breadcrumb"><a href="/">Runs</a><span aria-hidden="true">/</span><span id="crumb"></span></nav>
      <div class="section-head">
        <h2 id="detail-heading">Run detail</h2>
        <p id="detail-id" class="mono"></p>
      </div>
      <div id="summary"></div>
      <h3>Lifecycle</h3>
      <ol id="timeline" class="timeline"></ol>
    </section>
    <div id="error" class="error hidden" role="alert"></div>
  </main>
  <noscript><p class="error">JavaScript is required to poll local telemetry.</p></noscript>
</body>
</html>
`;

export const OBSERVER_CSS = `:root{color-scheme:light dark;--bg:#f4f5f6;--surface:#fff;--surface-2:#eceff1;--text:#172027;--muted:#58666f;--line:#cbd2d7;--accent:#126b55;--accent-soft:#dceee8;--danger:#a32929;--focus:#0875d1;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-size:15px;line-height:1.5}.skip{position:absolute;left:12px;top:-60px;background:var(--text);color:var(--surface);padding:8px 12px;z-index:2}.skip:focus{top:12px}.topbar{min-height:72px;padding:14px clamp(16px,4vw,48px);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:24px;background:var(--surface)}h1,h2,h3,p{margin:0}h1{font-size:20px;line-height:1.25}h2{font-size:22px}h3{font-size:16px;margin:28px 0 12px}.product{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase}.connection{border:1px solid var(--line);padding:5px 10px;border-radius:4px;color:var(--muted);font-size:13px}.connection.live{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}main{max-width:1240px;margin:0 auto;padding:28px clamp(16px,4vw,48px) 56px}.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-bottom:16px}.section-head p{color:var(--muted)}.runs{border-top:1px solid var(--line)}.run{display:grid;grid-template-columns:minmax(210px,1.4fr) minmax(130px,.8fr) minmax(150px,1fr) minmax(120px,.7fr);gap:20px;align-items:center;padding:16px 4px;border-bottom:1px solid var(--line);color:inherit;text-decoration:none}.run:hover{background:var(--surface-2)}.run:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:3px}.run-id,.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums}.run-id{font-size:13px;overflow-wrap:anywhere}.label{display:block;color:var(--muted);font-size:12px;margin-bottom:2px}.status{font-weight:700}.status.ready_for_publication{color:var(--accent)}.status.failed,.error{color:var(--danger)}.empty{padding:32px 4px;color:var(--muted)}nav{display:flex;gap:8px;margin-bottom:20px;color:var(--muted)}nav a{color:var(--accent)}.summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--line);background:var(--surface)}.metric{padding:14px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.metric:nth-child(3n){border-right:0}.metric:nth-last-child(-n+3){border-bottom:0}.metric strong{display:block;overflow-wrap:anywhere}.timeline{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}.event{display:grid;grid-template-columns:64px minmax(150px,.6fr) minmax(160px,1fr) minmax(160px,1.5fr);gap:16px;padding:12px 4px;border-bottom:1px solid var(--line);align-items:baseline}.seq{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums}.event-type{font-weight:650}.event-detail{color:var(--muted);overflow-wrap:anywhere}.hidden{display:none!important}.error{border:1px solid currentColor;padding:12px;margin-top:18px;background:var(--surface)}@media(max-width:760px){.topbar{align-items:flex-start}.section-head{display:block}.section-head p{margin-top:4px}.run{grid-template-columns:1fr 1fr;gap:12px}.summary-grid{grid-template-columns:1fr 1fr}.metric:nth-child(3n){border-right:1px solid var(--line)}.metric:nth-child(2n){border-right:0}.metric:nth-last-child(-n+3){border-bottom:1px solid var(--line)}.metric:nth-last-child(-n+2){border-bottom:0}.event{grid-template-columns:48px 1fr}.event-actor,.event-detail{grid-column:2;overflow-wrap:anywhere;min-width:0}}@media(max-width:430px){.run,.summary-grid{grid-template-columns:1fr}.metric:nth-child(n){border-right:0;border-bottom:1px solid var(--line)}.metric:last-child{border-bottom:0}}@media(prefers-color-scheme:dark){:root{--bg:#101417;--surface:#171d21;--surface-2:#20282d;--text:#e7edf0;--muted:#a5b1b8;--line:#39434a;--accent:#77cbb3;--accent-soft:#173a31;--danger:#ff9898;--focus:#70b7f0}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
`;

export const OBSERVER_JS = `(() => {
  const $ = id => document.getElementById(id);
  const connection = $('connection');
  const content = $('content');
  const error = $('error');
  let inflight = false;
  let selectedRun = null;
  let eventCursor = 0;
  let eventRows = [];
  let runsSnapshot = '';
  let pendingRuns = null;
  const text = (el, value) => { const next=value==null?'—':String(value); if(el.textContent!==next)el.textContent=next; };
  const time = value => value ? new Date(value).toLocaleString() : 'No activity';
  const duration = value => value==null ? '—' : Math.floor(value/60000)+'m '+Math.floor(value%60000/1000)+'s';
  const setConnection = (label, live) => { text(connection, label); connection.classList.toggle('live', live); };
  const showError = message => { text(error, message); error.classList.remove('hidden'); };
  const clearError = () => error.classList.add('hidden');
  const node = (tag, className, value) => { const el=document.createElement(tag); if(className)el.className=className; if(value!==undefined)text(el,value); return el; };
  const field = (label, value) => { const wrap=node('div','metric'); wrap.append(node('span','label',label),node('strong','',value)); return wrap; };
  async function get(url){ const response=await fetch(url,{headers:{accept:'application/json'}}); if(!response.ok)throw new Error('Observer request failed'); return response.json(); }
  function renderRuns(runs){ const host=$('runs'); host.replaceChildren(); if(!runs.length){host.append(node('p','empty','No runs yet. Start one with the factory skill or run start command.'));return;} for(const run of runs){const link=node('a','run');link.href='/runs/'+encodeURIComponent(run.runId);const id=node('div');id.append(node('span','label','Run'),node('span','run-id',run.runId));const state=node('div');state.append(node('span','label','State'),node('span','status '+run.status,run.status.replaceAll('_',' ')));const phase=node('div');phase.append(node('span','label','Phase'),node('span','',run.phase||'Waiting'));const activity=node('div');activity.append(node('span','label','Last activity'),node('time','',time(run.lastActivity)));link.append(id,state,phase,activity);host.append(link);}}
  function updateRuns(runs){const snapshot=JSON.stringify(runs);if(snapshot===runsSnapshot)return;const host=$('runs');if(host.contains(document.activeElement)){pendingRuns={runs,snapshot};return;}renderRuns(runs);runsSnapshot=snapshot;pendingRuns=null;}
  $('runs').addEventListener('focusout',()=>queueMicrotask(()=>{if(pendingRuns&&!$('runs').contains(document.activeElement)){const next=pendingRuns;renderRuns(next.runs);runsSnapshot=next.snapshot;pendingRuns=null;}}));
  function eventDetail(event){const p=event.payload||{};if(event.type==='tool_started'||event.type==='tool_finished')return p.toolName||'';if(event.type==='gate_finished')return (p.passed?'Passed':'Failed')+' · '+p.commandCount+' commands';if(event.type==='review_finished')return p.verdict+' · '+p.blockerCount+' blockers';if(event.type==='cleanup_updated')return p.cleanup;if(event.type==='failure')return p.message;if(event.type==='artifact_available')return p.name+' · '+p.size+' bytes';if(event.type==='run_finished')return p.status+' · cleanup '+p.cleanup;if(p.status)return p.status;return '';}
  function renderDetail(detail,events){$('run-list').classList.add('hidden');$('run-detail').classList.remove('hidden');text($('crumb'),detail.runId.slice(0,8));text($('detail-id'),detail.runId);const grid=node('div','summary-grid');grid.append(field('Status',detail.status.replaceAll('_',' ')),field('Phase',detail.phase||'Waiting'),field('Runtime',duration(detail.runtimeMilliseconds)),field('Current phase duration',duration(detail.phaseRuntimeMilliseconds)),field('Latest actor or open tool',detail.currentTool||detail.actor||'None'),field('Cleanup',detail.cleanup||'Not started'));$('summary').replaceChildren(grid);const timeline=$('timeline');timeline.replaceChildren();for(const event of events){const item=node('li','event');item.append(node('span','seq','#'+event.seq),node('span','event-type',event.type.replaceAll('_',' ')),node('span','event-actor',event.phase?.name||event.actor),node('span','event-detail',eventDetail(event)));timeline.append(item);}if(!events.length)timeline.append(node('li','empty','No telemetry events recorded yet.'));}
  async function tick(){if(inflight)return;inflight=true;content.setAttribute('aria-busy','true');try{const match=location.pathname.match(/^\\/runs\\/([0-9a-f-]{36})$/);if(match){const id=match[1];if(selectedRun!==id){selectedRun=id;eventCursor=0;eventRows=[];}const detail=await get('/api/v1/runs/'+id);let page;try{page=await get('/api/v1/runs/'+id+'/events?after='+eventCursor+'&limit=500');}catch{page={events:[],cursor:eventCursor,integrity:'invalid'};}if(page.events.length){eventRows=eventRows.concat(page.events);eventCursor=page.cursor;}renderDetail(detail,eventRows);if(page.integrity==='invalid'){showError('Telemetry events unavailable. Run summary remains available.');setConnection('Partial telemetry',false);}else{clearError();setConnection('Live · updates every second',true);}}else{selectedRun=null;const data=await get('/api/v1/runs?limit=100');updateRuns(data.runs);clearError();setConnection('Live · updates every second',true);}}catch{showError('Observer unavailable. Retrying…');setConnection('Reconnecting',false);}finally{content.setAttribute('aria-busy','false');inflight=false;}}
  void tick(); setInterval(()=>void tick(),1000);
})();
`;
