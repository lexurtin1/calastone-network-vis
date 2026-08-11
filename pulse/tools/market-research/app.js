
const EDIT_MODE = false; // set true to console.log clicked records

/* ================================================================
   ===================   SAVING / PERSISTENCE   =================
   ================================================================
   System of record: Neon via /api/atlas and /api/country.
   localStorage is a cache only (offline / fast first paint).
   Export/Import still works; import writes through to Neon. */

const STORAGE_KEY = 'calastone_atlas_v1';
let STORAGE_OK = true;
let DB_OK = null; // null=unknown, true/false after first attempt

(function testStorage(){
  try{
    const t='__test__'+Date.now();
    window.localStorage.setItem(t,'1'); window.localStorage.removeItem(t);
    STORAGE_OK=true;
  }catch(_){ STORAGE_OK=false; }
})();

function applyAtlasPayload(saved){
  if(!saved) return;
  if(saved.data) Object.assign(COUNTRY_DATA, saved.data);
  if(saved.markdown) Object.assign(COUNTRY_MARKDOWN, saved.markdown);
}

function loadSavedData(){
  if(!STORAGE_OK) return;
  let raw=null;
  try{ raw=window.localStorage.getItem(STORAGE_KEY); }catch(_){ return; }
  if(!raw) return;
  try{
    applyAtlasPayload(JSON.parse(raw));
  }catch(_){ /* corrupt save — ignore, keep defaults */ }
}

function cacheLocally(){
  if(!STORAGE_OK) return false;
  try{
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      data:COUNTRY_DATA, markdown:COUNTRY_MARKDOWN, savedAt:new Date().toISOString()
    }));
    return true;
  }catch(_){ STORAGE_OK=false; showSaveBanner(); return false; }
}

async function loadAtlasFromDb(){
  try{
    const res = await fetch('/api/atlas', { headers:{ 'Accept':'application/json' } });
    const ctype = (res.headers.get('content-type')||'').toLowerCase();
    if(!res.ok || !ctype.includes('json')){
      DB_OK=false;
      return false;
    }
    const atlas = await res.json();
    if(atlas && atlas.error){ DB_OK=false; return false; }
    applyAtlasPayload(atlas);
    cacheLocally();
    DB_OK=true;
    return true;
  }catch(_){
    DB_OK=false;
    return false;
  }
}

async function persistCountryToDb(iso3, source){
  const code = String(iso3||'').toUpperCase();
  const profile = COUNTRY_DATA[code] || null;
  const note = COUNTRY_MARKDOWN[code] || '';
  try{
    const res = await fetch('/api/country?iso3='+encodeURIComponent(code), {
      method:'PUT',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ profile, note, source: source||'manual' })
    });
    const ctype = (res.headers.get('content-type')||'').toLowerCase();
    if(!res.ok || !ctype.includes('json')){
      DB_OK=false;
      return false;
    }
    const body = await res.json();
    if(body && body.error){ DB_OK=false; throw new Error(body.error.message||'DB save failed'); }
    DB_OK=true;
    return true;
  }catch(err){
    DB_OK=false;
    console.warn('Neon persist failed', err);
    return false;
  }
}

async function persistAtlasToDb(source){
  try{
    const res = await fetch('/api/atlas', {
      method:'PUT',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify({
        data:COUNTRY_DATA,
        markdown:COUNTRY_MARKDOWN,
        source: source||'sync'
      })
    });
    const ctype = (res.headers.get('content-type')||'').toLowerCase();
    if(!res.ok || !ctype.includes('json')){
      DB_OK=false;
      return false;
    }
    const body = await res.json();
    if(body && body.error){ DB_OK=false; throw new Error(body.error.message||'DB sync failed'); }
    DB_OK=true;
    return true;
  }catch(err){
    DB_OK=false;
    console.warn('Neon atlas sync failed', err);
    return false;
  }
}

// Write current data to browser cache + Neon. Called after every change.
function saveData(iso3, source){
  cacheLocally();
  // Fire-and-forget server persist; UI stays responsive.
  const job = iso3 ? persistCountryToDb(iso3, source) : persistAtlasToDb(source);
  return job.then((ok)=>{
    if(!ok && DB_OK===false){
      // Keep working offline via localStorage / backup.
    }
    return ok;
  });
}

function exportData(){
  const blob=new Blob([JSON.stringify({
    data:COUNTRY_DATA, markdown:COUNTRY_MARKDOWN, savedAt:new Date().toISOString()
  }, null, 2)], {type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download='calastone-atlas-backup-'+new Date().toISOString().slice(0,10)+'.json';
  a.click(); URL.revokeObjectURL(url);
}

function importData(file){
  const r=new FileReader();
  r.onload=async ()=>{
    try{
      const saved=JSON.parse(String(r.result));
      applyAtlasPayload(saved);
      cacheLocally();
      const ok = await persistAtlasToDb('import');
      refreshGlobe(); if(typeof afterFilter==='function') afterFilter();
      alert('Backup loaded — '+Object.keys(saved.data||{}).length+' country records restored'+(ok?' to Neon.':' (local only; DB unreachable).'));
    }catch(_){ alert('That file could not be read as a valid backup.'); }
  };
  r.readAsText(file);
}

function showSaveBanner(){
  if(document.getElementById('saveBanner')) return;
  const b=document.createElement('div'); b.id='saveBanner';
  b.style.cssText='position:fixed;z-index:70;bottom:90px;right:24px;background:var(--mid-s);border:1px solid var(--mid);color:var(--ink);padding:10px 14px;border-radius:10px;font-size:12px;max-width:280px;box-shadow:var(--shadow)';
  b.innerHTML='Auto-save isn\u2019t available here. Use <b>Save backup</b> to keep your work, then <b>Load backup</b> next time.';
  document.body.appendChild(b);
  setTimeout(()=>{ b.style.transition='opacity .5s'; b.style.opacity='0'; setTimeout(()=>b.remove(),600); }, 7000);
}


/* Prefer /api/claude (server env). Fall back to config.js for local static use.
   config.js is gitignored — never commit live Anthropic credentials. */
const ANTHROPIC_API_KEY = (window.CONFIG && window.CONFIG.ANTHROPIC_API_KEY) || 'PASTE-YOUR-KEY-HERE';
const CLAUDE_MODEL = (window.CONFIG && window.CONFIG.CLAUDE_MODEL) || 'claude-sonnet-4-6';
const HAS_BROWSER_KEY = !!(ANTHROPIC_API_KEY && ANTHROPIC_API_KEY !== 'PASTE-YOUR-KEY-HERE');
const ON_HTTP = typeof location !== 'undefined' && /^https?:/.test(location.protocol || '');
// Allow long notes / large extracts. Continuation handles max_tokens cutoffs.
const BUILD_MAX_TOKENS = 8000;
const MERGE_MAX_TOKENS = 8000;
const CLAUDE_CONTINUE_LIMIT = 4;
// Vercel request body ~4.5MB; base64 expands ~4/3, so keep PDF under ~3MB raw.
const MAX_PDF_BYTES = 3 * 1024 * 1024;
const MAX_TEXT_CHARS = 500000;

function formatClaudeHttpError(status, detail){
  const d = String(detail || '');
  if(status === 504 || /timeout|UPSTREAM_TIMEOUT|FUNCTION_INVOCATION_TIMEOUT|Task timed out|error occurred with your deployment/i.test(d)){
    return 'Claude timed out before finishing. The file may be very large — try again, or split a huge PDF into sections.';
  }
  if(status === 413 || /payload|too large|entity too large/i.test(d)){
    return 'Upload is too large for the Claude proxy (Vercel body limit). Use a PDF under ~3MB or a text/Markdown extract.';
  }
  if(/ANTHROPIC_API_KEY/i.test(d)){
    return d;
  }
  return 'API '+status+(d ? (' — '+d) : '');
}

async function readProxyErrorDetail(proxyRes){
  const ctype = (proxyRes.headers.get('content-type') || '').toLowerCase();
  try{
    if(ctype.includes('json')){
      const errBody = await proxyRes.clone().json();
      return (errBody && errBody.error && (errBody.error.message || errBody.error.code)) ||
        (errBody && errBody.message) || '';
    }
  }catch(_){}
  try{
    return (await proxyRes.clone().text()).replace(/\s+/g, ' ').trim().slice(0, 280);
  }catch(_){
    return '';
  }
}

/** Confirm the serverless proxy can see ANTHROPIC_API_KEY before uploading. */
async function assertClaudeProxyReady(){
  if(!ON_HTTP) return;
  let res;
  try{
    res = await fetch('/api/claude', { method:'GET', cache:'no-store' });
  }catch(err){
    throw new Error('Could not reach /api/claude ('+(err && err.message || 'network error')+'). Check you are on the Vercel deployment (not a static file:// copy).');
  }
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if(res.status === 404 || !ctype.includes('json')){
    throw new Error('Claude proxy is not available on this host (HTTP '+res.status+'). Open the Vercel app URL and ensure /api/claude is deployed.');
  }
  let body = null;
  try{ body = await res.json(); }catch(_){}
  if(!res.ok){
    throw new Error(formatClaudeHttpError(res.status, body && body.error && body.error.message));
  }
  if(!body || !body.keyConfigured){
    throw new Error('ANTHROPIC_API_KEY is not set on the server. Add it in Vercel → Settings → Environment Variables (Production + Preview), then Redeploy.');
  }
}

/** Call Anthropic Messages via server proxy, or directly with config.js as fallback. */
async function anthropicMessages(body){
  const payload = { model: CLAUDE_MODEL, ...body };
  let proxyRes = null;
  try{
    proxyRes = await fetch('/api/claude', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify(payload)
    });
  }catch(err){
    if(ON_HTTP){
      throw new Error('Claude proxy request failed ('+(err && err.message || 'network error')+').');
    }
    proxyRes = null;
  }

  if(proxyRes){
    const ctype = (proxyRes.headers.get('content-type') || '').toLowerCase();
    const isJson = ctype.includes('json');

    // Hosted app: any non-404 response from /api/claude is authoritative.
    // Plain-text Vercel 504s must NOT fall through to "No API key set".
    if(ON_HTTP && proxyRes.status !== 404){
      if(!proxyRes.ok){
        throw new Error(formatClaudeHttpError(proxyRes.status, await readProxyErrorDetail(proxyRes)));
      }
      if(!isJson){
        throw new Error(formatClaudeHttpError(proxyRes.status, await readProxyErrorDetail(proxyRes) || 'non-JSON proxy response'));
      }
      return proxyRes;
    }

    // Static hosts return 404 HTML when the function is missing — fall back.
    if(proxyRes.status !== 404 && isJson){
      if(!proxyRes.ok){
        const detail = await readProxyErrorDetail(proxyRes);
        if(/ANTHROPIC_API_KEY/i.test(detail)) throw new Error(detail);
      }
      return proxyRes;
    }
  }

  if(!HAS_BROWSER_KEY){
    throw new Error('No API key set. Add ANTHROPIC_API_KEY to the server env (.env.local / Vercel), or create config.js from config.example.js for local use. Then run `npm run dev` (or redeploy).');
  }
  return fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      'x-api-key':ANTHROPIC_API_KEY,
      'anthropic-version':'2023-06-01',
      'anthropic-dangerous-direct-browser-access':'true'
    },
    body: JSON.stringify(payload)
  });
}

/** One Anthropic turn → { text, stopReason, truncated }. */
async function claudeTurn({ system, messages, maxTokens }){
  const res = await anthropicMessages({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    system,
    messages
  });
  if(!res.ok){
    let detail=''; try{ const j=await res.json(); detail=j.error?.message||''; }catch(_){}
    throw new Error(formatClaudeHttpError(res.status, detail));
  }
  const data = await res.json();
  const text = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  const stopReason = data.stop_reason || '';
  return { text, stopReason, truncated: stopReason === 'max_tokens' };
}

/**
 * Complete a Claude response, automatically continuing when output hits max_tokens.
 * Keeps going until stop_reason !== max_tokens or CLAUDE_CONTINUE_LIMIT is reached.
 */
async function claudeComplete({ system, userContent, maxTokens, onProgress }){
  const messages = [{ role:'user', content:userContent }];
  let full = '';
  let truncated = false;

  for(let i = 0; i < CLAUDE_CONTINUE_LIMIT; i++){
    if(onProgress) onProgress(i === 0 ? 'Asking Claude…' : ('Continuing Claude response ('+(i+1)+'/'+CLAUDE_CONTINUE_LIMIT+')…'));
    const turn = await claudeTurn({ system, messages, maxTokens });
    full += turn.text;
    truncated = turn.truncated;
    if(!turn.truncated) return { text: full, truncated: false };

    // Feed partial assistant output back and ask to continue seamlessly.
    messages.push({ role:'assistant', content: turn.text });
    messages.push({
      role:'user',
      content: 'Continue exactly from where you left off. Do not repeat earlier text. Do not add commentary — only the continuation of the same response format.'
    });
  }

  return { text: full, truncated: true };
}

/* Fixed extraction instructions. Same every time. */
const EXTRACTION_SYSTEM_PROMPT = `You extract mutual fund order-routing intelligence and propose edits to a country research note.

You receive: (1) the current country note in Markdown, (2) the text of an uploaded document.

Your job:
- Read the uploaded document and identify ONLY information relevant to mutual fund order routing: central hubs/CSDs, order channels, automation/manuality, regulators, cross-border routing, key participants, AUM, distribution channels.
- Ignore everything not relevant to fund order routing.
- Propose structured edits to the note. Do not rewrite unchanged sections.
- Spell out every acronym in full on first use with the abbreviation in brackets.
- Never delete existing content; only add or revise.

Respond with JSON ONLY — no prose, no markdown fences — matching exactly:
{
  "summary": "one sentence on what you changed",
  "edits": [
    { "section": "exact ## heading text to place under (omit the ## )",
      "action": "add",
      "newContent": "the markdown to append under that heading" }
  ]
}
If the document has nothing relevant, return {"summary":"No relevant content found","edits":[]}.`;

/* Used when the country has no note yet: build a full note from the document. */
const BUILD_SYSTEM_PROMPT = `You build a new country research note on mutual fund order-routing infrastructure from an uploaded document.

You receive an ISO3 country code and the text of an uploaded document.

Your job:
- Produce ONE complete Markdown research note for this country, capturing only mutual fund order-routing intelligence: market classification, central hub/CSD status, order channels, automation/manuality, regulators, cross-border routing, key participants, AUM, distribution channels, risks.
- Use this structure: a level-1 title (# Country), a blockquote header summarising ISO3/Region/Classification/Hub Status, then ## sections such as Market Overview, How Fund Orders Work Today, Distribution Channels, Key Participants, Risks, and Sources.
- Spell out every acronym in full on first use with the abbreviation in brackets.
- Use only information supported by the document. Do not invent figures.

OUTPUT FORMAT — follow exactly:
First, output the complete Markdown note as plain text (NOT inside JSON, NOT inside code fences).
Then, on a new line, output this exact delimiter:
===FIELDS===
Then output a small JSON object (and nothing after it) with these structured fields, values inferred from the document:
{
  "summary": "one sentence describing the note",
  "country": "Full country name",
  "region": "Europe | Asia | Americas | Africa | Oceania",
  "subregion": "short text",
  "market_classification": "Developed | Emerging | Frontier | Unknown",
  "central_hub_status": "Full hub | Partial hub | No central hub",
  "hub_name": "name or —",
  "operator": "who runs it or —",
  "opportunity_score": 0,
  "automation_rate_estimate": 0,
  "priority_tier": "Tier 1 | Tier 2 | Tier 3 | Watch",
  "existing_network_presence": "Established | Emerging | None",
  "market_aum_band": "short text",
  "mutual_fund_relevance": "one line",
  "growth_signal": "one line",
  "dominant_order_model": "one line",
  "current_order_channels": "one line",
  "manuality_snapshot": "one line",
  "regulatory_openness": "one line",
  "risks_or_barriers": "one line",
  "flow_diagram": [ { "label": "Stage", "mode": "auto" } ]
}`;


const C = {
  good:'#4a9d5b', mid:'#d79a31', bad:'#cf5a4e',
  developed:'#007DB7', emerging:'#2D9A8E', frontier:'#6AAD6A', unknown:'#a7b3bd',
  none:'#cdd8e1'
};
function scoreColor(v){ if(v==null)return null; if(v>=66)return C.good; if(v>=40)return C.mid; return C.bad; }
function scoreColorInv(v){ if(v==null)return null; if(v>=66)return C.bad; if(v>=40)return C.mid; return C.good; }
function hubColor(s){ if(s==='No central hub')return C.good; if(s==='Partial hub')return C.mid; if(s==='Full hub')return C.bad; return null; }
function classColor(c){ if(c==='Developed')return C.developed; if(c==='Emerging')return C.emerging; if(c==='Frontier')return C.frontier; return C.unknown; }

const LEGENDS = {
  opportunity:{title:'Opportunity',items:[{c:C.good,t:'High — friction & headroom (66+)'},{c:C.mid,t:'Medium (40–65)'},{c:C.bad,t:'Low — mature / well served (<40)'},{c:C.none,t:'No profile yet'}]},
  hub:{title:'Hub Maturity',items:[{c:C.good,t:'No central hub — fragmented'},{c:C.mid,t:'Partial hub'},{c:C.bad,t:'Full hub — well covered'},{c:C.none,t:'No profile yet'}]},
  automation:{title:'Automation',items:[{c:C.good,t:'Low automation — headroom'},{c:C.mid,t:'Medium automation'},{c:C.bad,t:'High automation — saturated'},{c:C.none,t:'No profile yet'}]},
  classification:{title:'Market Classification',items:[{c:C.developed,t:'Developed'},{c:C.emerging,t:'Emerging'},{c:C.frontier,t:'Frontier'},{c:C.unknown,t:'Unknown / no profile'}]}
};

let MODE='opportunity', world=null, globe=null, selectedISO=null;
const FILTERS={region:'',cls:'',hub:'',tier:'',net:'',highopp:false};

function featISO(f){const p=f.properties||{};return f.iso_a3||p.iso_a3||p.ISO_A3||p.adm0_a3||f.id||null;}
function featName(f){const p=f.properties||{};return p.name||p.NAME||p.admin||'Unknown';}
function recordFor(f){const iso=featISO(f);return iso?COUNTRY_DATA[iso]:null;}

function passesFilters(rec){
  if(!rec) return !FILTERS.region&&!FILTERS.cls&&!FILTERS.hub&&!FILTERS.tier&&!FILTERS.net&&!FILTERS.highopp;
  if(FILTERS.region&&rec.region!==FILTERS.region)return false;
  if(FILTERS.cls&&rec.market_classification!==FILTERS.cls)return false;
  if(FILTERS.hub&&rec.central_hub_status!==FILTERS.hub)return false;
  if(FILTERS.tier&&rec.priority_tier!==FILTERS.tier)return false;
  if(FILTERS.net&&rec.existing_network_presence!==FILTERS.net)return false;
  if(FILTERS.highopp&&!(rec.opportunity_score>=66))return false;
  return true;
}
function hexA(hex,a){const h=hex.replace('#','');return`rgba(${parseInt(h.slice(0,2),16)},${parseInt(h.slice(2,4),16)},${parseInt(h.slice(4,6),16)},${a})`;}

function polyCapColor(f){
  const rec=recordFor(f);
  if(!passesFilters(rec)) return 'rgba(190,205,216,0.30)';
  if(!rec) return 'rgba(205,216,225,0.70)';
  let col;
  if(MODE==='opportunity')col=scoreColor(rec.opportunity_score);
  else if(MODE==='hub')col=hubColor(rec.central_hub_status);
  else if(MODE==='automation')col=scoreColorInv(rec.automation_rate_estimate);
  else col=classColor(rec.market_classification);
  if(!col)col=C.none;
  return hexA(col, selectedISO===rec.iso3?0.95:0.82);
}
function polySideColor(){return 'rgba(0,80,120,0.10)';}
function polyStrokeColor(f){const rec=recordFor(f);if(selectedISO&&rec&&rec.iso3===selectedISO)return '#007DB7';return 'rgba(15,34,48,0.12)';}
function polyAltitude(f){const rec=recordFor(f);if(rec&&rec.iso3===selectedISO)return 0.10;if(f.__hover)return 0.07;if(rec&&passesFilters(rec))return 0.012;return 0.006;}

const tooltipEl=document.getElementById('tooltip');
function showTooltip(f,x,y){
  const rec=recordFor(f),name=featName(f);
  let html;
  if(!rec){html=`<div class="tt-name">${name}</div><div class="tt-region">No profile</div><div class="tt-empty">Profile not yet completed</div>`;}
  else{html=`<div class="tt-name">${rec.country}</div><div class="tt-region">${rec.region.toUpperCase()} · ${rec.subregion}</div>
    <div class="tt-row"><span class="k">Hub status</span><span class="v">${rec.central_hub_status}</span></div>
    <div class="tt-row"><span class="k">Opportunity</span><span class="v">${pillScore(rec.opportunity_score)}</span></div>
    <div class="tt-row"><span class="k">Automation</span><span class="v">${rec.automation_rate_estimate}%</span></div>
    <div class="tt-row"><span class="k">Priority</span><span class="v">${tierPill(rec.priority_tier)}</span></div>`;}
  tooltipEl.innerHTML=html;tooltipEl.classList.add('show');positionTooltip(x,y);
}
function positionTooltip(x,y){const pad=16,w=tooltipEl.offsetWidth,h=tooltipEl.offsetHeight;let nx=x+pad,ny=y+pad;if(nx+w>innerWidth-10)nx=x-w-pad;if(ny+h>innerHeight-10)ny=y-h-pad;tooltipEl.style.left=nx+'px';tooltipEl.style.top=ny+'px';}
function hideTooltip(){tooltipEl.classList.remove('show');}

function pillScore(v){const c=v>=66?C.good:v>=40?C.mid:C.bad;return`<span class="pill" style="background:${hexA(c,0.16)};color:${c}">${v}</span>`;}
function tierPill(t){const m={'Tier 1':C.good,'Tier 2':C.mid,'Tier 3':C.bad,'Watch':C.unknown};const c=m[t]||C.unknown;return`<span class="pill" style="background:${hexA(c,0.16)};color:${c}">${t}</span>`;}
function classPill(c){const col=classColor(c);return`<span class="pill" style="background:${hexA(col,0.14)};color:${col}">${c}</span>`;}
function hubPill(s){const c=hubColor(s)||C.unknown;return`<span class="pill" style="background:${hexA(c,0.16)};color:${c}">${s}</span>`;}
function netPill(n){const m={'Established':C.good,'Emerging':C.mid,'None':C.unknown};const c=m[n]||C.unknown;return`<span class="pill" style="background:${hexA(c,0.16)};color:${c}">Network: ${n}</span>`;}

const drawer=document.getElementById('drawer');
const drawerContent=document.getElementById('drawerContent');
function openDrawer(f){
  const rec=recordFor(f),name=featName(f);
  drawer.classList.remove('wide');
  if(!rec){
    const iso=featISO(f)||'';
    const existingNote=(typeof COUNTRY_MARKDOWN!=='undefined' && iso) ? cleanNote(COUNTRY_MARKDOWN[iso]||'') : '';
    drawerContent.innerHTML=`
      <div class="drawer-head">
        <button class="drawer-close" onclick="closeDrawer()" title="Close">×</button>
        <button class="drawer-expand" onclick="drawer.classList.toggle('wide')" title="Expand / narrow">⇔</button>
        <div class="ctry-name">${name}</div>
        <div class="ctry-region">${iso||'—'} · No structured profile yet</div>
      </div>
      <div class="scroll">
        <div class="section" style="margin-top:18px">
          <div class="s-title">Add to this note</div>
          <div class="dropzone" id="dropzone" data-iso="${iso}">
            <div class="dz-icon">⬆</div>
            <div class="dz-title">Drop a Markdown or PDF file here</div>
            <div class="dz-sub">Claude reads it and builds this country's note</div>
          </div>
          <div class="dz-status" id="dzStatus"></div>
        </div>
        ${renderNotePanel(iso, 'Research note', existingNote, 'No note yet — drop a Markdown file above or edit to create one.')}
      </div>`;
  } else { drawerContent.innerHTML=buildSnapshot(rec); }
  drawer.classList.add('open');
}
function closeDrawer(){drawer.classList.remove('open','wide');selectedISO=null;refreshGlobe();}
window.closeDrawer=closeDrawer;

function buildSnapshot(r){
  const oppC=r.opportunity_score>=66?C.good:r.opportunity_score>=40?C.mid:C.bad;
  const autoC=r.automation_rate_estimate>=66?C.bad:r.automation_rate_estimate>=40?C.mid:C.good;
  return `
  <button class="drawer-close" onclick="closeDrawer()">×</button>
  <div class="drawer-head">
    <div class="ctry-name">${r.country}</div>
    <div class="ctry-region">${r.region.toUpperCase()} · ${r.subregion} · ${r.iso3}</div>
    <div class="badges">${classPill(r.market_classification)}${tierPill(r.priority_tier)}${hubPill(r.central_hub_status)}${netPill(r.existing_network_presence)}</div>
  </div>
  <div class="scroll">
    <div class="kpis">
      <div class="kpi"><div class="k">Opportunity score</div><div class="v" style="color:${oppC}">${r.opportunity_score}<small>/100</small></div><div class="bar"><i style="width:${r.opportunity_score}%;background:${oppC}"></i></div></div>
      <div class="kpi"><div class="k">Automation estimate</div><div class="v">${r.automation_rate_estimate}<small>%</small></div><div class="bar"><i style="width:${r.automation_rate_estimate}%;background:${autoC}"></i></div></div>
      <div class="kpi"><div class="k">Priority tier</div><div class="v" style="font-size:17px">${r.priority_tier}</div></div>
      <div class="kpi"><div class="k">AUM band</div><div class="v" style="font-size:13px;font-family:var(--sans);line-height:1.3;margin-top:7px">${r.market_aum_band}</div></div>
    </div>

    <div class="snapshot-fact"><div class="sf-label">Dominant order model</div><div class="sf-val">${r.dominant_order_model}</div></div>
    <div class="snapshot-fact"><div class="sf-label">Hub</div><div class="sf-val">${r.central_hub_status}${r.hub_name&&r.hub_name!=='—'?' · '+r.hub_name:''}${r.operator?' ('+r.operator+')':''}</div></div>

    <button class="expand-btn" id="expandBtn" onclick="toggleDetail()">
      <span>Show full detail, flow &amp; research note</span><span class="chev">▾</span>
    </button>

    <div class="detail" id="detailBlock">
      ${buildFlow(r)}

      <div class="section"><div class="s-title">Why this market matters</div><p>${r.mutual_fund_relevance}</p></div>

      <div class="section"><div class="s-title">Current order-routing reality</div>
        <div class="field"><div class="fl">Dominant order model</div><div class="fv">${r.dominant_order_model}</div></div>
        <div class="field"><div class="fl">Current channels</div><div class="fv">${r.current_order_channels}</div></div>
        <div class="field"><div class="fl">Manuality snapshot</div><div class="fv">${r.manuality_snapshot}</div></div>
      </div>

      <div class="section"><div class="s-title">Market context</div>
        <div class="field"><div class="fl">Growth signal</div><div class="fv">${r.growth_signal}</div></div>
        <div class="field"><div class="fl">AUM band</div><div class="fv">${r.market_aum_band}</div></div>
        <div class="field"><div class="fl">Regulatory openness</div><div class="fv">${r.regulatory_openness}</div></div>
        <div class="field"><div class="fl">Existing network presence</div><div class="fv">${r.existing_network_presence}</div></div>
      </div>

      <div class="section risk-box"><div class="s-title">Risks / watchouts</div><p>${r.risks_or_barriers}</p></div>

      ${buildNote(r)}

      <div class="updated">Last updated ${r.last_updated}</div>
    </div>
  </div>`;
}

function buildNote(r){
  const md = (typeof COUNTRY_MARKDOWN!=='undefined') ? COUNTRY_MARKDOWN[r.iso3] : null;
  const dz = `<div class="section">
      <div class="s-title">Add to this note</div>
      <div class="dropzone" id="dropzone" data-iso="${r.iso3}">
        <div class="dz-icon">⬆</div>
        <div class="dz-title">Drop a Markdown or PDF file here</div>
        <div class="dz-sub">Claude extracts order-routing detail and proposes edits</div>
      </div>
      <div class="dz-status" id="dzStatus"></div>
    </div>`;
  return dz + renderNotePanel(r.iso3, 'Full research note', md, 'No research note yet for this country.');
}

/* View-mode research note panel with Edit control. */
function renderNotePanel(iso, title, md, missingMsg){
  const code = String(iso||'').toUpperCase();
  const body = (md && String(md).trim())
    ? renderMarkdown(md)
    : `<div class="note-missing">${missingMsg||'No research note yet.'}</div>`;
  return `<div class="md-note" id="mdNote" data-iso="${code}">
    <div class="note-head">
      <span class="nh-title">${title}</span>
      <div class="note-actions">
        <button type="button" class="btn-note" data-note-action="edit" data-iso="${code}">Edit note</button>
      </div>
    </div>
    <div class="note-status" id="noteStatus" hidden></div>
    <div class="note-body">${body}</div>
  </div>`;
}

function setNoteStatus(msg, cls){
  const s=document.getElementById('noteStatus');
  if(!s) return;
  if(!msg){ s.hidden=true; s.textContent=''; s.className='note-status'; return; }
  s.hidden=false;
  s.textContent=msg;
  s.className='note-status'+(cls?(' '+cls):'');
}

function startNoteEdit(iso){
  const code = String(iso||'').toUpperCase();
  const panel = document.getElementById('mdNote');
  if(!panel || !code) return;
  const md = (typeof COUNTRY_MARKDOWN!=='undefined' && COUNTRY_MARKDOWN[code]) ? COUNTRY_MARKDOWN[code] : '';
  panel.classList.add('editing');
  panel.innerHTML = `
    <div class="note-head">
      <span class="nh-title">Edit research note</span>
      <div class="note-actions">
        <button type="button" class="btn-note" data-note-action="cancel" data-iso="${code}">Cancel</button>
        <button type="button" class="btn-note btn-note-primary" data-note-action="save" data-iso="${code}">Save</button>
      </div>
    </div>
    <div class="note-status" id="noteStatus" hidden></div>
    <textarea class="note-editor" id="noteEditor" spellcheck="true" aria-label="Research note markdown"></textarea>
    <div class="note-preview-label">Preview</div>
    <div class="note-preview" id="notePreview"></div>`;
  const ta = document.getElementById('noteEditor');
  const preview = document.getElementById('notePreview');
  ta.value = md;
  const refreshPreview = ()=>{
    const v = ta.value;
    preview.innerHTML = v.trim() ? renderMarkdown(v) : '<div class="note-missing">Nothing to preview yet.</div>';
  };
  ta.addEventListener('input', refreshPreview);
  refreshPreview();
  ta.focus();
}

function cancelNoteEdit(iso){
  const code = String(iso||'').toUpperCase();
  const f = world && world.find(ft=>featISO(ft)===code);
  if(!f) return;
  const wasWide = drawer.classList.contains('wide');
  const detailOpen = !!(document.getElementById('detailBlock') && document.getElementById('detailBlock').classList.contains('open'));
  openDrawer(f);
  if(wasWide || detailOpen){
    const d=document.getElementById('detailBlock'), b=document.getElementById('expandBtn');
    if(d && !d.classList.contains('open')){
      d.classList.add('open');
      if(b){ b.classList.add('open'); b.querySelector('span').textContent='Hide full detail'; }
      drawer.classList.add('wide');
    }
  }
}

async function saveNoteEdit(iso){
  const code = String(iso||'').toUpperCase();
  const ta = document.getElementById('noteEditor');
  if(!ta || !code) return;
  const saveBtn = document.querySelector('#mdNote [data-note-action="save"]');
  const cancelBtn = document.querySelector('#mdNote [data-note-action="cancel"]');
  if(saveBtn){ saveBtn.disabled=true; saveBtn.textContent='Saving…'; }
  if(cancelBtn) cancelBtn.disabled=true;
  setNoteStatus('Saving…', 'work');
  COUNTRY_MARKDOWN[code] = ta.value;
  const ok = await saveData(code, 'manual');
  const f = world && world.find(ft=>featISO(ft)===code);
  if(f){
    const wasWide = drawer.classList.contains('wide');
    openDrawer(f);
    const d=document.getElementById('detailBlock'), b=document.getElementById('expandBtn');
    if(d && (wasWide || recordFor(f))){
      d.classList.add('open');
      if(b){ b.classList.add('open'); b.querySelector('span').textContent='Hide full detail'; }
      drawer.classList.add('wide');
    }
  }
  setNoteStatus(
    ok ? 'Saved — will persist across deployments.' : 'Saved in this browser only — Neon unreachable.',
    ok ? 'ok' : 'err'
  );
}

/* Markdown -> HTML. Uses marked if present; otherwise a small fallback.
   Tables are wrapped in a scroll container after rendering. */
function renderMarkdown(md){
  let html;
  try{
    if(window.marked){
      const fn = window.marked.parse || window.marked;
      html = fn(md, {gfm:true, breaks:false});
    } else { html = fallbackMarkdown(md); }
  }catch(e){ html = fallbackMarkdown(md); }
  // wrap tables so they can scroll horizontally on narrow panels
  html = html.replace(/<table>/g,'<div class="md-table-wrap"><table>').replace(/<\/table>/g,'</table></div>');
  return html;
}

/* Minimal fallback if the marked CDN is unavailable: handles headings,
   bold, code fences, blockquotes, lists and paragraphs (no tables). */
function fallbackMarkdown(md){
  const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines=md.split('\n'); let out=[]; let i=0;
  while(i<lines.length){
    let l=lines[i];
    if(/^```/.test(l)){ let buf=[];i++; while(i<lines.length&&!/^```/.test(lines[i])){buf.push(esc(lines[i]));i++;} i++; out.push('<pre><code>'+buf.join('\n')+'</code></pre>'); continue; }
    if(/^#{1,6}\s/.test(l)){ const n=l.match(/^#+/)[0].length; out.push('<h'+n+'>'+inline(esc(l.replace(/^#+\s/,'')))+'</h'+n+'>'); i++; continue; }
    if(/^>\s?/.test(l)){ let buf=[]; while(i<lines.length&&/^>\s?/.test(lines[i])){buf.push(esc(lines[i].replace(/^>\s?/,'')));i++;} out.push('<blockquote>'+inline(buf.join('<br>'))+'</blockquote>'); continue; }
    if(/^[-*]\s/.test(l)){ let buf=[]; while(i<lines.length&&/^[-*]\s/.test(lines[i])){buf.push('<li>'+inline(esc(lines[i].replace(/^[-*]\s/,'')))+'</li>');i++;} out.push('<ul>'+buf.join('')+'</ul>'); continue; }
    if(/^\s*$/.test(l)){ i++; continue; }
    if(/^---+$/.test(l)){ out.push('<hr>'); i++; continue; }
    let buf=[]; while(i<lines.length&&!/^\s*$/.test(lines[i])&&!/^[#>`-]/.test(lines[i])){buf.push(esc(lines[i]));i++;} out.push('<p>'+inline(buf.join(' '))+'</p>');
  }
  function inline(s){ return s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>'); }
  return out.join('\n');
}
window.renderMarkdown=renderMarkdown;

function buildFlow(r){
  let inner='';
  if(r.flow_image && r.flow_image.trim()){
    inner=`<img class="flow-img" src="${r.flow_image}" alt="Order flow diagram for ${r.country}" />`;
  } else if(Array.isArray(r.flow_diagram) && r.flow_diagram.length){
    const stages=r.flow_diagram.map((s,i)=>{
      const cls=(s.mode==='manual'?'manual':s.mode==='mixed'?'mixed':'auto');
      const modeTxt=cls==='manual'?'Manual':cls==='mixed'?'Mixed':'Automated';
      const box=`<div class="flow-stage ${cls}"><div class="fs-label">${s.label}</div><div class="fs-mode">${modeTxt}</div></div>`;
      const arrow=i<r.flow_diagram.length-1?`<div class="flow-arrow">→</div>`:'';
      return box+arrow;
    }).join('');
    inner=`<div class="flow-draw">${stages}</div>
      <div class="flow-legend">
        <div class="fl-item"><span class="fl-dot" style="background:${C.good}"></span>Automated</div>
        <div class="fl-item"><span class="fl-dot" style="background:${C.mid}"></span>Mixed</div>
        <div class="fl-item"><span class="fl-dot" style="background:${C.bad}"></span>Manual</div>
      </div>`;
  } else { return ''; }
  return `<div class="section"><div class="s-title">Order-flow path</div><div class="flow">${inner}</div></div>`;
}

function toggleDetail(){
  const d=document.getElementById('detailBlock'), b=document.getElementById('expandBtn');
  const open=d.classList.toggle('open'); b.classList.toggle('open',open);
  drawer.classList.toggle('wide',open);
  b.querySelector('span').textContent = open ? 'Hide full detail' : 'Show full detail, flow & research note';
}
window.toggleDetail=toggleDetail;

/* ================================================================
   ===============   FILE UPLOAD → CLAUDE → APPROVE   ============
   ================================================================ */

// Event delegation: the dropzone is rebuilt each time a country opens.
const drawerEl = document.getElementById('drawer');
drawerEl.addEventListener('dragover', e=>{
  const dz=e.target.closest('#dropzone'); if(!dz) return;
  e.preventDefault(); dz.classList.add('over');
});
drawerEl.addEventListener('dragleave', e=>{
  const dz=e.target.closest('#dropzone'); if(!dz) return;
  dz.classList.remove('over');
});
drawerEl.addEventListener('drop', e=>{
  const dz=e.target.closest('#dropzone'); if(!dz) return;
  e.preventDefault(); dz.classList.remove('over');
  const f=e.dataTransfer.files && e.dataTransfer.files[0];
  handleUpload(f, dz.dataset.iso);
});
// Note edit toolbar + click-to-pick on dropzone (delegation; panel is rebuilt often)
drawerEl.addEventListener('click', e=>{
  const noteBtn=e.target.closest('[data-note-action]');
  if(noteBtn){
    e.preventDefault();
    e.stopPropagation();
    const action=noteBtn.dataset.noteAction;
    const iso=noteBtn.dataset.iso;
    if(action==='edit') startNoteEdit(iso);
    else if(action==='cancel') cancelNoteEdit(iso);
    else if(action==='save') saveNoteEdit(iso);
    return;
  }
  const dz=e.target.closest('#dropzone'); if(!dz) return;
  if(e.target.closest('button')) return;
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.md,.markdown,.txt,.pdf';
  inp.onchange=()=>handleUpload(inp.files[0], dz.dataset.iso); inp.click();
});

function setStatus(msg, cls){
  const s=document.getElementById('dzStatus'); if(!s) return;
  s.textContent=msg||''; s.className='dz-status'+(cls?(' '+cls):'');
}

async function handleUpload(file, iso){
  if(!file){ return; }
  if(!iso){ setStatus('This country has no ISO code mapped — add it to NAME_TO_ISO first.', 'err'); return; }
  const isPdf=/\.pdf$/i.test(file.name);
  const isText=/\.(md|markdown|txt)$/i.test(file.name);
  if(!isPdf && !isText){ setStatus('Please drop a Markdown (.md), text, or PDF file.', 'err'); return; }
  if(isPdf && file.size > MAX_PDF_BYTES){
    setStatus('PDF is too large for the upload proxy (~3MB max due to Vercel request limits). Split it or upload a Markdown extract.', 'err');
    return;
  }

  setStatus('Reading file…', 'work');
  let payload;
  try{
    if(isPdf){
      const b64=await fileToBase64(file);
      payload={ kind:'pdf', data:b64, name:file.name };
    } else {
      const txt=await file.text();
      if(txt.length > MAX_TEXT_CHARS){
        setStatus('Text file is extremely large — using the first '+MAX_TEXT_CHARS.toLocaleString()+' characters.', 'work');
      }
      payload={ kind:'text', text:txt.slice(0, MAX_TEXT_CHARS), name:file.name };
    }
  }catch(_){ setStatus('Could not read the file.', 'err'); return; }

  // Keep a generous note window so merge still sees the full research note.
  const currentNote = (COUNTRY_MARKDOWN[iso]||'').slice(0, 120000);
  const isBlank = !currentNote.trim();

  setStatus(isBlank ? 'Asking Claude to build this country\u2019s note…' : 'Asking Claude to extract relevant detail…', 'work');
  try{
    await assertClaudeProxyReady();
    const proposal = await callClaude(iso, currentNote, payload, isBlank, msg => setStatus(msg, 'work'));
    setStatus('', '');
    openModal(proposal, iso);
  }catch(err){
    setStatus('Error: '+(err.message||'request failed'), 'err');
  }
}

// Read a file as a base64 string (no data: prefix), for the Claude document block.
function fileToBase64(file){
  return new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=()=>{ const s=String(r.result); res(s.slice(s.indexOf(',')+1)); };
    r.onerror=()=>rej(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

async function callClaude(iso, currentNote, payload, isBlank, onProgress){
  const sys = isBlank ? BUILD_SYSTEM_PROMPT : EXTRACTION_SYSTEM_PROMPT;
  const instruction = isBlank
    ? `COUNTRY ISO3: ${iso}\n\nThe uploaded document follows. Build the note from it.`
    : `COUNTRY: ${iso}\n\nCURRENT NOTE:\n${currentNote||'(empty)'}\n\nThe uploaded document follows. Extract relevant detail and propose edits. Prefer concise newContent values so the JSON stays complete.`;

  // Build the user content: instruction text + the document (PDF block or inline text).
  let content;
  if(payload.kind==='pdf'){
    content=[
      { type:'text', text:instruction },
      { type:'document', source:{ type:'base64', media_type:'application/pdf', data:payload.data } }
    ];
  } else {
    content = `${instruction}\n\nUPLOADED DOCUMENT:\n${payload.text}`;
  }

  const { text, truncated } = await claudeComplete({
    system: sys,
    userContent: content,
    maxTokens: isBlank ? BUILD_MAX_TOKENS : MERGE_MAX_TOKENS,
    onProgress
  });

  if(isBlank){
    // Build format: markdown note, then ===FIELDS===, then a small JSON object.
    const parsed=parseBuildResponse(text);
    if(!parsed.note){
      throw new Error(truncated
        ? 'The note was too long even after automatic continuation. Try splitting the source file.'
        : 'Could not read the built note. Try again.');
    }
    parsed.__mode='build';
    if(truncated) parsed.__truncated=true;
    return parsed;
  }

  // Merge format: JSON only. Continuation should usually close the JSON; if not,
  // try to salvage a partial edits array before failing.
  let parsed=safeParseJSON(text);
  if(!parsed){
    parsed = salvageMergeJson(text);
  }
  if(!parsed){
    throw new Error(truncated
      ? 'Claude could not finish the edit list for this file even after automatic continuation. Try uploading a focused extract.'
      : 'Claude did not return valid JSON.');
  }
  parsed.__mode='merge';
  if(!parsed.edits) parsed.edits=[];
  if(truncated) parsed.__truncated=true;
  return parsed;
}

/** Best-effort recovery when a merge JSON response is truncated mid-array. */
function salvageMergeJson(text){
  const raw = String(text || '').trim();
  if(!raw) return null;
  // Already valid?
  const direct = safeParseJSON(raw);
  if(direct) return direct;

  // Close a truncated edits array / object if we got useful items.
  let candidate = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const editsIdx = candidate.indexOf('"edits"');
  if(editsIdx < 0) return null;

  // Truncate to last complete edit object, then close brackets.
  const lastComplete = candidate.lastIndexOf('}');
  if(lastComplete < 0) return null;
  candidate = candidate.slice(0, lastComplete + 1);
  // Ensure edits array + root object are closed.
  const openSquares = (candidate.match(/\[/g) || []).length;
  const closeSquares = (candidate.match(/\]/g) || []).length;
  const openBraces = (candidate.match(/\{/g) || []).length;
  const closeBraces = (candidate.match(/\}/g) || []).length;
  candidate += ']'.repeat(Math.max(0, openSquares - closeSquares));
  candidate += '}'.repeat(Math.max(0, openBraces - closeBraces));

  const parsed = safeParseJSON(candidate);
  if(!parsed || !Array.isArray(parsed.edits) || !parsed.edits.length) return null;
  parsed.summary = parsed.summary || 'Partial extract recovered after a long response.';
  return parsed;
}

/* Split a build response into { note, fields:{...} }.
   Note is plain markdown before ===FIELDS===; fields is JSON after it.
   Falls back gracefully if the delimiter is missing. */
function parseBuildResponse(text){
  const t=String(text);
  const idx=t.indexOf('===FIELDS===');
  if(idx<0){
    // No delimiter — treat the whole thing as the note, no structured fields.
    return { note:cleanNote(t.replace(/```/g,'').trim()), fields:{} };
  }
  const note=cleanNote(t.slice(0,idx).replace(/```$/,'').trim());
  const fieldsRaw=t.slice(idx+12);
  const fields=safeParseJSON(fieldsRaw) || {};
  return { note, summary:fields.summary||'', fields };
}

/* Tolerant JSON extraction: strip fences, isolate the outermost {...},
   and retry. Returns null if nothing parseable. */
function safeParseJSON(raw){
  let t=String(raw).replace(/```json|```/g,'').trim();
  try{ return JSON.parse(t); }catch(_){}
  const a=t.indexOf('{'), b=t.lastIndexOf('}');
  if(a>=0 && b>a){
    let slice=t.slice(a,b+1);
    try{ return JSON.parse(slice); }catch(_){}
  }
  return null;
}

/* ----- approval modal ----- */
let PENDING=null; // {iso, mode, edits|note|fields}
function openModal(proposal, iso){
  const body=document.getElementById('modalBody');
  document.getElementById('modalSummary').textContent=proposal.summary||'';

  if(proposal.__mode==='build'){
    // building a brand-new note + structured record
    const note=cleanNote(proposal.note||'');
    PENDING={iso, mode:'build', note, fields:proposal.fields||{}};
    document.getElementById('modalCopy').style.display = note.trim() ? '' : 'none';
    if(!note.trim()){
      body.innerHTML=`<div class="modal-empty">Claude could not build a note from that file.</div>`;
      document.getElementById('modalApply').style.display='none';
    } else {
      document.getElementById('modalApply').style.display='';
      const f=PENDING.fields;
      const chips=[f.market_classification,f.priority_tier,f.central_hub_status]
        .filter(Boolean).map(x=>`<span class="ec-action" style="background:var(--blue-s);color:var(--blue)">${escapeHtml(x)}</span>`).join(' ');
      const warn = proposal.__truncated
        ? `<div style="font-size:11.5px;color:var(--mid);background:var(--mid-s);border-radius:8px;padding:8px 10px;margin-bottom:10px">⚠ The note may be slightly cut off (long source). Review before applying.</div>` : '';
      body.innerHTML=`
        ${warn}
        <div class="edit-card">
          <div class="ec-top">${chips}</div>
          <div style="font-size:12px;color:var(--ink-2);margin-bottom:8px">Opportunity ${f.opportunity_score??'—'} · Automation ${f.automation_rate_estimate??'—'}% · ${escapeHtml(f.market_aum_band||'')}</div>
          <div class="ec-content">${escapeHtml(note.slice(0,1400))}${note.length>1400?'\n…':''}</div>
          <label class="ec-check"><input type="checkbox" id="bcheck" checked> Create this country profile and note</label>
        </div>`;
    }
    document.getElementById('modalVeil').classList.add('open');
    return;
  }

  // merge mode (existing note)
  PENDING={iso, mode:'merge', edits:proposal.edits||[]};
  document.getElementById('modalCopy').style.display='none';
  if(!PENDING.edits.length){
    body.innerHTML=`<div class="modal-empty">No relevant order-routing content was found to add.</div>`;
    document.getElementById('modalApply').style.display='none';
  } else {
    document.getElementById('modalApply').style.display='';
    body.innerHTML=PENDING.edits.map((ed,i)=>`
      <div class="edit-card">
        <div class="ec-top"><span class="ec-action">${(ed.action||'add')}</span><span class="ec-section">${escapeHtml(ed.section||'(no heading)')}</span></div>
        <div class="ec-content">${escapeHtml(ed.newContent||'')}</div>
        <label class="ec-check"><input type="checkbox" data-i="${i}" checked> Apply this change</label>
      </div>`).join('');
  }
  document.getElementById('modalVeil').classList.add('open');
}

/* Strip stray JSON field labels a model sometimes leaks at the start. */
function cleanNote(s){
  return String(s).replace(/^\s*"?(note|newContent)"?\s*:?\s*/i,'').trim();
}
function closeModal(){ document.getElementById('modalVeil').classList.remove('open'); PENDING=null; }
function escapeHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

document.getElementById('modalClose').addEventListener('click',closeModal);
document.getElementById('modalCancel').addEventListener('click',closeModal);
document.getElementById('modalCopy').addEventListener('click',()=>{
  if(!PENDING || PENDING.mode!=='build') return;
  const snippet=buildRecordSnippet(PENDING.iso, PENDING.fields||{}, PENDING.note||'');
  navigator.clipboard.writeText(snippet).then(
    ()=>{ const b=document.getElementById('modalCopy'); const t=b.textContent; b.textContent='Copied ✓'; setTimeout(()=>b.textContent=t,1600); },
    ()=>{ alert('Copy failed — your browser blocked clipboard access.'); }
  );
});

/* Produce paste-ready code: a COUNTRY_DATA record + a COUNTRY_MARKDOWN entry,
   so the country survives a reload when pasted into the file. */
function buildRecordSnippet(iso, f, note){
  const q=s=>JSON.stringify(s==null?'':String(s));
  const arr=Array.isArray(f.flow_diagram)?f.flow_diagram:[];
  const flow=arr.map(s=>`      {label:${q(s.label)}, mode:${q(s.mode||'mixed')}}`).join(',\n');
  const rec =
`  // ---- paste this inside COUNTRY_DATA ----
  ${q(iso)}: {
    country:${q(f.country||iso)}, iso3:${q(iso)}, region:${q(f.region||'Asia')}, subregion:${q(f.subregion||'')},
    market_classification:${q(f.market_classification||'Unknown')},
    central_hub_status:${q(f.central_hub_status||'No central hub')}, hub_name:${q(f.hub_name||'—')}, operator:${q(f.operator||'—')},
    opportunity_score:${clampNum(f.opportunity_score,60)}, automation_rate_estimate:${clampNum(f.automation_rate_estimate,50)},
    priority_tier:${q(f.priority_tier||'Watch')}, existing_network_presence:${q(f.existing_network_presence||'None')},
    market_aum_band:${q(f.market_aum_band||'—')},
    mutual_fund_relevance:${q(f.mutual_fund_relevance||'')},
    growth_signal:${q(f.growth_signal||'')},
    dominant_order_model:${q(f.dominant_order_model||'')},
    current_order_channels:${q(f.current_order_channels||'')},
    manuality_snapshot:${q(f.manuality_snapshot||'')},
    regulatory_openness:${q(f.regulatory_openness||'')},
    risks_or_barriers:${q(f.risks_or_barriers||'')},
    flow_image:"", flow_diagram:[\n${flow}\n    ],
    last_updated:${q(new Date().toISOString().slice(0,7))}
  },`;
  // Use a placeholder for the backtick so we don't break this template string.
  const BT=String.fromCharCode(96);
  const md =
`  // ---- paste this inside COUNTRY_MARKDOWN ----
  ${q(iso)}: ${BT}${note.replace(new RegExp(BT,'g'), '\\'+BT)}${BT},`;
  return rec + '\n\n' + md + '\n';
}
document.getElementById('modalVeil').addEventListener('click',e=>{ if(e.target.id==='modalVeil') closeModal(); });

document.getElementById('modalApply').addEventListener('click',()=>{
  if(!PENDING) return;
  const iso=PENDING.iso;

  if(PENDING.mode==='build'){
    const c=document.getElementById('bcheck');
    if(c && !c.checked){ closeModal(); return; }
    // 1) save the note
    COUNTRY_MARKDOWN[iso]=PENDING.note;
    // 2) create a structured record so the country colours + scores
    const f0=PENDING.fields||{};
    COUNTRY_DATA[iso]={
      country:f0.country||iso, iso3:iso,
      region:f0.region||'Asia', subregion:f0.subregion||'',
      market_classification:f0.market_classification||'Unknown',
      central_hub_status:f0.central_hub_status||'No central hub',
      hub_name:f0.hub_name||'—', operator:f0.operator||'—',
      opportunity_score:clampNum(f0.opportunity_score,60),
      automation_rate_estimate:clampNum(f0.automation_rate_estimate,50),
      priority_tier:f0.priority_tier||'Watch',
      existing_network_presence:f0.existing_network_presence||'None',
      market_aum_band:f0.market_aum_band||'—',
      mutual_fund_relevance:f0.mutual_fund_relevance||'',
      growth_signal:f0.growth_signal||'', dominant_order_model:f0.dominant_order_model||'',
      current_order_channels:f0.current_order_channels||'', manuality_snapshot:f0.manuality_snapshot||'',
      regulatory_openness:f0.regulatory_openness||'', risks_or_barriers:f0.risks_or_barriers||'',
      flow_image:'', flow_diagram:Array.isArray(f0.flow_diagram)?f0.flow_diagram:[],
      last_updated:new Date().toISOString().slice(0,7)
    };
    closeModal();
    saveData(iso, 'claude');     // persist to Neon + local cache
    refreshGlobe();              // recolour the globe now that the record exists
    afterFilter();              // refresh counts/legend
    const f=world.find(ft=>featISO(ft)===iso);
    if(f) openDrawer(f);        // reopen as a full profiled panel
    setStatus('Profile and note created for this country.', 'ok');
    return;
  }

  // merge mode
  const checks=[...document.querySelectorAll('#modalBody input[type=checkbox]')];
  const chosen=checks.filter(c=>c.checked).map(c=>PENDING.edits[+c.dataset.i]);
  let note=COUNTRY_MARKDOWN[iso]||'';
  chosen.forEach(ed=>{ note=applyEdit(note, ed); });
  COUNTRY_MARKDOWN[iso]=note;
  saveData(iso, 'claude');       // persist to Neon + local cache
  closeModal();
  const f=world.find(ft=>featISO(ft)===iso);
  if(f){ const wasWide=drawer.classList.contains('wide'); openDrawer(f);
    if(wasWide){ toggleDetail(); } }
  setStatus('Changes applied to the note in the app.', 'ok');
});

function clampNum(v, dflt){ const n=Number(v); return Number.isFinite(n)?Math.max(0,Math.min(100,Math.round(n))):dflt; }

/* Append newContent under the matching "## heading". If not found, append a
   new section at the end. Never deletes existing text. */
function applyEdit(note, ed){
  const heading=(ed.section||'').trim();
  const content=(ed.newContent||'').trim();
  if(!content) return note;
  if(heading){
    // find a line that is "## <heading>" (any heading level), case-insensitive
    const lines=note.split('\n');
    let idx=-1;
    for(let i=0;i<lines.length;i++){
      const m=lines[i].match(/^#{1,6}\s+(.*)$/);
      if(m && m[1].trim().toLowerCase()===heading.toLowerCase()){ idx=i; break; }
    }
    if(idx>=0){
      // find end of this section (next heading of same/higher level or EOF)
      let j=idx+1;
      while(j<lines.length && !/^#{1,6}\s+/.test(lines[j])) j++;
      lines.splice(j,0,'',content,'');
      return lines.join('\n');
    }
    // heading not found → add it as a new section
    return note.replace(/\s*$/,'') + `\n\n## ${heading}\n\n${content}\n`;
  }
  return note.replace(/\s*$/,'') + `\n\n${content}\n`;
}

function renderLegend(){
  const L=LEGENDS[MODE];
  document.getElementById('legendTitle').textContent=L.title;
  document.getElementById('legendItems').innerHTML=L.items.map(i=>`<div class="item"><span class="sw" style="background:${i.c}"></span>${i.t}</div>`).join('');
}
function refreshGlobe(){if(!globe)return;globe.polygonCapColor(polyCapColor).polygonStrokeColor(polyStrokeColor).polygonAltitude(polyAltitude);}

function uniq(field){const s=new Set();Object.values(COUNTRY_DATA).forEach(r=>{if(r[field])s.add(r[field]);});return[...s].sort();}
function fillSelect(id,vals){const sel=document.getElementById(id);vals.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;sel.appendChild(o);});}
function initFilters(){
  fillSelect('f-region',uniq('region'));fillSelect('f-class',uniq('market_classification'));
  fillSelect('f-hub',uniq('central_hub_status'));fillSelect('f-tier',uniq('priority_tier'));
  fillSelect('f-net',uniq('existing_network_presence'));
  const map={'f-region':'region','f-class':'cls','f-hub':'hub','f-tier':'tier','f-net':'net'};
  Object.keys(map).forEach(id=>document.getElementById(id).addEventListener('change',e=>{FILTERS[map[id]]=e.target.value;afterFilter();}));
  document.getElementById('f-highopp').addEventListener('change',e=>{FILTERS.highopp=e.target.checked;afterFilter();});
  document.getElementById('clearFilters').addEventListener('click',()=>{
    Object.keys(FILTERS).forEach(k=>FILTERS[k]=k==='highopp'?false:'');
    ['f-region','f-class','f-hub','f-tier','f-net'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('f-highopp').checked=false;afterFilter();
  });
}
function activeFilterCount(){let n=0;['region','cls','hub','tier','net'].forEach(k=>{if(FILTERS[k])n++;});if(FILTERS.highopp)n++;return n;}
function afterFilter(){
  const n=activeFilterCount(),badge=document.getElementById('filterBadge');
  if(n>0){badge.style.display='inline-block';badge.textContent=n;}else badge.style.display='none';
  const matches=Object.values(COUNTRY_DATA).filter(r=>passesFilters(r)).length;
  document.getElementById('matchCount').textContent=`${matches} profiled market${matches!==1?'s':''} match`;
  refreshGlobe();refreshSuggestions(document.getElementById('search').value);
}

const searchEl=document.getElementById('search'),sugEl=document.getElementById('suggestions');
function searchablePool(){return Object.values(COUNTRY_DATA).filter(r=>passesFilters(r));}
function refreshSuggestions(q){
  q=(q||'').trim().toLowerCase();
  if(!q){sugEl.classList.remove('open');sugEl.innerHTML='';return;}
  const pool=searchablePool().filter(r=>r.country.toLowerCase().includes(q)||r.iso3.toLowerCase().includes(q)||r.region.toLowerCase().includes(q)).slice(0,8);
  sugEl.innerHTML=pool.length?pool.map(r=>`<div class="row" data-iso="${r.iso3}"><span class="nm">${r.country}</span><span class="tag">${r.iso3} · ${r.priority_tier}</span></div>`).join(''):`<div class="row empty">No matching profiled market</div>`;
  sugEl.classList.add('open');
}
searchEl.addEventListener('input',e=>refreshSuggestions(e.target.value));
searchEl.addEventListener('focus',e=>{if(e.target.value)refreshSuggestions(e.target.value);});
sugEl.addEventListener('click',e=>{const row=e.target.closest('.row[data-iso]');if(!row)return;flyToISO(row.dataset.iso);sugEl.classList.remove('open');searchEl.value='';});
document.addEventListener('click',e=>{if(!e.target.closest('.search-wrap'))sugEl.classList.remove('open');});
searchEl.addEventListener('keydown',e=>{if(e.key==='Enter'){const f=sugEl.querySelector('.row[data-iso]');if(f){flyToISO(f.dataset.iso);sugEl.classList.remove('open');searchEl.value='';}}});

function centroid(f){let lats=[],lngs=[];const g=f.geometry;if(!g)return null;const polys=g.type==='Polygon'?[g.coordinates]:g.coordinates;polys.forEach(p=>p[0].forEach(c=>{lngs.push(c[0]);lats.push(c[1]);}));if(!lats.length)return null;return{lat:(Math.min(...lats)+Math.max(...lats))/2,lng:(Math.min(...lngs)+Math.max(...lngs))/2};}
function flyToISO(iso){const f=world.find(ft=>featISO(ft)===iso);if(!f)return;selectedISO=iso;const c=centroid(f);if(c)globe.pointOfView({lat:c.lat,lng:c.lng,altitude:1.7},1100);refreshGlobe();openDrawer(f);}

document.getElementById('modeSeg').addEventListener('click',e=>{const b=e.target.closest('button[data-mode]');if(!b)return;document.querySelectorAll('#modeSeg button').forEach(x=>x.classList.remove('active'));b.classList.add('active');MODE=b.dataset.mode;renderLegend();refreshGlobe();});
document.getElementById('filterBtn').addEventListener('click',()=>{const p=document.getElementById('filterPanel');const o=p.classList.toggle('open');document.getElementById('filterBtn').classList.toggle('active',o);});
document.getElementById('saveBtn').addEventListener('click',exportData);
document.getElementById('loadBtn').addEventListener('click',()=>{
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.json,application/json';
  inp.onchange=()=>{ if(inp.files[0]) importData(inp.files[0]); }; inp.click();
});

fetch('https://unpkg.com/world-atlas@2.0.2/countries-110m.json').then(r=>r.json()).then(async topology=>{
  const geo=topojson.feature(topology,topology.objects.countries);
  world=geo.features;
  world.forEach(f=>{f.iso_a3=NAME_TO_ISO[f.properties.name]||null;});
  loadSavedData();   // local cache first for fast paint
  const fromDb = await loadAtlasFromDb(); // Neon wins when reachable
  if(!STORAGE_OK && !fromDb) showSaveBanner();
  globe=Globe()(document.getElementById('globeViz'))
    .backgroundColor('rgba(0,0,0,0)')
    .showAtmosphere(true).atmosphereColor('#7fb8d8').atmosphereAltitude(0.16)
    .showGlobe(true)
    .polygonsData(world).polygonAltitude(polyAltitude).polygonCapColor(polyCapColor)
    .polygonSideColor(polySideColor).polygonStrokeColor(polyStrokeColor)
    .polygonsTransitionDuration(300).onPolygonHover(handleHover).onPolygonClick(handleClick);
  const m=globe.globeMaterial();m.color=new THREE.Color('#eaf1f6');m.emissive=new THREE.Color('#dce8f0');m.emissiveIntensity=0.4;m.shininess=0.5;
  const ctr=globe.controls();ctr.autoRotate=true;ctr.autoRotateSpeed=0.32;ctr.enableDamping=true;ctr.dampingFactor=0.08;ctr.minDistance=160;ctr.maxDistance=600;
  let ui=false;function stop(){if(!ui){ctr.autoRotate=false;ui=true;}}
  const v=document.getElementById('globeViz');v.addEventListener('pointerdown',stop);v.addEventListener('wheel',stop);
  globe.pointOfView({lat:25,lng:10,altitude:2.4},0);
  renderLegend();initFilters();afterFilter();
  document.getElementById('loader').classList.add('hide');setTimeout(()=>document.getElementById('loader').remove(),700);
  addEventListener('resize',()=>{globe.width(innerWidth);globe.height(innerHeight);});globe.width(innerWidth);globe.height(innerHeight);
}).catch(err=>{document.getElementById('loader').innerHTML='<div class="lt" style="color:var(--bad)">Failed to load map data — check network access</div>';console.error(err);});

let hoverFeat=null;
function handleHover(f,prev){if(prev)prev.__hover=false;if(hoverFeat&&hoverFeat!==f)hoverFeat.__hover=false;hoverFeat=f;document.getElementById('globeViz').style.cursor=f?'pointer':'grab';if(f)f.__hover=true;refreshGlobe();if(!f)hideTooltip();}
document.getElementById('globeViz').addEventListener('mousemove',e=>{if(hoverFeat)showTooltip(hoverFeat,e.clientX,e.clientY);else hideTooltip();});
function handleClick(f){if(!f)return;selectedISO=featISO(f);const c=centroid(f);if(c)globe.pointOfView({lat:c.lat,lng:c.lng,altitude:1.7},1100);refreshGlobe();openDrawer(f);if(EDIT_MODE)console.log('Record:',recordFor(f)||('No profile for '+featISO(f)));}
addEventListener('keydown',e=>{if(e.key==='Escape'){if(document.getElementById('modalVeil').classList.contains('open')){closeModal();return;}closeDrawer();document.getElementById('filterPanel').classList.remove('open');document.getElementById('filterBtn').classList.remove('active');}});

/* ================================================================
   =====================   AI CHATBOT   =========================
   ================================================================
   Floating assistant on the main page. Uses the same API key/model.
   It is given a compact summary of all country data as context so it
   can answer questions about your research, plus general questions. */

const CHAT_SYSTEM_PROMPT = `You are the Atlas Assistant inside Calastone's Global Order-Routing Atlas, a tool about mutual fund order-routing infrastructure by country.

You may be given a CONTEXT block summarising the countries currently profiled in the app (hub status, scores, key facts). Use it when the user asks about specific markets or comparisons. You can also answer general questions using your own knowledge.

Be concise and factual. Spell out acronyms in full on first use with the abbreviation in brackets. When you are unsure or the app's data does not cover something, say so plainly rather than inventing figures. Use short paragraphs; use **bold** sparingly for key terms.`;

let CHAT_HISTORY=[];           // [{role, content}]
let chatBusy=false;

function chatContextSummary(){
  // Build a compact, token-efficient summary of profiled countries.
  const rows=Object.values(COUNTRY_DATA).map(r=>
    `${r.country} (${r.iso3}): ${r.market_classification}, ${r.central_hub_status}; opp ${r.opportunity_score}, automation ${r.automation_rate_estimate}%, ${r.priority_tier}; ${r.dominant_order_model}`
  );
  return 'CONTEXT — profiled markets in the app:\n'+rows.join('\n');
}

const chatFab=document.getElementById('chatFab');
const chatPanel=document.getElementById('chatPanel');
const chatLog=document.getElementById('chatLog');
const chatInput=document.getElementById('chatInput');
const chatSend=document.getElementById('chatSend');

function openChat(){
  chatPanel.classList.add('open'); chatFab.classList.add('hidden');
  if(!CHAT_HISTORY.length){
    chatLog.innerHTML=`<div class="chat-welcome">Hi — I'm the <b>Atlas Assistant</b>.<br>Ask me about any market's order-routing setup, compare countries, or anything else.</div>`;
  }
  setTimeout(()=>chatInput.focus(),50);
}
function closeChat(){ chatPanel.classList.remove('open'); chatFab.classList.remove('hidden'); }
function clearChat(){ CHAT_HISTORY=[]; chatLog.innerHTML=`<div class="chat-welcome">Conversation cleared. Ask me anything.</div>`; }

chatFab.addEventListener('click',openChat);
document.getElementById('chatClose').addEventListener('click',closeChat);
document.getElementById('chatClear').addEventListener('click',clearChat);

chatInput.addEventListener('input',()=>{ chatInput.style.height='auto'; chatInput.style.height=Math.min(chatInput.scrollHeight,90)+'px'; });
chatInput.addEventListener('keydown',e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendChat(); } });
chatSend.addEventListener('click',sendChat);

function addMsg(role, text){
  const d=document.createElement('div'); d.className='chat-msg '+role;
  d.innerHTML = role==='bot' ? renderChatMarkdown(text) : escapeHtml(text);
  chatLog.appendChild(d); chatLog.scrollTop=chatLog.scrollHeight;
  return d;
}
// light markdown for bot replies: bold, code, line breaks
function renderChatMarkdown(s){
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/`([^`]+)`/g,'<code>$1</code>');
}

async function sendChat(){
  if(chatBusy) return;
  const text=chatInput.value.trim(); if(!text) return;
  // clear welcome on first message
  if(!CHAT_HISTORY.length){ chatLog.innerHTML=''; }
  addMsg('user',text);
  chatInput.value=''; chatInput.style.height='auto';
  CHAT_HISTORY.push({role:'user', content:text});

  chatBusy=true; chatSend.disabled=true;
  const typing=document.createElement('div'); typing.className='chat-typing';
  typing.innerHTML='<span></span><span></span><span></span>'; chatLog.appendChild(typing); chatLog.scrollTop=chatLog.scrollHeight;

  try{
    // Send the context as a system addendum + the running history (cap to last 12 turns).
    const sys = CHAT_SYSTEM_PROMPT + '\n\n' + chatContextSummary();
    const msgs = CHAT_HISTORY.slice(-12);
    const res=await anthropicMessages({ model:CLAUDE_MODEL, max_tokens:1024, system:sys, messages:msgs });
    typing.remove();
    if(!res.ok){
      let detail=''; try{ const j=await res.json(); detail=j.error?.message||''; }catch(_){}
      const e=document.createElement('div'); e.className='chat-err'; e.textContent=formatClaudeHttpError(res.status, detail); chatLog.appendChild(e);
    } else {
      const data=await res.json();
      const reply=(data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim() || '(no reply)';
      addMsg('bot',reply);
      CHAT_HISTORY.push({role:'assistant', content:reply});
    }
  }catch(err){
    typing.remove();
    const e=document.createElement('div'); e.className='chat-err'; e.textContent=(err.message||'Network error — request failed'); chatLog.appendChild(e);
  }finally{
    chatBusy=false; chatSend.disabled=false; chatLog.scrollTop=chatLog.scrollHeight; chatInput.focus();
  }
}

/* NAME -> ISO3 (world-atlas exposes only country names) */
const NAME_TO_ISO={
  "United Kingdom":"GBR","Australia":"AUS","Brazil":"BRA","Singapore":"SGP","Hong Kong":"HKG",
  "Japan":"JPN","United States of America":"USA","United States":"USA","Luxembourg":"LUX","India":"IND",
  "Germany":"DEU","South Africa":"ZAF","United Arab Emirates":"ARE","Switzerland":"CHE",
  "France":"FRA","Italy":"ITA","Spain":"ESP","Netherlands":"NLD","Ireland":"IRL","Canada":"CAN",
  "Mexico":"MEX","China":"CHN","South Korea":"KOR","Taiwan":"TWN","Thailand":"THA","Malaysia":"MYS",
  "Indonesia":"IDN","Philippines":"PHL","Vietnam":"VNM","New Zealand":"NZL","Sweden":"SWE","Norway":"NOR",
  "Denmark":"DNK","Finland":"FIN","Belgium":"BEL","Austria":"AUT","Portugal":"PRT","Poland":"POL",
  "Saudi Arabia":"SAU","Qatar":"QAT","Israel":"ISR","Turkey":"TUR","Egypt":"EGY","Nigeria":"NGA",
  "Kenya":"KEN","Argentina":"ARG","Chile":"CHL","Colombia":"COL","Peru":"PER"
};
