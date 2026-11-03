/* =====================================================================
   L'IA de MacroViewer
   Une IA « maison » qui fonctionne entièrement dans le navigateur, sans
   service extérieur. Elle marche en trois temps :
   1. elle reconnaît les questions sur les données du jour (cours d'une
      action, taux d'un pays, devise, marché du jour, presse, portefeuille) ;
   2. sinon, elle cherche la réponse dans ses connaissances : le glossaire,
      le cours de SES, les banques centrales du G20, les grandes histoires
      et le fichier connaissances.json (que l'on peut compléter) ;
   3. elle classe les passages avec la méthode TF-IDF : un mot rare et
      présent dans la question compte plus qu'un mot fréquent.
   ===================================================================== */
(function(){
  const EN=()=>LANG==="en";

  /* ---------- 1. Découper une phrase en mots utiles ---------- */
  const norm=s=>String(s||"").replace(/<[^>]+>/g," ").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[’']/g," ");
  const STOP=new Set(("le la les un une des du de d l a au aux et ou en dans sur pour par avec sans ce cet cette ces qui que quoi quel quelle quels quelles qu "+
    "est sont etre etait c ca cela ceci il elle ils elles on je j tu me m te t se s mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs y ne n pas "+
    "plus moins tres trop comment pourquoi quand combien explique expliquer expliques moi dis dire veut veux voudrais peux peut faire fait "+
    "signifie definition definir simplement svp stp merci bien aussi alors donc mais si entre the what is are of to and how why do does a an it in on "+
    "for me tell explain about can you please").split(" "));
  const stem=w=>{
    if(w.length>6) w=w.replace(/(ements|ement|ations|ation|issement|ites|ite|iques|ique|euses|euse|eurs|eur|ives|ive|ifs|if|ables|able|ances|ance|ences|ence|ings|ing)$/,"");
    if(w.length>3) w=w.replace(/(aux|es|s|x)$/,m=>m==="aux"?"al":"");
    return w;
  };
  // synonymes : un mot de la question est complété par d'autres mots de même sens
  const SYN={bce:"banque centrale europeenne",ecb:"banque centrale europeenne",fed:"reserve federale",
    qe:"assouplissement quantitatif",pib:"produit interieur brut",gdp:"produit interieur brut",
    ipo:"introduction bourse",opa:"offre publique achat",per:"price earnings ratio",
    etf:"fonds indiciel",tracker:"fonds indiciel",short:"vente decouvert",shorter:"vente decouvert",
    steepening:"pentification",steepener:"pentification",flattening:"aplatissement",flattener:"aplatissement",
    prix:"inflation",chomage:"emploi",krach:"crise",bulle:"speculative",taux:"interet",
    stock:"action",share:"action",bond:"obligation",bonds:"obligation",yield:"taux",inflation:"inflation"};
  function toks(s,expand){
    let w=norm(s).split(/[^a-z0-9%]+/).filter(x=>x&&x.length>1&&!STOP.has(x));
    if(expand) w=w.concat(...w.map(x=>SYN[x]?SYN[x].split(" "):[]));
    return w.map(stem);
  }
  const has=(q,re)=>re.test(norm(q));
  const clip=(s,n=420)=>{ s=String(s).replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim(); if(s.length<=n) return s; const cut=s.slice(0,n); const i=Math.max(cut.lastIndexOf(". "),cut.lastIndexOf(" : ")); return (i>n*0.5?cut.slice(0,i+1):cut.replace(/\s+\S*$/,"")+"…"); };
  const L=x=>Array.isArray(x)?T2(x[0],x[1]):x;

  /* ---------- 2. Les connaissances ---------- */
  let DOCS=[], IDF={}, FAQ=[];
  function buildIndex(){
    const docs=[];
    for(const g of GLOSSARY){
      const e=EN()&&GLOSSARY_EN[g[0]];
      const [t,d,x]=e||g;
      docs.push({kind:"glos",title:t,key:t.replace(/\s*\(.*\)$/,""),text:d+" "+T2("Exemple : ","Example: ")+x,link:[T2("Voir le glossaire","Open the glossary"),"glos:"+g[0]]});
    }
    for(const c of COURSE){
      for(const [h,p] of c.secs) docs.push({kind:"course",title:L(h),chapter:L(c.t),text:L(p),link:[T2("Lire le chapitre","Read the chapter"),"course:"+c.id]});
      if(c.keep) docs.push({kind:"course",title:L(c.t),chapter:L(c.t),text:L(c.keep),link:[T2("Lire le chapitre","Read the chapter"),"course:"+c.id]});
    }
    HISTORY.forEach((h,i)=>{
      const e=EN()&&HISTORY_EN[h.t];
      docs.push({kind:"hist",title:e?e[0]:h.t,text:`${h.y} : ${e?e[1]:h.p} ${e?e[2]||"":h.r||""}`,link:[T2("Lire l'histoire","Read the story"),"hist:"+i]});
    });
    for(const a of ASSETS) if(a.type==="devise"&&a.cb)
      docs.push({kind:"fx",title:`${a.cb} (${a.country})`,keys:`${a.name} ${a.code} ${a.country} ${a.gov} ${T2("banque centrale gouverneur mandat","central bank governor mandate")}`,
        text:`${T2("Monnaie","Currency")} : ${a.name}. ${T2("Banque centrale","Central bank")} : ${a.cb}, ${T2("dirigée par","led by")} ${a.gov} (${a.since}). ${T2("Mandat","Mandate")} : ${a.mandate} ${a.desc||""}`,
        link:[T2("Voir la fiche du pays","Open the country page"),"asset:"+a.id]});
    for(const f of FAQ){
      const qs=EN()&&f.en?f.en.q:f.q, r=EN()&&f.en?f.en.r:f.r;
      docs.push({kind:"faq",title:qs[0],keys:qs.join(" ")+" "+(f.mots||""),text:r,link:f.voir?[f.lien||T2("Voir dans MacroViewer","Open in MacroViewer"),f.voir]:null});
    }
    // TF-IDF : on compte dans combien de passages chaque mot apparaît
    const df={};
    for(const d of docs){
      d.tt=toks(d.title+" "+(d.key||"")); d.tk=toks(d.keys||""); d.tx=toks(d.text);
      d.tf={}; for(const w of d.tx) d.tf[w]=(d.tf[w]||0)+1;
      d.nt=norm(d.key||d.title);
      for(const w of new Set([...d.tt,...d.tk,...d.tx])) df[w]=(df[w]||0)+1;
    }
    IDF={}; for(const w in df) IDF[w]=Math.log(1+docs.length/df[w]);
    DOCS=docs;
  }
  function search(q){
    const qt=[...new Set(toks(q,true))].filter(w=>IDF[w]);
    if(!qt.length) return {hits:[],known:0};
    const total=qt.reduce((s,w)=>s+IDF[w],0), nq=" "+norm(q)+" ";
    const hits=DOCS.map(d=>{
      let s=0;
      for(const w of qt){
        let m=0;
        if(d.tt.includes(w)) m+=3;
        if(d.tk.includes(w)) m+=2.5;
        if(d.tf[w]) m+=Math.min(d.tf[w],3)*0.6;
        if(m) s+=IDF[w]*Math.min(m,4);
      }
      s=s/(total*4);                                   // entre 0 et 1 : part de la question couverte
      if(d.nt.length>2&&nq.includes(" "+d.nt+" ")) s+=0.45;   // le titre exact est dans la question
      if(d.kind==="faq") s*=1.12;                      // les réponses rédigées sont prioritaires
      return {d,s};
    }).filter(h=>h.s>0).sort((a,b)=>b.s-a.s);
    return {hits,known:qt.length};
  }

  /* ---------- 3. Les données du jour ---------- */
  const ok=a=>a&&PX[a.id]&&PX[a.id].p!=null;
  // devises citées par leur nom courant
  const CUR=[["dollar canadien","eurcad"],["dollar australien","euraud"],["dollar de hong kong","eurhkd"],["dollar hongkongais","eurhkd"],["franc suisse","eurchf"],
    ["peso mexicain","eurmxn"],["peso argentin","eurars"],["roupie indonesienne","euridr"],["roupie","eurinr"],["rupee","eurinr"],["lire turque","eurtry"],["livre sterling","eurgbp"],
    ["livre","eurgbp"],["sterling","eurgbp"],["pound","eurgbp"],["yen","eurjpy"],["yuan","eurcny"],["renminbi","eurcny"],["real","eurbrl"],["won","eurkrw"],["rouble","eurrub"],
    ["ruble","eurrub"],["rand","eurzar"],["riyal","eursar"],["dollar","eurusd"]];
  const COUNTRY=[["etats unis|americain|amerique|usa|us|treasur","US"],["france|francais|oat","France"],["allemagne|allemand|bund","Allemagne"],["italie|italien|btp","Italie"],
    ["japon|japonais|jgb","Japon"],["royaume uni|britannique|anglais|gilt","Royaume-Uni"],["espagne|espagnol","Espagne"],["portugal","Portugal"],["grece","Grèce"],["belgique","Belgique"],
    ["pays bas|neerlandais","Pays-Bas"],["autriche","Autriche"],["suisse","Suisse"],["canada","Canada"],["australie","Australie"],["chine|chinois","Chine"],["inde|indien","Inde"],["bresil","Brésil"]];
  let NAMES=null;
  function names(){
    if(NAMES) return NAMES;
    NAMES=[];
    for(const a of ASSETS){
      if(a.type==="devise") continue;
      const n=norm(a.name).replace(/\(.*?\)/g," ").replace(/\b(sa|se|inc|corp|plc|ag|nv|group|groupe|holding|holdings|co|ltd|the|company)\b\.?/g," ").replace(/[^a-z0-9& ]+/g," ").replace(/\s+/g," ").trim();
      if(n.length>=4) NAMES.push([n,a]);
      const s=norm(a.sym||"").replace(/[^a-z0-9.]/g,"");
      if(s.length>=3&&!a.uni&&!/\d/.test(s)) NAMES.push([s,a]);
    }
    NAMES.sort((x,y)=>y[0].length-x[0].length);
    return NAMES;
  }
  function findAsset(q){
    const nq=" "+norm(q).replace(/[^a-z0-9& ]+/g," ").replace(/\s+/g," ")+" ";
    // taux d'un pays : « taux français à 2 ans », « OAT 10 ans »…
    if(/\b(taux|oat|bund|btp|gilt|treasur|jgb|obligation|emprunt|yield|rate)/.test(nq)){
      const m=nq.match(/\b(2|10|30)\s*ans?\b|\b(2|10|30)\s*y/); const mat=m?+(m[1]||m[2]):10;
      for(const [re,reg] of COUNTRY) if(new RegExp("\\b("+re+")\\b").test(nq)){
        const b=ASSETS.find(a=>a.type==="obligation"&&a.region===reg&&(a.mat||10)===mat)||ASSETS.find(a=>a.type==="obligation"&&a.region===reg);
        if(b) return b;
      }
    }
    for(const [n,id] of CUR) if(nq.includes(" "+n+" ")&&A[id]) return A[id];
    for(const [n,a] of names()) if(nq.includes(" "+n+" ")) return a;
    return null;
  }
  function assetAnswer(a){
    if(!ok(a)) return {text:T2(`Je connais **${a.name}**, mais je n'ai pas son cours en ce moment.`,`I know **${a.name}**, but I don't have its price right now.`),links:[[T2("Voir la fiche","Open the page"),"asset:"+a.id]]};
    const when=T2(`(cours relevés le ${asOfTxt()})`,`(prices as of ${asOfTxt()})`);
    let t;
    if(a.type==="obligation") t=T2(`L'État (${a.region}) emprunte à **${pxTxt(a)}** sur ${a.mat||10} ans, soit ${bondChgTxt(a)} sur la séance ${when}.`,`${a.name} yields **${pxTxt(a)}**, ${bondChgTxt(a)} on the day ${when}.`)+
      T2(" Quand ce taux monte, le prix des obligations déjà émises baisse."," When this yield rises, the price of existing bonds falls.");
    else if(a.type==="devise") t=T2(`**1 € = ${pxTxt(a)}** ${when}, soit ${pct(chg(a.id))} sur la séance. Si ce chiffre monte, l'euro s'apprécie face au ${a.name.toLowerCase()}.`,`**€1 = ${pxTxt(a)}** ${when}, ${pct(chg(a.id))} on the day. If this number rises, the euro strengthens.`);
    else{
      t=T2(`**${a.name}** (${a.sym}) cote **${pxTxt(a)}**, ${pct(chg(a.id))} par rapport à la clôture précédente ${when}.`,`**${a.name}** (${a.sym}) trades at **${pxTxt(a)}**, ${pct(chg(a.id))} versus the previous close ${when}.`);
      const y1=perfOf(a.id,"y1"); if(y1!=null) t+=T2(` Sur un an : ${pct(y1)}.`,` Over one year: ${pct(y1)}.`);
      const F=MARKET.a&&MARKET.a[a.id]&&MARKET.a[a.id].fin;
      if(F&&a.type==="action") t+=T2(`\nCapitalisation : ${money(F.mcap,a.cur)} · PER : ${nd(F.pe)} · dividende : ${pf(F.dy,2)}.`,`\nMarket cap: ${money(F.mcap,a.cur)} · P/E: ${nd(F.pe)} · dividend yield: ${pf(F.dy,2)}.`);
    }
    if(a.desc) t+="\n"+clip(a.desc,260);
    return {text:t,links:[[T2("Voir la fiche et le graphique","Open the page and chart"),"asset:"+a.id]]};
  }
  function marketAnswer(){
    const ix=["spx","ndx","dji","cac","dax","sx5e","n225"].map(id=>A[id]).filter(ok);
    const st=ASSETS.filter(a=>a.type==="action"&&!a.uni&&ok(a)).sort((x,y)=>chg(y.id)-chg(x.id));
    let t=T2(`Voici la dernière séance (cours relevés le ${asOfTxt()}) :\n`,`Here is the latest session (prices as of ${asOfTxt()}):\n`)+ix.map(a=>`• ${a.name} : **${pct(chg(a.id))}**`).join("\n");
    if(st.length>2) t+=T2(`\nPlus forte hausse : ${st[0].name} (${pct(chg(st[0].id))}). Plus forte baisse : ${st[st.length-1].name} (${pct(chg(st[st.length-1].id))}).`,`\nBiggest gain: ${st[0].name} (${pct(chg(st[0].id))}). Biggest loss: ${st[st.length-1].name} (${pct(chg(st[st.length-1].id))}).`);
    const ust=A.ust10; if(ok(ust)) t+=T2(`\nTaux américain à 10 ans : ${pxTxt(ust)} (${bondChgTxt(ust)}).`,`\nUS 10-year yield: ${pxTxt(ust)} (${bondChgTxt(ust)}).`);
    const n=NEWS.items&&NEWS.items[0]; if(n) t+=T2(`\nÀ la une : « ${n.title} » (${n.src}).`,`\nTop story: "${n.title}" (${n.src}).`);
    return {text:t,links:[[T2("Voir les actions et indices","Open stocks & indices"),"go:actions"],[T2("Voir la presse","Open the news"),"go:news"]]};
  }
  function newsAnswer(tag){
    const items=(NEWS.items||[]).filter(n=>!tag||(n.tags||[]).includes(tag)).slice(0,5);
    if(!items.length) return {text:T2("Je n'ai pas trouvé de titre récent sur ce sujet dans la presse du jour.","I found no recent headline on this topic."),links:[[T2("Voir la presse","Open the news"),"go:news"]]};
    const lbl=tag?TAGS[tag].toLowerCase():T2("l'actualité","the news");
    return {text:T2(`Les derniers titres sur ${lbl} (presse relevée : ${dateTxt(NEWS.asOf)}) :\n`,`Latest headlines (${dateTxt(NEWS.asOf)}):\n`)+items.map(n=>`• « ${n.title} » — ${n.src}`).join("\n"),links:[[T2("Toutes les news","All the news"),"go:news"]]};
  }
  function portfolioAnswer(){
    const ids=Object.keys(S.pos), tot=pfTotal(), pl=tot-START_CASH;
    let t=T2(`Ton portefeuille virtuel vaut **${fmtEur(tot)}** pour ${fmtEur(START_CASH)} au départ, soit **${pl>=0?"+":"−"}${fmtEur(Math.abs(pl))}** (${pct(pl/START_CASH*100)}). Liquidités : ${fmtEur(S.cash)}.`,
      `Your virtual portfolio is worth **${fmtEur(tot)}** versus ${fmtEur(START_CASH)} at the start: **${pl>=0?"+":"−"}${fmtEur(Math.abs(pl))}** (${pct(pl/START_CASH*100)}). Cash: ${fmtEur(S.cash)}.`);
    if(!ids.length) return {text:t+T2("\nTu n'as encore aucune position : ouvre la fiche d'une action ou d'un ETF et clique sur « Acheter ». Un ETF MSCI World est un bon point de départ pour être diversifié.","\nYou have no position yet: open a stock or ETF page and click Buy."),links:[[T2("Ouvrir le portefeuille","Open the portfolio"),"go:portefeuille"]]};
    const rows=ids.map(id=>({a:A[id],v:posValueEur(id),p:posPL(id)})).sort((x,y)=>Math.abs(y.v)-Math.abs(x.v));
    t+="\n"+rows.map(r=>`• ${r.a.name} : ${fmtEur(r.v)} (${r.p>=0?"+":"−"}${fmtEur(Math.abs(r.p))})`).join("\n");
    const big=Math.abs(rows[0].v)/Math.max(tot,1);
    const tips=[];
    if(big>0.4) tips.push(T2(`${rows[0].a.name} pèse ${fmt(big*100,0)} % du portefeuille : c'est beaucoup sur une seule ligne.`,`${rows[0].a.name} is ${fmt(big*100,0)}% of the portfolio: a lot on one line.`));
    if(rows.length<4) tips.push(T2("Avec moins de 4 lignes, le portefeuille est peu diversifié : un ETF ou des secteurs différents réduiraient le risque.","Fewer than 4 lines means little diversification."));
    if(rows.some(r=>r.v<0)) tips.push(T2("Tu as une position vendeuse (short) : la perte n'a pas de limite si le cours monte, pense au stop loss.","You have a short position: the loss is unlimited if the price rises, use a stop loss."));
    if(S.cash/tot>0.5) tips.push(T2("Plus de la moitié est en liquidités : c'est prudent, mais cet argent ne rapporte rien.","Over half is in cash: safe, but it earns nothing."));
    if(tips.length) t+="\n"+T2("Mon avis : ","My view: ")+tips.join(" ");
    return {text:t,links:[[T2("Ouvrir le portefeuille","Open the portfolio"),"go:portefeuille"]]};
  }

  // « Explique-moi cette actualité » : on définit les mots du glossaire présents dans le titre
  function explainHeadline(title,extra){
    const nt=" "+norm(title+" "+(extra||"")).replace(/[^a-z0-9 ]+/g," ")+" ";
    const words=DOCS.filter(d=>d.kind==="glos"&&d.nt.length>2&&(nt.includes(" "+d.nt+" ")||(d.tt.length===1&&d.tt[0].length>3&&nt.includes(" "+d.tt[0]))));
    const a=findAsset(title);
    let t=T2(`Le titre : « ${title} ».`,`The headline: "${title}".`);
    if(words.length) t+="\n"+T2("Les mots importants :","Key words:")+"\n"+words.slice(0,4).map(d=>`• **${d.title}** : ${clip(d.text.split(T2("Exemple : ","Example: "))[0],200)}`).join("\n");
    else t+="\n"+T2("Je n'y trouve pas de mot du glossaire. Ouvre l'article pour le détail, ou pose-moi une question sur un mot précis.","I can't find a glossary word in it.");
    const links=words.slice(0,2).map(d=>d.link&&[d.title,d.link[1]]).filter(Boolean);
    if(a&&ok(a)){ t+="\n"+T2(`${a.name} cote ${pxTxt(a)} (${a.type==="obligation"?bondChgTxt(a):pct(chg(a.id))}).`,`${a.name} trades at ${pxTxt(a)}.`); links.unshift([a.name,"asset:"+a.id]); }
    return {text:t,links};
  }

  /* ---------- 4. Répondre ---------- */
  const OUT=T2("Je suis l'IA de MacroViewer : je ne réponds qu'aux questions de finance et d'économie (marchés, entreprises, taux, monnaie, inflation, cours de SES…).","I'm MacroViewer's AI: I only answer finance and economics questions.");
  const IDEAS=()=>[T2("C'est quoi l'inflation ?","What is inflation?"),T2("Comment les banques créent-elles la monnaie ?","How do banks create money?"),T2("Combien vaut Apple ?","What's Apple's price?"),T2("C'est quoi une pentification ?","What is a steepener?")];
  function answer(q){
    if(!DOCS.length) buildIndex();
    const n=norm(q);
    const quoted=q.match(/«\s*(.+?)\s*»/);
    if(quoted&&/^explique.?moi (simplement cette actualite|ce flash)/.test(n)){ const s=q.match(/Résumé du journal : (.+?) Que veulent/); return explainHeadline(quoted[1],s&&s[1]); }
    if(/^\s*(bonjour|salut|hello|hi|coucou|bonsoir|hey)\b/.test(n)&&n.split(" ").length<=3) return {text:T2(`Bonjour${S.profile?.name?" "+S.profile.name:""} ! Pose-moi une question de finance ou d'économie : un mot du glossaire, une notion du cours de SES, le cours d'une action, le taux d'un pays…`,`Hi! Ask me a finance or economics question.`),ideas:IDEAS()};
    if(/\b(merci|thanks|thank you)\b/.test(n)&&n.split(" ").length<=4) return {text:T2("Avec plaisir ! Une autre question ?","You're welcome! Another question?")};
    if(/\b(qui es tu|tu es qui|comment tu marches|comment fonctionnes tu|who are you)\b/.test(n)) return {text:T2("Je suis l'IA de MacroViewer, programmée pour ce site. Je lis ta question, je repère les mots importants et je cherche la réponse dans le glossaire, le cours de SES, les fiches des banques centrales, les grandes histoires de la finance, ainsi que dans les cours de Bourse et la presse du jour. Je fonctionne directement dans ton navigateur, sans envoyer tes questions à personne.","I'm MacroViewer's own AI: I look for the answer in the glossary, the SES course, central bank pages, finance stories and today's market data, right in your browser.")};
    if(/\b(mon|ma|mes|my)\b.*\b(portefeuille|portfolio|positions?)\b|\b(analyse|bilan)\b.*\bportefeuille\b/.test(n)) return portfolioAnswer();
    if(/\b(introductions? en bourse|ipo|entree en bourse)\b/.test(n)&&/\b(actualite|en ce moment|recent|aujourd|cette semaine|font|news|derni)/.test(n)) return newsAnswer("ipo");
    if(/\b(rachats?|fusions?|acquisitions?|opa|deals?|mergers?)\b/.test(n)&&/\b(actualite|en ce moment|en cours|recent|aujourd|cette semaine|news|derni|gros)/.test(n)) return newsAnswer("deal");
    if(/\b(news|actualites?|presse|journaux|a la une|headlines?)\b/.test(n)) return newsAnswer(/\b(taux|bce|fed|banque centrale)\b/.test(n)?"taux":/\bresultats?\b/.test(n)?"result":null);
    if(/\b(marches?|bourses?|seance|markets?)\b.*\b(aujourd hui|du jour|ce soir|ce matin|today|hier)\b|\bque s est il passe\b|\bcomment va (la bourse|le marche)\b/.test(n)) return marketAnswer();
    const a=findAsset(q);
    const priceQ=/\b(cours|prix|combien|vaut|valent|cote|coter|performance|monte|baisse|varie|aujourd|price|worth|quote|taux|rendement)\b/.test(n);
    const {hits,known}=search(q);
    const top=hits[0];
    if(a&&(priceQ||!top||top.s<0.5||n.split(" ").length<=3)) return assetAnswer(a);
    if(top&&top.s>=0.32){
      const d=top.d;
      let t=`**${d.title}**${d.kind==="course"&&d.chapter&&d.chapter!==d.title?T2(` (cours de SES : ${d.chapter})`,` (SES course: ${d.chapter})`):""}\n${clip(d.text,d.kind==="faq"?900:480)}`;
      const links=d.link?[d.link]:[];
      const more=hits.slice(1).filter(h=>h.s>=Math.max(0.3,top.s*0.6)&&h.d.title!==d.title&&h.d.link).slice(0,2);
      if(more.length) t+="\n"+T2("Voir aussi : ","See also: ")+more.map(h=>h.d.title).join(" · ");
      for(const h of more) links.push([h.d.title,h.d.link[1]]);
      if(a) links.push([T2(`Cours de ${a.name}`,`${a.name} price`),"asset:"+a.id]);
      return {text:t,links};
    }
    if(a) return assetAnswer(a);
    if(known&&top&&top.s>=0.18) return {text:T2(`Je ne suis pas sûr d'avoir bien compris. Le plus proche que je connaisse : **${top.d.title}**.\n${clip(top.d.text,260)}\nEssaie de reformuler avec un mot clé (par exemple « inflation », « taux directeur », « ETF »).`,`I'm not sure I understood. The closest thing I know: **${top.d.title}**.`),links:top.d.link?[top.d.link]:[],ideas:IDEAS()};
    return {text:OUT+T2(" Essaie par exemple :"," Try for example:"),ideas:IDEAS()};
  }

  /* ---------- 5. Ouvrir une page depuis une réponse ---------- */
  function open(action){
    const [k,v]=[action.slice(0,action.indexOf(":")),action.slice(action.indexOf(":")+1)];
    if(window.innerWidth<900) closeChat();
    if(k==="asset") openAsset(v);
    else if(k==="hist") openHistory(+v);
    else if(k==="course"){ courseOpen=v; go("cours"); }
    else if(k==="go") go(v);
    else if(k==="glos"){ go("glossaire"); const gq=$("#gq"); if(gq){ gq.value=v.replace(/\s*\(.*\)$/,""); gq.dispatchEvent(new Event("input")); } }
  }

  // connaissances.json : questions-réponses rédigées, que l'on peut compléter sur GitHub
  fetch("connaissances.json?t="+Date.now(),{cache:"no-store"}).then(r=>r.ok?r.json():[]).then(j=>{ if(Array.isArray(j)){ FAQ=j.filter(f=>f&&Array.isArray(f.q)&&f.r); DOCS=[]; } }).catch(()=>{});

  window.MVIA={answer,open,reset(){ DOCS=[]; NAMES=null; }};
})();
