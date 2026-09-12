
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

/* ================================================================
   ==============   OPPORTUNITY SCORING MODEL   ==================
   ================================================================
   Opportunity scores are derived, never hand-typed. Five weighted
   categories (total 100):

     Manual operations intensity      30
     Market size & growth             20
     Network density & reachability   20
     Regulatory tailwinds/complexity  15
     Go-to-market feasibility         15

   Each category is built from named sub-indicators, and every
   indicator resolves through the same precedence chain — best
   evidence first:

     stated   an explicit number/enum in the record's `indicators`
     derived  computed from another structured field (automation
              rate, hub status, flow diagram, parsed AUM figure)
     inferred a phrase match against the profile text + note
     assumed  neutral fallback; contributes nothing to confidence

   The chain is the point. The old model read almost everything off
   phrase matches, so a rewording of a narrative line moved a score.
   Now a market with real indicators is scored on those numbers, the
   drawer shows which categories earned which points, and the
   confidence figure says how much of the score rests on evidence
   rather than on wording. */

const OPPORTUNITY_MODEL_VERSION = 2;

/* How much each evidence class counts toward a record's confidence.
   `estimated` is a stated indicator on a record marked
   indicators_basis:"estimate" — an analyst's structural read of the
   market rather than a figure lifted from a source pack. It moves the
   score exactly as a stated value does, but it must not claim the
   confidence of one. */
const CONFIDENCE_BY_SOURCE = Object.freeze({
  stated:1, derived:0.8, estimated:0.65, inferred:0.45, assumed:0
});

/* Strategic coverage decisions take precedence over inferred market
   headroom, and are surfaced in the drawer rather than applied silently.

   Both entries are the same case: a universal domestic utility already
   routes every order, so the market's size and counterparty count are
   real but unreachable. A weighted sum cannot express "large but fully
   served" — 50% of the model's weight sits on market size and network
   density, which stay high however saturated the market is — so the
   judgement is recorded here instead of being tuned into the inputs. */
const OPPORTUNITY_SCORE_OVERRIDES = Object.freeze({
  AUS:{ score:25, reason:'Calastone already provides near-complete coverage of this market — no incremental routing headroom.' },
  USA:{ score:22, reason:'DTCC/NSCC Fund/SERV is an entrenched universal domestic order-routing utility. Order flow is ~98% straight-through, so there is no addressable manual-processing gap despite the market being the largest in the world.' }
});

/* ---------- small numeric helpers ---------- */
/* null and '' must not become 0 here: Number(null) is 0, so a parser
   that found nothing would otherwise read as a hard zero. */
function toNum(v){
  if(v==null || v==='') return null;
  const n=Number(v);
  return Number.isFinite(n)?n:null;
}
function clamp01(v){ return v==null?null:Math.max(0,Math.min(1,v)); }
function pct01(v){ const n=toNum(v); return n==null?null:clamp01(n/100); }
function inv01(v){ return v==null?null:1-v; }
/** Position of v on a log scale between lo and hi, clamped to 0–1. */
function logScale(v, lo, hi){
  const n=toNum(v);
  if(n==null || n<=0) return null;
  return clamp01((Math.log10(n)-Math.log10(lo))/(Math.log10(hi)-Math.log10(lo)));
}
/** Piecewise-linear lookup over [[x,y],…] sorted by x. */
function curve(v, points){
  const n=toNum(v);
  if(n==null) return null;
  if(n<=points[0][0]) return points[0][1];
  for(let i=1;i<points.length;i++){
    const [x0,y0]=points[i-1], [x1,y1]=points[i];
    if(n<=x1) return y0+(y1-y0)*((n-x0)/((x1-x0)||1));
  }
  return points[points.length-1][1];
}
function enumScale(v, map){
  if(v==null) return null;
  const k=String(v).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(map,k) ? map[k] : null;
}

/* ---------- evidence wrappers ---------- */
function stated(value, evidence){ const v=clamp01(value); return v==null?null:{value:v, source:'stated', evidence}; }
function derived(value, evidence){ const v=clamp01(value); return v==null?null:{value:v, source:'derived', evidence}; }
/** Ordered bands: the FIRST band with a matching phrase wins, so list
    the phrases that should dominate (usually the negatives) first. */
function inferred(text, bands){
  for(const [value, phrases] of bands){
    const hit=phrases.find(p=>text.includes(p));
    if(hit) return {value:clamp01(value), source:'inferred', evidence:'"'+hit+'"'};
  }
  return null;
}
/** Prior used when the record says nothing. Carries a value but no
    confidence, so "we assume most markets have no T+1 mandate" never
    reads as "this market was checked". */
function assumed(value, evidence){ return {value:clamp01(value), source:'assumed', evidence}; }
/** First candidate that resolved; neutral 0.5 if none did. */
function pick(...candidates){
  for(const c of candidates) if(c && c.value!=null) return c;
  return {value:0.5, source:'assumed', evidence:'no evidence in record'};
}
/** Re-use a resolved candidate as a proxy for a related indicator. A
    proxy is never better than derived, however good its own source. */
function proxy(base, factor, evidence){
  if(!base || base.value==null) return null;
  return { value:clamp01(base.value*factor),
           source: base.source==='stated' ? 'derived' : base.source,
           evidence };
}
/** Weighted mix of two resolved candidates, keeping the weaker source
    so confidence never claims more than the evidence supports. */
function blend(a, b, bShare){
  if(!a || a.value==null) return b || null;
  if(!b || b.value==null) return a;
  const weaker = CONFIDENCE_BY_SOURCE[a.source] <= CONFIDENCE_BY_SOURCE[b.source] ? a : b;
  return {
    value: clamp01(a.value*(1-bShare) + b.value*bShare),
    source: weaker.source,
    evidence: [a.evidence,b.evidence].filter(Boolean).join(' + ')
  };
}

/* ---------- parsers over the free-text fields ---------- */
/* Rough spot rates, only ever used to put an AUM band on a common
   log scale — a 10% FX move cannot shift a score by a whole point. */
const FX_TO_USD = Object.freeze({
  'us$':1,'usd':1,'$':1,'£':1.27,'gbp':1.27,'€':1.08,'eur':1.08,'chf':1.12,
  'a$':0.66,'aud':0.66,'r$':0.18,'brl':0.18,'₹':0.012,'inr':0.012,
  'rmb':0.14,'cny':0.14,'¥':0.0067,'jpy':0.0067,'s$':0.74,'sgd':0.74,
  'hk$':0.128,'hkd':0.128,'zar':0.055
});
const AUM_RE = /(us\$|hk\$|a\$|s\$|r\$|usd|gbp|eur|aud|brl|inr|rmb|cny|jpy|chf|sgd|hkd|zar|£|€|₹|¥|\$)\s*([\d][\d,.]*)\s*(trillion|tn|t\b|billion|bn|b\b)/gi;
/** Largest credible AUM figure in a band string, in USD billions.
    A stated USD figure wins over a local-currency one for the same market. */
function parseAumUsdBn(band){
  const text=String(band||'').toLowerCase();
  let best=null, bestIsUsd=false;
  for(const m of text.matchAll(AUM_RE)){
    const rate=FX_TO_USD[m[1]];
    const amount=Number(String(m[2]).replace(/,/g,'').replace(/\.$/,''));
    if(rate==null || !Number.isFinite(amount)) continue;
    const bn=amount*(/^(trillion|tn|t)$/.test(m[3].trim())?1000:1)*rate;
    const isUsd=(m[1]==='usd'||m[1]==='us$'||m[1]==='$');
    if(best==null || (isUsd && !bestIsUsd) || (isUsd===bestIsUsd && bn>best)){ best=bn; bestIsUsd=isUsd; }
  }
  return best;
}
/** "~34,000 funds" / "1,200 share classes" → 34000 / 1200. */
function parseFundCount(text){
  let best=null;
  for(const m of String(text||'').matchAll(/([\d][\d,]{2,})\s*(?:registered\s+|mutual\s+|investment\s+)?(?:funds|share classes)\b/g)){
    const n=Number(m[1].replace(/,/g,''));
    if(Number.isFinite(n) && (best==null || n>best)) best=n;
  }
  return best;
}
/** "~10.4% CAGR" / "projected to grow 4.8%" → 10.4 / 4.8. */
function parseCagr(text){
  const t=String(text||'');
  const cagr=t.match(/([\d.]+)\s*%\s*(?:compound|cagr)/i) || t.match(/cagr[^\d]{0,12}([\d.]+)\s*%/i);
  if(cagr) return Number(cagr[1]);
  const grow=t.match(/(?:grow|growth|expand)[^.%]{0,30}?([\d.]+)\s*%/i);
  return grow?Number(grow[1]):null;
}

/* Benchmarks from published fund-market forecasts: ~7–8% CAGR for
   North America and Europe, ~10.4% for APAC ex-Japan. 7.5% therefore
   sits mid-scale and only a clearly above-trend market scores high. */
const CAGR_CURVE = [[0,0.05],[3,0.18],[7.5,0.5],[10.4,0.78],[14,1]];
const HUB_GAP = { 'No central hub':1, 'Partial hub':0.62, 'Full hub':0.18 };
const NETWORK_REACH = { 'Emerging':1, 'Established':0.68, 'None':0.45 };
// Distance from a hub Calastone can already service the market from.
const REGION_HUB_REACH = { 'Europe':0.9, 'Asia':0.8, 'Oceania':0.75, 'Americas':0.55, 'Africa':0.45 };

/* Market scale is resolved once and reused: fund counts and counterparty
   counts are rarely stated anywhere, and both track market size closely
   enough to be a better fallback than a blind 0.5. */
function resolveMarketScale(ctx){
  return pick(
    stated(logScale(ctx.ind.fund_aum_usd_bn,10,25000), 'indicator: fund_aum_usd_bn'),
    derived(logScale(ctx.aumUsdBn,10,25000), 'AUM figure in band'),
    inferred(ctx.text, [
      [1,['largest fund market','largest retail','largest cross-border','among the largest','fourth-largest','4th largest']],
      [0.85,['very large','major regional','major continental','leading private','large distribution','large managed','large domestic','trillions']],
      [0.65,['large','regional gateway','growing market']],
      [0.45,['medium','mid-sized','moderate size']],
      [0.25,['small domestic','small but','small market','limited aum','smaller absolute']]
    ])
  );
}

/** Everything the indicator resolvers read, assembled once per country. */
function scoringContext(profile, note){
  // Ignore any old score declaration in a note so it cannot feed the new score.
  const cleanNote=String(note||'').split(/\r?\n/)
    .filter(line=>!(/opportunity\s+score/i.test(line))).join(' ');
  const join=(...parts)=>parts.filter(Boolean).join(' ').toLowerCase();
  const flow=Array.isArray(profile.flow_diagram)?profile.flow_diagram:[];
  return {
    profile,
    ind: profile.indicators||{},
    text: join(profile.market_aum_band, profile.mutual_fund_relevance, profile.growth_signal,
               profile.dominant_order_model, profile.current_order_channels, profile.manuality_snapshot,
               profile.regulatory_openness, profile.risks_or_barriers, profile.hub_name, profile.operator, cleanNote),
    ops: join(profile.dominant_order_model, profile.current_order_channels, profile.manuality_snapshot, cleanNote),
    growthText: join(profile.growth_signal, profile.mutual_fund_relevance, profile.market_aum_band, cleanNote),
    regText: join(profile.regulatory_openness, cleanNote),
    riskText: join(profile.risks_or_barriers, profile.regulatory_openness, cleanNote),
    automation: pct01(profile.automation_rate_estimate),
    // Share of the drawn order path that is not straight-through.
    manualStages: flow.length
      ? flow.reduce((s,st)=>s+(st.mode==='manual'?1:st.mode==='mixed'?0.5:0),0)/flow.length
      : null,
    aumUsdBn: parseAumUsdBn(profile.market_aum_band)
  };
}

function buildScoringContext(profile, note){
  const ctx=scoringContext(profile, note);
  ctx.marketScale=resolveMarketScale(ctx);
  return ctx;
}

/* The optional `indicators` block on a country record — the "stated"
   rung of the evidence chain. Every field is optional; anything absent
   falls back to derivation or phrase matching. Shared by the validator,
   the extraction prompts and the paste-ready snippet writer so the
   three can never drift apart. */
const INDICATOR_SCHEMA = Object.freeze([
  {key:'stp_rate_pct', type:'pct', hint:'straight-through-processing rate, % of orders'},
  {key:'manual_transfer_pct', type:'pct', hint:'% of transfers / re-registrations handled manually'},
  {key:'legacy_instruction_pct', type:'pct', hint:'% of instructions arriving by fax, email, PDF or portal re-keying'},
  {key:'failed_trade_pct', type:'num', max:100, hint:'% of trades failing or needing repair'},
  {key:'fund_aum_usd_bn', type:'num', max:1e6, hint:'domestic fund AUM in USD billions'},
  {key:'net_flow_trend', type:'enum', values:['Strong inflows','Inflows','Flat','Outflows']},
  {key:'registered_funds', type:'num', max:1e6, hint:'count of registered funds / share classes'},
  {key:'projected_cagr_pct', type:'num', max:100, hint:'projected AUM CAGR, %'},
  {key:'fund_managers', type:'num', max:1e5, hint:'count of distinct fund managers'},
  {key:'transfer_agents', type:'num', max:1e5, hint:'count of transfer agents / administrators'},
  {key:'distributors', type:'num', max:1e5, hint:'count of distributors'},
  {key:'platforms', type:'num', max:1e5, hint:'count of platforms'},
  // Measures how fragmented instruction formats are, not how modern they
  // are: one mandatory domestic standard is not a fragmented market.
  {key:'message_standard', type:'enum', values:['ISO 20022','Single domestic standard','Mixed','Proprietary bilateral','None']},
  {key:'settlement_compression', type:'enum', values:['Mandated','Consultation','Proposed','None']},
  {key:'cross_border_regime', type:'enum', values:['Open passporting','Partial','Restricted','Closed']},
  {key:'reporting_mandate', type:'enum', values:['Standardised mandate','Emerging','None']},
  {key:'regulatory_openness_rating', type:'enum', values:['Very high','High','Moderate-high','Moderate','Low','Closed']},
  {key:'data_localisation', type:'enum', values:['None','Partial','Strict']},
  {key:'licensing_barrier', type:'enum', values:['Low','Moderate','High','Prohibitive']},
  {key:'local_competitor_strength', type:'enum', values:['None','Fragmented','Credible','Dominant']},
  {key:'operating_complexity', type:'enum', values:['Low','Moderate','High']},
  {key:'servicing_hub', type:'text', hint:'existing hub the market can be serviced from'}
]);

/** Keep only well-formed indicator values; drop anything unrecognised. */
function normalizeIndicators(raw){
  if(!raw || typeof raw!=='object' || Array.isArray(raw)) return null;
  const out={};
  INDICATOR_SCHEMA.forEach(f=>{
    const v=raw[f.key];
    if(v==null || v==='') return;
    if(f.type==='pct'){
      const n=toNum(v); if(n==null) return;
      out[f.key]=Math.max(0,Math.min(100,Math.round(n*10)/10));
    }else if(f.type==='num'){
      const n=toNum(v); if(n==null || n<0 || n>f.max) return;
      out[f.key]=Math.round(n*100)/100;
    }else if(f.type==='enum'){
      const match=f.values.find(o=>o.toLowerCase()===String(v).trim().toLowerCase());
      if(match) out[f.key]=match;
    }else{
      const s=String(v).trim();
      if(s && s!=='—' && s!=='-') out[f.key]=s;
    }
  });
  return Object.keys(out).length?out:null;
}

/** The indicators block as prompt text, so Claude fills exactly these keys. */
function indicatorPromptSpec(){
  return INDICATOR_SCHEMA.map(f=>{
    const type=f.type==='enum' ? f.values.join(' | ') : (f.hint||f.type);
    return `      "${f.key}": ${f.type==='enum'||f.type==='text'?`"${type}"`:`0   // ${type}`}`;
  }).join(',\n');
}

/* Every sub-indicator returns 0–1 where 1 = most attractive to Calastone.
   Sub-weights within a category sum to 1. */
const OPPORTUNITY_MODEL = Object.freeze([
  {
    key:'manualOperations', label:'Manual operations intensity', weight:30,
    blurb:'Straight-through-processing gap, manual transfer load, legacy instruction channels and failed trades.',
    parts:[
      { key:'stpGap', label:'STP gap', weight:0.40, resolve:c=>pick(
          stated(inv01(pct01(c.ind.stp_rate_pct)), 'indicator: stp_rate_pct'),
          derived(inv01(c.automation), 'automation estimate'),
          derived(c.manualStages, 'order-flow stages')
        )},
      { key:'manualTransfers', label:'Manual transfers & re-registration', weight:0.20, resolve:c=>pick(
          stated(pct01(c.ind.manual_transfer_pct), 'indicator: manual_transfer_pct'),
          inferred(c.ops, [
            [0.95,['manual re-registration','manual transfer','paper transfer','re-registration is manual']],
            [0.8,['re-keying','rekeying','manual file','manual processing','paper-heavy']],
            [0.2,['automated transfer','electronic re-registration']]
          ]),
          derived(c.manualStages, 'order-flow stages'),
          derived(inv01(c.automation), 'automation estimate')
        )},
      { key:'legacyChannels', label:'Fax / email / PDF instruction load', weight:0.25, resolve:c=>{
          const stated_=stated(pct01(c.ind.legacy_instruction_pct), 'indicator: legacy_instruction_pct');
          if(stated_) return stated_;
          const hit=pick(
            // Positive evidence of legacy channels is checked first: notes
            // routinely expand "STP (straight-through processing)" while
            // describing a fax-and-email market, and the acronym gloss must
            // not outrank the fax.
            inferred(c.ops, [
              [0.95,['fax','paper-heavy','re-keying','rekeying']],
              [0.8,['pdf','csv','email','spreadsheet']],
              [0.6,['proprietary portal','portal','bilateral file exchange','bilateral file']],
              [0.12,['near-complete market coverage','fully automated','centralised automated','straight-through across']],
              [0.35,['partly automated','mixed']]
            ]),
            derived(c.automation==null?null:inv01(c.automation)*0.9, 'automation estimate')
          );
          // Naming a channel says it exists, not how much flow it carries.
          // The STP rate is the ceiling: a 95%-automated market with a
          // "residual fax tail" cannot be a fax-run market.
          if(c.automation==null) return hit;
          const cap=clamp01(inv01(c.automation)+0.25);
          return hit.value<=cap ? hit
            : { value:cap, source:hit.source,
                evidence:(hit.evidence?hit.evidence+', ':'')+'capped by automation estimate' };
        }},
      { key:'failedTrades', label:'Errors & failed trades', weight:0.15, resolve:c=>pick(
          // 8%+ of trades failing or needing repair is treated as the top of the scale.
          stated(toNum(c.ind.failed_trade_pct)==null?null:toNum(c.ind.failed_trade_pct)/8, 'indicator: failed_trade_pct'),
          inferred(c.ops, [
            [0.25,['low error','few fails','minimal exceptions','low failure']],
            [0.9,['settlement fails','failed trades','trade fails','high error','reconciliation breaks','repair rate']],
            [0.7,['errors','breaks','repairs','exceptions']]
          ]),
          derived(c.automation==null?null:inv01(c.automation)*0.8, 'automation estimate')
        )}
    ]
  },
  {
    key:'marketSizeGrowth', label:'Market size & growth', weight:20,
    blurb:'Domestic fund AUM, net new flows, the registered fund universe and projected CAGR.',
    parts:[
      { key:'aumScale', label:'Domestic fund AUM', weight:0.45, resolve:c=>c.marketScale },
      { key:'netFlows', label:'Net new fund flows', weight:0.20, resolve:c=>pick(
          stated(enumScale(c.ind.net_flow_trend,{'strong inflows':1,'inflows':0.75,'flat':0.45,'outflows':0.15}), 'indicator: net_flow_trend'),
          inferred(c.growthText, [
            [0.15,['net outflows','redemptions exceed','shrinking','declining']],
            [1,['record inflows','record capital','strong net inflows','surging','mass adoption']],
            [0.75,['net inflows','inflows','rising domestic','compounding fast']],
            [0.5,['steady','stable','moderate']]
          ]),
          // A market growing above trend is taking money in.
          derived(curve(toNum(c.ind.projected_cagr_pct) ?? parseCagr(c.growthText),
                        [[0,0.15],[5,0.5],[10,0.85],[14,1]]), 'implied by growth rate')
        )},
      { key:'fundUniverse', label:'Registered funds & share classes', weight:0.15, resolve:c=>pick(
          stated(logScale(c.ind.registered_funds,200,40000), 'indicator: registered_funds'),
          derived(logScale(parseFundCount(c.text),200,40000), 'fund count in profile text'),
          inferred(c.text, [
            [0.75,['thousands of funds','many funds','wide fund range']],
            [0.4,['concentrated','few funds','narrow fund range']]
          ]),
          proxy(c.marketScale, 0.9, 'scaled from market size')
        )},
      { key:'growthOutlook', label:'Projected AUM CAGR', weight:0.20, resolve:c=>pick(
          stated(curve(c.ind.projected_cagr_pct, CAGR_CURVE), 'indicator: projected_cagr_pct'),
          derived(curve(parseCagr(c.growthText), CAGR_CURVE), 'growth rate in profile text'),
          inferred(c.growthText, [
            [0.15,['declining','stagnant','mature and stable','volume growth limited']],
            [1,['very strong','fastest-growing','rapid growth','structural retail growth']],
            [0.8,['strong growth','strong;','compounding fast','unlock','reform-driven']],
            [0.6,['growing','growth','expanding']],
            [0.4,['moderate','steady','stable']],
            [0.28,['constrained']]
          ])
        )}
    ]
  },
  {
    key:'networkDensity', label:'Network density & reachability', weight:20,
    blurb:'How many distinct counterparties a hub would connect, how fragmented their formats are, and whether Calastone can already reach them.',
    parts:[
      { key:'counterpartyBreadth', label:'Managers, TAs, distributors & platforms', weight:0.40, resolve:c=>pick(
          stated(logScale(
            ['fund_managers','transfer_agents','distributors','platforms']
              .reduce((s,k)=>{ const n=toNum(c.ind[k]); return n==null?s:(s==null?n:s+n); }, null),
            20, 3000), 'indicator: counterparty counts'),
          inferred(c.text, [
            [0.95,['more than 100','over 100','hundreds of','many small','fragmented administrators','fragmented domestic intermediaries','intermediary-heavy']],
            [0.75,['bank platforms','broad distribution','large distribution','ifas','multiple']],
            [0.45,['bank-dominated','concentrated','handful','few intermediaries']],
            [0.3,['single utility','one dominant']]
          ]),
          // Bigger markets carry more counterparties; a weak proxy, so it sits last.
          proxy(c.marketScale, 0.85, 'scaled from market size')
        )},
      { key:'formatFragmentation', label:'Standards fragmentation & hub gap', weight:0.35, resolve:c=>blend(
          pick(
            stated(enumScale(c.ind.message_standard,
              {'none':1,'proprietary bilateral':0.9,'mixed':0.6,'single domestic standard':0.35,'iso 20022':0.25}),
              'indicator: message_standard'),
            derived(HUB_GAP[c.profile.central_hub_status], 'hub status')
          ),
          inferred(c.text, [
            [1,['no neutral routing','no fund routing utility','no routing utility','proprietary domestic messaging','no iso 20022','fully bilateral']],
            [0.85,['fragmented bilateral','fragmented','bilateral file exchange']],
            [0.65,['bilateral','manual tail','automation gaps','cross-border friction']],
            [0.25,['iso 20022','standardised messaging']]
          ]),
          0.4
        )},
      { key:'reachability', label:'Existing Calastone footprint', weight:0.25, resolve:c=>pick(
          // A foothold makes the rest of the market reachable; full coverage
          // leaves less to win, a cold start costs more to open.
          derived(NETWORK_REACH[c.profile.existing_network_presence], 'network presence')
        )}
    ]
  },
  {
    key:'regulatoryTailwinds', label:'Regulatory tailwinds & complexity', weight:15,
    blurb:'Settlement-cycle compression, cross-border passporting, reporting mandates, and how much localisation offsets them.',
    parts:[
      { key:'settlementCompression', label:'Settlement-cycle compression', weight:0.30, resolve:c=>pick(
          stated(enumScale(c.ind.settlement_compression,{'mandated':1,'consultation':0.75,'proposed':0.6,'none':0.3}), 'indicator: settlement_compression'),
          inferred(c.text, [
            [1,['t+1 mandate','t+0','mandated settlement','settlement compression','shorten the settlement']],
            [0.75,['t+1 consultation','t+1','settlement cycle']],
            [0.3,['t+2','t+3']]
          ]),
          // Silence on settlement cycles almost always means no live mandate.
          assumed(0.35, 'no settlement-cycle mandate recorded')
        )},
      { key:'crossBorderRegime', label:'Cross-border / passporting regime', weight:0.25, resolve:c=>pick(
          stated(enumScale(c.ind.cross_border_regime,{'open passporting':1,'open':1,'partial':0.6,'restricted':0.3,'closed':0.1}), 'indicator: cross_border_regime'),
          inferred(c.text, [
            [0.1,['closed market','prohibited']],
            [0.25,['capital controls','safe quotas','quota','domestic-first','domestic-protective']],
            [1,['passporting','ucits','opening cross-border','cross-border distribution','mutual recognition','gift city']],
            [0.65,['cross-border','regional gateway']]
          ])
        )},
      { key:'reportingMandates', label:'Reporting & standardisation mandates', weight:0.20, resolve:c=>pick(
          stated(enumScale(c.ind.reporting_mandate,{'standardised mandate':1,'emerging':0.6,'none':0.3}), 'indicator: reporting_mandate'),
          inferred(c.text, [
            [1,['standardised reporting','reporting mandate','reporting requirement','iso 20022 migration','cvm 175']],
            [0.6,['reporting','disclosure']]
          ]),
          assumed(0.4, 'no reporting mandate recorded')
        )},
      { key:'regulatoryAccess', label:'Openness net of localisation', weight:0.25, resolve:c=>{
          const openness=pick(
            stated(enumScale(c.ind.regulatory_openness_rating,{'very high':1,'high':0.82,'moderate-high':0.62,'moderate':0.48,'low':0.25,'closed':0.1}), 'indicator: regulatory_openness_rating'),
            inferred(c.regText, [
              [0.1,['closed market','prohibited']],
              [0.25,['tightly managed','domestic-protective','restrictive']],
              [1,['very high','actively opening','actively court','supportive of infrastructure']],
              [0.82,['high —','high -','infrastructure-friendly','politically supported','eu-harmonised']],
              [0.62,['moderate-high','moderate high','reform-minded']],
              [0.48,['moderate —','moderate -','partially open']],
              // Bare ratings, checked last so the qualified phrasings win.
              [0.82,['high']],
              [0.48,['moderate']],
              [0.25,['low']]
            ])
          );
          // Localisation and capital controls discount openness rather than replace it.
          const drag=pick(
            stated(enumScale(c.ind.data_localisation,{'none':1,'partial':0.8,'strict':0.55}), 'indicator: data_localisation'),
            inferred(c.text, [
              [0.55,['data localisation','regulatory localisation','capital controls','data residency','onshore hosting']],
              [0.8,['localisation','local presence required']]
            ]),
            {value:1, source:'derived', evidence:'no localisation signal'}
          );
          return { value:clamp01(openness.value*drag.value), source:openness.source,
                   evidence:[openness.evidence, drag.value<1?drag.evidence:null].filter(Boolean).join(' × ') };
        }}
    ]
  },
  {
    key:'goToMarket', label:'Go-to-market feasibility', weight:15,
    blurb:'Licensing friction, whether a credible incumbent already owns the rails, operating complexity, and hub serviceability.',
    parts:[
      { key:'licensingFriction', label:'Licensing & entry friction', weight:0.35, resolve:c=>pick(
          stated(enumScale(c.ind.licensing_barrier,{'low':1,'moderate':0.6,'high':0.3,'prohibitive':0.08}), 'indicator: licensing_barrier'),
          inferred(c.riskText, [
            [0.15,['prohibited','closed market','foreign-entrant scrutiny','regulatory posture toward foreign providers']],
            [0.35,['regulatory localisation','tightly managed','capital controls','csrc approvals','domestic-protective']],
            [1,['0% corporate','actively court','no licensing requirement','very high']],
            [0.8,['eu-harmonised','infrastructure-friendly','supportive of infrastructure','high']],
            [0.55,['moderate','licensing','approval']]
          ])
        )},
      { key:'competitiveWhitespace', label:'Absence of a dominant incumbent', weight:0.30, resolve:c=>pick(
          stated(enumScale(c.ind.local_competitor_strength,{'none':1,'fragmented':0.85,'credible':0.5,'dominant':0.2}), 'indicator: local_competitor_strength'),
          inferred(c.text, [
            [0.12,['market saturation','dominant domestic utility','already fully covered','near-complete market coverage','incumbent-protected','little friction']],
            [0.3,['entrenched utility','entrenched transfer agents','entrenched registry','entrenched intermediaries','entrenched domestic','dominant clearing','strong domestic infrastructure','bank vertical integration']],
            [0.5,['competitive infrastructure','relationship-driven','relationship-led','vestima','clearstream','allfunds','euroclear']],
            [1,['no neutral routing','no fund routing utility','no routing utility','no central hub']]
          ]),
          // A market already served end-to-end by one hub has an incumbent,
          // whether or not the narrative names it.
          derived(({'Full hub':0.3,'Partial hub':0.55,'No central hub':0.9})[c.profile.central_hub_status], 'hub status')
        )},
      { key:'operatingComplexity', label:'Language, currency & rails complexity', weight:0.20, resolve:c=>pick(
          stated(enumScale(c.ind.operating_complexity,{'low':1,'moderate':0.6,'high':0.3}), 'indicator: operating_complexity'),
          inferred(c.riskText, [
            [0.25,['fx/settlement complexity','currency and regulatory complexity','capital controls','nominee vs','language']],
            [0.45,['currency','fx','price sensitivity','long sales cycles','conservative procurement']],
            [0.9,['eu-harmonised','0% corporate']]
          ]),
          // Developed markets tend to have convertible currencies and
          // established banking rails; frontier ones rarely do.
          derived(({'Developed':0.7,'Emerging':0.45,'Frontier':0.3})[c.profile.market_classification], 'market classification')
        )},
      { key:'hubServiceability', label:'Servable from an existing hub', weight:0.15, resolve:c=>pick(
          stated(c.ind.servicing_hub?1:null, 'indicator: servicing_hub'),
          inferred(c.text, [
            [1,['regional gateway','cross-border hub','offshore hub','gateway']],
            [0.5,['domestic-first']]
          ]),
          derived(REGION_HUB_REACH[c.profile.region], 'region')
        )}
    ]
  }
]);

function calculateOpportunity(profile, note){
  const ctx=buildScoringContext(profile, note);
  // Indicators an analyst estimated still drive the score, but they are
  // not evidence in the way a sourced figure is.
  const estimated=String(profile.indicators_basis||'').toLowerCase()==='estimate';
  const categories=OPPORTUNITY_MODEL.map(cat=>{
    const parts=cat.parts.map(p=>{
      const r=p.resolve(ctx) || {value:0.5, source:'assumed', evidence:'no evidence in record'};
      const source=(estimated && r.source==='stated') ? 'estimated' : r.source;
      return { key:p.key, label:p.label, weight:p.weight,
               value:clamp01(r.value)??0.5, source, evidence:r.evidence||null };
    });
    const value=parts.reduce((s,p)=>s+p.value*p.weight,0);
    const confidence=parts.reduce((s,p)=>s+CONFIDENCE_BY_SOURCE[p.source]*p.weight,0);
    return { key:cat.key, label:cat.label, blurb:cat.blurb, weight:cat.weight, value,
             points:Math.round(value*cat.weight*10)/10, confidence, parts };
  });
  const calculated=Math.max(0,Math.min(100,Math.round(
    categories.reduce((s,c)=>s+c.value*c.weight,0))));
  const confidence=Math.round(100*categories.reduce((s,c)=>s+c.confidence*c.weight,0)/100);
  const override=OPPORTUNITY_SCORE_OVERRIDES[String(profile.iso3||'').toUpperCase()]||null;
  return {
    score: override ? override.score : calculated,
    calculated, override, categories, confidence,
    version: OPPORTUNITY_MODEL_VERSION
  };
}

function confidenceBand(v){
  if(v>=75) return 'High';
  if(v>=55) return 'Moderate';
  if(v>=35) return 'Low';
  return 'Indicative';
}

/* Full per-indicator detail is kept out of COUNTRY_DATA so it never
   travels to Neon or localStorage; only the 5 category totals do. */
const OPPORTUNITY_DETAIL = {};

function recalculateOpportunity(iso3){
  const code=String(iso3||'').toUpperCase(), profile=COUNTRY_DATA[code];
  if(!profile) return null;
  const result=calculateOpportunity(profile, COUNTRY_MARKDOWN[code]||'');
  profile.opportunity_score=result.score;
  profile.opportunity_score_breakdown=Object.fromEntries(
    result.categories.map(c=>[c.key, c.points])
  );
  profile.opportunity_score_confidence=result.confidence;
  OPPORTUNITY_DETAIL[code]=result;
  return result;
}

function recalculateAllOpportunities(){
  Object.keys(COUNTRY_DATA).forEach(recalculateOpportunity);
}

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
  recalculateAllOpportunities();
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
  recalculateAllOpportunities();
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
      console.error('Atlas load failed — showing cached data. HTTP '+res.status+' ('+(ctype||'no content-type')+')');
      DB_OK=false;
      return false;
    }
    const atlas = await res.json();
    if(atlas && atlas.error){
      console.error('Atlas load failed — showing cached data.', atlas.error.message||atlas.error);
      DB_OK=false;
      return false;
    }
    applyAtlasPayload(atlas);
    cacheLocally();
    DB_OK=true;
    return true;
  }catch(err){
    console.error('Atlas load failed — showing cached data.', err);
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
  if(iso3) recalculateOpportunity(iso3);
  else recalculateAllOpportunities();
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
- Read the uploaded document and identify ONLY information relevant to mutual fund order routing: central hubs/CSDs, order channels, automation/manuality, regulators, cross-border routing, key participants, AUM, distribution channels, scores/KPIs.
- Ignore everything not relevant to fund order routing.
- Propose structured edits to the note. Do not rewrite unchanged sections.
- Spell out every acronym in full on first use with the abbreviation in brackets.
- Never delete existing content; only add or revise.
- ALWAYS populate profile_updates with every structured KPI the document supports (AUM, hub status, order model, flow diagram, indicators, etc.). Do not put figures only in the markdown edits — the app's drawer cards and globe colours come from profile_updates.
- If the document is itself a structured country brief / research pack with explicit KPIs, prefer filling profile_updates completely even when few markdown edits are needed.
- flow_diagram must be a complete 4–7 stage path when order routing is described. Never return a one-stage diagram.
- Never return an opportunity score. The app calculates it from the "indicators" block below; a score you invent would be discarded. Instead, fill in every indicator the document supports — those are what move the score.

Respond with JSON ONLY — no prose, no markdown fences — matching exactly:
{
  "summary": "one sentence on what you changed",
  "edits": [
    { "section": "exact ## heading text to place under (omit the ## )",
      "action": "add",
      "newContent": "the markdown to append under that heading" }
  ],
  "profile_updates": {
    "country": "Full country name",
    "region": "Europe | Asia | Americas | Africa | Oceania",
    "subregion": "short text",
    "market_classification": "Developed | Emerging | Frontier | Unknown",
    "central_hub_status": "Full hub | Partial hub | No central hub",
    "hub_name": "name or —",
    "operator": "who runs it or —",
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
    "indicators": {
${indicatorPromptSpec()}
    },
    "flow_diagram": [
      { "label": "Investor / Adviser", "mode": "auto" },
      { "label": "Broker / Platform", "mode": "mixed" },
      { "label": "Central Hub / CSD", "mode": "manual" },
      { "label": "Transfer Agent", "mode": "mixed" },
      { "label": "Fund Manager", "mode": "auto" }
    ]
  }
}
Include only keys in profile_updates that the document supports; omit keys you cannot support. Prefer including the full set when the document is a complete country pack.
If the document has nothing relevant, return {"summary":"No relevant content found","edits":[]}.`;

/* Dedicated pass: fill drawer KPIs / flow diagram from the upload alone. */
const PROFILE_SYSTEM_PROMPT = `You extract structured mutual-fund order-routing profile fields for ONE country from an uploaded document.

The app drawer cards (automation, AUM, hub, priority tier, order-flow diagram) and the calculated opportunity score are populated ONLY from your JSON — not from the research note. Markdown commentary is useless here.

Rules:
- Use only facts supported by the document. Do not invent numbers.
- If the document states AUM, hub status, tiers, automation, or order-path stages, copy them into the matching fields.
- flow_diagram must be a complete 4–7 stage end-to-end path when the document describes order routing. Never return one stage. Each stage: { "label", "mode": "auto"|"mixed"|"manual" }.
- Never return an opportunity score — the app calculates it. Fill the "indicators" block instead: those measurements are what the score is built from. Omit any indicator the document does not support rather than guessing, and use the exact enum wording offered.
- Respond with JSON ONLY — no prose, no markdown fences.

{
  "summary": "one sentence",
  "profile_updates": {
    "country": "Full country name",
    "region": "Europe | Asia | Americas | Africa | Oceania",
    "subregion": "short text",
    "market_classification": "Developed | Emerging | Frontier | Unknown",
    "central_hub_status": "Full hub | Partial hub | No central hub",
    "hub_name": "name or —",
    "operator": "who runs it or —",
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
    "indicators": {
${indicatorPromptSpec()}
    },
    "flow_diagram": [
      { "label": "Investor / Adviser", "mode": "auto" },
      { "label": "Broker / Platform", "mode": "mixed" },
      { "label": "Central Hub / CSD", "mode": "manual" },
      { "label": "Transfer Agent", "mode": "mixed" },
      { "label": "Fund Manager", "mode": "auto" }
    ]
  }
}`;

/* Used when the country has no note yet: build a full note from the document. */
const BUILD_SYSTEM_PROMPT = `You build a new country research note on mutual fund order-routing infrastructure from an uploaded document.

You receive an ISO3 country code and the text of an uploaded document.

Your job:
- Produce ONE complete Markdown research note for this country, capturing only mutual fund order-routing intelligence: market classification, central hub/CSD status, order channels, automation/manuality, regulators, cross-border routing, key participants, AUM, distribution channels, risks.
- Use this structure: a level-1 title (# Country), a blockquote header summarising ISO3/Region/Classification/Hub Status, then ## sections such as Market Overview, How Fund Orders Work Today, Distribution Channels, Key Participants, Risks, and Sources.
- Spell out every acronym in full on first use with the abbreviation in brackets.
- Use only information supported by the document. Do not invent figures.
- If the document states explicit KPIs (automation %, priority tier, AUM band, hub status, network presence, order model, channels, risks), copy those values into the ===FIELDS=== JSON. Do not leave numbers at 0 or text fields blank when the document provides them. Markdown alone is not enough — the drawer cards and globe colours read only from the JSON fields.
- Never return an opportunity score — the app calculates it from the "indicators" block. Fill in every indicator the document supports (STP rate, manual transfer share, fax/email/PDF reliance, failed trades, AUM, flows, fund counts, CAGR, counterparty counts, messaging standard, settlement and reporting mandates, licensing barriers, competitor strength). Omit any indicator the document does not support rather than guessing, and use the exact enum wording offered.

ORDER-FLOW DIAGRAM (required — the app draws this automatically from flow_diagram):
- Always include a complete end-to-end order path in "flow_diagram". Never leave it empty. Never return only one stage.
- Use 4–7 stages in left-to-right order (investor → intermediaries / hubs → fund).
- Each stage is { "label": "short role name", "mode": "auto" | "mixed" | "manual" }.
- mode reflects how that hop is typically processed in this market (auto=fully automated, mixed=partly automated, manual=mostly manual). Infer from the document; if unclear use "mixed".
- Labels must be concrete market roles (e.g. Investor, Broker / Platform, CSD / Hub, Transfer Agent, Fund Manager) — not placeholder text like "Stage".
- Example shape (replace labels/modes for the actual country):
  "flow_diagram": [
    { "label": "Investor / Adviser", "mode": "auto" },
    { "label": "Broker / Platform", "mode": "mixed" },
    { "label": "Central Hub / CSD", "mode": "manual" },
    { "label": "Transfer Agent", "mode": "mixed" },
    { "label": "Fund Manager", "mode": "auto" }
  ]

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
  "indicators": {
${indicatorPromptSpec()}
  },
  "flow_diagram": [
    { "label": "Investor / Adviser", "mode": "auto" },
    { "label": "Broker / Platform", "mode": "mixed" },
    { "label": "Central Hub / CSD", "mode": "manual" },
    { "label": "Transfer Agent", "mode": "mixed" },
    { "label": "Fund Manager", "mode": "auto" }
  ]
}`;


const C = {
  good:'#4a9d5b', mid:'#d79a31', bad:'#cf5a4e',
  developed:'#007DB7', emerging:'#2D9A8E', frontier:'#6AAD6A', unknown:'#a7b3bd',
  none:'#cdd8e1'
};
/* Opportunity uses a red→green heat scale: red is a weak opportunity, green a
   strong one. The old good/mid/bad split gave 11 of 18 markets the same amber,
   which hid the differences the score exists to show.

   Five bands, not more: red→green cannot carry seven steps without two of them
   colliding — a 7-step version put yellow next to yellow-green at ΔE 8.9 (and
   1.0 under protanopia), i.e. the same colour. Hues and lightnesses were
   searched in OKLCH and measured AS RENDERED (painted at OPP_ALPHA over the
   globe): worst adjacent pair ΔE 16.4, above the 15 "tell apart" floor, and
   every band ≥ 19.5 from the "no profile" grey so a low score never reads as
   missing data.

   Known limit: red↔green is the classic colour-vision confusion — under
   deuteranopia the orange and lime bands converge. The score is printed as a
   number in the tooltip and the drawer, and the legend labels every band, so
   colour is never the only channel. */
const OPP_ALPHA = 0.92;
const OPP_BANDS = [
  { min:70, c:'#008244', label:'70 +' },
  { min:60, c:'#6caf00', label:'60 – 69' },
  { min:50, c:'#ebbb00', label:'50 – 59' },
  { min:30, c:'#fe6200', label:'30 – 49' },
  { min:0,  c:'#b7000a', label:'under 30' }
];
function oppColor(v){
  if(v==null) return null;
  return (OPP_BANDS.find(b=>v>=b.min) || OPP_BANDS[OPP_BANDS.length-1]).c;
}
function scoreColor(v){ return oppColor(v); }
function scoreColorInv(v){ if(v==null)return null; if(v>=66)return C.bad; if(v>=40)return C.mid; return C.good; }
function hubColor(s){ if(s==='No central hub')return C.good; if(s==='Partial hub')return C.mid; if(s==='Full hub')return C.bad; return null; }
function classColor(c){ if(c==='Developed')return C.developed; if(c==='Emerging')return C.emerging; if(c==='Frontier')return C.frontier; return C.unknown; }

const LEGENDS = {
  opportunity:{title:'Opportunity',scale:true,items:[{c:C.none,t:'No profile yet'}]},
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
  // The opportunity ramp was validated at OPP_ALPHA — keep the fill opaque
  // enough that the steps land where they were measured.
  const base = MODE==='opportunity' ? OPP_ALPHA : 0.82;
  return hexA(col, selectedISO===rec.iso3 ? Math.min(1, base+0.06) : base);
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

function pillScore(v){const c=oppColor(v)||C.unknown;return`<span class="pill" style="background:${hexA(c,0.16)};color:${c}">${v}</span>`;}
function tierPill(t){const m={'Tier 1':C.good,'Tier 2':C.mid,'Tier 3':C.bad,'Watch':C.unknown};const c=m[t]||C.unknown;return`<span class="pill" style="background:${hexA(c,0.16)};color:${c}">${t}</span>`;}
function classPill(c){const col=classColor(c);return`<span class="pill" style="background:${hexA(col,0.14)};color:${col}">${c}</span>`;}
function hubPill(s){const c=hubColor(s)||C.unknown;return`<span class="pill" style="background:${hexA(c,0.16)};color:${c}">${s}</span>`;}
function netPill(n){const m={'Established':C.good,'Emerging':C.mid,'None':C.unknown};const c=m[n]||C.unknown;return`<span class="pill" style="background:${hexA(c,0.16)};color:${c}">Network: ${n}</span>`;}

const drawer=document.getElementById('drawer');
const drawerContent=document.getElementById('drawerContent');
function openDrawer(f){
  const rec=recordFor(f),name=featName(f);
  clearGlobeHover();
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
        ${relatedDocsPanel(iso)}
        ${renderNotePanel(iso, 'Research note', existingNote, 'No note yet — drop a Markdown file above or edit to create one.')}
      </div>`;
  } else { drawerContent.innerHTML=buildSnapshot(rec); }
  drawer.classList.add('open');
}
function closeDrawer(){drawer.classList.remove('open','wide');selectedISO=null;refreshGlobe();}
window.closeDrawer=closeDrawer;

/* Category-by-category account of where the score came from, plus the
   evidence class behind every sub-indicator. The score is only useful
   if a reader can see which parts of it are measured and which are
   read off a phrase. */
const SOURCE_LABEL = { stated:'Sourced', estimated:'Estimate', derived:'Derived', inferred:'Inferred', assumed:'Assumed' };
function buildScoreBreakdown(r){
  const detail=OPPORTUNITY_DETAIL[r.iso3];
  if(!detail) return '';
  const rows=detail.categories.map(cat=>{
    const pct=Math.round(cat.value*100);
    const col=oppColor(pct)||C.unknown;
    const parts=cat.parts.map(p=>
      `<div class="sb-part">
         <span class="sb-p-name">${escapeHtml(p.label)}</span>
         <span class="sb-p-src ${p.source}">${SOURCE_LABEL[p.source]}</span>
         <span class="sb-p-val">${Math.round(p.value*100)}</span>
       </div>
       ${p.evidence?`<div class="sb-p-ev">${escapeHtml(p.evidence)}</div>`:''}`).join('');
    return `<details class="sb-cat">
      <summary>
        <span class="sb-c-name">${escapeHtml(cat.label)}</span>
        <span class="sb-c-wt">${cat.weight}%</span>
        <span class="sb-c-pts" style="color:${col}">${cat.points.toFixed(1)}<small>/${cat.weight}</small></span>
      </summary>
      <div class="sb-body">
        <div class="sb-bar"><i style="width:${pct}%;background:${col}"></i></div>
        <p class="sb-blurb">${escapeHtml(cat.blurb)}</p>
        ${parts}
      </div>
    </details>`;
  }).join('');
  const conf=detail.confidence;
  const confC=conf>=75?C.good:conf>=45?C.mid:C.bad;
  const override=detail.override
    ? `<div class="sb-override">Manual override in force — published score ${detail.override.score}, model score ${detail.calculated}. ${escapeHtml(detail.override.reason)}</div>`
    : '';
  return `<div class="section score-breakdown"><div class="s-title">How this score was built</div>
    ${override}
    <div class="sb-conf">Evidence confidence <b style="color:${confC}">${conf}/100 · ${confidenceBand(conf)}</b>
      <span>— share of the score backed by sourced, estimated or derived indicators rather than phrase matching.</span></div>
    ${rows}
  </div>`;
}

function buildSnapshot(r){
  const oppC=oppColor(r.opportunity_score)||C.unknown;
  const autoC=r.automation_rate_estimate>=66?C.bad:r.automation_rate_estimate>=40?C.mid:C.good;
  const detail=OPPORTUNITY_DETAIL[r.iso3];
  const scoreDetail=detail
    ? detail.categories.map(c=>`${c.label}: ${c.points.toFixed(1)}/${c.weight}`)
    : [];
  return `
  <button class="drawer-close" onclick="closeDrawer()">×</button>
  <div class="drawer-head">
    <div class="ctry-name">${r.country}</div>
    <div class="ctry-region">${r.region.toUpperCase()} · ${r.subregion} · ${r.iso3}</div>
    <div class="badges">${classPill(r.market_classification)}${tierPill(r.priority_tier)}${hubPill(r.central_hub_status)}${netPill(r.existing_network_presence)}</div>
  </div>
  <div class="scroll">
    <div class="kpis">
      <div class="kpi" title="${scoreDetail.join(' · ')}"><div class="k">Opportunity score · calculated</div><div class="v" style="color:${oppC}">${r.opportunity_score}<small>/100</small></div><div class="bar"><i style="width:${r.opportunity_score}%;background:${oppC}"></i></div></div>
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
      ${buildScoreBreakdown(r)}

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
  return dz + relatedDocsPanel(r.iso3) + renderNotePanel(r.iso3, 'Full research note', md, 'No research note yet for this country.');
}

/* Global library documents tagged with this market (library.js owns the data). */
function relatedDocsPanel(iso){
  if(typeof docsForCountry !== 'function') return '';
  const docs = docsForCountry(iso);
  if(!docs.length) return '';
  const rows = docs.map(d=>{
    const meta=[d.doc_type, d.publisher, d.published_at].filter(Boolean).join(' · ');
    return `<button type="button" class="related-doc" onclick="openLibrary(${d.id})">
      ${escapeHtml(d.title)}<span class="rd-meta">${escapeHtml(meta)}</span>
    </button>`;
  }).join('');
  return `<div class="section">
      <div class="s-title">Related global research</div>
      <div class="related-docs">${rows}</div>
    </div>`;
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
  const f = featureForISO(code);
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
  const f = featureForISO(code);
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
  if(!iso){ setStatus('The globe could not resolve an ISO code for this shape.', 'err'); return; }
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
    ? `COUNTRY ISO3: ${iso}\n\nThe uploaded document follows. Build the note from it. Remember: ===FIELDS=== must include every KPI the document provides (automation_rate_estimate, priority_tier, market_aum_band, hub fields, narrative KPI lines, and the indicators block) plus a complete 4–7 stage flow_diagram. Do not return an opportunity score — the app calculates it from the indicators.`
    : `COUNTRY: ${iso}\n\nCURRENT NOTE:\n${currentNote||'(empty)'}\n\nThe uploaded document follows. Extract relevant detail and propose edits. Prefer concise newContent values so the JSON stays complete. ALWAYS include profile_updates with every KPI the document provides (scoring indicators, automation, AUM, hub, tiers, order model, flow_diagram) — do not only edit the markdown note. Do not return an opportunity score — the app calculates it from the indicators.`;

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
    // If KPIs/diagram came back thin, run a focused profile pass on the same upload.
    const fields = parsed.fields || {};
    const flowLen = Array.isArray(fields.flow_diagram) ? fields.flow_diagram.length : 0;
    const thin = !(fields.market_aum_band && fields.automation_rate_estimate!=null) || !normalizeIndicators(fields.indicators) || flowLen < 4;
    if(thin){
      const profileOnly = await extractProfileUpdates(iso, payload, onProgress);
      if(profileOnly && profileUpdateCount(profileOnly)){
        parsed.fields = { ...fields, ...profileOnly };
        if(Array.isArray(profileOnly.flow_diagram)) parsed.fields.flow_diagram = profileOnly.flow_diagram;
      }
    }
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

  // Always run a dedicated KPI/diagram pass for merge uploads. Note-edit responses
  // frequently omit profile_updates, which leaves stale smoke-test drawer values.
  const fromMerge = normalizeProfileUpdates(parsed.profile_updates || {});
  const flowLen = Array.isArray(fromMerge.flow_diagram) ? fromMerge.flow_diagram.length : 0;
  const needsProfilePass = profileUpdateCount(fromMerge) < 4 || flowLen < 4 || looksLikeStubProfile(COUNTRY_DATA[iso]);
  if(needsProfilePass){
    const profileOnly = await extractProfileUpdates(iso, payload, onProgress);
    parsed.profile_updates = { ...fromMerge, ...(profileOnly || {}) };
    if(profileOnly && Array.isArray(profileOnly.flow_diagram) && profileOnly.flow_diagram.length >= flowLen){
      parsed.profile_updates.flow_diagram = profileOnly.flow_diagram;
    }
  } else {
    parsed.profile_updates = fromMerge;
  }
  return parsed;
}

/** True when the stored profile still looks like a placeholder / smoke test. */
function looksLikeStubProfile(rec){
  if(!rec) return true;
  const blob = [rec.market_aum_band, rec.mutual_fund_relevance, rec.growth_signal, rec.dominant_order_model]
    .map(v => String(v||'').toLowerCase()).join(' | ');
  if(/smoke\s*test|\btest\b|placeholder|todo|tbd/.test(blob)) return true;
  const flow = Array.isArray(rec.flow_diagram) ? rec.flow_diagram : [];
  if(flow.length < 4) return true;
  return false;
}

/** Focused Claude call that returns only normalized profile_updates. */
async function extractProfileUpdates(iso, payload, onProgress){
  const instruction = `COUNTRY ISO3: ${iso}\n\nExtract EVERY structured profile KPI and the order-flow diagram from the uploaded document. Return JSON only.`;
  let content;
  if(payload.kind==='pdf'){
    content=[
      { type:'text', text:instruction },
      { type:'document', source:{ type:'base64', media_type:'application/pdf', data:payload.data } }
    ];
  } else {
    content = `${instruction}\n\nUPLOADED DOCUMENT:\n${payload.text}`;
  }
  if(onProgress) onProgress('Extracting profile KPIs & order-flow diagram…');
  const { text } = await claudeComplete({
    system: PROFILE_SYSTEM_PROMPT,
    userContent: content,
    maxTokens: 2500,
    onProgress: null
  });
  const parsed = safeParseJSON(text) || salvageMergeJson(text) || {};
  const updates = normalizeProfileUpdates(parsed.profile_updates || parsed);
  return updates;
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
  const fields=safeParseJSON(fieldsRaw) || salvageFieldsJson(fieldsRaw) || {};
  if(Array.isArray(fields.flow_diagram)){
    fields.flow_diagram = normalizeFlowDiagram(fields.flow_diagram);
  }
  return { note, summary:fields.summary||'', fields };
}

/** Keep only usable flow stages; coerce mode to auto|mixed|manual. */
function normalizeFlowDiagram(arr){
  return (Array.isArray(arr)?arr:[])
    .map(s=>{
      if(!s || typeof s!=='object') return null;
      const label=String(s.label||'').trim();
      if(!label || /^stage$/i.test(label)) return null;
      let mode=String(s.mode||'mixed').toLowerCase();
      if(mode!=='auto' && mode!=='manual' && mode!=='mixed') mode='mixed';
      return { label, mode };
    })
    .filter(Boolean);
}

const PROFILE_TEXT_KEYS = [
  'country','region','subregion','market_classification','central_hub_status',
  'hub_name','operator','priority_tier','existing_network_presence','market_aum_band',
  'mutual_fund_relevance','growth_signal','dominant_order_model','current_order_channels',
  'manuality_snapshot','regulatory_openness','risks_or_barriers'
];
// opportunity_score is deliberately absent: it is calculated, never accepted from a document.
const PROFILE_NUM_KEYS = ['automation_rate_estimate'];

/** Strip empty/placeholder profile_updates and normalize flow_diagram. */
function normalizeProfileUpdates(raw){
  if(!raw || typeof raw!=='object' || Array.isArray(raw)) return {};
  const out={};
  PROFILE_TEXT_KEYS.forEach(k=>{
    if(raw[k]==null) return;
    const v=String(raw[k]).trim();
    if(!v || v==='—' || v==='-') return;
    out[k]=v;
  });
  PROFILE_NUM_KEYS.forEach(k=>{
    if(raw[k]==null || raw[k]==='') return;
    const n=Number(raw[k]);
    if(!Number.isFinite(n)) return;
    out[k]=Math.max(0, Math.min(100, Math.round(n)));
  });
  const indicators=normalizeIndicators(raw.indicators);
  if(indicators) out.indicators=indicators;
  if(Array.isArray(raw.flow_diagram)){
    const flow=normalizeFlowDiagram(raw.flow_diagram);
    if(flow.length) out.flow_diagram=flow;
  }
  return out;
}

function profileUpdateCount(u){
  if(!u) return 0;
  return Object.keys(u).length;
}

function profileUpdatesPreviewHtml(u){
  if(!u || !profileUpdateCount(u)) return '';
  const rows=[];
  if(u.indicators) rows.push(['Scoring indicators', Object.entries(u.indicators).map(([k,v])=>k.replace(/_/g,' ')+' '+v).join(', ')]);
  if(u.automation_rate_estimate!=null) rows.push(['Automation', u.automation_rate_estimate+'%']);
  if(u.priority_tier) rows.push(['Priority tier', u.priority_tier]);
  if(u.market_aum_band) rows.push(['AUM band', u.market_aum_band]);
  if(u.market_classification) rows.push(['Classification', u.market_classification]);
  if(u.central_hub_status) rows.push(['Hub', u.central_hub_status+(u.hub_name?' · '+u.hub_name:'')]);
  if(u.existing_network_presence) rows.push(['Network', u.existing_network_presence]);
  if(u.dominant_order_model) rows.push(['Order model', u.dominant_order_model]);
  if(u.flow_diagram) rows.push(['Order-flow path', u.flow_diagram.map(s=>s.label+' ('+s.mode+')').join(' → ')]);
  // Catch remaining narrative KPI lines briefly.
  ['mutual_fund_relevance','growth_signal','current_order_channels','manuality_snapshot','regulatory_openness','risks_or_barriers']
    .forEach(k=>{ if(u[k]) rows.push([k.replace(/_/g,' '), u[k]]); });
  if(!rows.length) return '';
  return rows.map(([k,v])=>`<div style="margin:2px 0"><b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}</div>`).join('');
}

/** Merge normalized profile_updates into COUNTRY_DATA[iso], creating a shell if needed. */
function applyProfileUpdates(iso, updates){
  const u=normalizeProfileUpdates(updates);
  if(!profileUpdateCount(u)) return false;
  if(!COUNTRY_DATA[iso]){
    COUNTRY_DATA[iso]={
      country:u.country||iso, iso3:iso, region:u.region||'Asia', subregion:u.subregion||'',
      market_classification:u.market_classification||'Unknown',
      central_hub_status:u.central_hub_status||'No central hub',
      hub_name:u.hub_name||'—', operator:u.operator||'—',
      opportunity_score:0,   // replaced by recalculateOpportunity on the next save
      automation_rate_estimate:u.automation_rate_estimate??50,
      priority_tier:u.priority_tier||'Watch',
      existing_network_presence:u.existing_network_presence||'None',
      market_aum_band:u.market_aum_band||'—',
      mutual_fund_relevance:'', growth_signal:'', dominant_order_model:'',
      current_order_channels:'', manuality_snapshot:'', regulatory_openness:'',
      risks_or_barriers:'', indicators:u.indicators||{}, flow_image:'', flow_diagram:[],
      last_updated:new Date().toISOString().slice(0,7)
    };
  }
  const rec=COUNTRY_DATA[iso];
  PROFILE_TEXT_KEYS.forEach(k=>{ if(u[k]!=null) rec[k]=u[k]; });
  PROFILE_NUM_KEYS.forEach(k=>{ if(u[k]!=null) rec[k]=u[k]; });
  // Merge indicators: a new document adds measurements, it never blanks
  // the ones an earlier source established.
  if(u.indicators) rec.indicators=Object.assign({}, rec.indicators, u.indicators);
  if(u.flow_diagram){
    rec.flow_diagram=u.flow_diagram;
    rec.flow_image=rec.flow_image||'';
  }
  rec.iso3=iso;
  rec.last_updated=new Date().toISOString().slice(0,7);
  return true;
}

/** Best-effort recovery when ===FIELDS=== JSON is truncated mid-object. */
function salvageFieldsJson(raw){
  let candidate = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if(!candidate) return null;
  const direct = safeParseJSON(candidate);
  if(direct) return direct;

  const lastComplete = candidate.lastIndexOf('}');
  if(lastComplete < 0) return null;
  candidate = candidate.slice(0, lastComplete + 1);
  const openSquares = (candidate.match(/\[/g) || []).length;
  const closeSquares = (candidate.match(/\]/g) || []).length;
  const openBraces = (candidate.match(/\{/g) || []).length;
  const closeBraces = (candidate.match(/\}/g) || []).length;
  candidate += ']'.repeat(Math.max(0, openSquares - closeSquares));
  candidate += '}'.repeat(Math.max(0, openBraces - closeBraces));
  return safeParseJSON(candidate);
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

  if(proposal.__mode==='library'){
    // Global research library document (library.js owns the card + apply).
    PENDING={mode:'library', doc:proposal.doc};
    document.getElementById('modalCopy').style.display='none';
    document.getElementById('modalApply').style.display='';
    body.innerHTML=libraryModalCardHtml(proposal.doc, proposal.__truncated);
    document.getElementById('modalVeil').classList.add('open');
    return;
  }

  if(proposal.__mode==='build'){
    // building a brand-new note + structured record
    const note=cleanNote(proposal.note||'');
    const fields=proposal.fields||{};
    if(Array.isArray(fields.flow_diagram)){
      fields.flow_diagram = normalizeFlowDiagram(fields.flow_diagram);
    }
    PENDING={iso, mode:'build', note, fields};
    document.getElementById('modalCopy').style.display = note.trim() ? '' : 'none';
    if(!note.trim()){
      body.innerHTML=`<div class="modal-empty">Claude could not build a note from that file.</div>`;
      document.getElementById('modalApply').style.display='none';
    } else {
      document.getElementById('modalApply').style.display='';
      const f=PENDING.fields;
      const chips=[f.market_classification,f.priority_tier,f.central_hub_status]
        .filter(Boolean).map(x=>`<span class="ec-action" style="background:var(--blue-s);color:var(--blue)">${escapeHtml(x)}</span>`).join(' ');
      const flow = Array.isArray(f.flow_diagram) ? f.flow_diagram : [];
      const flowPreview = flow.length
        ? flow.map(s=>escapeHtml(s.label)+(s.mode?` (${escapeHtml(s.mode)})`:'')).join(' → ')
        : '';
      const flowWarn = flow.length < 4
        ? `<div style="font-size:11.5px;color:var(--mid);background:var(--mid-s);border-radius:8px;padding:8px 10px;margin-bottom:10px">⚠ Order-flow diagram looks incomplete (${flow.length||0} stage${flow.length===1?'':'s'}). Prefer re-running the upload so Claude returns a full 4–7 stage path.</div>`
        : `<div style="font-size:11.5px;color:var(--ink-2);margin:0 0 10px">Order-flow path: ${flowPreview}</div>`;
      const missingKpis = !(f.market_aum_band && f.dominant_order_model) || !normalizeIndicators(f.indicators);
      const kpiWarn = missingKpis
        ? `<div style="font-size:11.5px;color:var(--mid);background:var(--mid-s);border-radius:8px;padding:8px 10px;margin-bottom:10px">⚠ Structured KPIs look thin (indicators / AUM / order model). Check the source pack was fully read — drawer cards need the ===FIELDS=== JSON, not just the note.</div>`
        : '';
      const warn = proposal.__truncated
        ? `<div style="font-size:11.5px;color:var(--mid);background:var(--mid-s);border-radius:8px;padding:8px 10px;margin-bottom:10px">⚠ The note may be slightly cut off (long source). Review before applying.</div>` : '';
      body.innerHTML=`
        ${warn}
        ${kpiWarn}
        ${flowWarn}
        <div class="edit-card">
          <div class="ec-top">${chips}</div>
          <div style="font-size:12px;color:var(--ink-2);margin-bottom:8px">Indicators ${Object.keys(normalizeIndicators(f.indicators)||{}).length} · Automation ${f.automation_rate_estimate??'—'}% · ${escapeHtml(f.market_aum_band||'')}</div>
          <div class="ec-content">${escapeHtml(note.slice(0,1400))}${note.length>1400?'\n…':''}</div>
          <label class="ec-check"><input type="checkbox" id="bcheck" checked> Create this country profile and note</label>
        </div>`;
    }
    document.getElementById('modalVeil').classList.add('open');
    return;
  }

  // merge mode (existing note)
  const profileUpdates = normalizeProfileUpdates(proposal.profile_updates || {});
  PENDING={iso, mode:'merge', edits:proposal.edits||[], profileUpdates};
  document.getElementById('modalCopy').style.display='none';
  const hasProfileUpdate = profileUpdateCount(PENDING.profileUpdates) > 0;
  if(!PENDING.edits.length && !hasProfileUpdate){
    body.innerHTML=`<div class="modal-empty">No relevant order-routing content was found to add.</div>`;
    document.getElementById('modalApply').style.display='none';
  } else {
    document.getElementById('modalApply').style.display='';
    const profileCard = hasProfileUpdate
      ? `<div class="edit-card">
          <div class="ec-top"><span class="ec-action">update</span><span class="ec-section">Profile KPIs &amp; order-flow</span></div>
          <div class="ec-content">${profileUpdatesPreviewHtml(PENDING.profileUpdates)}</div>
          <label class="ec-check"><input type="checkbox" id="profilecheck" checked> Apply structured profile updates (scores, AUM, hub, diagram)</label>
        </div>`
      : `<div style="font-size:11.5px;color:var(--mid);background:var(--mid-s);border-radius:8px;padding:8px 10px;margin-bottom:10px">⚠ Claude returned note edits only — no structured KPI updates. Re-upload if the source pack contains opportunity score / AUM / automation figures.</div>`;
    body.innerHTML=profileCard + PENDING.edits.map((ed,i)=>`
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
function closeModal(){
  document.getElementById('modalVeil').classList.remove('open');
  PENDING=null;
  // Let a queued library→markets run continue to the next country.
  if(typeof resolveLibraryModalWait==='function') resolveLibraryModalWait();
}
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
  const ind=normalizeIndicators(f.indicators);
  const indLine = ind
    ? '    indicators:{ '+Object.entries(ind)
        .map(([k,v])=>`${k}:${typeof v==='number'?v:q(v)}`).join(', ')+' },\n'
    : '';
  const rec =
`  // ---- paste this inside COUNTRY_DATA ----
  ${q(iso)}: {
    country:${q(f.country||iso)}, iso3:${q(iso)}, region:${q(f.region||'Asia')}, subregion:${q(f.subregion||'')},
    market_classification:${q(f.market_classification||'Unknown')},
    central_hub_status:${q(f.central_hub_status||'No central hub')}, hub_name:${q(f.hub_name||'—')}, operator:${q(f.operator||'—')},
    opportunity_score:0, automation_rate_estimate:${clampNum(f.automation_rate_estimate,50)},
    priority_tier:${q(f.priority_tier||'Watch')}, existing_network_presence:${q(f.existing_network_presence||'None')},
    market_aum_band:${q(f.market_aum_band||'—')},
    mutual_fund_relevance:${q(f.mutual_fund_relevance||'')},
    growth_signal:${q(f.growth_signal||'')},
    dominant_order_model:${q(f.dominant_order_model||'')},
    current_order_channels:${q(f.current_order_channels||'')},
    manuality_snapshot:${q(f.manuality_snapshot||'')},
    regulatory_openness:${q(f.regulatory_openness||'')},
    risks_or_barriers:${q(f.risks_or_barriers||'')},
${indLine}    flow_image:"", flow_diagram:[\n${flow}\n    ],
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

  if(PENDING.mode==='library'){
    const pending=PENDING;
    const applyBtn=document.getElementById('modalApply');
    applyBtn.disabled=true;
    applyLibraryPending(pending).then(
      ()=>{ applyBtn.disabled=false; closeModal(); },
      err=>{
        applyBtn.disabled=false;
        alert('Could not save to the library: '+(err.message||'request failed'));
      }
    );
    return;
  }

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
      opportunity_score:0,   // calculated on save
      automation_rate_estimate:clampNum(f0.automation_rate_estimate,50),
      priority_tier:f0.priority_tier||'Watch',
      existing_network_presence:f0.existing_network_presence||'None',
      market_aum_band:f0.market_aum_band||'—',
      mutual_fund_relevance:f0.mutual_fund_relevance||'',
      growth_signal:f0.growth_signal||'', dominant_order_model:f0.dominant_order_model||'',
      current_order_channels:f0.current_order_channels||'', manuality_snapshot:f0.manuality_snapshot||'',
      regulatory_openness:f0.regulatory_openness||'', risks_or_barriers:f0.risks_or_barriers||'',
      indicators:normalizeIndicators(f0.indicators)||{},
      flow_image:'', flow_diagram:normalizeFlowDiagram(f0.flow_diagram),
      last_updated:new Date().toISOString().slice(0,7)
    };
    closeModal();
    saveData(iso, 'claude');     // persist to Neon + local cache
    refreshGlobe();              // recolour the globe now that the record exists
    afterFilter();              // refresh counts/legend
    const f=featureForISO(iso);
    if(f) openDrawer(f);        // reopen as a full profiled panel
    setStatus('Profile and note created for this country.', 'ok');
    return;
  }

  // merge mode
  const checks=[...document.querySelectorAll('#modalBody input[type=checkbox][data-i]')];
  const chosen=checks.filter(c=>c.checked).map(c=>PENDING.edits[+c.dataset.i]);
  let note=COUNTRY_MARKDOWN[iso]||'';
  chosen.forEach(ed=>{ note=applyEdit(note, ed); });
  COUNTRY_MARKDOWN[iso]=note;

  const profileCheck=document.getElementById('profilecheck');
  let profileApplied=false;
  if(profileCheck && profileCheck.checked){
    profileApplied = applyProfileUpdates(iso, PENDING.profileUpdates);
  }

  saveData(iso, 'claude');       // persist to Neon + local cache
  if(profileApplied){ refreshGlobe(); afterFilter(); }
  closeModal();
  const f=featureForISO(iso);
  if(f){ const wasWide=drawer.classList.contains('wide'); openDrawer(f);
    if(wasWide){ toggleDetail(); } }
  setStatus(profileApplied
    ? 'Note edits and structured profile KPIs applied.'
    : 'Changes applied to the note in the app.', 'ok');
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
  const items=L.items.map(i=>`<div class="item"><span class="sw" style="background:${i.c}"></span>${i.t}</div>`).join('');
  document.getElementById('legendItems').innerHTML=(L.scale?opportunityScaleHtml():'')+items;
}

/* Scale legend for the opportunity heat scale. Bands are drawn at equal width
   regardless of how many points they span, so each tick sits on the join it
   actually marks (the next band's lower bound) rather than on a 0–100 axis. */
function opportunityScaleHtml(){
  const steps=[...OPP_BANDS].reverse();   // low → high, left to right
  const n=steps.length;
  const segs=steps.map(b=>`<span class="seg" style="background:${b.c}" title="${b.label}"></span>`).join('');
  const ticks=steps.slice(1)
    .map((b,i)=>`<span class="tk" style="left:${((i+1)/n*100).toFixed(2)}%">${b.min}</span>`).join('');
  return `<div class="scale">
      <div class="scale-bar">${segs}</div>
      <div class="scale-ticks">${ticks}</div>
      <div class="scale-ends"><span>Weaker opportunity</span><span>Stronger</span></div>
    </div>`;
}
function refreshGlobe(){
  if(!globe)return;
  globe.polygonCapColor(polyCapColor).polygonStrokeColor(polyStrokeColor).polygonAltitude(polyAltitude);
  // A market researched in this session may be a point-only jurisdiction,
  // so the set itself is rebuilt here rather than only at boot.
  const before=OFFSHORE_FEATURES.length;
  rebuildOffshoreFeatures();
  if(OFFSHORE_FEATURES.length!==before) globe.pointsData(OFFSHORE_FEATURES);
  globe.pointColor(pointCapColor).pointAltitude(pointAltitude).pointRadius(pointRadius);
}

/* Points share the polygon colour logic so the two layers read as one
   map, but a point is a few pixels wide — it is kept fully opaque and
   given a visible lift so it does not disappear against the globe. */
function pointCapColor(f){
  const rec=recordFor(f);
  if(!passesFilters(rec)) return 'rgba(150,170,186,0.35)';
  let col;
  if(!rec) col=C.unknown;
  else if(MODE==='opportunity')col=scoreColor(rec.opportunity_score);
  else if(MODE==='hub')col=hubColor(rec.central_hub_status);
  else if(MODE==='automation')col=scoreColorInv(rec.automation_rate_estimate);
  else col=classColor(rec.market_classification);
  return hexA(col||C.none, 1);
}
function pointAltitude(f){
  const rec=recordFor(f);
  if(rec&&rec.iso3===selectedISO)return 0.085;
  if(f.__hover)return 0.06;
  return 0.02;
}
function pointRadius(f){
  const rec=recordFor(f);
  if(rec&&rec.iso3===selectedISO)return 0.85;
  if(f.__hover)return 0.8;
  return passesFilters(rec)?0.62:0.45;
}

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

function centroid(f){if(f&&f.__offshore)return{lat:f.lat,lng:f.lng};let lats=[],lngs=[];const g=f.geometry;if(!g)return null;const polys=g.type==='Polygon'?[g.coordinates]:g.coordinates;polys.forEach(p=>p[0].forEach(c=>{lngs.push(c[0]);lats.push(c[1]);}));if(!lats.length)return null;return{lat:(Math.min(...lats)+Math.max(...lats))/2,lng:(Math.min(...lngs)+Math.max(...lngs))/2};}
function flyToISO(iso){
  const f=featureForISO(iso);
  if(!f)return;
  selectedISO=featISO(f);
  const c=centroid(f);
  if(c&&globe)globe.pointOfView({lat:c.lat,lng:c.lng,altitude:f.__offshore?1.1:1.7},1100);
  refreshGlobe();
  openDrawer(f);
}

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
  world.forEach(f=>{f.iso_a3=isoForFeature(f);});
  POLYGON_ISOS=new Set(world.map(f=>f.iso_a3).filter(Boolean));
  recalculateAllOpportunities(); // score the bundled defaults before any cache/DB overlay
  loadSavedData();   // local cache first for fast paint
  const fromDb = await loadAtlasFromDb(); // Neon wins when reachable
  if(!STORAGE_OK && !fromDb) showSaveBanner();
  rebuildOffshoreFeatures(); // after the DB overlay, so its markets get points too
  globe=Globe()(document.getElementById('globeViz'))
    .backgroundColor('rgba(0,0,0,0)')
    .showAtmosphere(true).atmosphereColor('#7fb8d8').atmosphereAltitude(0.16)
    .showGlobe(true)
    .polygonsData(world).polygonAltitude(polyAltitude).polygonCapColor(polyCapColor)
    .polygonSideColor(polySideColor).polygonStrokeColor(polyStrokeColor)
    .polygonsTransitionDuration(300).onPolygonHover(handleHover).onPolygonClick(handleClick)
    .pointsData(OFFSHORE_FEATURES).pointLat('lat').pointLng('lng')
    .pointColor(pointCapColor).pointAltitude(pointAltitude).pointRadius(pointRadius)
    .pointsTransitionDuration(300).onPointHover(handleHover).onPointClick(handleClick);
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
function handleHover(f,prev){
  if(drawer.classList.contains('open')){ clearGlobeHover(); return; }
  if(prev)prev.__hover=false;
  if(hoverFeat&&hoverFeat!==f)hoverFeat.__hover=false;
  hoverFeat=f;
  document.getElementById('globeViz').style.cursor=f?'pointer':'grab';
  if(f)f.__hover=true;
  refreshGlobe();
  if(!f)hideTooltip();
}
function clearGlobeHover(){
  if(hoverFeat) hoverFeat.__hover=false;
  hoverFeat=null;
  document.getElementById('globeViz').style.cursor='grab';
  hideTooltip();
  refreshGlobe();
}
document.getElementById('globeViz').addEventListener('mousemove',e=>{
  if(drawer.classList.contains('open')){ hideTooltip(); return; }
  if(hoverFeat) showTooltip(hoverFeat,e.clientX,e.clientY); else hideTooltip();
});
function handleClick(f){if(!f)return;selectedISO=featISO(f);const c=centroid(f);if(c)globe.pointOfView({lat:c.lat,lng:c.lng,altitude:1.7},1100);refreshGlobe();openDrawer(f);if(EDIT_MODE)console.log('Record:',recordFor(f)||('No profile for '+featISO(f)));}
addEventListener('keydown',e=>{if(e.key==='Escape'){if(document.getElementById('modalVeil').classList.contains('open')){closeModal();return;}const lv=document.getElementById('libVeil');if(lv&&lv.classList.contains('open')){closeLibrary();return;}closeDrawer();document.getElementById('filterPanel').classList.remove('open');document.getElementById('filterBtn').classList.remove('active');}});

/* ================================================================
   =====================   AI CHATBOT   =========================
   ================================================================
   Floating assistant on the main page. Uses the same API key/model.
   It is given a compact summary of all country data as context so it
   can answer questions about your research, plus general questions. */

const CHAT_SYSTEM_PROMPT = `You are the Atlas Assistant inside Calastone's Global Order-Routing Atlas, a tool about mutual fund order-routing infrastructure by country.

You may be given a CONTEXT block summarising the countries currently profiled in the app (hub status, scores, key facts). Use it when the user asks about specific markets or comparisons. You can also answer general questions using your own knowledge.

You may also be given a GLOBAL RESEARCH LIBRARY block: an index of cross-market documents uploaded to this app (platform reports, regulatory notes, articles), and — when a document looks relevant to the question — its full text under a GLOBAL RESEARCH DOCUMENT heading. Treat those documents as the most authoritative source available: prefer them over your own general knowledge for questions about distribution, platforms, regulation, flows and cross-border market structure, and use their figures exactly as written. Name the document in your answer when a fact comes from one, e.g. "per the European Fund Distribution Platforms report". If the index lists a document that looks relevant but its text was not supplied, say which document should be consulted rather than guessing at its contents. Never attribute a figure to a document that does not contain it.

Write for a narrow chat panel. Give the direct answer or verdict in the first one or two sentences. Do not restate the question or open with generic scene-setting.

Use the smallest structure that makes the answer easy to scan:
- For a simple fact, use one short paragraph with no heading.
- For an assessment or recommendation, give the verdict, then 3–5 evidence bullets, then a one-sentence bottom line or next step.
- For a comparison, use parallel bullets with the same fields for each market.

Keep paragraphs to no more than two sentences. Give each bullet one idea and, when useful, start it with a short **bold label**. Use at most one ## title and two ### subheadings, and only when the answer genuinely has multiple sections. Do not use nested lists. Do not repeat a fact across the verdict, evidence, and conclusion. Avoid decorative headings, multiple dividers, and walls of text.

Be concise and factual. Spell out acronyms in full on first use with the abbreviation in brackets. When you are unsure or the app's data does not cover something, say so plainly rather than inventing figures. Use **bold** only for decisive labels, figures, and conclusions.`;

let CHAT_HISTORY=[];           // [{role, content}]
let chatBusy=false;

function chatContextSummary(){
  // Build a compact, token-efficient summary of profiled countries.
  // The category split travels with the score so the assistant can say
  // WHY a market scores the way it does instead of just quoting a number.
  const rows=Object.values(COUNTRY_DATA).map(r=>{
    const bd=r.opportunity_score_breakdown||{};
    const split=OPPORTUNITY_MODEL.map(c=>`${c.key} ${bd[c.key]??'?'}/${c.weight}`).join(', ');
    return `${r.country} (${r.iso3}): ${r.market_classification}, ${r.central_hub_status}; opportunity ${r.opportunity_score}/100 [${split}; evidence confidence ${r.opportunity_score_confidence??0}], automation ${r.automation_rate_estimate}%, ${r.priority_tier}; ${r.dominant_order_model}`;
  });
  return 'CONTEXT — profiled markets in the app.\n'
    +'Opportunity scores are calculated, not hand-set: manual operations intensity 30, market size & growth 20, '
    +'network density & reachability 20, regulatory tailwinds 15, go-to-market feasibility 15. '
    +'Evidence confidence (0–100) is how much of a score rests on sourced, estimated or derived indicators rather than phrase matching.\n'
    +rows.join('\n');
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
function renderChatInline(s){
  return escapeHtml(s)
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g,'<em>$1</em>');
}

// Small, safe Markdown renderer for assistant replies. Input is escaped before
// formatting so Claude cannot inject arbitrary HTML into the page.
function renderChatMarkdown(s){
  const lines=String(s||'').replace(/\r\n?/g,'\n').split('\n');
  const html=[];
  let paragraph=[];
  let listType=null;

  const flushParagraph=()=>{
    if(paragraph.length){
      html.push(`<p>${paragraph.map(line=>renderChatInline(line.trim())).join(' ')}</p>`);
      paragraph=[];
    }
  };
  const closeList=()=>{
    if(listType){ html.push(`</${listType}>`); listType=null; }
  };

  lines.forEach(line=>{
    const trimmed=line.trim();
    const heading=trimmed.match(/^(#{1,4})\s+(.+)$/);
    const bullet=trimmed.match(/^[-*]\s+(.+)$/);
    const numbered=trimmed.match(/^\d+[.)]\s+(.+)$/);

    if(!trimmed){ flushParagraph(); closeList(); return; }
    if(/^([-*_])\1{2,}$/.test(trimmed)){
      flushParagraph(); closeList(); html.push('<hr>'); return;
    }
    if(heading){
      flushParagraph(); closeList();
      const level=Math.min(4,heading[1].length+1);
      html.push(`<h${level}>${renderChatInline(heading[2])}</h${level}>`);
      return;
    }
    if(bullet||numbered){
      flushParagraph();
      const nextType=bullet?'ul':'ol';
      if(listType!==nextType){ closeList(); listType=nextType; html.push(`<${listType}>`); }
      html.push(`<li>${renderChatInline((bullet||numbered)[1])}</li>`);
      return;
    }
    closeList();
    paragraph.push(trimmed);
  });
  flushParagraph(); closeList();
  return html.join('');
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
    // Library retrieval is best-effort — a failure must never block the answer.
    let libraryBlock = '';
    if(typeof libraryChatContext === 'function'){
      try{ libraryBlock = await libraryChatContext(text); }
      catch(err){ console.warn('library context unavailable', err); }
    }
    const sys = CHAT_SYSTEM_PROMPT + '\n\n' + chatContextSummary()
      + (libraryBlock ? '\n\n' + libraryBlock : '');
    const msgs = CHAT_HISTORY.slice(-12);
    const res=await anthropicMessages({ model:CLAUDE_MODEL, max_tokens:1024, system:sys, messages:msgs });
    typing.remove();
    if(!res.ok){
      let detail=''; try{ const j=await res.json(); detail=j.error?.message||''; }catch(_){}
      const e=document.createElement('div'); e.className='chat-err'; e.textContent=formatClaudeHttpError(res.status, detail); chatLog.appendChild(e);
    } else {
      const data=await res.json();
      const reply=(data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim() || '(no reply)';
      const replyEl=addMsg('bot',reply);
      // Start each completed answer at its beginning instead of leaving the
      // reader at the bottom of a long response.
      chatLog.scrollTop=Math.max(0,replyEl.offsetTop-chatLog.offsetTop-18);
      CHAT_HISTORY.push({role:'assistant', content:reply});
    }
  }catch(err){
    typing.remove();
    const e=document.createElement('div'); e.className='chat-err'; e.textContent=(err.message||'Network error — request failed'); chatLog.appendChild(e);
  }finally{
    chatBusy=false; chatSend.disabled=false; chatInput.focus();
  }
}

/* ================================================================
   ============   GLOBE FEATURE -> ISO3 RESOLUTION   =============
   ================================================================
   Every record lives in Neon; this is only the lookup that ties a
   record to the shape on the globe. It used to be a hand-kept list of
   the ~48 markets that had been researched, which meant a market
   could be fully written up in Neon and still render as "Profile not
   yet completed" on any machine, because nobody had added its name
   here. The list is now complete and keyed on the numeric M49 id that
   world-atlas puts on every feature, so it never needs editing again:
   the id is stable where the display name is not ("Czech Republic"
   became "Czechia", "Swaziland" became "eSwatini"). */
const ID_TO_ISO={
  "004":"AFG","024":"AGO","008":"ALB","784":"ARE","032":"ARG","051":"ARM","010":"ATA","260":"ATF",
  "036":"AUS","040":"AUT","031":"AZE","108":"BDI","056":"BEL","204":"BEN","854":"BFA","050":"BGD",
  "100":"BGR","044":"BHS","070":"BIH","112":"BLR","084":"BLZ","068":"BOL","076":"BRA","096":"BRN",
  "064":"BTN","072":"BWA","140":"CAF","124":"CAN","756":"CHE","152":"CHL","156":"CHN","384":"CIV",
  "120":"CMR","180":"COD","178":"COG","170":"COL","188":"CRI","192":"CUB","196":"CYP","203":"CZE",
  "276":"DEU","262":"DJI","208":"DNK","214":"DOM","012":"DZA","218":"ECU","818":"EGY","232":"ERI",
  "732":"ESH","724":"ESP","233":"EST","231":"ETH","246":"FIN","242":"FJI","238":"FLK","250":"FRA",
  "266":"GAB","826":"GBR","268":"GEO","288":"GHA","324":"GIN","270":"GMB","624":"GNB","226":"GNQ",
  "300":"GRC","304":"GRL","320":"GTM","328":"GUY","340":"HND","191":"HRV","332":"HTI","348":"HUN",
  "360":"IDN","356":"IND","372":"IRL","364":"IRN","368":"IRQ","352":"ISL","376":"ISR","380":"ITA",
  "388":"JAM","400":"JOR","392":"JPN","398":"KAZ","404":"KEN","417":"KGZ","116":"KHM","410":"KOR",
  "414":"KWT","418":"LAO","422":"LBN","430":"LBR","434":"LBY","144":"LKA","426":"LSO","440":"LTU",
  "442":"LUX","428":"LVA","504":"MAR","498":"MDA","450":"MDG","484":"MEX","807":"MKD","466":"MLI",
  "104":"MMR","499":"MNE","496":"MNG","508":"MOZ","478":"MRT","454":"MWI","458":"MYS","516":"NAM",
  "540":"NCL","562":"NER","566":"NGA","558":"NIC","528":"NLD","578":"NOR","524":"NPL","554":"NZL",
  "512":"OMN","586":"PAK","591":"PAN","604":"PER","608":"PHL","598":"PNG","616":"POL","630":"PRI",
  "408":"PRK","620":"PRT","600":"PRY","275":"PSE","634":"QAT","642":"ROU","643":"RUS","646":"RWA",
  "682":"SAU","729":"SDN","686":"SEN","090":"SLB","694":"SLE","222":"SLV","706":"SOM","688":"SRB",
  "728":"SSD","740":"SUR","703":"SVK","705":"SVN","752":"SWE","748":"SWZ","760":"SYR","148":"TCD",
  "768":"TGO","764":"THA","762":"TJK","795":"TKM","626":"TLS","780":"TTO","788":"TUN","792":"TUR",
  "158":"TWN","834":"TZA","800":"UGA","804":"UKR","858":"URY","840":"USA","860":"UZB","862":"VEN",
  "704":"VNM","548":"VUT","887":"YEM","710":"ZAF","894":"ZMB","716":"ZWE"
};

/* Natural Earth ships three polygons with no id (disputed status), and
   restyles display names between releases. Names are the fallback. */
const NAME_TO_ISO={
  "Kosovo":"XKX","N. Cyprus":"CYP","Somaliland":"SOM",
  "United States":"USA","United States of America":"USA",
  "Czechia":"CZE","Czech Republic":"CZE","South Korea":"KOR","Korea":"KOR",
  "North Korea":"PRK","Macedonia":"MKD","North Macedonia":"MKD","Swaziland":"SWZ","eSwatini":"SWZ",
  "Bosnia and Herz.":"BIH","Dem. Rep. Congo":"COD","Central African Rep.":"CAF",
  "Dominican Rep.":"DOM","Eq. Guinea":"GNQ","S. Sudan":"SSD","Solomon Is.":"SLB",
  "Timor-Leste":"TLS","W. Sahara":"ESH","Falkland Is.":"FLK","Fr. S. Antarctic Lands":"ATF",
  "Côte d'Ivoire":"CIV","Ivory Coast":"CIV","Myanmar":"MMR","Burma":"MMR",
  "Cape Verde":"CPV","Brunei":"BRN","Brunei Darussalam":"BRN"
};

function isoForFeature(f){
  if(!f) return null;
  if(f.iso_a3) return f.iso_a3;
  const p=f.properties||{};
  return ID_TO_ISO[String(f.id)] || NAME_TO_ISO[p.name] || null;
}

/* ================================================================
   =============   JURISDICTIONS WITH NO POLYGON   ===============
   ================================================================
   world-atlas at 110m resolution has no shape for a territory below
   roughly 1,000 km2, which removes most of the offshore fund centres
   from the map entirely — Cayman, Jersey, Guernsey, the Isle of Man,
   Malta, Gibraltar, Liechtenstein, Bermuda, Singapore and Hong Kong
   are all absent. No name table can fix that; there is nothing to
   name. They are drawn as points instead, and a point carries the
   same record, tooltip and drawer as a polygon does.

   Coordinates are the jurisdiction's financial centre. Adding one
   here is optional — a market with neither a polygon nor a point is
   still reachable from search, it just has no location on the globe. */
const OFFSHORE_COORDS={
  CYM:[19.30,-81.38], JEY:[49.19,-2.11], GGY:[49.46,-2.58], IMN:[54.15,-4.48],
  MLT:[35.90,14.51], GIB:[36.14,-5.35], LIE:[47.14,9.52], MCO:[43.74,7.42],
  AND:[42.51,1.52], SMR:[43.94,12.45], BMU:[32.29,-64.78], BRB:[13.10,-59.62],
  BHS:[25.06,-77.35], VGB:[18.42,-64.62], AIA:[18.22,-63.07], TCA:[21.47,-71.14],
  CUW:[12.17,-69.00], ABW:[12.52,-70.04], ATG:[17.06,-61.80], KNA:[17.30,-62.72],
  LCA:[14.01,-60.99], VCT:[13.16,-61.22], GRD:[12.06,-61.75], DMA:[15.31,-61.38],
  SGP:[1.29,103.85], HKG:[22.32,114.17], MAC:[22.20,113.54], BRN:[4.90,114.94],
  MUS:[-20.16,57.50], SYC:[-4.62,55.45], MDV:[4.18,73.51], BHR:[26.23,50.59],
  QAT:[25.29,51.53], LUX:[49.61,6.13], FRO:[62.01,-6.77], CPV:[14.93,-23.51],
  STP:[0.34,6.73], VAT:[41.90,12.45], SXM:[18.03,-63.05], KIR:[1.33,172.98],
  MHL:[7.09,171.38], FSM:[6.92,158.16], PLW:[7.50,134.62], NRU:[-0.55,166.92],
  TUV:[-8.52,179.20], TON:[-21.14,-175.20], WSM:[-13.83,-171.77], COM:[-11.70,43.26]
};

/* Records the globe has no polygon for, rebuilt whenever the data
   changes so a market researched today appears without a reload.
   Shaped like a world-atlas feature on purpose: featISO, featName,
   recordFor, showTooltip and openDrawer then all work unchanged. */
let OFFSHORE_FEATURES=[];
let POLYGON_ISOS=new Set();

function rebuildOffshoreFeatures(){
  OFFSHORE_FEATURES=Object.keys(COUNTRY_DATA)
    .filter(iso=>!POLYGON_ISOS.has(iso) && OFFSHORE_COORDS[iso])
    .map(iso=>({
      iso_a3:iso, __offshore:true,
      lat:OFFSHORE_COORDS[iso][0], lng:OFFSHORE_COORDS[iso][1],
      properties:{ name:(COUNTRY_DATA[iso]&&COUNTRY_DATA[iso].country)||iso }
    }));
  return OFFSHORE_FEATURES;
}

/* A market with neither polygon nor point still has to open from
   search, so hand back something openDrawer can render. */
function featureForISO(iso){
  const code=String(iso||'').toUpperCase();
  const poly=world&&world.find(f=>featISO(f)===code);
  if(poly) return poly;
  const pt=OFFSHORE_FEATURES.find(f=>f.iso_a3===code);
  if(pt) return pt;
  const rec=COUNTRY_DATA[code];
  return rec?{iso_a3:code,__placeless:true,properties:{name:rec.country||code}}:null;
}
