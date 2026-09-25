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
// `prep(data, headers)`, when given, reshapes the sweep first (thins it, or
// cleans it) and returns { data, headers } still paired radial for radial.
export const readCut = (radar, elevationNumber, getter, prep) => {
    radar.setElevation(elevationNumber);
    let data = getter();
    const hs = radar.getHeader();
    let heads = Array.isArray(hs) ? hs : [hs];
    if (prep && Array.isArray(data)) ({ data, headers: heads } = prep(data, heads));
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

// -- NOISE, FOR RADARS THAT SEND IT --------------------------------------------
// A NEXRAD throws away every gate whose signal is not clearly above the
// receiver's own noise before the volume leaves the radar. Some MRRL radars
// do not, over part or all of the circle, and what comes through is the
// noise itself: a solid fan of 10 to 30 dBZ with random velocity in it
// (Cancun, 1852, sends one north of the radar). Noise has a fingerprint real
// weather does not: its power is the same at every range, so once the range
// is taken out of reflectivity (dBZ minus 20 log10 r) it is flat along the
// whole radial. Interference from other transmitters is the same, a flat
// line along one or two radials.
//
// noiseMask finds radials like that and marks every gate on them that is not
// clearly above that radial's own noise level (by NOISE_MARGIN_DB, on a one
// kilometre average, so one lucky gate does not count). A radial that is
// already thresholded, or full of real rain, is not flat, and is left alone.
// Returns one Uint8Array per radial (1 = noise) or null for a clean radial.
//
// `confirm(i)`, when given, is a second opinion on radial i (the page's
// velocity: noise has random velocity or none, rain has a smooth wind). With
// it, a radial only half filled can be called noise too, which is what an
// interference spike's ragged edges look like; without it the radial must be
// mostly filled, so a patch of steady rain is never mistaken for noise.
export const NOISE_MARGIN_DB = 5;
export const NOISE_MIN_RUN_KM = 3;
export const noiseMask = (radials, confirm) => radials.map((d, i) => {
    if (!d || !Array.isArray(d.moment_data) || !(d.gate_size > 0)) return null;
    const m = d.moment_data, n = m.length, gs = d.gate_size, fg = d.first_gate;
    const B = Math.max(4, Math.round(1 / gs));          // gates in a kilometre
    const nb = Math.floor(n / B);
    const q = new Float32Array(nb).fill(NaN);
    let considered = 0, filled = 0;
    for (let b = 0; b < nb; b++) {
        let s = 0, c = 0;
        for (let k = b * B; k < (b + 1) * B; k++) { const x = m[k]; if (Number.isFinite(x)) { s += x; c++; } }
        const rk = fg + (b + 0.5) * B * gs;
        if (c) q[b] = s / c - 20 * Math.log10(Math.max(rk, 0.5));
        if (rk < 20) continue;
        considered++;
        if (c >= B * (confirm ? 0.3 : 0.6)) filled++;
    }
    // Mostly empty is a thresholded radial; nothing to do.
    if (considered < 10 || filled < considered * (confirm ? 0.3 : 0.6)) return null;
    const vals = [];
    for (let b = 0; b < nb; b++) {
        const rk = fg + (b + 0.5) * B * gs;
        if (rk >= 20 && Number.isFinite(q[b])) vals.push(q[b]);
    }
    vals.sort((a, b) => a - b);
    const med = vals[vals.length >> 1];
    let flat = 0;
    for (const v of vals) if (Math.abs(v - med) <= 4) flat++;
    // Flat along most of its length: noise. Rain is never that tidy.
    const full = filled >= considered * 0.6;
    if (flat < (full ? considered : vals.length) * 0.5) return null;
    // Mostly filled and flat is noise on its own; half filled needs the
    // second opinion as well.
    if (!full && !(confirm && confirm(i))) return null;
    const bad = new Uint8Array(n);
    const floor = med + NOISE_MARGIN_DB;
    // Noise poking over the line by chance is a kilometre here and there, so
    // on a noise radial an echo has to hold above it for NOISE_MIN_RUN_KM in
    // a row to count as one.
    const above = (b) => Number.isFinite(q[b]) && q[b] >= floor;
    for (let b = 0; b < nb; ) {
        if (!above(b)) { bad.fill(1, b * B, (b + 1) * B); b++; continue; }
        let e = b;
        while (e < nb && above(e)) e++;
        if (e - b < NOISE_MIN_RUN_KM) bad.fill(1, b * B, e * B);
        b = e;
    }
    bad.fill(1, nb * B, n);
    return bad;
});

// The same mask applied to a moment's radials (reflectivity or any other on
// the same cut). Gates are matched by range, so a moment with a different
// gate spacing lines up too.
export const applyNoiseMask = (radials, masks, refRadials) => radials.map((d, i) => {
    const mk = masks[i], ref = refRadials[i];
    if (!d || !Array.isArray(d.moment_data) || !mk || !ref) return d;
    const out = d.moment_data.slice();
    for (let g = 0; g < out.length; g++) {
        const rk = d.first_gate + g * d.gate_size;
        const rg = Math.round((rk - ref.first_gate) / ref.gate_size);
        if (rg < 0 || rg >= mk.length || mk[rg]) out[g] = null;
    }
    return Object.assign({}, d, { moment_data: out });
});

// Velocity that is noise jumps at random from gate to gate across the whole
// Nyquist interval; real wind, even a tornado's, is smooth along a radial
// over a few hundred metres. Gates whose mean squared step (folded, so an
// alias is not counted as a jump) over about a kilometre is more than
// (0.3 Nyquist)^2, or with less than half the window filled, are dropped.
// Done before dealiasing, which would otherwise unfold the noise into
// strong fake winds.
// Per gate: 1 where velocity is present but is noise by the rule below, 2
// where too little of the window around it holds any velocity at all.
export const velocityNoiseFlags = (d, nyquist) => {
    const m = d.moment_data, n = m.length;
    const W = Math.max(2, Math.round(0.5 / d.gate_size));
    const N2 = 2 * nyquist, lim = (0.3 * nyquist) ** 2;
    const step = new Float32Array(n).fill(NaN);
    for (let g = 0; g + 1 < n; g++) {
        const a = m[g], b = m[g + 1];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        let dv = b - a;
        dv = ((dv + nyquist) % N2 + N2) % N2 - nyquist;
        step[g] = dv * dv;
    }
    const flags = new Uint8Array(n);
    for (let g = 0; g < n; g++) {
        if (!Number.isFinite(m[g])) continue;
        let s = 0, c = 0, f = 0;
        for (let k = Math.max(0, g - W); k < Math.min(n, g + W); k++) {
            if (Number.isFinite(m[k])) f++;
            if (Number.isFinite(step[k])) { s += step[k]; c++; }
        }
        const span = Math.min(n, g + W) - Math.max(0, g - W);
        if (!c || s / c > lim) flags[g] = 1;
        else if (f < span * 0.5) flags[g] = 2;
    }
    return flags;
};
// The second opinion noiseMask takes: is radial i's velocity mostly noise,
// or mostly missing where it has reflectivity?
export const velocityCallsNoise = (refRadials, velRadials, nyquist) => (i) => {
    const d = refRadials[i], v = velRadials && velRadials[i];
    if (!d || !v || !Array.isArray(v.moment_data) || !(nyquist > 0)) return false;
    const flags = velocityNoiseFlags(v, nyquist);
    let withRef = 0, withVel = 0, noisy = 0;
    for (let g = 0; g < d.moment_data.length; g++) {
        const rk = d.first_gate + g * d.gate_size;
        if (rk < 20 || !Number.isFinite(d.moment_data[g])) continue;
        withRef++;
        const vg = Math.round((rk - v.first_gate) / v.gate_size);
        if (vg < 0 || vg >= flags.length || !Number.isFinite(v.moment_data[vg])) continue;
        withVel++;
        if (flags[vg] === 1) noisy++;
    }
    if (!withRef) return false;
    return withVel < withRef * 0.1 || noisy > withVel * 0.3;
};
// A strong echo is never noise, and turbulent wind inside one (a tornado's
// couplet, a hail core) is exactly what must not be thinned, so velocity in
// reflectivity of KEEP_STRONG_DBZ or more is always kept.
export const KEEP_STRONG_DBZ = 35;
export const cleanVelocityNoise = (radials, nyquist, refRadials) => radials.map((d, i) => {
    if (!d || !Array.isArray(d.moment_data) || !(d.gate_size > 0) || !(nyquist > 0)) return d;
    const flags = velocityNoiseFlags(d, nyquist);
    const ref = refRadials && refRadials[i];
    const out = d.moment_data.slice();
    for (let g = 0; g < out.length; g++) {
        if (!flags[g]) continue;
        if (ref && Array.isArray(ref.moment_data)) {
            const rg = Math.round((d.first_gate + g * d.gate_size - ref.first_gate) / ref.gate_size);
            const z = ref.moment_data[rg];
            if (Number.isFinite(z) && z >= KEEP_STRONG_DBZ) continue;
        }
        out[g] = null;
    }
    return Object.assign({}, d, { moment_data: out });
});

// Any other moment on the same cut loses the gates where velocity is there
// but is noise: a real echo has a real wind in it. (A gate with no velocity
// at all is kept; plenty of radars measure reflectivity further out than
// velocity.) This is what takes out interference spikes and the brighter
// stripes of a noise fan that are not flat enough for noiseMask.
export const maskByVelocityNoise = (radials, velRadials, nyquist) => radials.map((d, i) => {
    const v = velRadials && velRadials[i];
    if (!d || !Array.isArray(d.moment_data) || !v || !Array.isArray(v.moment_data)
        || !(v.gate_size > 0) || !(nyquist > 0)) return d;
    const flags = velocityNoiseFlags(v, nyquist);
    const out = d.moment_data.slice();
    for (let g = 0; g < out.length; g++) {
        const rk = d.first_gate + g * d.gate_size;
        const vg = Math.round((rk - v.first_gate) / v.gate_size);
        if (vg >= 0 && vg < flags.length && flags[vg] === 1) out[g] = null;
    }
    return Object.assign({}, d, { moment_data: out });
});

// What is left of noise after the rest is specks: a gate or two with almost
// nothing round it. A gate is kept when at least DESPECKLE_MIN of its
// neighbourhood (this radial and the one either side, half a kilometre each
// way along them) holds data. Any real echo, even a single shower, fills its
// own neighbourhood.
export const DESPECKLE_MIN = 0.3;
export const despeckle = (radials) => {
    const n = radials.length;
    return radials.map((d, i) => {
        if (!d || !Array.isArray(d.moment_data) || !(d.gate_size > 0)) return d;
        const W = Math.max(2, Math.round(0.5 / d.gate_size));
        const rows = [radials[(i + n - 1) % n], d, radials[(i + 1) % n]]
            .filter((r) => r && Array.isArray(r.moment_data));
        const m = d.moment_data, out = m.slice();
        for (let g = 0; g < m.length; g++) {
            if (!Number.isFinite(m[g])) continue;
            const rk = d.first_gate + g * d.gate_size;
            let f = 0, t = 0;
            for (const r of rows) {
                const c = Math.round((rk - r.first_gate) / r.gate_size);
                for (let k = c - W; k <= c + W; k++) {
                    if (k < 0 || k >= r.moment_data.length) continue;
                    t++;
                    if (Number.isFinite(r.moment_data[k])) f++;
                }
            }
            if (f < t * DESPECKLE_MIN) out[g] = null;
        }
        return Object.assign({}, d, { moment_data: out });
    });
};
