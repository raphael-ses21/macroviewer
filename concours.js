/* =====================================================================
   Groupes et concours de trading de MacroViewer
   - un élève crée un groupe : capital de départ, durée, effet de levier,
     vente à découvert autorisée ou non ; il reçoit un code à 6 caractères ;
   - les autres rejoignent le groupe avec ce code et un pseudo ;
   - chacun joue avec les vrais cours, le classement se met à jour en direct.
   Les données sont rangées dans une base Supabase (voir concours.sql et
   concours-config.js). Chaque visiteur reçoit un identifiant anonyme.
   ===================================================================== */
(function(){
  const CFG=window.MV_CONCOURS||{};
  const LS_ACTIVE="mv.contest.active", LS_JOINED="mv.contest.joined";
  const configured=()=>!!(CFG.mock||(CFG.url&&CFG.key));
  let api=null, ready=null, state="idle";        // idle | loading | ok | error
  let groups=[];                                  // [{group, me:{cash,pos,trades}, pseudo}]
  const members={};                               // code -> lignes du classement
  let form=null, msg=null, saveT=null, pollT=null, lastLogged={};

  /* ---------- accès à la base ---------- */
  const loadScript=src=>new Promise((ok,ko)=>{ const s=document.createElement("script"); s.src=src; s.onload=ok; s.onerror=()=>ko(new Error("Chargement impossible")); document.head.appendChild(s); });
  async function supabaseApi(){
    if(!window.supabase) await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js");
    const sb=window.supabase.createClient(CFG.url,CFG.key,{auth:{persistSession:true,storageKey:"mv.concours.auth"}});
    let {data:{session}}=await sb.auth.getSession();
    if(!session){ const r=await sb.auth.signInAnonymously(); if(r.error) throw r.error; session=r.data.session; }
    const uid=session.user.id, chk=r=>{ if(r.error) throw r.error; return r.data; };
    return {uid,
      createGroup:async g=>chk(await sb.from("groups").insert(g).select().single()),
      join:async(code,pseudo)=>chk(await sb.rpc("join_group",{p_code:code,p_pseudo:pseudo})),
      myGroups:async()=>chk(await sb.from("members").select("*, groups(*)").eq("player_id",uid)),
      members:async code=>chk(await sb.from("members").select("player_id,pseudo,cash,pos,value,updated_at").eq("group_code",code)),
      // un seul appel, vérifié par le serveur : liquidités et quantités doivent correspondre aux ordres
      // renvoie les liquidités et la valeur calculées par le serveur, avec les cours officiels
      saveMine:async(code,d,orders)=>chk(await sb.rpc("save_portfolio",{p_code:code,p_cash:d.cash,p_pos:d.pos,p_trades:d.trades,p_value:d.value,p_orders:orders})),
      saveDaily:async(code,rows)=>chk(await sb.rpc("save_daily_rank",{p_code:code,p_rows:rows})),
      daily:async code=>chk(await sb.from("daily_ranks").select("day,player_id,pseudo,value,rank").eq("group_code",code).order("day").order("rank"))};
  }
  // base simulée dans le navigateur, pour tester sans Supabase (MV_CONCOURS = {mock:true})
  function mockApi(){
    const K="mv.mock.db", db=()=>lsGet(K)||{groups:{},members:[],orders:[]}, put=d=>lsSet(K,d), E=m=>new Error(m);
    let uid=lsGet("mv.mock.uid"); if(!uid){ uid="u"+Math.random().toString(36).slice(2,10); lsSet("mv.mock.uid",uid); }
    return {uid,
      async createGroup(g){ const d=db(); if(d.groups[g.code]) throw E("duplicate key"); g={...g,owner:uid,created_at:new Date().toISOString()}; d.groups[g.code]=g; put(d); return g; },
      async join(code,pseudo){ const d=db(), g=d.groups[code]; if(!g) throw E("Code inconnu"); if(Date.now()>Date.parse(g.ends_at)) throw E("Ce concours est terminé");
        let m=d.members.find(x=>x.group_code===code&&x.player_id===uid); if(m) return m;
        if(d.members.some(x=>x.group_code===code&&x.pseudo.toLowerCase()===pseudo.toLowerCase())) throw E('duplicate key value violates unique constraint "members_pseudo_unique"');
        m={group_code:code,player_id:uid,pseudo,cash:g.start_cash,pos:{},trades:[],value:g.start_cash,updated_at:new Date().toISOString()}; d.members.push(m); put(d); return m; },
      async myGroups(){ const d=db(); return d.members.filter(m=>m.player_id===uid).map(m=>({...m,groups:d.groups[m.group_code]})); },
      async members(code){ return db().members.filter(m=>m.group_code===code); },
      async saveMine(code,x,orders){ const d=db(), g=d.groups[code], m=d.members.find(m=>m.group_code===code&&m.player_id===uid);
        if(Date.now()<Date.parse(g.starts_at)||Date.now()>Date.parse(g.ends_at)+3e5) throw E("permission refusée");
        // mêmes vérifications que la fonction save_portfolio de Supabase
        let cash=Number(m.cash); const run={}; const q0=a=>a in run?run[a]:Number(m.pos[a]?.qty||0);
        for(const o of orders){ let q=q0(o.asset), s;
          if(o.side==="buy"){ s=-o.amount_eur; q+=o.qty; } else if(o.side==="sell"){ if(q<o.qty) throw E("Portefeuille incohérent"); s=o.amount_eur; q-=o.qty; }
          else if(o.side==="short"){ s=o.amount_eur; q-=o.qty; } else if(o.side==="cover"){ s=-o.amount_eur; q+=o.qty; } else { s=q>0?o.amount_eur:-o.amount_eur; q=0; }
          cash+=s; run[o.asset]=q; }
        if(Math.abs(cash-x.cash)>0.01*orders.length+0.02) throw E("Portefeuille incohérent (liquidités)");
        for(const a of new Set([...Object.keys(m.pos),...Object.keys(x.pos),...Object.keys(run)])) if(q0(a)!==Number(x.pos[a]?.qty||0)) throw E("Portefeuille incohérent (quantités)");
        // simulation des cours officiels : le serveur calcule à 0,1 % près du prix du navigateur
        const srvCash=Math.round((cash-orders.reduce((s,o)=>s+(o.side==="buy"?1:o.side==="cover"?-1:0)*o.amount_eur*0.001,0))*100)/100;
        Object.assign(m,JSON.parse(JSON.stringify(x)),{cash:srvCash}); d.orders.push(...orders.map(o=>({...o,group_code:code,player_id:uid}))); put(d);
        return {cash:srvCash,value:x.value}; },
      async saveDaily(code,rows){ const d=db(), g=d.groups[code], now=Date.now(); d.daily=d.daily||[];
        if(now<Date.parse(g.starts_at)) return 0;
        let day=parisDay(now);
        if(now>Date.parse(g.ends_at)){ day=parisDay(Date.parse(g.ends_at)); if(now>Date.parse(g.ends_at)+864e5||d.daily.some(r=>r.group_code===code&&r.day===day&&Date.parse(r.saved_at)>Date.parse(g.ends_at))) return 0; }
        d.daily=d.daily.filter(r=>!(r.group_code===code&&r.day===day));
        const ok=rows.map(r=>({...r,m:d.members.find(m=>m.group_code===code&&m.player_id===r.player_id)})).filter(r=>r.m).sort((a,b)=>b.value-a.value);
        ok.forEach((r,i)=>d.daily.push({group_code:code,day,player_id:r.player_id,pseudo:r.m.pseudo,value:r.value,rank:i&&ok[i-1].value===r.value?d.daily[d.daily.length-1].rank:i+1,saved_at:new Date().toISOString()}));
        put(d); return ok.length; },
      async daily(code){ return (db().daily||[]).filter(r=>r.group_code===code).sort((a,b)=>a.day.localeCompare(b.day)||a.rank-b.rank); }};
  }
  // jour au format AAAA-MM-JJ, à l'heure de Paris (comme dans la base)
  const parisDay=t=>new Intl.DateTimeFormat("fr-CA",{timeZone:"Europe/Paris",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(t));
  function init(){
    if(!ready){ state="loading";
      ready=(CFG.mock?Promise.resolve(mockApi()):supabaseApi()).then(a=>{ api=a; return loadMine(); }).then(()=>{ state="ok"; refreshView(); })
        .catch(e=>{ ready=null; state="error"; msg=["err",errTxt(e)]; refreshView(); throw e; });
    }
    return ready;
  }
  function errTxt(e){
    const m=String(e&&(e.message||e.details)||e);
    if(/Code inconnu/i.test(m)) return "Ce code n'existe pas. Vérifie les 6 caractères.";
    if(/termin/i.test(m)) return "Ce concours est terminé : on ne peut plus le rejoindre.";
    if(/members_pseudo_unique/.test(m)) return "Ce pseudo est déjà pris dans ce groupe. Choisis-en un autre.";
    if(/anonymous/i.test(m)) return "La connexion anonyme est désactivée dans Supabase (Authentication → Sign In / Providers → Allow anonymous sign-ins).";
    if(/Inscriptions closes/i.test(m)) return "Les inscriptions à ce concours sont closes.";
    if(/incoh/i.test(m)) return "Le serveur a refusé cet enregistrement. Ton portefeuille de concours a été rechargé tel qu'il est enregistré.";
    if(/row-level security|permission/i.test(m)) return "Action refusée : le concours n'est pas en cours.";
    if(/fetch|network|Chargement/i.test(m)) return "Impossible de joindre le serveur des concours. Vérifie ta connexion.";
    return "Erreur du serveur des concours : "+m;
  }

  /* ---------- mes groupes ---------- */
  async function loadMine(){
    const rows=await api.myGroups();
    const before=Object.fromEntries(groups.map(g=>[g.group.code,Math.max(0,...g.me.trades.map(t=>t.t||0))]));
    groups=rows.filter(r=>r.groups).map(r=>({group:r.groups,pseudo:r.pseudo,me:{cash:Number(r.cash),pos:r.pos||{},trades:r.trades||[]}}));
    for(const g of groups) lastLogged[g.group.code]=Math.max(0,...g.me.trades.map(t=>t.t||0));
    // stop loss / take profit exécutés par le serveur pendant que le site était fermé ou sur un autre portefeuille
    for(const g of groups){ const b=before[g.group.code]; if(b==null) continue;
      for(const t of g.me.trades.filter(t=>t.auto&&t.t>b).reverse()){ const a=A[t.id]; if(!a) continue;
        notify(t.auto,t.id,`${t.auto==="sl"?"Stop loss déclenché":"Take profit atteint"} (concours « ${g.group.name} ») : ${t.side==="sell"?"vente":"rachat"} de ${t.qty} × ${a.name} à ${fmt(Number(t.px),2)} ${CUR_SYM[a.cur]||""}.`); }
    }
    if(typeof updateBell==="function") updateBell();
    if(groups.length) lsSet(LS_JOINED,true);
    const saved=lsGet(LS_ACTIVE), cur=ACTIVE&&ACTIVE.group.code;
    const want=cur||saved;
    ACTIVE=groups.find(g=>g.group.code===want)||null;
    if(ACTIVE) fetchMembers(ACTIVE.group.code);
  }
  async function fetchMembers(code){
    try{ members[code]=await api.members(code); if(view==="portefeuille") refreshView(); }catch(e){ return; }
    // mon portefeuille a changé sur le serveur (stop loss / take profit exécuté par le serveur) : on recharge
    const mine=members[code].find(r=>r.player_id===api.uid), g=groups.find(x=>x.group.code===code);
    if(mine&&g&&!saveT&&!flushing&&Math.abs(Number(mine.cash)-g.me.cash)>0.01&&Date.parse(mine.updated_at)>(lastValSave[code]||0)+1000){
      try{ await loadMine(); render(true); }catch(e){}
    }
    snapshotDay(code);
  }
  // resynchronise tous mes concours régulièrement (si un ordre automatique a été exécuté sur un autre portefeuille)
  let lastResync=Date.now();
  async function resync(){ if(!api||saveT||flushing||Date.now()-lastResync<3e5) return; lastResync=Date.now(); try{ await loadMine(); refreshView(); }catch(e){} }

  /* ---------- classement quotidien sauvegardé ----------
     Quand un participant regarde le concours, le classement du jour est enregistré dans la base
     (au plus toutes les 10 minutes). Le dernier enregistrement de la journée devient le classement du jour ;
     les jours passés ne peuvent plus être modifiés. */
  const dailies={}, selDay={}, lastSnap={};
  async function snapshotDay(code){
    const g=groups.find(x=>x.group.code===code); if(!g||!api.saveDaily) return;
    const s=status(g.group);
    if(s!=="soon"&&Date.now()-(lastSnap[code]||0)>=6e5&&(members[code]||[]).length){
      lastSnap[code]=Date.now();
      const rows=members[code].map(r=>({player_id:r.player_id,value:Math.round(rowValue(r)*100)/100})).filter(r=>isFinite(r.value));
      try{ await api.saveDaily(code,rows); }catch(e){}
    }
    if(!dailies[code]||lastSnap[code]>(dailies[code].at||0)) fetchDaily(code);
  }
  async function fetchDaily(code){
    try{ const r=await api.daily(code); r.at=Date.now(); dailies[code]=r; if(view==="portefeuille") refreshView(); }catch(e){}
  }
  const dayTxt=d=>new Date(d+"T12:00:00").toLocaleDateString(LOC(),{weekday:"long",day:"numeric",month:"long"});
  function dailyBoard(g){
    const all=dailies[g.code], start=Number(g.start_cash);
    const head=`<h3 style="margin:18px 0 6px;font-size:16px">Classement jour par jour</h3>`;
    if(!all) return head+`<p class="note" style="margin:0">Chargement de l'historique…</p>`;
    if(!all.length) return head+`<p class="note" style="margin:0">Aucun classement enregistré pour l'instant. Le classement de chaque jour est sauvegardé automatiquement dès qu'un participant ouvre le concours, à partir du ${dt(g.starts_at)}.</p>`;
    const days=[...new Set(all.map(r=>r.day))].sort();
    const day=days.includes(selDay[g.code])?selDay[g.code]:days[days.length-1], i=days.indexOf(day);
    const rows=all.filter(r=>r.day===day).sort((a,b)=>a.rank-b.rank);
    const prev=i>0?new Map(all.filter(r=>r.day===days[i-1]).map(r=>[r.player_id,r.rank])):null;
    const move=r=>{ if(!prev) return `<span class="muted">—</span>`; const p=prev.get(r.player_id); if(p==null) return `<span class="tag">nouveau</span>`;
      const d=p-r.rank; return d>0?`<span class="up">▲ ${d}</span>`:d<0?`<span class="down">▼ ${-d}</span>`:`<span class="muted">=</span>`; };
    const today=parisDay(Date.now())===day&&status(g)==="live";
    return head+`<div class="btns" style="align-items:center;margin-bottom:8px">
        <label class="note" for="grp-day">Jour :</label>
        <select id="grp-day" data-grp-day="${esc(g.code)}">${days.map((d,k)=>`<option value="${d}" ${d===day?"selected":""}>Jour ${k+1} · ${dayTxt(d)}</option>`).join("")}</select>
        <button class="btn" data-grp="day:-1" ${i===0?"disabled":""} aria-label="Jour précédent">←</button><button class="btn" data-grp="day:1" ${i===days.length-1?"disabled":""} aria-label="Jour suivant">→</button></div>
      <div class="tbl-wrap"><table><thead><tr><th>Rang</th><th>Pseudo</th><th>Valeur</th><th>Performance</th><th>Évolution du rang</th></tr></thead><tbody>
      ${rows.map(r=>{ const me=api&&r.player_id===api.uid, v=Number(r.value); return `<tr${me?' style="background:var(--panel-2,rgba(47,124,246,.12))"':""}><td class="num">${r.rank}</td><td><b>${esc(r.pseudo)}</b>${me?" (toi)":""}</td><td class="num">${fmtEur(v)}</td><td class="num ${cls(v-start)}">${pct((v/start-1)*100)}</td><td class="num">${move(r)}</td></tr>`; }).join("")}
      </tbody></table></div>
      <p class="note" style="margin:6px 0 0">${today?"Classement du jour en cours : il est mis à jour quand un participant ouvre le concours et sera figé à minuit.":`Classement enregistré le ${dayTxt(day)} (dernière mise à jour de la journée).`} L'évolution compare avec le jour précédent enregistré.</p>`;
  }
  function setActive(code){
    if(ACTIVE&&saveT){ clearTimeout(saveT); saveT=null; flush(ACTIVE); }
    ACTIVE=code?groups.find(g=>g.group.code===code)||null:null;
    lsSet(LS_ACTIVE,ACTIVE?ACTIVE.group.code:null);
    form=null; msg=null;
    if(ACTIVE) fetchMembers(ACTIVE.group.code);
    render(true);
  }
  function refreshView(){ if(view==="portefeuille"||view==="accueil"||view==="detail") render(true); }

  /* ---------- enregistrer mon portefeuille de concours ---------- */
  function save(){ const E=ACTIVE; if(!E||!api) return; clearTimeout(saveT); saveT=setTimeout(()=>{ saveT=null; flush(E); },500); }
  let flushing=0;
  async function flush(E){ flushing++; try{ await flushNow(E); } finally { flushing--; } }
  async function flushNow(E){
    const code=E.group.code, me=E.me, prev=ACTIVE; ACTIVE=E; const value=pfTotal(); ACTIVE=prev;
    const fresh=me.trades.filter(t=>t.t>(lastLogged[code]||0));
    // ordres envoyés du plus ancien au plus récent (le serveur les rejoue dans cet ordre)
    const orders=fresh.slice().reverse().map(t=>({asset:t.id,side:t.side,qty:Math.abs(t.qty),amount_eur:Math.round(Math.abs(t.eur)*100)/100}));
    try{
      const sent=me.cash;
      const res=await api.saveMine(code,{cash:sent,pos:me.pos,trades:me.trades.slice(0,100),value:Math.round(value*100)/100},orders);
      // le serveur fait foi : on reprend ses liquidités (en gardant les ordres passés pendant l'envoi)
      if(res&&isFinite(Number(res.cash))){ me.cash+=Number(res.cash)-sent; if(ACTIVE===E&&view==="portefeuille") render(true); }
      if(fresh.length) lastLogged[code]=Math.max(...fresh.map(t=>t.t));
      lastValSave[code]=Date.now();
      const row=(members[code]||[]).find(r=>r.player_id===api.uid); if(row){ row.cash=me.cash; row.pos=me.pos; row.value=value; }
    }catch(e){
      toast("Le concours n'a pas pu enregistrer ton ordre : "+errTxt(e),"sl");
      // le portefeuille affiché ne correspond plus à celui du serveur : on recharge la version enregistrée
      if(/incoh|permission|row-level/i.test(String(e&&(e.message||e.details)||e))){ try{ await loadMine(); fetchMembers(code); render(true); }catch(err){} }
    }
  }
  // la valeur de mon portefeuille est enregistrée régulièrement (sert au classement du jour)
  const lastValSave={};
  function saveValue(){ if(ACTIVE&&api&&!saveT&&status(ACTIVE.group)==="live"&&Date.now()-(lastValSave[ACTIVE.group.code]||0)>=3e5) flush(ACTIVE); }

  /* ---------- règles du concours ---------- */
  const T=x=>Date.parse(x);
  const dt=x=>new Date(x).toLocaleString(LOC(),{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
  const left=ms=>{ const d=Math.floor(ms/864e5), h=Math.floor(ms%864e5/36e5), m=Math.floor(ms%36e5/6e4); return d?`${d} j ${h} h`:h?`${h} h ${m} min`:`${Math.max(1,m)} min`; };
  function status(g){ const n=Date.now(); return n<T(g.starts_at)?"soon":n>T(g.ends_at)?"over":"live"; }
  function blocked(side){
    const g=ACTIVE.group, s=status(g);
    if(side==="liquidation") return "";
    if(s==="soon") return `Le concours commence le ${dt(g.starts_at)} : les ordres seront possibles à ce moment-là.`;
    if(s==="over") return "Le concours est terminé : on ne peut plus passer d'ordre.";
    if(side==="short"&&!g.shorts) return "La vente à découvert n'est pas autorisée dans ce concours.";
    return "";
  }
  // appel de marge : avec du levier, si la valeur du portefeuille tombe sous 5 % de l'exposition, tout est fermé
  function onPrices(){
    if(!ACTIVE||pfLev()<=1||status(ACTIVE.group)!=="live") return;
    const eq=pfTotal(), gross=longValue()+shortExposure();
    if(gross>0&&eq<=gross*0.05){
      const P=PF();
      for(const id of Object.keys(P.pos)){ if(!A[id]) continue; const p=P.pos[id], v=unitEur(id)*p.qty; P.cash+=v; P.trades.unshift({t:Date.now(),id,side:"liquidation",qty:Math.abs(p.qty),px:price(id),eur:Math.abs(v)}); }
      P.pos={}; save();
      notify("sl",null,`Appel de marge dans « ${ACTIVE.group.name} » : ta perte a presque effacé ton capital, toutes tes positions ont été fermées.`);
    }
  }
  function rowValue(r){
    if(api&&r.player_id===api.uid&&ACTIVE) return pfTotal();
    let v=Number(r.cash);
    for(const [id,p] of Object.entries(r.pos||{})) v+=A[id]&&PX[id]?unitEur(id)*p.qty:(p.cost||0)*p.qty;
    return v;
  }

  /* ---------- affichage ---------- */
  function rules(g){
    const s=status(g);
    const st=s==="soon"?`<span class="tag">À venir · début dans ${left(T(g.starts_at)-Date.now())}</span>`:s==="live"?`<span class="tag long">En cours · fin dans ${left(T(g.ends_at)-Date.now())}</span>`:`<span class="tag short">Terminé</span>`;
    return `<div class="btns" style="align-items:center">${st}
      <span class="note">Capital de départ : <b>${fmtEur(Number(g.start_cash))}</b></span>
      <span class="note">${Number(g.leverage)>1?`Effet de levier : <b>×${g.leverage}</b>`:"<b>Sans effet de levier</b>"}</span>
      <span class="note">Vente à découvert : <b>${g.shorts?"autorisée":"interdite"}</b></span>
      <span class="note">Du ${dt(g.starts_at)} au ${dt(g.ends_at)}</span></div>
      ${Number(g.leverage)>1?`<p class="note" style="margin:6px 0 0">Avec un levier ×${g.leverage}, tu peux investir jusqu'à ${g.leverage} fois la valeur de ton portefeuille : les gains comme les pertes sont multipliés. Si ta valeur tombe sous 5 % de ton exposition, toutes tes positions sont fermées (appel de marge).</p>`:""}`;
  }
  function board(g){
    const rows=(members[g.code]||[]).map(r=>({r,v:rowValue(r)})).sort((a,b)=>b.v-a.v), start=Number(g.start_cash), over=status(g)==="over";
    if(!rows.length) return `<p class="note">Chargement du classement…</p>`;
    return `${over?`<p style="margin:0 0 8px"><b>Classement final.</b> Bravo à ${esc(rows[0].r.pseudo)} qui gagne avec ${pct((rows[0].v/start-1)*100)} !</p>`:""}
      <div class="tbl-wrap"><table><thead><tr><th>Rang</th><th>Pseudo</th><th>Valeur</th><th>Performance</th><th>Positions</th></tr></thead><tbody>
      ${rows.map(({r,v},i)=>{ const me=api&&r.player_id===api.uid; return `<tr${me?' style="background:var(--panel-2,rgba(47,124,246,.12))"':""}><td class="num">${i+1}</td><td><b>${esc(r.pseudo)}</b>${me?" (toi)":""}</td><td class="num">${fmtEur(v)}</td><td class="num ${cls(v-start)}">${pct((v/start-1)*100)}</td><td class="num">${Object.keys(r.pos||{}).length}</td></tr>`; }).join("")}
      </tbody></table></div><p class="note" style="margin:6px 0 0">Valeurs calculées avec les derniers cours (${asOfTxt()}). Le classement se met à jour toutes les minutes.</p>`;
  }
  function createForm(){
    const name=esc(S.profile?.name||"");
    return `<form id="grp-create" class="grid" style="gap:12px" novalidate>
      <div class="field"><label for="g-name">Nom du groupe</label><input id="g-name" maxlength="40" placeholder="Ex. : Concours 1re ES 2" required></div>
      <div class="field"><label for="g-pseudo">Ton pseudo dans le groupe</label><input id="g-pseudo" maxlength="20" value="${name}" placeholder="Ex. : Léa" required></div>
      <div class="field"><label for="g-cash">Montant alloué à chaque participant (€)</label><input id="g-cash" type="number" min="100" max="10000000" step="100" value="10000" list="g-cash-list"><datalist id="g-cash-list"><option value="1000"><option value="5000"><option value="10000"><option value="50000"><option value="100000"></datalist></div>
      <div class="field"><label for="g-start">Début du concours</label><select id="g-start"><option value="now">Maintenant</option><option value="tomorrow">Demain à 9 h</option><option value="monday">Lundi prochain à 9 h</option></select></div>
      <div class="field"><label for="g-days">Durée du concours</label><select id="g-days"><option value="1">1 jour</option><option value="7">1 semaine</option><option value="14" selected>2 semaines</option><option value="30">1 mois</option><option value="60">2 mois</option><option value="90">3 mois</option><option value="180">6 mois</option></select></div>
      <div class="field"><label for="g-lev">Effet de levier</label><select id="g-lev"><option value="1">Sans effet de levier</option><option value="2">Levier ×2</option><option value="5">Levier ×5</option><option value="10">Levier ×10</option></select></div>
      <label class="note" style="display:flex;gap:8px;align-items:center"><input id="g-shorts" type="checkbox" checked> Autoriser la vente à découvert (parier sur la baisse)</label>
      <div class="btns"><button class="btn primary" type="submit">Créer le groupe</button><button class="btn" type="button" data-grp="cancel">Annuler</button></div>
    </form>`;
  }
  function joinForm(){
    return `<form id="grp-join" class="grid" style="gap:12px" novalidate>
      <div class="field"><label for="j-code">Code du groupe</label><input id="j-code" maxlength="6" autocomplete="off" placeholder="Ex. : K7P2QM" style="text-transform:uppercase;letter-spacing:.15em"></div>
      <div class="field"><label for="j-pseudo">Ton pseudo dans le groupe</label><input id="j-pseudo" maxlength="20" value="${esc(S.profile?.name||"")}" placeholder="Ex. : Léa"></div>
      <div class="btns"><button class="btn primary" type="submit">Rejoindre</button><button class="btn" type="button" data-grp="cancel">Annuler</button></div>
    </form>`;
  }
  function panelHTML(){
    if(!configured()) return panel("Groupes et concours","GRP",`<p class="pb note" style="margin:0">Le mode concours n'est pas encore activé sur ce site : la personne qui a créé le site doit le relier à une base de données Supabase (voir le mode d'emploi du concours).</p>`);
    if(state==="idle"&&(lsGet(LS_JOINED)||lsGet(LS_ACTIVE))) init().catch(()=>{});
    const chips=`<div class="filters"><button data-grp="mine" aria-pressed="${!ACTIVE}">Mon portefeuille</button>${groups.map(g=>`<button data-grp="open:${esc(g.group.code)}" aria-pressed="${ACTIVE&&ACTIVE.group.code===g.group.code}">${esc(g.group.name)}</button>`).join("")}</div>`;
    const acts=`<div class="btns"><button class="btn primary" data-grp="create">Créer un groupe</button><button class="btn" data-grp="join">Rejoindre avec un code</button></div>`;
    const m=msg?`<p class="msg ${msg[0]}" role="status" style="margin:0">${esc(msg[1])}</p>`:"";
    let body;
    if(form==="create") body=createForm();
    else if(form==="join") body=joinForm();
    else if(ACTIVE){
      const g=ACTIVE.group, mine=api&&g.owner===api.uid;
      body=`<div class="btns" style="align-items:center;justify-content:space-between"><div><small class="note">Code à donner aux participants</small><div class="num" style="font-size:26px;letter-spacing:.2em;font-weight:700">${esc(g.code)}</div></div>
        <div class="btns"><button class="btn" data-grp="copy">Copier le code</button>${mine?`<span class="tag">Tu as créé ce groupe</span>`:""}</div></div>
        ${rules(g)}${board(g)}${dailyBoard(g)}`;
    } else body=`<p class="note" style="margin:0">Crée un groupe pour organiser un concours de Bourse avec ta classe, ou rejoins-en un avec le code qu'on t'a donné. Chaque participant reçoit le même capital virtuel et joue avec les vrais cours.</p>`;
    const load=state==="loading"?`<p class="note" style="margin:0">Connexion au serveur des concours…</p>`:"";
    return panel("Groupes et concours","GRP",`<div class="pb grid" style="gap:12px">${chips}${load}${m}${body}${form?"":acts}</div>`);
  }
  function tradeSwitch(){
    if(!configured()||!groups.length) return "";
    return `<div class="note" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">Jouer dans : <select data-grp-switch><option value="">Mon portefeuille</option>${groups.map(g=>`<option value="${esc(g.group.code)}" ${ACTIVE&&ACTIVE.group.code===g.group.code?"selected":""}>Concours « ${esc(g.group.name)} »</option>`).join("")}</select></div>`;
  }

  /* ---------- actions ---------- */
  const CODE_CH="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const newCode=()=>Array.from({length:6},()=>CODE_CH[Math.floor(Math.random()*CODE_CH.length)]).join("");
  function startDate(k){
    const d=new Date();
    if(k==="tomorrow"){ d.setDate(d.getDate()+1); d.setHours(9,0,0,0); }
    else if(k==="monday"){ d.setDate(d.getDate()+((8-d.getDay())%7||7)); d.setHours(9,0,0,0); }
    return d;
  }
  async function createGroup(){
    const name=$("#g-name").value.trim(), pseudo=$("#g-pseudo").value.trim(), cash=Math.round(Number($("#g-cash").value));
    if(name.length<2){ msg=["err","Donne un nom au groupe (2 caractères minimum)."]; return render(true); }
    if(pseudo.length<2){ msg=["err","Choisis un pseudo (2 caractères minimum)."]; return render(true); }
    if(!(cash>=100&&cash<=10000000)){ msg=["err","Le montant doit être compris entre 100 € et 10 000 000 €."]; return render(true); }
    const start=startDate($("#g-start").value), end=new Date(start.getTime()+Number($("#g-days").value)*864e5);
    const g={name,start_cash:cash,leverage:Number($("#g-lev").value),shorts:$("#g-shorts").checked,starts_at:start.toISOString(),ends_at:end.toISOString()};
    msg=["ok","Création du groupe…"]; render(true);
    try{
      await init();
      let made=null;
      for(let i=0;i<5&&!made;i++){ try{ made=await api.createGroup({...g,code:newCode()}); }catch(e){ if(!/duplicate|23505/.test(String(e.message||e.code))) throw e; } }
      if(!made) throw new Error("Impossible de créer un code unique");
      await api.join(made.code,pseudo); await loadMine(); lsSet(LS_JOINED,true);
      setActive(made.code); msg=["ok",`Groupe créé ! Donne le code ${made.code} aux participants pour qu'ils te rejoignent.`]; render(true);
    }catch(e){ msg=["err",errTxt(e)]; render(true); }
  }
  async function joinGroup(){
    const code=$("#j-code").value.trim().toUpperCase(), pseudo=$("#j-pseudo").value.trim();
    if(!/^[A-Z0-9]{6}$/.test(code)){ msg=["err","Le code fait 6 caractères (lettres et chiffres)."]; return render(true); }
    if(pseudo.length<2){ msg=["err","Choisis un pseudo (2 caractères minimum)."]; return render(true); }
    msg=["ok","Connexion au groupe…"]; render(true);
    try{
      await init(); await api.join(code,pseudo); await loadMine(); lsSet(LS_JOINED,true);
      setActive(code); msg=["ok",`Bienvenue dans « ${ACTIVE?ACTIVE.group.name:code} » ! Ouvre une action ou un ETF pour passer tes ordres.`]; render(true);
    }catch(e){ msg=["err",errTxt(e)]; render(true); }
  }
  document.addEventListener("click",e=>{
    const b=e.target.closest("[data-grp]"); if(!b) return;
    const a=b.dataset.grp;
    if(a==="create"||a==="join"){ form=a; msg=null; render(true); }
    else if(a==="cancel"){ form=null; msg=null; render(true); }
    else if(a==="mine") setActive(null);
    else if(a.startsWith("open:")) setActive(a.slice(5));
    else if(a.startsWith("day:")&&ACTIVE){ const c=ACTIVE.group.code, all=dailies[c]||[], days=[...new Set(all.map(r=>r.day))].sort();
      const cur=days.includes(selDay[c])?selDay[c]:days[days.length-1], k=days.indexOf(cur)+Number(a.slice(4));
      if(k>=0&&k<days.length){ selDay[c]=days[k]; render(true); } }
    else if(a==="copy"&&ACTIVE){ const c=ACTIVE.group.code; try{ navigator.clipboard.writeText(c).then(()=>toast(`Code ${c} copié.`,"tp"),()=>toast(`Le code est ${c}.`,"tp")); }catch(err){ toast(`Le code est ${c}.`,"tp"); } }
  });
  document.addEventListener("submit",e=>{
    if(e.target.id==="grp-create"){ e.preventDefault(); createGroup(); }
    else if(e.target.id==="grp-join"){ e.preventDefault(); joinGroup(); }
  });
  document.addEventListener("change",e=>{
    if(e.target.matches("[data-grp-switch]")) setActive(e.target.value||null);
    else if(e.target.matches("[data-grp-day]")){ selDay[e.target.dataset.grpDay]=e.target.value; render(true); }
  });

  // classement : mis à jour toutes les minutes pendant qu'on regarde un concours
  pollT=setInterval(()=>{ if(ACTIVE&&api){ fetchMembers(ACTIVE.group.code); onPrices(); saveValue(); } if(api&&groups.length) resync(); },60000);

  window.CONTEST={panelHTML,tradeSwitch,blocked,save,onPrices,setActive,list:()=>groups};
  if(configured()&&(lsGet(LS_JOINED)||lsGet(LS_ACTIVE))) init().catch(()=>{});
  if(view==="portefeuille"||view==="detail") render(true);   // la page a été dessinée avant le chargement de ce fichier
})();
