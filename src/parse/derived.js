// GWCFC: products worked out from a whole Level 2 volume, for radars that
// publish nothing else.
//
// A NEXRAD's own product generator makes the Level 3 products (composite
// reflectivity, echo tops, VIL, rainfall, hydrometeor class, storm relative
// velocity) and the Weather Service publishes them. The MRRL radars around
// the world publish only their raw Level 2 volumes. Every one of those
// products is a calculation over the volume's own numbers, so this does the
// calculation here, in the decoder, from the same volume the picture comes
// from. Each is drawn on the lowest tilt's own geometry, so it lines up
// exactly with that radar's reflectivity.
//
//   CREF   composite reflectivity: the strongest echo above each spot, dBZ
//   ETOP   echo tops: the highest beam that still sees 18 dBZ, kft
//   DVIL   vertically integrated liquid, the standard Z to M relation, kg/m2
//   HCLS   a hydrometeor class from reflectivity, ZDR and correlation,
//          on the Weather Service's class numbers (10 biological ... 110 large hail)
//   SRV    storm relative velocity (drawn by the velocity path, with the
//          motion from estimateStormMotion taken off)
//   ACC    rainfall accumulated over several volumes (Z = 300 R^1.4), mm
//
// The geometry is the standard four-thirds-earth beam: the height of a beam
// at slant range r and elevation e, and the ground distance under it.

const DEG = Math.PI / 180;
const RE = 8494.7;                 // four thirds of the earth's radius, km

export const DERIVED_LAYERS = new Set(['CREF', 'ETOP', 'DVIL', 'HCLS', 'ACC']);

export const beamHeightKm = (rKm, elDeg) =>
    Math.sqrt(rKm * rKm + RE * RE + 2 * rKm * RE * Math.sin(elDeg * DEG)) - RE;
export const groundKm = (rKm, elDeg) => {
    const h = beamHeightKm(rKm, elDeg);
    return RE * Math.asin((rKm * Math.cos(elDeg * DEG)) / (RE + h));
};
// The slant range at which a tilt's beam passes over a ground distance.
export const slantForGround = (sKm, elDeg) => sKm / Math.cos(elDeg * DEG);

// One cut read into plain arrays, with a half-degree azimuth index so any
// azimuth finds its nearest radial in one step.
export const readCut = (radar, elevationNumber, getter) => {
    radar.setElevation(elevationNumber);
    const data = getter();
    const hs = radar.getHeader();
    const heads = Array.isArray(hs) ? hs : [hs];
    const radials = [];
    let angSum = 0, angN = 0;
    for (let i = 0; i < data.length; i++) {
        const d = data[i];
        const h = heads[i];
        if (!d || !Array.isArray(d.moment_data) || !h || !Number.isFinite(h.azimuth)) continue;
        radials.push({ az: h.azimuth, fg: d.first_gate, gs: d.gate_size, v: d.moment_data });
        const a = Number(h.elevation_angle);
        if (Number.isFinite(a)) { angSum += a; angN += 1; }
    }
    if (!radials.length) return null;
    const index = new Int32Array(720).fill(-1);
    radials.forEach((r, i) => {
        const b = Math.round(((r.az % 360) + 360) % 360 * 2) % 720;
        index[b] = i;
    });
    // Fill the gaps from the nearest filled bin either side.
    for (let pass = 0; pass < 4; pass++) {
        for (let b = 0; b < 720; b++) {
            if (index[b] >= 0) continue;
            const l = index[(b + 719) % 720], r = index[(b + 1) % 720];
            if (l >= 0) index[b] = l; else if (r >= 0) index[b] = r;
        }
    }
    return { radials, index, angle: angN ? angSum / angN : 0.5 };
};

export const valueAt = (cut, azDeg, slantKm) => {
    const b = Math.round(((azDeg % 360) + 360) % 360 * 2) % 720;
    const ri = cut.index[b];
    if (ri < 0) return null;
    const r = cut.radials[ri];
    const gi = Math.floor((slantKm - r.fg) / r.gs);
    if (gi < 0 || gi >= r.v.length) return null;
    const v = r.v[gi];
    return Number.isFinite(v) ? v : null;
};

// The distinct tilts of a volume, lowest first: one cut per angle (a SAILS
// volume repeats the low tilts, and split cuts share an angle), the
// lowest-numbered cut of each, which is the surveillance one.
export const distinctCuts = (elevations, angles, topAngle = 20) => {
    const items = elevations.map((el, i) => ({ el, a: angles[i] }))
        .filter((x) => Number.isFinite(x.a) && x.a <= topAngle)
        .sort((p, q) => p.a - q.a || p.el - q.el);
    const out = [];
    for (const it of items) {
        const c = out[out.length - 1];
        if (c && it.a - c.a < 0.25) { if (it.el < c.el) c.el = it.el; }
        else out.push({ el: it.el, a: it.a });
    }
    return out;
};

// What one column of cuts says, for the column-wise products. `samples` is
// [{h, z}] for every tilt that has a reading over this spot, any order.
export const columnValue = (layer, samples) => {
    if (!samples.length) return null;
    if (layer === 'CREF') {
        let m = -Infinity;
        for (const s of samples) if (s.z > m) m = s.z;
        return m;
    }
    if (layer === 'ETOP') {
        let top = null;
        for (const s of samples) if (s.z >= 18 && (top === null || s.h > top)) top = s.h;
        return top === null ? null : top * 3.28084;     // km to kft
    }
    if (layer === 'DVIL') {
        // VIL = sum of 3.44e-6 * Zbar^(4/7) * dh over the column, with each
        // reflectivity capped at 56 dBZ so hail does not count as water.
        const s = samples.slice().sort((p, q) => p.h - q.h);
        let vil = 0;
        for (let i = 0; i + 1 < s.length; i++) {
            const za = Math.pow(10, Math.min(s[i].z, 56) / 10);
            const zb = Math.pow(10, Math.min(s[i + 1].z, 56) / 10);
            const dh = (s[i + 1].h - s[i].h) * 1000;
            if (dh > 0) vil += 3.44e-6 * Math.pow((za + zb) / 2, 4 / 7) * dh;
        }
        return vil >= 0.5 ? vil : null;
    }
    return null;
};

// A hydrometeor class from one gate's dual polarization readings, on the
// Weather Service's class numbers. A simplified version of the fuzzy logic
// the NWS runs, without its melting layer (that needs a model sounding):
// the beam's height stands in for it, ice above about 4 km.
export const classify = (z, zdr, cc, hKm) => {
    if (!Number.isFinite(z)) return null;
    if (Number.isFinite(cc) && cc < 0.8) {
        if (z < 30) return 10;                 // biological
        return 140;                            // unknown (debris, clutter mixed with echo)
    }
    const d = Number.isFinite(zdr) ? zdr : 0;
    const ice = hKm > 4.0;
    if (z >= 55) return d < 1 ? (z >= 60 ? 110 : 100) : 100;   // (large) hail
    if (ice) {
        if (z >= 40) return 90;                // graupel
        if (z < 20 && d > 1) return 30;        // ice crystals
        return 40;                             // dry snow
    }
    if (hKm > 3.0 && z >= 25 && z < 45 && Number.isFinite(cc) && cc < 0.95) return 50;   // wet snow near the melting layer
    if (d >= 2.5 && z < 45) return 80;         // big drops
    if (z >= 42) return 70;                    // heavy rain
    if (z >= 5) return 60;                     // light rain
    return null;
};

// The storm motion used for storm relative velocity, from the volume's own
// wind: a velocity-azimuth fit (Vr = a + u sin(az) cos(el) + v cos(az) cos(el))
// over the near gates of the Doppler cut gives the mean wind; storms move
// at about three quarters of it, thirty degrees to its right (a common
// rule of thumb, used where no storm tracking is available). m/s.
export const estimateStormMotion = (cut) => {
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sb = 0, sbx = 0, sby = 0;
    const ce = Math.cos(cut.angle * DEG);
    for (const r of cut.radials) {
        const x = Math.sin(r.az * DEG) * ce, y = Math.cos(r.az * DEG) * ce;
        for (let g = 0; g < r.v.length; g++) {
            const km = r.fg + g * r.gs;
            if (km < 10 || km > 60) continue;
            const vr = r.v[g];
            if (!Number.isFinite(vr)) continue;
            n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
            sb += vr; sbx += vr * x; sby += vr * y;
        }
    }
    if (n < 200) return { u: 0, v: 0 };
    // Normal equations for [a, u, v].
    const A = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]], B = [sb, sbx, sby];
    const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det3(A);
    if (!Number.isFinite(D) || Math.abs(D) < 1e-9) return { u: 0, v: 0 };
    const col = (k) => A.map((row, i) => row.map((val, j) => (j === k ? B[i] : val)));
    const u = det3(col(1)) / D, v = det3(col(2)) / D;
    const c = Math.cos(30 * DEG), s = Math.sin(30 * DEG);
    return { u: 0.75 * (u * c + v * s), v: 0.75 * (-u * s + v * c) };
};

// Rain rate from reflectivity, mm per hour: Z = 300 R^1.4, the Weather
// Service's convective default, with the usual 53 dBZ hail cap.
export const rainRate = (dbz) => {
    if (!Number.isFinite(dbz) || dbz < 10) return 0;
    const z = Math.pow(10, Math.min(dbz, 53) / 10);
    return Math.pow(z / 300, 1 / 1.4);
};
