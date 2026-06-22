// GWCFCRadar -- NEXRAD Level-2 Proxy Worker
// Source: UCAR THREDDS Data Server (public, no credentials needed)
// Paste into Cloudflare Workers editor, Save and Deploy.
// Test: https://YOUR-WORKER.workers.dev?station=KLTX
// Returns: raw Level-2 binary (application/octet-stream) for client-side parsing

var THREDDS = 'https://thredds.ucar.edu/thredds';

addEventListener('fetch', function(event) {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    var url     = new URL(request.url);
    var station = (url.searchParams.get('station') || '').toUpperCase().trim();

    if (!station) return jsonErr('station param required', 400);
    if (!/^[A-Z]{4}$/.test(station)) return jsonErr('station must be 4 letters e.g. KLTX', 400);

    var result = await fetchLatestL2(station);
    if (!result) {
      return jsonErr('No Level-2 data found for ' + station + '. Station may be offline or data is delayed.', 502);
    }

    var h = corsHeaders();
    h['Content-Type']  = 'application/octet-stream';
    h['Cache-Control'] = 'public, max-age=90';
    h['X-Radar-File']  = result.name;
    return new Response(result.body, { headers: h });

  } catch (e) {
    return jsonErr('Internal error: ' + e.message, 500);
  }
}

async function fetchLatestL2(station) {
  for (var dayOff = 0; dayOff <= 1; dayOff++) {
    var d    = new Date(Date.now() - dayOff * 86400000);
    var yyyy = String(d.getUTCFullYear());
    var mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd   = String(d.getUTCDate()).padStart(2, '0');
    var yyyymmdd = yyyy + mm + dd;

    var catalogUrl = THREDDS + '/catalog/nexrad/level2/' + station + '/' + yyyymmdd + '/catalog.xml';

    try {
      var catRes = await fetch(catalogUrl);
      if (!catRes.ok) continue;
      var xml = await catRes.text();

      var names = [];
      var re = /name="([^"]+\.ar2v)"/g;
      var m;
      while ((m = re.exec(xml)) !== null) {
        names.push(m[1]);
      }
      if (names.length === 0) continue;

      names.sort();
      var latest = names[names.length - 1];

      var fileUrl = THREDDS + '/fileServer/nexrad/level2/' + station + '/' + yyyymmdd + '/' + latest;
      var fileRes = await fetch(fileUrl);
      if (!fileRes.ok) continue;

      return { body: fileRes.body, name: latest };
    } catch (err) { continue; }
  }
  return null;
}

function corsHeaders() {
  var h = {};
  h['Access-Control-Allow-Origin']  = '*';
  h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
  h['Access-Control-Allow-Headers'] = 'Content-Type';
  return h;
}

function jsonErr(msg, status) {
  var h = corsHeaders();
  h['Content-Type'] = 'application/json';
  return new Response(JSON.stringify({ error: msg }), { status: status, headers: h });
}
