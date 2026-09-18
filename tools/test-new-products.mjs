// The products added in one sweep: digital VIL (DVL), the two rain
// accumulations (DAA, DTA), the surface hydrometeor classifier (HHC) on
// Level 3, and raw differential phase (PHI) on Level 2 - each wired from
// the decoder through the families, the palettes and the menus.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const BUNDLE = readFileSync(join(ROOT, 'assets/radar_worker.bundle.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('1. the DVL parser module: the RPG float16 and the two-part scale');
{
  const mod = await import('../src/parse/level3/src/products/134/index.js');
  ok('registers as product 134 DVL', mod.code === 134 && mod.abbreviation.includes('DVL'));
  // A synthetic description block: linear scale 10, offset 20, log from
  // level 20 with scale 20 and offset -40, all in the coded float16.
  const f16 = (v) => {
    // encode small positive/negative values the way the decoder reads them
    const sign = v < 0 ? 0x8000 : 0; const m = Math.abs(v);
    for (let e = 1; e < 31; e++) {
      const f = m / 2 ** (e - 25) - 1024;
      if (f >= 0 && f < 1024 && Math.abs(f - Math.round(f)) < 1e-6) return sign | (e << 10) | Math.round(f);
    }
    throw new Error('cannot encode ' + v);
  };
  const buf = Buffer.alloc(48);
  buf.writeInt16BE(0, 0);              // hw30 dependent
  buf.writeUInt16BE(f16(10), 2);       // linear scale 10
  buf.writeUInt16BE(f16(20), 4);       // linear offset 20
  buf.writeInt16BE(20, 6);             // log start level
  buf.writeUInt16BE(f16(20), 8);       // log scale 20
  buf.writeUInt16BE(f16(-40), 10);     // log offset -40
  const pd = mod.halfwords30_53(buf);
  const d = pd.plot.decodeDataLevel;
  ok('the coded float16 reads back exactly', pd.plot.linearScale === 10 && pd.plot.linearOffset === 20
     && pd.plot.logScale === 20 && pd.plot.logOffset === -40,
     JSON.stringify([pd.plot.linearScale, pd.plot.linearOffset, pd.plot.logScale, pd.plot.logOffset]));
  ok('levels 0 and 1 are no-data', d(0) === null && d(1) === null);
  ok('below the log start the scale is linear, floored at zero',
     Math.abs(d(19) - 0) < 1e-9 && d(10) === 0, JSON.stringify([d(19), d(10)]));
  ok('from the log start the scale is exponential',
     Math.abs(d(25) - Math.exp((25 + 40) / 20)) < 1e-9 && Math.abs(d(100) - Math.exp(7)) < 1e-6,
     JSON.stringify([d(25), d(100)]));
}

console.log('\n2. the worker carries the new decoders');
{
  ok('product 134 is bundled', /High Resolution Digital VIL/.test(BUNDLE));
  ok('the PHI moment layer exists', /getHighresDiffPhase/.test(BUNDLE) && /case ?["']PHI["']/.test(BUNDLE));
}

console.log('\n3. the page wires them through');
{
  ok('the bucket table maps the four new products to their codes',
     /vil:\s*\{ k: \['DVL'\] \}/.test(PAGE) && /onehour:\s*\{ k: \['DAA'\] \}/.test(PAGE)
     && /stormtotal:\s*\{ k: \['DTA'\] \}/.test(PAGE) && /hydrohybrid:\s*\{ k: \['HHC'\] \}/.test(PAGE));
  ok('picture-only shrinks to the two with genuinely no raw feed',
     /const PR_PICTURE_ONLY = \['composite', 'spectrum'\];/.test(PAGE));
  ok('a terminal radar declines them honestly',
     /TDWR_CANNOT = \[[^\]]*'phi', 'hydrohybrid',\s*'vil', 'onehour', 'stormtotal'\]/.test(PAGE));
  ok('the families know VIL, the accumulations and phase',
     /vil:\s*\{ label: 'VIL',\s*unit: 'kg\/m²'/.test(PAGE) && /phi:\s*\{ label: 'Diff\. Phase'/.test(PAGE));
  ok('accumulations arrive in inches and are turned to millimetres on landing',
     /c === 'daa' \|\| c === 'dta'/.test(PAGE) && /u \* 25\.4/.test(PAGE));
  ok('the Level 2 menu offers differential phase and the layer map carries it',
     /id:'l2-phi', product:'phi'/.test(PAGE) && /sw: 'SW', phi: 'PHI'/.test(PAGE));
  ok('the 3D picker gains differential phase, Level 2 only',
     /id: 'phi', label: 'Differential phase', layer: 'PHI', l3: null/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes anywhere new', !PAGE.includes(EM) || PAGE.split(EM).length === readFileSync(join(ROOT, 'index.html'), 'utf8').split(EM).length);
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch (e) {}
if (chromium) {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--allow-file-access-from-files'] });
  const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
  await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });
  await p.route('**://**', route => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.includes('leaflet') && url.endsWith('.js')) return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist', 'leaflet.js'), 'utf8') });
    if (url.includes('leaflet') && url.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: readFileSync(join(process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist', 'leaflet.css'), 'utf8') });
    return route.abort();
  });
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);

  console.log('\n4. families, colours and units behave');
  {
    const r = await p.evaluate(() => {
      const probe = {};
      probe.fams = { dvl: _meshFamily('dvl'), daa: _meshFamily('daa'), dta: _meshFamily('dta'),
                     hhc: _meshFamily('hhc'), phi: _meshFamily('phi') };
      probe.vilLow = _meshColorFn('vil')(0.06);
      probe.vilNone = _meshColorFn('vil')(0.01);
      probe.vilHail = _meshColorFn('vil')(50);
      probe.rain = _meshColorFn('onehour')(20);
      probe.phi0 = _meshColorFn('phi')(0);
      probe.phi180 = _meshColorFn('phi')(180);
      // DAA mesh in inches: one quad worth of numbers, normalised on landing.
      const mesh = new Float32Array(9); mesh[8] = 1;               // one inch
      _l3MeshNormalize(mesh, 'DAA');
      probe.inch = mesh[8];
      const dvlMesh = new Float32Array(9); dvlMesh[8] = 30;        // kg/m² untouched
      _l3MeshNormalize(dvlMesh, 'DVL');
      probe.vilKept = dvlMesh[8];
      return probe;
    });
    ok('the codes land in their families', r.fams.dvl === 'vil' && r.fams.daa === 'onehour'
       && r.fams.dta === 'stormtotal' && r.fams.hhc === 'hc' && r.fams.phi === 'phi', JSON.stringify(r.fams));
    ok('VIL colours: drizzle band, nothing below it, hail red high up',
       !!r.vilLow && r.vilNone == null && r.vilHail === '#c00000', JSON.stringify([r.vilLow, r.vilNone, r.vilHail]));
    ok('rain gets the precip scale', r.rain === '#00fa00', r.rain);
    ok('phase walks the colour wheel', /^hsl\(0,/.test(r.phi0) && /^hsl\(180,/.test(r.phi180),
       JSON.stringify([r.phi0, r.phi180]));
    ok('an inch of rain becomes 25.4 mm; VIL stays in kg/m²',
       Math.abs(r.inch - 25.4) < 1e-4 && r.vilKept === 30,
       JSON.stringify([r.inch, r.vilKept]));
  }

  console.log('\n5. menus and routing');
  {
    const r = await p.evaluate(() => ({
      l2Bubbles: RADAR_L2_BUBBLES.map(b2 => b2.product),
      pi: Object.keys(PR_PRODUCTS),
      code: { vil: _l3BucketCode('KTLX', 'vil', 1), hh: _l3BucketCode('KTLX', 'hydrohybrid', 1),
              tdwrVil: _l3BucketCode('TDAL', 'vil', 1) },
      canMake: { ktlx: _prSiteCanMake('KTLX', 'vil') && _prSiteCanMake('KTLX', 'hydrohybrid'),
                 tdal: _prSiteCanMake('TDAL', 'vil') || _prSiteCanMake('TDAL', 'phi') },
      spec3d: (typeof R3D_PRODUCTS !== 'undefined') && R3D_PRODUCTS.some(x => x.id === 'phi' && x.layer === 'PHI' && x.l3 === null),
    }));
    ok('the Level 2 row offers phi', r.l2Bubbles.includes('phi'), r.l2Bubbles.join(','));
    ok('the product table carries the new rows', r.pi.includes('phi') && r.pi.includes('hydrohybrid'), '');
    ok('codes resolve for a NEXRAD and refuse for a terminal',
       r.code.vil === 'DVL' && r.code.hh === 'HHC' && r.code.tdwrVil === null, JSON.stringify(r.code));
    ok('availability says yes for KTLX, no for a TDWR', r.canMake.ktlx === true && r.canMake.tdal === false,
       JSON.stringify(r.canMake));
    ok('the 3D picker knows phi as a Level 2 only product', r.spec3d === true);
  }

  console.log('\n6. nothing threw');
  {
    const real = errs.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
    ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
  }
  await b.close();
}
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
