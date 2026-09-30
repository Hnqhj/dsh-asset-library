# Smoke test for the asset-library plugin HTTP surface against a running instance.
#
# Uses curl.exe for every request on purpose:
#   * Windows PowerShell 5.1 refuses to set restricted headers (Range) through
#     Invoke-WebRequest -Headers, and the failed call leaves the WebSession in a
#     state where every later request throws the same ArgumentException;
#   * a string body through Invoke-WebRequest is not encoded as UTF-8, which
#     mangles non-ASCII paths before they reach the server.
#
# ASCII ONLY: non-ASCII test data (tags, notes, folder names, project path) is
# passed in as parameters from the caller.
param(
    [string]$Base = 'http://127.0.0.1:3082',
    [Parameter(Mandatory = $true)][string]$Token,
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$TagZh = 'cover',
    [string]$NoteZh = 'portrait cover',
    [string]$NonAsciiFolder = 'covers'
)

$ErrorActionPreference = 'Continue'
$script:pass = 0
$script:fail = 0
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$jar = Join-Path $env:TEMP 'asset-lib-cookies.txt'
Remove-Item -LiteralPath $jar -Force -ErrorAction SilentlyContinue

function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { $script:pass++; Write-Output ("  PASS  " + $Name + $(if ($Detail) { "  ($Detail)" } else { '' })) }
    else { $script:fail++; Write-Output ("  FAIL  " + $Name + $(if ($Detail) { "  ($Detail)" } else { '' })) }
}

# Establish the browser session: the token is accepted once, then the cookie carries it.
& curl.exe -s -c $jar -o NUL "$Base/?token=$Token" | Out-Null

function Api {
    param(
        [string]$Path,
        [string]$Method = 'GET',
        [string]$JsonBody = $null,
        [string[]]$Header = @()
    )
    $id = [guid]::NewGuid().ToString('N')
    $bodyFile = Join-Path $env:TEMP "al-body-$id.txt"
    $headFile = Join-Path $env:TEMP "al-head-$id.txt"
    $jsonFile = Join-Path $env:TEMP "al-json-$id.txt"
    $curlArgs = @('-s', '-X', $Method, '-b', $jar, '-c', $jar, '-D', $headFile, '-o', $bodyFile, '-w', '%{http_code}')
    foreach ($h in $Header) { $curlArgs += @('-H', $h) }
    if ($null -ne $JsonBody) {
        [System.IO.File]::WriteAllText($jsonFile, $JsonBody, $utf8NoBom)
        $curlArgs += @('-H', 'content-type: application/json; charset=utf-8', '--data-binary', "@$jsonFile")
    }
    $curlArgs += "$Base/api/asset-library$Path"
    $statusText = ((& curl.exe @curlArgs) -join '').Trim()
    # A status that is not three digits means the transport broke (curl printed the body
    # or an error to stdout, or the connection was reset). This used to be a bare [int]
    # cast: the exception got swallowed by ErrorActionPreference=Continue, the function
    # returned $null, and callers saw a mystery failure. Surface it instead.
    $status = 0
    if ($statusText -match '^\d{3}$') { $status = [int]$statusText }
    else { $script:transportAnomalies++; Write-Output ("  ! transport anomaly on " + $Path + ": statusText=[" + $statusText + "]") }
    $headers = @{}
    if (Test-Path -LiteralPath $headFile) {
        foreach ($line in (Get-Content -LiteralPath $headFile)) {
            if ($line -match '^([^:]+):\s*(.*)$') { $headers[$matches[1].Trim().ToLowerInvariant()] = $matches[2].Trim() }
        }
    }
    $body = if (Test-Path -LiteralPath $bodyFile) { [System.IO.File]::ReadAllText($bodyFile, [System.Text.Encoding]::UTF8) } else { '' }
    foreach ($f in @($bodyFile, $headFile, $jsonFile)) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
    return @{ status = $status; body = $body; headers = $headers }
}

Write-Output "== switch to the fixture project =="
$rootResponse = Api -Path '/root' -Method 'POST' -JsonBody (@{ root = $Root } | ConvertTo-Json -Depth 6)
Check 'POST /root -> 200' ($rootResponse.status -eq 200) ("status=" + $rootResponse.status + " " + $rootResponse.body.Substring(0, [Math]::Min(120, $rootResponse.body.Length)))
$status = $rootResponse.body | ConvertFrom-Json
Check 'assets subfolder detected' ($status.conventional -eq $true) ("assetsRoot=" + $status.assetsRoot)
Check 'image count = 5' ($status.counts.image -eq 5) ("got " + $status.counts.image)
Check 'video count = 2' ($status.counts.video -eq 2) ("got " + $status.counts.video)
Check 'audio count = 2' ($status.counts.audio -eq 2) ("got " + $status.counts.audio)
Check 'total = 9' ($status.counts.total -eq 9) ("got " + $status.counts.total)

Write-Output "== listing and filtering =="
$images = (Api -Path '/assets?kind=image').body | ConvertFrom-Json
Check 'kind=image returns 5' ($images.total -eq 5) ("got " + $images.total)
$dirImages = (Api -Path '/assets?dir=images').body | ConvertFrom-Json
Check 'dir=images prefix-matches 4' ($dirImages.total -eq 4) ("got " + $dirImages.total)
$deep = (Api -Path '/assets?dir=deep/nested').body | ConvertFrom-Json
Check 'dir=deep/nested returns 1' ($deep.total -eq 1) ("got " + $deep.total)
$search = (Api -Path '/assets?q=nested').body | ConvertFrom-Json
Check 'q=nested returns 1' ($search.total -eq 1) ("got " + $search.total)
$sorted = (Api -Path '/assets?sort=size&limit=1').body | ConvertFrom-Json
Check 'sort=size puts the largest first' ($sorted.items[0].kind -eq 'video') ("largest kind=" + $sorted.items[0].kind)
Check 'pagination reports hasMore' ($sorted.hasMore -eq $true)

Write-Output "== hidden and non-asset files stay out =="
$all = (Api -Path '/assets?limit=200').body | ConvertFrom-Json
$paths = ($all.items | ForEach-Object { $_.relPath }) -join ','
Check 'notes.txt excluded' (-not ($paths -like '*notes.txt*'))
Check 'readme.md excluded' (-not ($paths -like '*readme.md*'))
Check '.git contents excluded' (-not ($paths -like '*.git*'))
Check 'hidden dir excluded' (-not ($paths -like '*secret*'))
Check 'svg counted as an image' ($paths -like '*logo.svg*')
$encodedFolder = [uri]::EscapeDataString($NonAsciiFolder)
$nonAscii = (Api -Path ("/assets?dir=images/" + $encodedFolder)).body | ConvertFrom-Json
Check 'non-ASCII folder listed' ($nonAscii.total -eq 1) ("got " + $nonAscii.total + " folder=" + $NonAsciiFolder)
Check 'non-ASCII relPath round-trips' ($nonAscii.items[0].relPath -like ("*" + $NonAsciiFolder + "*")) ($nonAscii.items[0].relPath)

Write-Output "== annotation round trip (non-ASCII values) =="
$annotated = Api -Path '/annotate' -Method 'POST' -JsonBody (@{ relPath = 'images/cover.png'; tags = @($TagZh, 'ep1'); note = $NoteZh } | ConvertTo-Json -Depth 6)
Check 'POST /annotate -> 200' ($annotated.status -eq 200) ("status=" + $annotated.status + " " + $annotated.body.Substring(0, [Math]::Min(120, $annotated.body.Length)))
$tagged = (Api -Path ('/assets?tag=' + [uri]::EscapeDataString($TagZh))).body | ConvertFrom-Json
Check 'tag filter finds the annotated asset' ($tagged.total -eq 1) ("got " + $tagged.total)
$detail = (Api -Path '/asset?relPath=images%2Fcover.png').body | ConvertFrom-Json
Check 'annotation persisted (2 tags)' ($detail.item.tags.Count -eq 2) ("tags=" + ($detail.item.tags -join '|'))
Check 'note persisted' ($detail.item.note -eq $NoteZh) ("note=" + $detail.item.note)
Check 'index.json written' (Test-Path -LiteralPath (Join-Path $Root '.dsh-assets\index.json'))
Check 'absolutePath reported' ($detail.item.absolutePath -like ("*" + 'cover.png'))

Write-Output "== tag facets (drives the panel's tag filter row) =="
$facetStatus = (Api -Path '/status').body | ConvertFrom-Json
$facet = $facetStatus.tagFacets | Where-Object { $_.tag -eq $TagZh }
Check 'status aggregates tag facets' ($null -ne $facet -and $facet.count -eq 1) ("count=" + $(if ($null -ne $facet) { $facet.count } else { 'n/a' }))
$epFacet = $facetStatus.tagFacets | Where-Object { $_.tag -eq 'ep1' }
Check 'facets include ascii tags too' ($null -ne $epFacet -and $epFacet.count -eq 1) ("count=" + $(if ($null -ne $epFacet) { $epFacet.count } else { 'n/a' }))

Write-Output "== search covers tags and notes; order parameter =="
$qTag = (Api -Path ("/assets?q=" + [uri]::EscapeDataString($TagZh))).body | ConvertFrom-Json
Check 'q matches tags' ($qTag.total -eq 1) ("got " + $qTag.total)
$qNote = (Api -Path ("/assets?q=" + [uri]::EscapeDataString($NoteZh))).body | ConvertFrom-Json
Check 'q matches notes' ($qNote.total -eq 1) ("got " + $qNote.total)
$asc = (Api -Path '/assets?sort=size&order=asc&limit=1').body | ConvertFrom-Json
Check 'order=asc puts the smallest first' ($asc.items[0].relPath -eq 'images/logo.svg') ($asc.items[0].relPath)
$descName = (Api -Path '/assets?sort=name&order=desc&limit=1').body | ConvertFrom-Json
Check 'order=desc reverses names' ($descName.items[0].relPath -eq 'video/scene-02.mov') ($descName.items[0].relPath)
$badOrder = Api -Path '/assets?order=sideways'
Check 'unknown order -> 400' ($badOrder.status -eq 400) ("status=" + $badOrder.status)

Write-Output "== header-probed dimensions =="
$dims = (Api -Path '/asset?relPath=images%2Fcover.png').body | ConvertFrom-Json
Check 'png dimensions probed' ($dims.item.width -eq 640 -and $dims.item.height -eq 360) ("got " + $dims.item.width + "x" + $dims.item.height)
$svgItem = (Api -Path '/asset?relPath=images%2Flogo.svg').body | ConvertFrom-Json
Check 'unprobed format has no dimensions' ($null -eq $svgItem.item.width)

Write-Output "== batch annotation (relPaths + tagsAdd/tagsRemove) =="
$batch = Api -Path '/annotate' -Method 'POST' -JsonBody (@{ relPaths = @('images/cover.png', 'images/portrait.png'); tagsAdd = @('batch-add') } | ConvertTo-Json -Depth 6)
Check 'batch annotate -> 200' ($batch.status -eq 200) ("status=" + $batch.status + " " + $batch.body.Substring(0, [Math]::Min(120, $batch.body.Length)))
$batchBody = $batch.body | ConvertFrom-Json
Check 'batch updated 2' ($batchBody.updated -eq 2) ("updated=" + $batchBody.updated + " skipped=" + $batchBody.skipped)
$batched = (Api -Path ('/assets?tag=' + [uri]::EscapeDataString('batch-add'))).body | ConvertFrom-Json
Check 'batch tag filters to 2' ($batched.total -eq 2) ("got " + $batched.total)
$batchRemove = Api -Path '/annotate' -Method 'POST' -JsonBody (@{ relPaths = @('images/portrait.png'); tagsRemove = @('batch-add') } | ConvertTo-Json -Depth 6)
$batchRemoveBody = $batchRemove.body | ConvertFrom-Json
Check 'tagsRemove narrows to 1' ($batchRemove.status -eq 200 -and $batchRemoveBody.updated -eq 1 -and (((Api -Path ('/assets?tag=' + [uri]::EscapeDataString('batch-add'))).body | ConvertFrom-Json).total -eq 1)) ("updated=" + $batchRemoveBody.updated)
$batchGhosts = Api -Path '/annotate' -Method 'POST' -JsonBody (@{ relPaths = @('images/nope.png', 'images/cover.png'); tagsAdd = @('ghost-tag') } | ConvertTo-Json -Depth 6)
$batchGhostsBody = $batchGhosts.body | ConvertFrom-Json
Check 'missing paths are skipped, not fatal' ($batchGhosts.status -eq 200 -and $batchGhostsBody.updated -eq 1 -and $batchGhostsBody.skipped -eq 1) ("updated=" + $batchGhostsBody.updated + " skipped=" + $batchGhostsBody.skipped)

Write-Output "== media streaming (Range via curl) =="
$full = Api -Path '/file?relPath=images%2Fcover.png'
Check 'full file -> 200' ($full.status -eq 200) ("status=" + $full.status + " type=" + $full.headers['content-type'])
Check 'media is never cached (no-store)' ($full.headers['cache-control'] -eq 'no-store') ("cache-control=" + $full.headers['cache-control'])
$range = Api -Path '/file?relPath=images%2Fcover.png' -Header @('Range: bytes=0-99')
Check 'range request -> 206' ($range.status -eq 206) ("status=" + $range.status)
Check 'content-range present' ($range.headers['content-range'] -eq 'bytes 0-99/41190') ($range.headers['content-range'])
Check 'content-length is the slice' ($range.headers['content-length'] -eq '100') ($range.headers['content-length'])
Check 'accept-ranges bytes' ($range.headers['accept-ranges'] -eq 'bytes')
$suffix = Api -Path '/file?relPath=audio%2Ftheme.wav' -Header @('Range: bytes=-500')
Check 'suffix range -> 206' ($suffix.status -eq 206) ("status=" + $suffix.status + " range=" + $suffix.headers['content-range'])
$openEnded = Api -Path '/file?relPath=video%2Fscene-01.mp4' -Header @('Range: bytes=1000-')
Check 'open-ended range -> 206' ($openEnded.status -eq 206) ("range=" + $openEnded.headers['content-range'])
Check 'open-ended length matches' ($openEnded.headers['content-length'] -eq '199000') ($openEnded.headers['content-length'])
$bad = Api -Path '/file?relPath=images%2Fcover.png' -Header @('Range: bytes=999999999-')
Check 'out-of-range -> 416' ($bad.status -eq 416) ("status=" + $bad.status)
$head = Api -Path '/file?relPath=images%2Fcover.png' -Method 'HEAD'
Check 'HEAD -> 200 without a body' ($head.status -eq 200 -and $head.body -eq '') ("status=" + $head.status)
$svg = Api -Path '/file?relPath=images%2Flogo.svg'
Check 'svg carries the CSP guard' (([string]$svg.headers['content-security-policy']) -like '*sandbox*')
Check 'nosniff present' ($svg.headers['x-content-type-options'] -eq 'nosniff')
$nonAsciiFile = Api -Path ("/file?relPath=" + [uri]::EscapeDataString("images/$NonAsciiFolder/banana.png"))
Check 'non-ASCII file streams' ($nonAsciiFile.status -eq 200) ("status=" + $nonAsciiFile.status)

Write-Output "== containment and error envelope =="
$escape = Api -Path '/file?relPath=..%2F..%2Fpackage.json'
Check 'path traversal rejected' ($escape.status -eq 400) ("status=" + $escape.status + " " + $escape.body)
$missing = Api -Path '/asset?relPath=images%2Fnope.png'
Check 'unknown asset -> 404 envelope' ($missing.status -eq 404 -and $missing.body -like '*NOT_FOUND*') ("status=" + $missing.status)
$badKind = Api -Path '/assets?kind=pdf'
Check 'unknown kind -> 400' ($badKind.status -eq 400) ("status=" + $badKind.status)
$badSort = Api -Path '/assets?sort=colour'
Check 'unknown sort -> 400' ($badSort.status -eq 400) ("status=" + $badSort.status)
$badMethod = Api -Path '/assets' -Method 'POST' -JsonBody '{}'
Check 'wrong method -> 405' ($badMethod.status -eq 405) ("status=" + $badMethod.status)
$unknown = Api -Path '/nope'
Check 'unknown route -> 404' ($unknown.status -eq 404) ("status=" + $unknown.status)

Write-Output "== reveal endpoint (validation only; the success path opens a real window) =="
$revealEscape = Api -Path '/reveal' -Method 'POST' -JsonBody '{"relPath":"../package.json"}'
Check 'reveal rejects traversal' ($revealEscape.status -eq 400) ("status=" + $revealEscape.status)
$revealMissing = Api -Path '/reveal' -Method 'POST' -JsonBody '{"relPath":"images/nope.png"}'
Check 'reveal rejects a missing asset' ($revealMissing.status -eq 404) ("status=" + $revealMissing.status)
$revealNonAsset = Api -Path '/reveal' -Method 'POST' -JsonBody '{"relPath":"notes.txt"}'
Check 'reveal refuses non-asset files' ($revealNonAsset.status -eq 404) ("status=" + $revealNonAsset.status)
$revealMethod = Api -Path '/reveal' -Method 'GET'
Check 'reveal requires POST' ($revealMethod.status -eq 405) ("status=" + $revealMethod.status)

Write-Output "== freshness: the disk is the only source of truth =="
# Scan caching is off by default, so an added/removed file must show up WITHOUT a rescan.
$firstCall = Api -Path '/assets?limit=200'
if ($env:DEBUG_SMOKE -eq '1') {
    Write-Output ("  DEBUG status=" + $firstCall.status + " bodyLen=" + $firstCall.body.Length + " ctype=" + $firstCall.headers['content-type'] + " len-hdr=" + $firstCall.headers['content-length'])
}
$before = ($firstCall.body | ConvertFrom-Json).total
$probe = Join-Path $Root 'assets\images\fresh-probe.png'
[System.IO.File]::WriteAllBytes($probe, [byte[]](1..64))
$after = ((Api -Path '/assets?limit=200').body | ConvertFrom-Json).total
Check 'new file appears without POST /rescan' ($after -eq $before + 1) ("before=$before after=$after")
Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
$final = ((Api -Path '/assets?limit=200').body | ConvertFrom-Json).total
Check 'deleted file disappears without POST /rescan' ($final -eq $before) ("now=$final expected=$before")

Write-Output "== tree, rescan, and clearing the override =="
$tree = (Api -Path '/tree').body | ConvertFrom-Json
$imagesFolder = $tree.folders | Where-Object { $_.dir -eq 'images' }
Check 'tree lists the images folder with a count' ($null -ne $imagesFolder -and $imagesFolder.count -eq 4) ("count=" + $(if ($null -ne $imagesFolder) { $imagesFolder.count } else { 'n/a' }))
$rootFolder = $tree.folders | Where-Object { $_.dir -eq '' }
Check 'tree includes the root folder entry' ($null -ne $rootFolder -and $rootFolder.count -eq 9) ("count=" + $(if ($null -ne $rootFolder) { $rootFolder.count } else { 'n/a' }))
$nonAsset = Api -Path '/file?relPath=notes.txt'
Check 'non-asset file refused by the media route' ($nonAsset.status -eq 404) ("status=" + $nonAsset.status)
$rescan = Api -Path '/rescan' -Method 'POST' -JsonBody '{}'
Check 'POST /rescan -> 200' ($rescan.status -eq 200) ("status=" + $rescan.status)
$cleared = Api -Path '/root' -Method 'POST' -JsonBody '{"root":""}'
Check 'POST /root empty clears the override' ($cleared.status -eq 200 -and (($cleared.body | ConvertFrom-Json).explicit -eq $false))
$badRoot = Api -Path '/root' -Method 'POST' -JsonBody (@{ root = 'G:\definitely-not-here-12345' } | ConvertTo-Json)
Check 'nonexistent project root -> 500 with envelope' ($badRoot.status -eq 500 -and $badRoot.body -like '*INTERNAL_ERROR*') ("status=" + $badRoot.status)

Write-Output ""
Write-Output ("RESULT: {0} passed, {1} failed" -f $script:pass, $script:fail)
if ($script:fail -gt 0) { exit 1 }
