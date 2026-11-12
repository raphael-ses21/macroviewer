# MacroViewer : relève les derniers cours réels (Yahoo Finance, CNBC) et les titres de presse (flux RSS)
# puis écrit quotes.json et news.json à la racine du site. Lancé par GitHub Actions (.github/workflows/update.yml).
param([string]$OutDir = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
$utf8 = New-Object Text.UTF8Encoding($false)

# ---------- cours ----------
$yahoo = [ordered]@{ spx='^GSPC'; ndx='^NDX'; dji='^DJI'; cac='^FCHI'; dax='^GDAXI'; sx5e='^STOXX50E'; n225='^N225'; aapl='AAPL'; msft='MSFT'; nvda='NVDA'; amzn='AMZN'; googl='GOOGL'; tsla='TSLA'; meta='META'; mc='MC.PA'; tte='TTE.PA'; air='AIR.PA'; or='OR.PA'; bnp='BNP.PA'; san='SAN.PA'; rms='RMS.PA'; asml='ASML.AS'; cw8='CW8.PA'; cspx='CSPX.L'; cndx='CNDX.L'; c40='C40.PA'; vwce='VWCE.DE'; aeem='AEEM.PA'; ieag='IEGA.AS' }
foreach($kv in @(@('ftse','^FTSE'),@('smi','^SSMI'),@('ibex','^IBEX'),@('mib','FTSEMIB.MI'),@('aex','^AEX'),@('hsi','^HSI'),@('sse','000001.SS'),@('kospi','^KS11'),@('sensex','^BSESN'),@('bvsp','^BVSP'),@('tsx','^GSPTSE'),@('asx','^AXJO'),@('rut','^RUT'),@('vix','^VIX'),@('bel20','^BFX'),@('sbf120','^SBF120'),@('spy','SPY'),@('qqq','QQQ'),@('voo','VOO'),@('vti','VTI'),@('gld','GLD'),@('iwda','IWDA.AS'),@('eimi','EIMI.L'),@('meud','MEUD.PA'),@('icln','ICLN'),@('ieac','IEAC.AS'),@('ese','ESE.PA'),@('panx','PANX.PA'))){ $yahoo[$kv[0]]=$kv[1] }
# devises du G20 face à l'euro
foreach($x in 'usd','jpy','gbp','chf','cad','aud','cny','inr','brl','hkd','krw','idr','mxn','rub','sar','zar','try','ars'){ $yahoo["eur$x"] = "EUR$($x.ToUpper())=X" }
$bonds = [ordered]@{ oat10='FR10Y'; bund10='DE10Y'; btp10='IT10Y'; ust10='US10Y'; gilt10='GB10Y'; jgb10='JP10Y'
  es10='ES10Y'; pt10='PT10Y'; be10='BE10Y'; nl10='NL10Y'; gr10='GR10Y'; at10='AT10Y'; ch10='CH10Y'; ca10='CA10Y'; au10='AU10Y'; cn10='CN10Y'; in10='IN10Y'; br10='BR10Y'
  fr2='FR2Y'; fr30='FR30Y'; de2='DE2Y'; de30='DE30Y'; us2='US2Y'; us30='US30Y'; it2='IT2Y'; jp2='JP2Y' }
# courbes des taux de 3 mois à 30 ans (clés r_pays_durée)
foreach($c in 'us','fr','de','it','gb','jp'){ foreach($t in '3m','6m','1y','2y','5y','10y','30y'){ $bonds["r_${c}_$t"] = ($c.ToUpper() + $t.ToUpper()) } }

$q = [ordered]@{}; $errors = @()
foreach ($k in $yahoo.Keys) {
  try {
    $r = Invoke-RestMethod -Uri ("https://query1.finance.yahoo.com/v8/finance/chart/" + [uri]::EscapeDataString($yahoo[$k]) + "?range=1d&interval=5m") -UserAgent $ua -TimeoutSec 20
    $res = $r.chart.result[0]; $m = $res.meta
    $h = @($res.indicators.quote[0].close | Where-Object { $_ -ne $null } | ForEach-Object { [math]::Round([double]$_, 6) })
    if ($h.Count -gt 100) { $step = [math]::Ceiling($h.Count / 100); $h = @(for ($i = 0; $i -lt $h.Count; $i += $step) { $h[$i] }) }
    $p = [double]$m.regularMarketPrice; $h += $p
    $q[$k] = [ordered]@{ p = $p; prev = [double]$m.chartPreviousClose; t = [int64]$m.regularMarketTime; h = $h }
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
        $div = if ($x.currency -eq 'GBp') { 100 } else { 1 }   # Londres cote en pence
        if ($id -and -not $q.Contains($id) -and $null -ne $x.regularMarketPrice) { $q[$id] = [ordered]@{ p = [double]$x.regularMarketPrice/$div; prev = [double]$x.regularMarketPreviousClose/$div; t = [int64]$x.regularMarketTime } }
      }
      Start-Sleep -Milliseconds 300
    }
  } catch { $errors += "univers : $($_.Exception.Message)" }
}
if ($q.Count -lt 30) { throw "Trop peu de cours récupérés ($($q.Count)). Erreurs : $($errors -join ' | ')" }
$asOf = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
[IO.File]::WriteAllText((Join-Path $OutDir 'quotes.json'), ([ordered]@{ asOf = $asOf; q = $q } | ConvertTo-Json -Depth 6 -Compress), $utf8)
"OK : $($q.Count) cours" + $(if ($errors) { " (manquants : $($errors.Count))" } else { "" })

# ---------- cours de référence des concours (Supabase) ----------
# Le serveur des concours recalcule chaque ordre avec ces prix : un joueur ne peut pas annoncer un faux cours.
# Il faut le secret SUPABASE_SERVICE_KEY dans GitHub (Settings → Secrets and variables → Actions).
$sbUrl = "$env:SUPABASE_URL".Trim().TrimEnd('/')
# on extrait la clé de ce qui a été collé (elle peut être entourée d'espaces, de retours à la ligne ou d'un libellé)
$rawKey = "$env:SUPABASE_SERVICE_KEY"; $km = [regex]::Match($rawKey, 'sb_secret_[A-Za-z0-9_\-]+|eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+')
$sbKey = if ($km.Success) { $km.Value } else { $rawKey -replace '\s', '' }
if ($sbKey) { "Clé des concours : " + $(if ($sbKey -like 'sb_secret_*') { 'clé secrète sb_secret' } elseif ($sbKey -like 'eyJ*') { 'ancienne clé service_role' } elseif ($sbKey -like 'sb_publishable_*') { 'ATTENTION : clé publique (publishable), il faut la clé SECRÈTE' } else { "format inconnu ($($sbKey.Length) caractères)" }) }
$metaFile = Join-Path $PSScriptRoot 'assets_meta.json'
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
      if ($eur -gt 0 -and -not [double]::IsInfinity($eur) -and -not [double]::IsNaN($eur)) { $rows.Add([ordered]@{ asset = $id; px_eur = [math]::Round($eur, 6); at = $now }) }
    }
    $h = @{ apikey = $sbKey; Prefer = 'resolution=merge-duplicates,return=minimal' }
    if ($sbKey -like 'eyJ*') { $h.Authorization = "Bearer $sbKey" }   # ancienne clé service_role
    for ($i = 0; $i -lt $rows.Count; $i += 500) {
      $chunk = $rows.GetRange($i, [math]::Min(500, $rows.Count - $i)).ToArray()
      $body = ConvertTo-Json -InputObject $chunk -Compress -Depth 3
      Invoke-RestMethod -Method Post -Uri "$sbUrl/rest/v1/prices" -Headers $h -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30 | Out-Null
    }
    "OK : $($rows.Count) cours envoyés au serveur des concours"
  } catch { "Cours non envoyés au serveur des concours : $($_.Exception.Message)" }
} else { "Cours des concours non envoyés (secret SUPABASE_SERVICE_KEY absent)" }

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
