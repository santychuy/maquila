export const OBSERVER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Maquila Observer</title>
  <link rel="stylesheet" href="/styles.css">
  <script type="module" src="/app.js"></script>
</head>
<body>
  <a class="skip" href="#content">Skip to runs</a>
  <header class="topbar">
    <div>
      <p class="product">Maquila</p>
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
        <h2 id="detail-heading">Run detail <span id="pull-request-link"></span></h2>
        <p id="detail-id" class="mono"></p>
      </div>
      <div id="summary"></div>
      <h3 id="timeline-heading">Phase sequence</h3>
      <p id="timeline-note" class="timeline-note">Select a phase to view details.</p>
      <ol id="timeline" class="phase-timeline" aria-labelledby="timeline-heading" aria-describedby="timeline-note"><li class="empty">Loading phase telemetry…</li></ol>
    </section>
    <div id="error" class="error hidden" role="alert"></div>
  </main>
  <noscript><p class="error">JavaScript is required to poll local telemetry.</p></noscript>
</body>
</html>
`;

export const OBSERVER_CSS = `:root{color-scheme:light dark;--bg:#f4f5f6;--surface:#fff;--surface-2:#eceff1;--text:#172027;--muted:#58666f;--line:#cbd2d7;--accent:#126b55;--accent-soft:#dceee8;--danger:#a32929;--focus:#0875d1;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-size:15px;line-height:1.5}.skip{position:absolute;left:12px;top:-60px;background:var(--text);color:var(--surface);padding:8px 12px;z-index:2}.skip:focus{top:12px}.topbar{min-height:72px;padding:14px clamp(16px,4vw,48px);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:24px;background:var(--surface)}h1,h2,h3,p{margin:0}h1{font-size:20px;line-height:1.25}h2{font-size:22px}h3{font-size:16px;margin:28px 0 12px}.product{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase}.connection{border:1px solid var(--line);padding:5px 10px;border-radius:4px;color:var(--muted);font-size:13px}.connection.live{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}main{max-width:1240px;margin:0 auto;padding:28px clamp(16px,4vw,48px) 56px}.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-bottom:16px}.section-head p{color:var(--muted)}.runs{border-top:1px solid var(--line)}.run{display:grid;grid-template-columns:minmax(210px,1.4fr) minmax(130px,.8fr) minmax(150px,1fr) minmax(120px,.7fr);gap:20px;align-items:center;padding:16px 4px;border-bottom:1px solid var(--line);color:inherit;text-decoration:none}.run:hover{background:var(--surface-2)}.run:focus-visible,a:focus-visible,.segment:focus-visible{outline:3px solid var(--focus);outline-offset:3px}.run-id,.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums}.run-id{font-size:13px;overflow-wrap:anywhere}.label{display:block;color:var(--muted);font-size:12px;margin-bottom:2px}.status{font-weight:700}.status.ready_for_publication{color:var(--accent)}.status.failed,.error{color:var(--danger)}.empty{padding:32px 4px;color:var(--muted)}nav{display:flex;gap:8px;margin-bottom:20px;color:var(--muted)}nav a{color:var(--accent)}.summary-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border:1px solid var(--line);background:var(--surface)}.metric{padding:14px;border-right:1px solid var(--line)}.metric:last-child{border-right:0}.metric strong{display:block;overflow-wrap:anywhere}.timeline-note{color:var(--muted);font-size:13px}.phase-timeline{list-style:none;padding:8px 0 16px 38px;margin:0;position:relative}.phase-timeline:before{content:"";position:absolute;left:10px;top:18px;bottom:34px;border-left:1px solid var(--line)}.phase-item{position:relative;margin:0}.phase-node{position:absolute;left:-38px;top:14px;width:21px;height:21px;border:1px solid var(--line);border-radius:50%;background:var(--bg);color:var(--muted);display:grid;place-items:center;z-index:1}.phase-node svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.phase-node.agent{border-color:var(--accent);color:var(--accent)}.phase-node.engineer{border-color:var(--focus);color:var(--focus)}.phase-node.failed,.phase-node.timed_out,.phase-node.interrupted_at_run_end{border-color:var(--danger);color:var(--danger)}.segment{position:relative;display:block;width:100%;min-height:72px;padding:13px 36px 13px 4px;border:0;border-bottom:1px solid var(--line);background:transparent;color:inherit;text-align:left;overflow-wrap:anywhere}.segment[aria-expanded=true]{color:var(--text)}.segment[aria-current=step] strong{color:var(--accent)}.phase-title{display:flex;align-items:baseline;justify-content:space-between;gap:16px}.phase-title time{flex:none;color:var(--muted);font-size:12px;font-weight:400}.phase-chevron{position:absolute;right:8px;top:18px;width:16px;height:16px;fill:none;stroke:var(--muted);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;transition:transform 160ms ease}.segment[aria-expanded=true] .phase-chevron{transform:rotate(180deg)}.segment small{display:block;color:var(--muted)}.segment-detail{margin:0;border:0;border-bottom:1px solid var(--line);background:transparent;padding:16px 4px 20px}.segment-detail h3{margin-top:0}.detail-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.detail-list div{overflow-wrap:anywhere}.context-usage{margin-top:16px}.context-usage-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}.context-usage-head .label{margin:0}.context-usage-head span:last-child{color:var(--muted)}.context-usage progress{display:block;width:100%;height:10px;margin-top:7px;accent-color:var(--accent)}.tools{margin:12px 0 0;padding-left:22px}.github-link{display:inline-flex;vertical-align:middle;margin-left:6px;color:inherit}.segment-detail details{margin-top:14px}.segment-detail pre{white-space:pre-wrap;overflow-wrap:anywhere}.segment-detail dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px}.segment-detail dd{margin:0;overflow-wrap:anywhere}.raw-events{margin-top:24px}.raw-events summary{cursor:pointer;font-weight:700}.timeline{list-style:none;padding:0;margin:12px 0 0;border-top:1px solid var(--line)}.event{display:grid;grid-template-columns:64px minmax(150px,.6fr) minmax(160px,1fr) minmax(160px,1.5fr);gap:16px;padding:12px 4px;border-bottom:1px solid var(--line);align-items:baseline}.seq{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums}.event-type{font-weight:650}.event-detail{color:var(--muted);overflow-wrap:anywhere}.hidden{display:none!important}.error{border:1px solid currentColor;padding:12px;margin-top:18px;background:var(--surface)}@media(max-width:760px){.detail-list{grid-template-columns:1fr 1fr}.topbar{align-items:flex-start}.section-head{display:block}.section-head p{margin-top:4px}.run{grid-template-columns:1fr 1fr;gap:12px}.summary-grid{grid-template-columns:1fr 1fr}.metric{border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.metric:nth-child(2n){border-right:0}.metric:last-child{border-bottom:0}.event{grid-template-columns:48px 1fr}.event-actor,.event-detail{grid-column:2;overflow-wrap:anywhere;min-width:0}}@media(max-width:430px){.detail-list,.run,.summary-grid,.segment-detail dl{grid-template-columns:1fr}.metric{border-right:0;border-bottom:1px solid var(--line)}.metric:last-child{border-bottom:0}}@media(prefers-color-scheme:dark){:root{--bg:#101417;--surface:#171d21;--surface-2:#20282d;--text:#e7edf0;--muted:#a5b1b8;--line:#39434a;--accent:#77cbb3;--accent-soft:#173a31;--danger:#ff9898;--focus:#70b7f0}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}.phase-activity{display:grid;gap:.5rem;padding:0;list-style:none}.phase-activity>li{display:grid;grid-template-columns:auto minmax(8rem,auto) 1fr auto;gap:.75rem;align-items:start;padding:.6rem;border-top:1px solid var(--line)}.phase-activity time{font-variant-numeric:tabular-nums;color:var(--muted)}.phase-activity details{grid-column:2/-1}.phase-activity pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:24rem;overflow:auto}@media(max-width:700px){.phase-activity>li{grid-template-columns:1fr}.phase-activity details{grid-column:1}}
`;

export { OBSERVER_JS } from "./bundle.generated.js";
