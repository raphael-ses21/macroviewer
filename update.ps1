# MacroViewer : relève les derniers cours réels (Yahoo Finance, CNBC) et les titres de presse (flux RSS)
# puis écrit quotes.json et news.json à la racine du site. Lancé par GitHub Actions (.github/workflows/update.yml).
param([string]$OutDir = (Split-Path $PSScriptRoot -Parent), [int]$LiveMinutes = 0, [int]$LiveEvery = 300)
$ErrorActionPreference = 'Stop'
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
$utf8 = New-Object Text.UTF8Encoding($false)

# ---------- cours ----------
$yahoo = [ordered]@{ spx='^GSPC'; ndx='^NDX'; dji='^DJI'; cac='^FCHI'; dax='^GDAXI'; sx5e='^STOXX50E'; n225='^N225'; aapl='AAPL'; msft='MSFT'; nvda='NVDA'; amzn='AMZN'; googl='GOOGL'; tsla='TSLA'; meta='META'; mc='MC.PA'; tte='TTE.PA'; air='AIR.PA'; or='OR.PA'; bnp='BNP.PA'; san='SAN.PA'; rms='RMS.PA'; asml='ASML.AS'; cw8='CW8.PA'; cspx='CSPX.L'; cndx='CNDX.L'; c40='C40.PA'; vwce='VWCE.DE'; aeem='AEEM.PA'; ieag='IEGA.AS' }
foreach($kv in @(@('ftse','^FTSE'),@('smi','^SSMI'),@('ibex','^IBEX'),@('mib','FTSEMIB.MI'),@('aex','^AEX'),@('hsi','^HSI'),@('sse','000001.SS'),@('kospi','^KS11'),@('sensex','^BSESN'),@('bvsp','^BVSP'),@('tsx','^GSPTSE'),@('asx','^AXJO'),@('rut','^RUT'),@('vix','^VIX'),@('bel20','^BFX'),@('sbf120','^SBF120'),@('spy','SPY'),@('qqq','QQQ'),@('voo','VOO'),@('vti','VTI'),@('gld','GLD'),@('iwda','IWDA.AS'),@('eimi','EIMI.L'),@('meud','MEUD.PA'),@('icln','ICLN'),@('ieac','IEAC.AS'),@('ese','ESE.PA'),@('panx','PANX.PA'))){ $yahoo[$kv[0]]=$kv[1] }
# ETF par pays, ETF matières premières et crypto, cryptomonnaies (en euros), matières premières (contrats à terme en dollars)
foreach($kv in @(@('bova11','BOVA11.SA'),@('ewz','EWZ'),@('kodex200','069500.KS'),@('ewy','EWY'),@('ewj','EWJ'),@('inda','INDA'),@('mchi','MCHI'),@('ewt','EWT'),@('ewa','EWA'),@('ewc','EWC'),@('ewu','EWU'),@('ewg','EWG'),@('ewl','EWL'),@('eww','EWW'),@('eza','EZA'),@('slv','SLV'),@('uso','USO'),@('ibit','IBIT'),
  @('btc','BTC-EUR'),@('eth','ETH-EUR'),@('sol','SOL-EUR'),@('xrp','XRP-EUR'),@('bnb','BNB-EUR'),@('ada','ADA-EUR'),@('doge','DOGE-EUR'),
  @('gold','GC=F'),@('silver','SI=F'),@('platinum','PL=F'),@('copper','HG=F'),@('wti','CL=F'),@('brent','BZ=F'),@('natgas','NG=F'),@('wheat','ZW=F'),@('corn','ZC=F'),@('coffee','KC=F'),@('cocoa','CC=F'),@('sugar','SB=F'))){ $yahoo[$kv[0]]=$kv[1] }
# ETF des grands indices
foreach($kv in @(@('tiger200','102110.KS'),@('kodexkq150','229200.KS'),@('smal11','SMAL11.SA'),@('exs1','EXS1.DE'),@('exw1','EXW1.DE'),@('isf','ISF.L'),@('cssmi','CSSMI.SW'),@('lyxib','LYXIB.MC'),@('etfmib','ETFMIB.MI'),@('iaex','IAEX.AS'),@('dia','DIA'),@('iwm','IWM'),@('nk225','1321.T'),@('tracker','2800.HK'),@('sse50etf','510050.SS'),@('niftybees','NIFTYBEES.NS'),@('stw','STW.AX'),@('xiu','XIU.TO'))){ $yahoo[$kv[0]]=$kv[1] }
# Taïwan : indice TAIEX et ETF
foreach($kv in @(@('taiex','^TWII'),@('tw0050','0050.TW'),@('tw006208','006208.TW'),@('tw0056','0056.TW'),@('tw00878','00878.TW'),@('tw00919','00919.TW'),@('fltw','FLTW'))){ $yahoo[$kv[0]]=$kv[1] }
# devises du G20 face à l'euro
foreach($x in 'twd','usd','jpy','gbp','chf','cad','aud','cny','inr','brl','hkd','krw','idr','mxn','rub','sar','zar','try','ars'){ $yahoo["eur$x"] = "EUR$($x.ToUpper())=X" }
# ---------- entrées en Bourse attendues ----------
# Dès que l'entreprise est cotée à New York (Nasdaq ou NYSE), ses cours sont relevés automatiquement
# et le site l'affiche tout seul (onglet « Autres actions »). Rien d'autre à faire ce jour-là.
$ipoWatch = [ordered]@{ anthropic = '^Anthropic(?!.*(ETF|ETP|Synth|Token|Lab Ecosystem))' }
$ipoSym = @{}
foreach ($k in $ipoWatch.Keys) {
  try {
    $r = Invoke-RestMethod -Uri ("https://query2.finance.yahoo.com/v1/finance/search?q=" + [uri]::EscapeDataString($k) + "&quotesCount=10&newsCount=0") -UserAgent $ua -TimeoutSec 20
    $hit = $r.quotes | Where-Object { $_.quoteType -eq 'EQUITY' -and $_.exchange -in 'NMS','NGM','NCM','NYQ','ASE' -and ((@($_.longname, $_.shortname) -match $ipoWatch[$k]).Count -gt 0) } | Select-Object -First 1
    if ($hit) { $yahoo[$k] = $hit.symbol; $ipoSym[$k] = $hit.symbol; "Entrée en Bourse détectée : $k = $($hit.symbol)" }
  } catch {}
}
$bonds = [ordered]@{ oat10='FR10Y'; bund10='DE10Y'; btp10='IT10Y'; ust10='US10Y'; gilt10='GB10Y'; jgb10='JP10Y'
  es10='ES10Y'; pt10='PT10Y'; be10='BE10Y'; nl10='NL10Y'; gr10='GR10Y'; at10='AT10Y'; ch10='CH10Y'; ca10='CA10Y'; au10='AU10Y'; cn10='CN10Y'; in10='IN10Y'; br10='BR10Y'
  fr2='FR2Y'; fr30='FR30Y'; de2='DE2Y'; de30='DE30Y'; us2='US2Y'; us30='US30Y'; it2='IT2Y'; jp2='JP2Y' }
# courbes des taux de 3 mois à 30 ans (clés r_pays_durée)
foreach($c in 'us','fr','de','it','gb','jp'){ foreach($t in '3m','6m','1y','2y','5y','10y','30y'){ $bonds["r_${c}_$t"] = ($c.ToUpper() + $t.ToUpper()) } }

# ---------- cours de référence des concours (Supabase) ----------
# Le serveur des concours recalcule chaque ordre avec ces prix : un joueur ne peut pas annoncer un faux cours.
# Il faut le secret SUPABASE_SERVICE_KEY dans GitHub (Settings → Secrets and variables → Actions).
$sbUrl = "$env:SUPABASE_URL".Trim().TrimEnd('/')
# on extrait la clé de ce qui a été collé (elle peut être entourée d'espaces, de retours à la ligne ou d'un libellé)
$rawKey = "$env:SUPABASE_SERVICE_KEY"; $km = [regex]::Match($rawKey, 'sb_secret_[A-Za-z0-9_\-]+|eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+')
$sbKey = if ($km.Success) { $km.Value } else { $rawKey -replace '\s', '' }
if ($sbKey) { "Clé des concours : " + $(if ($sbKey -like 'sb_secret_*') { 'clé secrète sb_secret' } elseif ($sbKey -like 'eyJ*') { 'ancienne clé service_role' } elseif ($sbKey -like 'sb_publishable_*') { 'ATTENTION : clé publique (publishable), il faut la clé SECRÈTE' } else { "format inconnu ($($sbKey.Length) caractères)" }) }
$metaFile = Join-Path $PSScriptRoot 'assets_meta.json'
function Send-Prices($q) {
  if ($sbUrl -and $sbKey -and (Test-Path $metaFile)) {
    try {
      $meta = [IO.File]::ReadAllText($metaFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
      $fx = @{ EUR = 1.0 }
      foreach ($k in @($q.PSBase.Keys)) { if ($k -match '^eur([a-z]{3})$' -and $q[$k].p) { $fx[$Matches[1].ToUpper()] = [double]$q[$k].p } }
      $coupon = [double]$meta.coupon; $now = [DateTimeOffset]::UtcNow.ToString('o'); $rows = New-Object System.Collections.Generic.List[object]
      foreach ($e in $meta.a.PSObject.Properties) {
        $id = $e.Name; if (-not $q.Contains($id)) { continue }; $r = $q[$id]
        if ($e.Value -is [array]) {     # obligation : prix d'une obligation à coupon 3 %, calculé à partir du taux (comme sur le site)
          $cur = [string]$e.Value[0]; $mat = [int]$e.Value[1]; if ($null -eq $r.y) { continue }
          $y = [double]$r.y / 100; $px = 0.0; for ($t = 1; $t -le $mat; $t++) { $px += $coupon / [math]::Pow(1 + $y, $t) }; $px += 100 / [math]::Pow(1 + $y, $mat)
        } else { $cur = [string]$e.Value; if ($null -eq $r.p) { continue }; $px = [double]$r.p }
        $rate = if ($cur -ne 'pts' -and $fx.ContainsKey($cur)) { $fx[$cur] } else { 1.0 }   # « pts » : pas de conversion, comme sur le site
        $eur = $px / $rate
        if ($eur -gt 0 -and -not [double]::IsInfinity($eur) -and -not [double]::IsNaN($eur)) { $rows.Add([ordered]@{ asset = $id; px_eur = [math]::Round($eur, 6); px = [math]::Round($px, 6); at = $now }) }
      }
      $h = @{ apikey = $sbKey; Prefer = 'resolution=merge-duplicates,return=minimal' }
      if ($sbKey -like 'eyJ*') { $h.Authorization = "Bearer $sbKey" }   # ancienne clé service_role
      $withPx = $true
      for ($i = 0; $i -lt $rows.Count; $i += 500) {
        $chunk = $rows.GetRange($i, [math]::Min(500, $rows.Count - $i)).ToArray()
        if (-not $withPx) { $chunk = @($chunk | ForEach-Object { [ordered]@{ asset = $_.asset; px_eur = $_.px_eur; at = $_.at } }) }
        $body = ConvertTo-Json -InputObject $chunk -Compress -Depth 3
        try { Invoke-RestMethod -Method Post -Uri "$sbUrl/rest/v1/prices" -Headers $h -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30 | Out-Null }
        catch {
          # la colonne px n'existe pas encore (stop-loss-serveur.sql pas encore lancé) : on renvoie sans elle
          if ($withPx -and $_.Exception.Message -match '\(400\)') { $withPx = $false; $i -= 500; continue }
          throw
        }
      }
      "OK : $($rows.Count) cours envoyés au serveur des concours" + $(if (-not $withPx) { " (sans prix en devise : lance stop-loss-serveur.sql dans Supabase)" } else { "" })
      # stop loss et take profit des concours, exécutés au cours officiel
      if ($withPx) {
        try {
          $hr = @{ apikey = $sbKey }; if ($h.Authorization) { $hr.Authorization = $h.Authorization }
          $n = Invoke-RestMethod -Method Post -Uri "$sbUrl/rest/v1/rpc/run_stops" -Headers $hr -ContentType 'application/json' -Body '{}' -TimeoutSec 60
          "OK : stop loss / take profit exécutés dans les concours : $n"
        } catch { "Stop loss des concours non exécutés : $($_.Exception.Message)" }
      }
    } catch { "Cours non envoyés au serveur des concours : $($_.Exception.Message)" }
  } else { "Cours des concours non envoyés (secret SUPABASE_SERVICE_KEY absent)" }
}

# ---------- cours en direct ----------
# Lancé avec -LiveMinutes : relève tous les cours toutes les $LiveEvery secondes (5 minutes par défaut) et les envoie à Supabase
# (table live_quotes, lue chaque minute par le site), puis exécute les stop loss des concours.
if ($LiveMinutes -gt 0) {
  # les cours sont publiés dans live.json sur la branche « live » du dépôt (lue chaque minute par le site) :
  # cela marche sans clé ; si la clé secrète est bonne, ils vont aussi dans Supabase (stop loss côté serveur)
  $pushGit = [bool]$env:GITHUB_ACTIONS -and [bool](Get-Command git -ErrorAction SilentlyContinue)
  if (-not ($sbUrl -and $sbKey)) { "Supabase non utilisé (secret SUPABASE_SERVICE_KEY absent) : cours publiés seulement sur GitHub" }
  if ($pushGit) {
    $env:GIT_AUTHOR_NAME = $env:GIT_COMMITTER_NAME = "github-actions[bot]"
    $env:GIT_AUTHOR_EMAIL = $env:GIT_COMMITTER_EMAIL = "41898283+github-actions[bot]@users.noreply.github.com"
  }
  $liveFile = Join-Path $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }) 'live.json'
  $pairs = New-Object System.Collections.Generic.List[object]
  foreach ($k in $yahoo.Keys) { $pairs.Add(@($k, $yahoo[$k])) }
  $uniFile = Join-Path $PSScriptRoot 'universe_ids.txt'
  if (Test-Path $uniFile) { foreach ($l in Get-Content $uniFile) { if ($l -match ';') { $pp = $l.Split(';'); $pairs.Add(@($pp[0], $pp[1])) } } }
  $byY = @{}; foreach ($pp in $pairs) { $byY[$pp[1]] = $pp[0] }
  $hl = @{ apikey = $sbKey; Prefer = 'resolution=merge-duplicates,return=minimal' }; if ($sbKey -like 'eyJ*') { $hl.Authorization = "Bearer $sbKey" }
  $deadline = (Get-Date).AddMinutes($LiveMinutes); $crumb = $null; $round = 0
  while ((Get-Date) -lt $deadline) {
    $start = Get-Date; $round++
    try {
      if (-not $crumb) {
        $ws = New-Object Microsoft.PowerShell.Commands.WebRequestSession
        try { Invoke-WebRequest -Uri 'https://fc.yahoo.com' -WebSession $ws -UserAgent $ua -UseBasicParsing -TimeoutSec 15 | Out-Null } catch {}
        $crumb = (Invoke-WebRequest -Uri 'https://query1.finance.yahoo.com/v1/test/getcrumb' -WebSession $ws -UserAgent $ua -UseBasicParsing).Content
      }
      $lq = @{}
      for ($i = 0; $i -lt $pairs.Count; $i += 50) {
        $batch = ($pairs.GetRange($i, [math]::Min(50, $pairs.Count - $i)) | ForEach-Object { $_[1] }) -join ','
        try {
          $r = Invoke-RestMethod -Uri ("https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + [uri]::EscapeDataString($batch) + "&crumb=" + [uri]::EscapeDataString($crumb)) -WebSession $ws -UserAgent $ua -TimeoutSec 30
          foreach ($x in $r.quoteResponse.result) {
            $id = $byY[$x.symbol]; if (-not $id -or $null -eq $x.regularMarketPrice) { continue }
            $div = if ($x.currency -in 'GBp','GBX','ZAc','ILA','USX') { 100.0 } else { 1.0 }
            $lq[$id] = [ordered]@{ p = [double]$x.regularMarketPrice / $div; prev = [double]$x.regularMarketPreviousClose / $div; t = [int64]$x.regularMarketTime }
          }
        } catch {}
        Start-Sleep -Milliseconds 200
      }
      if ($lq.Count -lt 30) { $crumb = $null; throw "seulement $($lq.Count) cours" }
      $data = [ordered]@{}; foreach ($k in @($lq.PSBase.Keys)) { $data[$k] = @([math]::Round($lq[$k].p, 6), [math]::Round($lq[$k].prev, 6), $lq[$k].t) }
      $nowIso = [DateTimeOffset]::UtcNow.ToString('o')
      "Direct n°$($round) à $((Get-Date).ToUniversalTime().ToString('HH:mm')) UTC : $($lq.Count) cours"
      # 1) GitHub : live.json sur la branche « live » (un seul commit, remplacé à chaque relevé)
      $json = ConvertTo-Json -InputObject ([ordered]@{ at = $nowIso; data = $data }) -Depth 5 -Compress
      [IO.File]::WriteAllText($liveFile, $json, (New-Object Text.UTF8Encoding $false))
      if ($pushGit) {
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try {
          $blob = git hash-object -w $liveFile
          $env:GIT_INDEX_FILE = Join-Path (Split-Path $liveFile) 'live.index'
          if (Test-Path $env:GIT_INDEX_FILE) { Remove-Item $env:GIT_INDEX_FILE }
          git update-index --add --cacheinfo "100644,$blob,live.json"
          $tree = git write-tree
          Remove-Item Env:GIT_INDEX_FILE
          $commit = git commit-tree $tree -m "Cours en direct"
          git push -f -q origin "$($commit):refs/heads/live"
          if ($LASTEXITCODE -eq 0) { "  publié sur GitHub (branche live)" } else { "  envoi GitHub refusé (code $LASTEXITCODE)" }
        } catch { "  envoi GitHub impossible : $($_.Exception.Message)" } finally { Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue; $ErrorActionPreference = $eap }
      }
      # 2) Supabase (si la clé secrète est bonne)
      if ($sbUrl -and $sbKey) {
        try {
          $body = ConvertTo-Json -InputObject @([ordered]@{ id = 1; data = $data; at = $nowIso }) -Depth 5 -Compress
          Invoke-RestMethod -Method Post -Uri "$sbUrl/rest/v1/live_quotes" -Headers $hl -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30 | Out-Null
          "  envoyé à Supabase"
        } catch { "  Supabase refuse les cours : $($_.Exception.Message) (vérifie la clé secrète SUPABASE_SERVICE_KEY)" }
        Send-Prices $lq
      }
    } catch { "Direct n°$($round) : $($_.Exception.Message)" }
    $wait = $LiveEvery - ((Get-Date) - $start).TotalSeconds
    if ((Get-Date).AddSeconds([math]::Max(0, $wait)) -ge $deadline) { break }
    if ($wait -gt 0) { Start-Sleep -Seconds ([int]$wait) }
  }
  return
}

$q = [ordered]@{}; $errors = @()
foreach ($k in $yahoo.Keys) {
  try {
    $r = Invoke-RestMethod -Uri ("https://query1.finance.yahoo.com/v8/finance/chart/" + [uri]::EscapeDataString($yahoo[$k]) + "?range=1d&interval=5m") -UserAgent $ua -TimeoutSec 20
    $res = $r.chart.result[0]; $m = $res.meta
    $div = if ($m.currency -in 'GBp','GBX','ZAc','ILA','USX') { 100.0 } else { 1.0 }   # cotés en cents ou en pence
    $h = @($res.indicators.quote[0].close | Where-Object { $_ -ne $null } | ForEach-Object { [math]::Round([double]$_ / $div, 6) })
    if ($h.Count -gt 100) { $step = [math]::Ceiling($h.Count / 100); $h = @(for ($i = 0; $i -lt $h.Count; $i += $step) { $h[$i] }) }
    $p = [double]$m.regularMarketPrice / $div; $h += $p
    $q[$k] = [ordered]@{ p = $p; prev = [double]$m.chartPreviousClose / $div; t = [int64]$m.regularMarketTime; h = $h }
  } catch { $errors += "$k : $($_.Exception.Message)" }
}
foreach ($k in $bonds.Keys) {
  try {
    $r = Invoke-RestMethod -Uri ("https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=" + $bonds[$k] + "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1") -UserAgent $ua -TimeoutSec 20
    $x = $r.FormattedQuoteResult.FormattedQuote[0]
    $y = [double]::Parse(($x.last -replace '%',''), [Globalization.CultureInfo]::InvariantCulture)
    $pv = [double]::Parse(($x.previous_day_closing -replace '%',''), [Globalization.CultureInfo]::InvariantCulture)
    $t = [DateTimeOffset]::Parse($x.last_time).ToUnixTimeSeconds()
    $q[$k] = [ordered]@{ y = $y; prev = $pv; t = [int64]$t }
  } catch { $errors += "$k : $($_.Exception.Message)" }
}
# toutes les actions des grands indices : cours par lots de 50 (liste dans universe_ids.txt : id;symbole Yahoo)
$uniFile = Join-Path $PSScriptRoot 'universe_ids.txt'
if (Test-Path $uniFile) {
  try {
    $ws = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    try { Invoke-WebRequest -Uri 'https://fc.yahoo.com' -WebSession $ws -UserAgent $ua -UseBasicParsing -TimeoutSec 15 | Out-Null } catch {}
    $crumb = (Invoke-WebRequest -Uri 'https://query1.finance.yahoo.com/v1/test/getcrumb' -WebSession $ws -UserAgent $ua -UseBasicParsing).Content
    $pairs = @(Get-Content $uniFile | Where-Object { $_ -match ';' } | ForEach-Object { $p = $_.Split(';'); ,@($p[0], $p[1]) })
    $byY = @{}; foreach ($p in $pairs) { $byY[$p[1]] = $p[0] }
    for ($i = 0; $i -lt $pairs.Count; $i += 50) {
      $batch = ($pairs[$i..([math]::Min($i + 49, $pairs.Count - 1))] | ForEach-Object { $_[1] }) -join ','
      $r = Invoke-RestMethod -Uri ("https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + [uri]::EscapeDataString($batch) + "&crumb=" + [uri]::EscapeDataString($crumb)) -WebSession $ws -UserAgent $ua -TimeoutSec 30
      foreach ($x in $r.quoteResponse.result) {
        $id = $byY[$x.symbol]
        $div = if ($x.currency -in 'GBp','GBX','ZAc','ILA') { 100 } else { 1 }   # Londres, Johannesburg, Tel-Aviv cotent en centimes
        if ($id -and -not $q.Contains($id) -and $null -ne $x.regularMarketPrice) { $q[$id] = [ordered]@{ p = [double]$x.regularMarketPrice/$div; prev = [double]$x.regularMarketPreviousClose/$div; t = [int64]$x.regularMarketTime } }
      }
      Start-Sleep -Milliseconds 300
    }
  } catch { $errors += "univers : $($_.Exception.Message)" }
}
foreach ($k in $ipoSym.Keys) { if ($q.Contains($k)) { $q[$k].s = $ipoSym[$k] } }   # symbole de la nouvelle action, lu par le site
if ($q.Count -lt 30) { throw "Trop peu de cours récupérés ($($q.Count)). Erreurs : $($errors -join ' | ')" }
$asOf = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
[IO.File]::WriteAllText((Join-Path $OutDir 'quotes.json'), ([ordered]@{ asOf = $asOf; q = $q } | ConvertTo-Json -Depth 6 -Compress), $utf8)
"OK : $($q.Count) cours" + $(if ($errors) { " (manquants : $($errors.Count))" } else { "" })

# ---------- historique quotidien des 3 derniers mois (graphiques 1 mois / 1 an du site) ----------
# refait au plus toutes les 6 heures : cours de clôture de chaque titre, 20 titres par requête
$histFile = Join-Path $OutDir 'history.json'; $needHist = $true
if (Test-Path $histFile) {
  $head = [IO.File]::ReadAllText($histFile).Substring(0, 60)
  if ($head -match '"asOf":(\d+)' -and ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$Matches[1]) -lt 6 * 3600) { $needHist = $false }
}
if ($needHist) {
  try {
    $hp = New-Object System.Collections.Generic.List[object]
    foreach ($k in $yahoo.Keys) { $hp.Add(@($k, $yahoo[$k])) }
    if (Test-Path $uniFile) { foreach ($l in Get-Content $uniFile) { if ($l -match ';') { $pp = $l.Split(';'); $hp.Add(@($pp[0], $pp[1])) } } }
    $hy = @{}; foreach ($pp in $hp) { $hy[$pp[1]] = $pp[0] }
    $hd = [ordered]@{}
    for ($i = 0; $i -lt $hp.Count; $i += 20) {
      $batch = ($hp.GetRange($i, [math]::Min(20, $hp.Count - $i)) | ForEach-Object { $_[1] }) -join ','
      try {
        $r = Invoke-RestMethod -Uri ("https://query1.finance.yahoo.com/v8/finance/spark?symbols=" + [uri]::EscapeDataString($batch) + "&range=3mo&interval=1d") -UserAgent $ua -TimeoutSec 30
        foreach ($n in $r.PSObject.Properties.Name) {
          $id = $hy[$n]; $x = $r.$n; if (-not $id -or -not $x.timestamp) { continue }
          $ts = @($x.timestamp); $cl = @($x.close); if ($ts.Count -lt 2) { continue }
          $lastc = ($cl | Where-Object { $_ -ne $null } | Select-Object -Last 1)
          $div = if ($q.Contains($id) -and $q[$id].p -gt 0 -and $lastc / $q[$id].p -gt 50) { 100.0 } else { 1.0 }   # cotés en pence ou en cents
          $arr = New-Object System.Collections.Generic.List[object]
          for ($j = 0; $j -lt $ts.Count; $j++) { if ($null -ne $cl[$j]) { $arr.Add([int64]([int64]$ts[$j] / 60)); $arr.Add([math]::Round([double]$cl[$j] / $div, 6)) } }
          if ($arr.Count -ge 4) { $hd[$id] = $arr.ToArray() }
        }
      } catch {}
      Start-Sleep -Milliseconds 250
    }
    if ($hd.Count -gt 100) {
      [IO.File]::WriteAllText($histFile, ([ordered]@{ asOf = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); d = $hd } | ConvertTo-Json -Depth 4 -Compress), $utf8)
      "OK : historique de $($hd.Count) titres"
    } else { "Historique non mis à jour (seulement $($hd.Count) titres)" }
  } catch { "Historique non mis à jour : $($_.Exception.Message)" }
}

# ---------- cours de référence des concours (Supabase) ----------
Send-Prices $q

# ---------- titres de presse ----------
$feeds = @(
  @('Le Monde', 'fr', 'https://www.lemonde.fr/economie/rss_full.xml'),
  @('Financial Times', 'en', 'https://www.ft.com/markets?format=rss'),
  @('Financial Times', 'en', 'https://www.ft.com/companies?format=rss'),
  @('Wall Street Journal', 'en', 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain'),
  @('Wall Street Journal', 'en', 'https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness'),
  @('Bloomberg', 'en', 'https://feeds.bloomberg.com/markets/news.rss'),
  @('CNBC', 'en', 'https://www.cnbc.com/id/10000664/device/rss/rss.html')
)
$topics = [ordered]@{
  ipo    = '\bIPOs?\b|introduction en Bourse|entr(é|e)e en Bourse|go(es|ing)? public|listing|cotation'
  deal   = '\bOPA\b|\bOPE\b|rachat|rach(è|e)te|fusion|acquisi|acqui[eè]r|cession|\bmerger|\bdeal|takeover|\bbid\b|to buy|buys\b|\bsells?\b.*\b(unit|stake|business)|stake'
  result = 'r(é|e)sultats|chiffre d.affaires|b(é|e)n(é|e)fice|earnings|quarterly|profit|revenue|guidance'
  taux   = '\bBCE\b|\bFed\b|\bECB\b|banque centrale|taux|rates?\b|inflation|bond|obligat|yield|Treasur'
}
function Clean($s){ if(-not $s){ return '' }; if($s -is [Xml.XmlNode]){ $s = $s.InnerText }; $t =[Net.WebUtility]::HtmlDecode(([string]$s -replace '<[^>]+>',' ')); ($t -replace '\s+',' ').Trim() }
$items = New-Object System.Collections.Generic.List[object]; $nerr = @()
foreach ($f in $feeds) {
  try {
    $raw = (Invoke-WebRequest -Uri $f[2] -UserAgent $ua -UseBasicParsing -TimeoutSec 20).Content
    if ($raw -is [byte[]]) { $raw = [Text.Encoding]::UTF8.GetString($raw) }
    [xml]$x = $raw
    foreach ($it in @($x.rss.channel.item) | Select-Object -First 25) {
      $title = Clean $it.title; if (-not $title) { continue }
      $link = [string]$it.link; if ($it.link -is [Xml.XmlElement]) { $link = $it.link.InnerText }
      $d = $null; try { $d = [DateTimeOffset]::Parse((Clean $it.pubDate)).ToUnixTimeSeconds() } catch { $d = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
      $sum = Clean $it.description; if ($sum.Length -gt 240) { $sum = $sum.Substring(0, 237).TrimEnd() + '…' }
      $tags = @(); foreach ($k in $topics.Keys) { if (($title + ' ' + $sum) -match $topics[$k]) { $tags += $k } }
      $items.Add([ordered]@{ src = $f[0]; lang = $f[1]; t = $d; title = $title; link = $link.Trim(); sum = $sum; tags = $tags })
    }
  } catch { $nerr += "$($f[0]) : $($_.Exception.Message)" }
}
$seen = @{}; $list = @($items | Sort-Object { -$_.t } | Where-Object { $k = $_.title.ToLower(); if ($seen[$k]) { $false } else { $seen[$k] = 1; $true } } | Select-Object -First 120)
if ($list.Count -ge 10) {
  [IO.File]::WriteAllText((Join-Path $OutDir 'news.json'), ([ordered]@{ asOf = $asOf; items = $list } | ConvertTo-Json -Depth 5 -Compress), $utf8)
  "OK : $($list.Count) titres"
} else { "Titres non mis à jour ($($list.Count)) : $($nerr -join ' | ')" }
