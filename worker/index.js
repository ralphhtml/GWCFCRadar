// GWCFCRadar -- NEXRAD Level-2 Proxy Worker
// Data source: AWS S3 noaa-nexrad-level2 (public) -- accessible from Cloudflare Workers
// Paste into Cloudflare Workers editor, Save and Deploy.
// Test: https://YOUR-WORKER.workers.dev/radar?station=KLTX
// Returns: raw Level-2 binary (application/octet-stream) for client-side parsing

var S3 = 'https://noaa-nexrad-level2.s3.amazonaws.com';

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
    h['X-Radar-File']  = result.key;
    return new Response(result.body, { headers: h });

  } catch (e) {
    return jsonErr('Internal error: ' + e.message, 500);
  }
}

// List the S3 bucket for today (then yesterday) and return the latest V06 file body
async function fetchLatestL2(station) {
  for (var dayOff = 0; dayOff <= 1; dayOff++) {
    var d    = new Date(Date.now() - dayOff * 86400000);
    var yyyy = String(d.getUTCFullYear());
    var mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd   = String(d.getUTCDate()).padStart(2, '0');

    var prefix  = yyyy + '/' + mm + '/' + dd + '/' + station + '/';
    var listUrl = S3 + '?list-type=2&prefix=' + encodeURIComponent(prefix) + '&max-keys=200';

    try {
      var listRes = await fetch(listUrl);
      if (!listRes.ok) continue;
      var xml = await listRes.text();

      // Pull <Key> values from S3 XML -- skip MDM metadata sidecars
      var keys = [];
      var re = /<Key>([^<]+)<\/Key>/g;
      var m;
      while ((m = re.exec(xml)) !== null) {
        if (m[1].indexOf('_MDM') === -1) keys.push(m[1]);
      }
      if (keys.length === 0) continue;

      // Filenames end in timestamp, so alphabetical sort gives newest last
      keys.sort();
      var latest = keys[keys.length - 1];
      var fileUrl = S3 + '/' + latest;

      var fileRes = await fetch(fileUrl);
      if (!fileRes.ok) continue;

      return { body: fileRes.body, key: latest };
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
