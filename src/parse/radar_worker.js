import { Buffer } from 'buffer';
import { Level2Radar } from './level2/src/index.js';
import nexradLevel3Data from './level3/src/browser.js';
import { dealiasVelocityRadials } from './dealias.js';
import decompressL2 from './level2/src/decompress.js';
import { RandomAccessFile, BIG_ENDIAN } from './level2/src/classes/RandomAccessFile.js';
import { DERIVED_LAYERS, beamHeightKm, groundKm, slantForGround, readCut, valueAt,
         distinctCuts, columnValue, classify, estimateStormMotion, rainRate,
         noiseMask, applyNoiseMask, cleanVelocityNoise, maskByVelocityNoise,
         velocityCallsNoise, despeckle } from './derived.js';

const LEVEL3_PARSE_MODE = 'fast';

const EARTH_RADIUS = 6371000;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

const getLevel2MomentForLayer = (layer) => {
    const upperLayer = typeof layer === 'string' ? layer.toUpperCase() : '';
    switch (upperLayer) {
    case 'REF':
        return 'reflect';
    case 'VEL':
        return 'velocity';
    case 'CC':
        return 'rho';
    case 'KDP':
        // Level-II parser exposes differential phase (phi); KDP is derived during rendering.
        return 'phi';
    case 'SW':
        return 'spectrum';
    case 'PHI':
        return 'phi';
    case 'ZDR':
        return 'zdr';
    // GWCFC: products worked out from the whole volume (see derived.js).
    case 'SRV':
        return 'velocity';
    case 'CREF':
    case 'ETOP':
    case 'DVIL':
    case 'ACC':
        return 'reflect';
    default:
        return null;
    }
};
// GWCFC: some radars (several on the MRRL feed) sample far finer than their
// beam can see: Cancun sends 1501 radials of 4800 gates 62.5 m long, seven
// million numbers a tilt, where a NEXRAD's super resolution is 720 radials
// of 250 m. Drawing, unfolding and filtering all of that cost seconds and
// showed nothing more, since a one degree beam is kilometres wide out there.
// So a sweep like that is thinned first: every k-th radial kept so there are
// about 720, and gates merged to about 250 m (the strongest reflectivity of
// the group, so no core is lost; the first reading for the other moments).
// A NEXRAD sweep is already at that resolution and passes through untouched.
const THIN_RADIALS = 720, THIN_GATE_KM = 0.25;
const thinSweep = (data, headers, layer) => {
    const n = data.length;
    const k = Math.max(1, Math.floor(n / THIN_RADIALS));
    const d0 = data.find((d) => d && d.gate_size > 0);
    const gm = d0 && d0.gate_size < THIN_GATE_KM * 0.8 ? Math.max(1, Math.round(THIN_GATE_KM / d0.gate_size)) : 1;
    if (k === 1 && gm === 1) return { data, headers };
    const outD = [], outH = [];
    const useMax = layer === 'REF';
    for (let i = 0; i < n; i += k) {
        const d = data[i];
        outH.push(headers[i]);
        if (!d || !Array.isArray(d.moment_data) || gm === 1) { outD.push(d); continue; }
        const m = d.moment_data, len = Math.floor(m.length / gm);
        const out = new Array(len);
        for (let j = 0; j < len; j++) {
            let v = null;
            for (let q = j * gm; q < (j + 1) * gm; q++) {
                const x = m[q];
                if (x === null || x === undefined) continue;
                if (v === null || v === 'rf') { v = x; if (!useMax && v !== 'rf') break; continue; }
                if (useMax && x !== 'rf' && x > v) v = x;
            }
            out[j] = v;
        }
        outD.push(Object.assign({}, d, { moment_data: out, gate_size: d.gate_size * gm, gate_count: len }));
    }
    return { data: outD, headers: outH };
};

// GWCFC: the last volume's decompressed bytes. Switching product or tilt
// sends the same compressed file again; unpacking its bzip2 blocks is most
// of the parse (two of Cancun's three seconds), so the unpacked copy is kept
// and a repeat skips straight to reading it.
let _plainCache = null;
const fingerprint = (buf) => {
    let h = buf.length;
    const step = Math.max(1, Math.floor(buf.length / 997));
    for (let i = 0; i < buf.length; i += step) h = (h * 31 + buf[i]) >>> 0;
    return buf.length + ':' + h;
};
const plainVolume = (buf) => {
    const key = fingerprint(buf);
    if (_plainCache && _plainCache.key === key) return _plainCache.buf;
    const raf = decompressL2(new RandomAccessFile(buf, BIG_ENDIAN));
    const plain = raf.buffer;
    _plainCache = { key, buf: plain };
    return plain;
};

const MOMENT_LABEL = { reflect: 'reflectivity', velocity: 'velocity', spectrum: 'spectrum width',
    zdr: 'differential reflectivity', phi: 'differential phase', rho: 'correlation coefficient' };
// Every moment a layer needs. Hydrometeor class reads three at once.
const getLevel2MomentsForLayer = (layer, options = {}) => {
    if (String(layer || '').toUpperCase() === 'HCLS') return ['reflect', 'zdr', 'rho'];
    const m = getLevel2MomentForLayer(layer);
    if (!m) return undefined;
    // The noise filter reads reflectivity to find the noise, whatever is drawn,
    // and velocity to recognise it by.
    return options && options.noise_filter ? [...new Set([m, 'reflect', 'velocity'])] : [m];
};

// GWCFC: a moment's radials with a radar's raw noise taken out (see
// noiseMask in derived.js), for the radars that send it. The mask comes from
// the reflectivity of the same cut; velocity is also checked on its own.
const safeRef = (radar) => { try { return radar.getHighresReflectivity(); } catch (e) { return null; } };
const denoise = (radar, layer, radials, thin) => {
    // The other moments read here are thinned exactly as `radials` was, so
    // radial i is the same beam in all of them.
    const same = (d) => {
        if (!thin || !Array.isArray(d)) return d;
        const hs = radar.getHeader();
        return Array.isArray(hs) && hs.length === d.length ? thin(d, hs).data : d;
    };
    if (!Array.isArray(radials)) return radials;
    const ref = layer === 'REF' ? radials : same(safeRef(radar));
    const hs = radar.getHeader();
    const h0 = Array.isArray(hs) ? hs.find((h) => h && h.radial) : hs;
    const nyq = Number(h0 && h0.radial && h0.radial.nyquist_velocity);
    let vel = null;
    try { vel = layer === 'VEL' ? radials : same(radar.getHighresVelocity()); } catch (e) { vel = null; }
    const velOk = Array.isArray(vel) && vel.length === radials.length && nyq > 0;
    let out = radials;
    if (Array.isArray(ref) && ref.length === radials.length) {
        out = applyNoiseMask(radials,
            noiseMask(ref, velOk ? velocityCallsNoise(ref, vel, nyq) : undefined), ref);
    }
    if (layer === 'VEL') out = cleanVelocityNoise(out, nyq,
        Array.isArray(ref) && ref.length === out.length ? ref : null);
    else if (velOk) out = maskByVelocityNoise(out, vel, nyq);
    return despeckle(out);
};

const getLevel2Vcp = (radar, header = null) => {
    const patternNumber = Number(radar?.vcp?.record?.pattern_number);
    if (Number.isFinite(patternNumber)) {
        return patternNumber;
    }

    const headerVcp = Number(header?.vcp);
    if (Number.isFinite(headerVcp)) {
        return headerVcp;
    }

    return null;
};

const createRadarProjector = (radarLat, radarLon) => {
    const lat1 = radarLat * DEG_TO_RAD;
    const lon1 = radarLon * DEG_TO_RAD;
    const sinLat1 = Math.sin(lat1);
    const cosLat1 = Math.cos(lat1);
    // sin/cos of angular distance depend only on range, not azimuth.
    // Cache them so each unique distance is computed once across all radials.
    const rangeCache = new Map();

    return (sinAz, cosAz, distanceMeters) => {
        let entry = rangeCache.get(distanceMeters);
        if (entry === undefined) {
            const dR = distanceMeters / EARTH_RADIUS;
            entry = { s: Math.sin(dR), c: Math.cos(dR) };
            rangeCache.set(distanceMeters, entry);
        }
        const lat2 = Math.asin(sinLat1 * entry.c + cosLat1 * entry.s * cosAz);
        const lon2 = lon1 + Math.atan2(
            sinAz * entry.s * cosLat1,
            entry.c - sinLat1 * Math.sin(lat2)
        );
        return [lon2 * RAD_TO_DEG, lat2 * RAD_TO_DEG];
    };
};

const buildPolygon = (project, sinAz1, cosAz1, sinAz2, cosAz2, r1, r2) => {
    const p1 = project(sinAz1, cosAz1, r1);
    const p2 = project(sinAz2, cosAz2, r1);
    const p3 = project(sinAz2, cosAz2, r2);
    const p4 = project(sinAz1, cosAz1, r2);
    return [p1, p2, p3, p4];
};

// -- How far out to draw, and at what detail -------------------------------
//
// A NEXRAD reflectivity sweep reaches 460 km. At super-resolution it is
// sampled every 250 m, so that is 1832 cells on each of 720 radials: 1.3
// million polygons for one picture, which no phone is going to hold.
//
// The cap used to be a flat count of 460 GATES, which is a completely
// different distance depending on how wide a gate is. On the legacy 1 km
// gates it meant 460 km, the whole sweep. On the 250 m super-resolution
// gates that every modern VCP uses at the lowest tilt, it meant 115 km - a
// quarter of what the radar measured, and the reason this looked short next
// to every other radar app.
//
// So the cap is a DISTANCE now, set to the full reach of the product, and
// the thing that keeps the polygon count down is detail thinning with range
// instead. That is not a compromise made to save memory, it is what the beam
// already does: about one degree wide, it is 2 km across at 115 km and 4 km
// at 230 km, so 250 m radial cells out there are finer than anything the
// radar can resolve. Merging them loses nothing that was ever there.
//
// Full detail is kept inside RANGE_FULL_DETAIL_KM, which covers every storm
// anyone interrogates closely, and beyond that the cells lengthen in steps.
const RANGE_FULL_DETAIL_KM = 100;
const RANGE_STEP_KM = 100;      // every further step of this doubles the cell
const RANGE_MAX_STRIDE = 8;     // never coarser than this, however far out

// How many gates to merge into one cell at this range.
//
// Range is in kilometres and gateSizeKm is how long one gate is. A gate that
// is already a kilometre long is not thinned at all: it is coarser than the
// beam is wide out to 57 km, and past that the sweep is short enough to draw
// whole anyway.
const strideForRange = (rangeKm, gateSizeKm, full) => {
    if (full) return 1;
    if (!(gateSizeKm > 0) || gateSizeKm >= 0.9) return 1;
    if (rangeKm <= RANGE_FULL_DETAIL_KM) return 1;
    // Doubling rather than counting up: 100 to 200 km merges two gates, 200
    // to 300 merges four, 300 to 400 merges eight. Counting up gave 460 km of
    // sweep about a thousand cells on every radial, and drawing a million of
    // anything is where a browser stops being a browser. Doubling gives about
    // six hundred, and it matches what the beam is doing anyway: the beam
    // widens in proportion to range, so the cell should too.
    const steps = Math.floor((rangeKm - RANGE_FULL_DETAIL_KM) / RANGE_STEP_KM) + 1;
    const stride = Math.pow(2, steps);
    // Never merge past the point where a cell is longer than the beam is
    // wide: that would be visible as blockiness rather than as fidelity
    // nobody could see anyway.
    const beamKm = rangeKm / 57;
    const byBeam = Math.max(1, Math.floor(beamKm / gateSizeKm));
    return Math.max(1, Math.min(RANGE_MAX_STRIDE, stride, byBeam));
};

// What the caller asked for, resolved once per scan.
//
// `range_limit_km` is the real control. `gate_limit` is still honoured
// because it is what the page used to send, but it is now a ceiling on the
// gate index rather than the only limit, so an old caller cannot silently
// shorten the range back to a quarter of the sweep.
const readRangeOptions = (options) => ({
    limitKm: Number.isFinite(options.range_limit_km) && options.range_limit_km > 0
        ? options.range_limit_km : null,
    gateCap: Number.isFinite(options.gate_limit) && options.gate_limit > 0
        ? options.gate_limit : null,
    full: options.full_detail === true,
});

// `bbox` ([lonMin, latMin, lonMax, latMax]) keeps only the cells whose
// centroid falls inside it. GWCFC's Radar 3D asks for one small zone of the
// sky from every tilt of a volume; dropping the rest here, in the worker,
// means the page is handed a few thousand cells per tilt instead of a few
// hundred thousand, and never has to copy or scan the ones it will throw
// away.
const createMeshBuilder = (includeGeojson, bbox) => {
    const mesh = [];
    const features = includeGeojson ? [] : null;
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;

    const updateBounds = (point) => {
        const lng = point[0];
        const lat = point[1];
        minLng = Math.min(minLng, lng);
        minLat = Math.min(minLat, lat);
        maxLng = Math.max(maxLng, lng);
        maxLat = Math.max(maxLat, lat);
    };

    const pushQuad = (quad, value) => {
        if (bbox) {
            const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
            const cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
            if (cx < bbox[0] || cx > bbox[2] || cy < bbox[1] || cy > bbox[3]) return;
        }
        for (let i = 0; i < 4; i++) {
            updateBounds(quad[i]);
        }

        const encodedValue = value === 'rf' ? NaN : value;
        mesh.push(
            quad[0][0], quad[0][1],
            quad[1][0], quad[1][1],
            quad[2][0], quad[2][1],
            quad[3][0], quad[3][1],
            encodedValue
        );

        if (features) {
            const closed = [quad[0], quad[1], quad[2], quad[3], quad[0]];
            features.push({
                type: 'Feature',
                properties: { val: value === 'rf' ? 'rf' : value },
                geometry: {
                    type: 'Polygon',
                    coordinates: [closed]
                }
            });
        }
    };

    const finalize = () => {
        const meshData = new Float32Array(mesh);
        const bounds = Number.isFinite(minLng) ? [minLng, minLat, maxLng, maxLat] : null;
        const geojson = features ? { type: 'FeatureCollection', features } : null;
        return { meshData, bounds, geojson };
    };

    return { pushQuad, finalize };
};

const processRadarData = (radar, radarLocation, extent, layer, options = {}) => {
    // GWCFC fix, carried into the SparkRadar source: the tilt-up hunt below
    // was written for velocity alone, but spectrum width lives on the same
    // Doppler cut velocity does, one sweep above the surveillance cut, so
    // asking for SW at the lowest tilt failed on virtually every scan while
    // the data sat a sweep away. Every moment walks now.
    const momentGetters = {
        REF: () => radar.getHighresReflectivity(),
        VEL: () => radar.getHighresVelocity(),
        CC:  () => radar.getHighresCorrelationCoefficient(),
        KDP: () => radar.getHighresDiffPhase(),
        SW:  () => radar.getHighresSpectrum(),
        ZDR: () => radar.getHighresDiffReflectivity(),
        // The raw differential phase itself, the moment KDP is derived
        // from: the propagation phase shift in degrees, 0 to 360.
        PHI: () => radar.getHighresDiffPhase(),
    };
    const momentEmpty = (d) => !Array.isArray(d) || d.length === 0
        || d.every((item) => item === undefined);
    let radarData;
    if (momentGetters[layer]) {
        radarData = momentGetters[layer]();
        // Tilt up until we find the moment
        if (momentEmpty(radarData)) {
            const elevationLevels = radar.listElevations().sort((a, b) => a - b);
            let currentIndex = elevationLevels.indexOf(radar.elevation);
            while (currentIndex + 1 < elevationLevels.length) {
                currentIndex += 1;
                radar.setElevation(elevationLevels[currentIndex]);
                radarData = momentGetters[layer]();
                if (!momentEmpty(radarData)) {
                    break;
                }
            }
        }
    } else if (layer === 'CC') {
        radarData = radar.getHighresCorrelationCoefficient();
    } else if (layer === 'KDP') {
        radarData = radar.getHighresDiffPhase();
    } else if (layer === 'SW') {
        radarData = radar.getHighresSpectrum();
    } else if (layer == 'ZDR') {
        radarData = radar.getHighresDiffReflectivity();
    } else {
        throw new Error(`Unknown radar layer: ${layer}`);
    }

    if (!Array.isArray(radarData) || radarData.length === 0) {
        throw new Error(`No radar data available for layer: ${layer}`);
    }

    // GWCFC: an oversampled sweep thinned to what the beam resolves (see
    // thinSweep), before anything else touches it.
    let headers = radar.getHeader();
    const thin = options.thin === false ? null : (data, hs) => thinSweep(data, hs, layer);
    if (thin && Array.isArray(headers) && headers.length === radarData.length) {
        ({ data: radarData, headers } = thin(radarData, headers));
    }
    const numberOfRadarIterations = radarData.length;
    const range = readRangeOptions(options);
    const project = createRadarProjector(radarLocation[0], radarLocation[1]);
    const includeGeojson = options.includeGeojson === true;
    const bbox = Array.isArray(options.bbox) && options.bbox.length === 4
        && options.bbox.every(Number.isFinite) ? options.bbox : null;
    const builder = createMeshBuilder(includeGeojson, bbox);
    const scanIsPartial = Boolean(radar?.hasGaps || radar?.isTruncated);

    if (options && options.noise_filter) radarData = denoise(radar, layer, radarData, thin);

    const shouldDealiasLevel2Velocity = layer === 'VEL' && options?.enableVelocityDealias !== false;

    if (shouldDealiasLevel2Velocity) {
        try {
            console.log('Applying velocity dealiasing to Level-II velocity data...');
            const beforeRows = radarData.map((radial) => {
                if (!radial || !Array.isArray(radial.moment_data)) return null;
                return radial.moment_data.slice();
            });
            const dealiasDebug = {};
            const firstNyquist = Number(headers?.[0]?.radial?.nyquist_velocity);
            radarData = dealiasVelocityRadials(radarData, {
                nyquistVelocity: Number.isFinite(firstNyquist) && firstNyquist > 0 ? firstNyquist : undefined,
				headers,
                debugStats: dealiasDebug
            });

            let finiteBefore = 0;
            let changedGates = 0;
            let maxAbsDelta = 0;
            for (let i = 0; i < radarData.length; i++) {
                const radial = radarData[i];
                const before = beforeRows[i];
                if (!radial || !Array.isArray(radial.moment_data) || !Array.isArray(before)) {
                    continue;
                }
                const gateCount = Math.min(before.length, radial.moment_data.length);
                for (let g = 0; g < gateCount; g++) {
                    const oldVal = before[g];
                    const newVal = radial.moment_data[g];
                    if (!Number.isFinite(oldVal) || !Number.isFinite(newVal)) {
                        continue;
                    }
                    finiteBefore += 1;
                    const delta = newVal - oldVal;
                    if (delta !== 0) {
                        changedGates += 1;
                        const absDelta = Math.abs(delta);
                        if (absDelta > maxAbsDelta) {
                            maxAbsDelta = absDelta;
                        }
                    }
                }
            }

            console.log(
                `[dealias] L2 VEL changed ${changedGates}/${finiteBefore} finite gates; max |delta|=${maxAbsDelta.toFixed(3)} m/s`
            );
            console.log(
                `[dealias] rotation protection marked ${dealiasDebug.rotationProtectedGateCount || 0} gates; expanded mask covers ${dealiasDebug.rotationProtectedExpandedGateCount || 0} gates`
            );
            console.log(
                `[dealias] local rotation-zone unwrap adjusted ${dealiasDebug.rotationLocalAdjustedGateCount || 0} gates`
            );
            console.log(
                `[dealias] local rotation-zone double-wrap candidates ${dealiasDebug.rotationLocalDoubleWrapCandidateCount || 0}`
            );
            console.log(
                `[dealias] local rotation-zone solved ${dealiasDebug.rotationLocalSolvedSegmentCount || 0} segments across ${dealiasDebug.rotationLocalSolvedRayCount || 0} radials`
            );
            console.log('Velocity dealiasing completed successfully.');
        } catch (error) {
            console.error('Velocity dealiasing failed for Level-II velocity data:', error);
        }
    }

    // GWCFC: storm relative velocity. The storm's own motion (u east, v
    // north, m/s) is taken off every gate: the part of that motion along
    // this radial, which is what the radar would have seen of it.
    const motion = options && options.stormMotion;
    if (layer === 'VEL' && motion && (motion.u || motion.v)) {
        radarData = radarData.map((radial, i) => {
            const h = headers?.[i];
            if (!radial || !Array.isArray(radial.moment_data) || !h || !Number.isFinite(h.azimuth)) return radial;
            const el = Number.isFinite(h.elevation_angle) ? h.elevation_angle : 0.5;
            const along = (motion.u * Math.sin(h.azimuth * DEG_TO_RAD)
                + motion.v * Math.cos(h.azimuth * DEG_TO_RAD)) * Math.cos(el * DEG_TO_RAD);
            return Object.assign({}, radial, {
                moment_data: radial.moment_data.map((v) => (Number.isFinite(v) ? v - along : v))
            });
        });
    }
    // A class code merges by keeping the first gate, not the biggest code.
    const keepFirst = options && options.merge === 'first';

    const forwardDelta = (fromAz, toAz) => {
        if (!Number.isFinite(fromAz) || !Number.isFinite(toAz)) return 1;
        let delta = toAz - fromAz;
        while (delta <= 0) delta += 360;
        return delta;
    };

    const getAzimuthPair = (index) => {
        const current = headers?.[index];
        if (!current || !Number.isFinite(current.azimuth)) {
            return null;
        }

        const az1 = current.azimuth;
        const prev = index > 0 ? headers[index - 1] : null;
        const next = index + 1 < numberOfRadarIterations ? headers[index + 1] : null;
        const prevDelta = prev && Number.isFinite(prev.azimuth)
            ? forwardDelta(prev.azimuth, az1)
            : null;

        let delta;
        if (next && Number.isFinite(next.azimuth)) {
            const nextDelta = forwardDelta(az1, next.azimuth);
            // For interior radials, use the true next-edge delta so adjacent wedges touch.
            delta = nextDelta;
        } else {
            if (!scanIsPartial && headers?.[0] && Number.isFinite(headers[0].azimuth)) {
                delta = forwardDelta(az1, headers[0].azimuth);
            } else {
                delta = Number.isFinite(prevDelta) ? prevDelta : 1;
            }
        }

        const az2 = az1 + (Number.isFinite(delta) && delta > 0 ? delta : 1);
        return { az1, az2 };
    };

    const normalizePhiDelta = (delta) => {
        if (!Number.isFinite(delta)) return null;
        if (delta > 180) return delta - 360;
        if (delta < -180) return delta + 360;
        return delta;
    };

    const computeKdpFromPhi = (momentData, gateIndex, gateSizeKm) => {
        if (!Array.isArray(momentData) || !Number.isFinite(gateSizeKm) || gateSizeKm <= 0) {
            return null;
        }

        // Use a wider adaptive baseline for dPhi/dr to reduce gate-to-gate noise.
        let leftIndex = null;
        let rightIndex = null;
        for (let step = 1; step <= 3; step++) {
            const li = gateIndex - step;
            const ri = gateIndex + step;
            if (leftIndex == null && li >= 0 && Number.isFinite(momentData[li])) {
                leftIndex = li;
            }
            if (rightIndex == null && ri < momentData.length && Number.isFinite(momentData[ri])) {
                rightIndex = ri;
            }
            if (leftIndex != null && rightIndex != null) break;
        }

        let kdp = null;
        if (leftIndex != null && rightIndex != null && rightIndex > leftIndex) {
            const dPhi = normalizePhiDelta(momentData[rightIndex] - momentData[leftIndex]);
            if (Number.isFinite(dPhi)) {
                const dR = (rightIndex - leftIndex) * gateSizeKm;
                // KDP = 0.5 * dPhi/dr
                kdp = 0.5 * (dPhi / dR);
            }
        }

        // One-sided fallback.
        if (!Number.isFinite(kdp)) {
            const curr = momentData[gateIndex];
            if (Number.isFinite(curr) && rightIndex != null && rightIndex > gateIndex) {
                const dPhi = normalizePhiDelta(momentData[rightIndex] - curr);
                if (Number.isFinite(dPhi)) {
                    const dR = (rightIndex - gateIndex) * gateSizeKm;
                    kdp = 0.5 * (dPhi / dR);
                }
            } else if (Number.isFinite(curr) && leftIndex != null && gateIndex > leftIndex) {
                const dPhi = normalizePhiDelta(curr - momentData[leftIndex]);
                if (Number.isFinite(dPhi)) {
                    const dR = (gateIndex - leftIndex) * gateSizeKm;
                    kdp = 0.5 * (dPhi / dR);
                }
            }
        }

        if (!Number.isFinite(kdp)) return null;

        // Match display expectations for this product family: suppress negative artifacts.
        if (kdp < 0) kdp = 0;
        if (kdp > 20) kdp = 20;
        return kdp;
    };

    for (let index = 0; index < numberOfRadarIterations; index++) {
        const radial = radarData[index];
        if (!radial || typeof radial !== 'object' || !radial.moment_data || typeof radial.gate_count !== 'number') {
            continue;
        }

        const azPair = getAzimuthPair(index);
        if (!azPair) {
            continue;
        }
        const { az1, az2 } = azPair;
        const az1Rad = az1 * DEG_TO_RAD;
        const az2Rad = az2 * DEG_TO_RAD;
        const sinAz1 = Math.sin(az1Rad);
        const cosAz1 = Math.cos(az1Rad);
        const sinAz2 = Math.sin(az2Rad);
        const cosAz2 = Math.cos(az2Rad);

        const firstGate = radial.first_gate;
        const gateSize = radial.gate_size;
        const lastGate = radial.gate_count - 1;

        // Where the sweep is allowed to stop. With nothing asked for, that is
        // wherever the radar stopped measuring, which is the whole point of
        // this change: the full 460 km rather than a quarter of it.
        let capIndex = lastGate;
        if (range.limitKm !== null && gateSize > 0) {
            capIndex = Math.min(capIndex,
                Math.ceil((range.limitKm - firstGate) / gateSize));
        }
        if (range.gateCap !== null) capIndex = Math.min(capIndex, range.gateCap);
        if (capIndex < 1) continue;

        for (let gateIndex = 0; gateIndex < capIndex; ) {
            const rangeKm = firstGate + gateIndex * gateSize;
            const stride = Math.max(1, Math.min(
                strideForRange(rangeKm, gateSize, range.full),
                capIndex - gateIndex));

            // One value for the merged cell, and which one is not a detail.
            //
            // On correlation coefficient it has to be the MINIMUM: a debris
            // ball under a tornado is a hole of LOW CC, and a merge that took
            // the maximum would erase exactly the signature a warning gets
            // written from. On velocity it is the largest magnitude either
            // way, so an inbound-outbound couplet survives instead of the two
            // halves cancelling. Everywhere else the maximum is right, since
            // a core is what a merged cell should still show.
            //
            // GWCFC: correlation coefficient merges by MEAN, not by minimum.
            //
            // For reflectivity and velocity the extreme IS the signal: a core
            // and a couplet are what a merged cell must not lose, so max and
            // max-magnitude are right. Correlation coefficient is the other
            // way round. Low CC is mostly NOISE - a single poorly lit gate at
            // low signal to noise reads low - and it is only occasionally the
            // rare thing worth seeing. Taking the minimum of a merged cell
            // therefore hands the whole cell to its worst gate.
            //
            // That is not a small bias. Stride is 1 inside 100 km and doubles
            // every 100 km after, so past 300 km eight gates collapse into one
            // and uniform 0.98 rain reported whichever of those eight happened
            // to be lowest. The far half of every sweep came out looking like
            // mixed or non-meteorological echo, and the closer the colour
            // scale got to being useful at the top end the more obvious it was.
            //
            // Nothing is lost by averaging. Debris balls sit close to the
            // radar - that is where a tornado is observable at all - and
            // inside 100 km the stride is 1, so there is no merge happening
            // there in the first place. The minimum rule only ever applied
            // where it was not needed, and only ever did harm.
            let value = null;
            let ccSum = 0, ccCount = 0;
            for (let k = 0; k < stride; k++) {
                const rawValue = radial.moment_data[gateIndex + k];
                if (rawValue === null || rawValue === undefined) continue;
                let v = rawValue;
                if (layer === 'KDP' && v !== 'rf') {
                    v = computeKdpFromPhi(radial.moment_data, gateIndex + k, gateSize);
                }
                if (v == null) continue;
                if (layer === 'CC') {
                    if (v === 'rf') continue;
                    ccSum += v; ccCount += 1;
                    value = ccSum / ccCount;
                    continue;
                }
                if (value == null || value === 'rf') { value = v; continue; }
                if (v === 'rf' || keepFirst) continue;
                if (layer === 'VEL') value = Math.abs(v) > Math.abs(value) ? v : value;
                else value = Math.max(value, v);
            }

            if (value == null) { gateIndex += stride; continue; }

            if (layer === 'VEL' && value !== 'rf' && Number.isFinite(value)) {
                // Convert m/s to knots to match palette units
                value *= 1.94384;
            }

            const r1 = rangeKm * 1000;
            const r2 = (firstGate + (gateIndex + stride) * gateSize) * 1000;
            const coords = buildPolygon(project, sinAz1, cosAz1, sinAz2, cosAz2, r1, r2);
            builder.pushQuad(coords, value);
            gateIndex += stride;
        }
    }

    return builder.finalize();
};

// Storm relative velocity ships four bits per bin, which is a code into this
// table rather than a speed. Index 0 means no data and 15 means range folded.
const SRV_LEVELS = [null, -64, -50, -36, -26, -20, -10, -1, 0,
                    10, 20, 26, 36, 50, 64];

const processLevel3Data = (radar, radarLocation, options = {}) => {
    const radialPackets = Array.isArray(radar.radialPackets) ? radar.radialPackets : [];
    const packet = radialPackets.find((entry) => entry && Array.isArray(entry.radials));
    if (!packet) {
        throw new Error('No radial packet data found in Level 3 product.');
    }

    const firstBin = packet.firstBin ?? 0;
    const numberBins = packet.numberBins ?? 0;
    const radials = packet.radials || [];
    const range = readRangeOptions(options);

    // The product code, not a name the page passed in, because the file says
    // what it is and the page only says what it asked for.
    const code = radar.productDescription?.code;

    // How long one bin is, in KILOMETRES, for the products whose files do not
    // say.
    //
    // The packet header carries a range scale as an integer scaled by a
    // thousand, so a 250 m gate is written as 999 and read back as 0.999,
    // which is then multiplied by the product's nominal gate size. That works
    // for the moment products and it is a trap for these four: they write a
    // bare 1 into the same halfword, which reads back as 0.001, and taking
    // that at face value shrinks the sweep by a factor of a thousand.
    //
    // The consequence was not a wrong picture, it was NO picture. The mesh
    // was built correctly and then placed on the map inside a box a few
    // metres across, so it drew as a dot far too small to see. Every product
    // of every one of the 46 terminal radars was invisible this way, and so
    // were echo tops at all 160 NEXRADs. Only the canvas looked right, which
    // is why photographing the canvas rather than the map missed it.
    //
    // Their geometry is fixed and published, and the numbers below were each
    // confirmed against a live file: bin count times bin size lands on the
    // product's documented range to within half a percent.
    const FIXED_BIN_KM = {
        135: 1.0,    // enhanced echo tops:      346 bins x 1.00 km = 346 km
        180: 0.15,   // TDWR base reflectivity:  592 bins x 0.15 km =  89 km
        182: 0.15,   // TDWR base velocity:      592 bins x 0.15 km =  89 km
        186: 0.30,   // TDWR long range refl:   1390 bins x 0.30 km = 417 km
    };
    const fixedBinKm = FIXED_BIN_KM[code];

    // scaleFactor is one bin in metres; rangeScaleKm is the multiplier on top
    // of it. Stating the bin size outright means the multiplier is exactly 1.
    const scaleFactor = fixedBinKm ? fixedBinKm * 1000
        : ((code === 56 || code === 170 || code === 172) ? 1000 : 250);
    const rangeScaleKm = fixedBinKm ? 1 : (packet.rangeScale ?? 1);
    const binKm = (rangeScaleKm * scaleFactor) / 1000;
    const isVelocity = code === 25 || code === 27 || code === 55
                       || code === 56 || code === 99;
    const isCorrelation = code === 161;

    // One bin's raw code turned into the number the palette reads.
    const decodeBin = (raw) => {
        if (raw == null) return null;
        if (code === 56) {
            if (raw === 15) return 'rf';
            const level = SRV_LEVELS[raw];
            return level === undefined ? raw : level;
        }
        if ((code === 170 || code === 172) && raw === 'rf') return 0;
        return raw;
    };

    const numberOfRadarIterations = radials.length;
    const project = createRadarProjector(radarLocation[0], radarLocation[1]);
    const includeGeojson = options.includeGeojson === true;
    const builder = createMeshBuilder(includeGeojson);

    for (let index = 0; index < numberOfRadarIterations; index++) {
        const radial = radials[index];
        if (!radial || typeof radial !== 'object') {
            continue;
        }

        const az1 = radial.startAngle;
        const az2 = radial.startAngle + radial.angleDelta;
        const az1Rad = az1 * DEG_TO_RAD;
        const az2Rad = az2 * DEG_TO_RAD;
        const sinAz1 = Math.sin(az1Rad);
        const cosAz1 = Math.cos(az1Rad);
        const sinAz2 = Math.sin(az2Rad);
        const cosAz2 = Math.cos(az2Rad);
        const bins = radial.bins || [];

        const binCount = Math.min(bins.length, numberBins);
        // How far out this radial is drawn. With nothing asked for, all of it:
        // a long-range base reflectivity product carries 460 km and used to be
        // cut to 115 by a cap counted in bins rather than in kilometres.
        let cap = binCount;
        if (range.limitKm !== null && rangeScaleKm > 0) {
            cap = Math.min(cap, Math.ceil(
                ((range.limitKm * 1000) / scaleFactor - firstBin) / rangeScaleKm));
        }
        if (range.gateCap !== null) cap = Math.min(cap, range.gateCap);
        if (cap < 1) continue;

        for (let binIndex = 0; binIndex < cap; ) {
            const rangeKm = ((firstBin + binIndex * rangeScaleKm) * scaleFactor) / 1000;
            const stride = Math.max(1, Math.min(
                strideForRange(rangeKm, binKm, range.full), cap - binIndex));

            // Same rule as Level 2, including the correction: correlation
            // coefficient merges by MEAN. Low CC is mostly noise rather than
            // the rare thing worth seeing, so handing a merged cell to its
            // worst gate dragged the whole far field down. See the long note
            // on the Level 2 path above.
            let value = null;
            let ccSum = 0, ccCount = 0;
            for (let k = 0; k < stride; k++) {
                const v = decodeBin(bins[binIndex + k]);
                if (v == null) continue;
                if (isCorrelation) {
                    if (v === 'rf') continue;
                    ccSum += v; ccCount += 1;
                    value = ccSum / ccCount;
                    continue;
                }
                if (value == null || value === 'rf') { value = v; continue; }
                if (v === 'rf') continue;
                if (isVelocity) value = Math.abs(v) > Math.abs(value) ? v : value;
                else value = Math.max(value, v);
            }

            if (value == null) { binIndex += stride; continue; }

            const r1 = (firstBin + (binIndex * rangeScaleKm)) * scaleFactor;
            const r2 = (firstBin + ((binIndex + stride) * rangeScaleKm)) * scaleFactor;

            const coords = buildPolygon(project, sinAz1, cosAz1, sinAz2, cosAz2, r1, r2);
            builder.pushQuad(coords, value);
            binIndex += stride;
        }
    }

    return builder.finalize();
};

const getLevel3Metadata = (radar) => {
    const productDescription = radar?.productDescription;
    if (!productDescription) return { timeIso: null, elevationAngle: null, vcp: null };

    const dateValue = Number(productDescription.volumeScanDate ?? productDescription.productDate);
    const timeValue = Number(productDescription.volumeScanTime ?? productDescription.productTime);
    let timeIso = null;
    if (Number.isFinite(dateValue) && Number.isFinite(timeValue)) {
        // A Level 3 date is a modified Julian day counted from 1 January
        // 1970 as day ONE, not day zero, so the epoch offset is a day less
        // than the number in the file. Taken at face value every Level 3
        // stamp read one day late.
        const epochMs = ((dateValue - 1) * 86400 + timeValue) * 1000;
        timeIso = new Date(epochMs).toISOString();
    }

    const elevationAngle = Number.isFinite(productDescription.elevationAngle)
        ? productDescription.elevationAngle
        : null;

    const vcp = Number.isFinite(productDescription.vcp)
        ? productDescription.vcp
        : null;

    return { timeIso, elevationAngle, vcp };
};

const toEpochMs = (monotonicMs) => performance.timeOrigin + monotonicMs;

// GWCFC: the mean elevation angle of one cut, over every radial in it.
// A cut's header angle is just its first radial's, and the antenna wanders
// a tenth of a degree or so around the nominal tilt as it turns; the mean
// is what the beam height for the whole sweep should be figured from.
const meanElevationAngle = (radar, elevationNumber) => {
    try {
        radar.setElevation(elevationNumber);
        const hs = radar.getHeader();
        const list = Array.isArray(hs) ? hs : [hs];
        let sum = 0, n = 0;
        for (const h of list) {
            const a = Number(h && h.elevation_angle);
            if (Number.isFinite(a)) { sum += a; n += 1; }
        }
        return n ? sum / n : null;
    } catch (e) {
        return null;
    }
};

// The radar's own position comes from a record's volume block, but the cut
// the parser lands on first can have none: a moment-filtered parse leaves a
// split cut's surveillance sweep empty when only velocity was asked for.
// Walk the cuts until one has it - every volume has it somewhere.
// Volumes older than 2008 (message 1, the legacy format) carry no volume
// block at all: the radar's position is not in the file. The page passes the
// site's position in (options.siteLat / siteLon) and it is used then.
let _siteFallback = null;
const firstUsableHeader = (radar, elevations) => {
    let firstAny = null;
    for (const el of elevations) {
        try {
            radar.setElevation(el);
            const h = radar.getHeader(0);
            if (h && h.volume && Number.isFinite(h.volume.latitude)) return h;
            if (h && !firstAny) firstAny = h;
        } catch (e) { /* next cut */ }
    }
    if (firstAny && _siteFallback) {
        firstAny.volume = { latitude: _siteFallback[0], longitude: _siteFallback[1] };
        if (!Number.isFinite(firstAny.radial_length)) firstAny.radial_length = 0;
        if (elevations.length) radar.setElevation(elevations[0]);
        return firstAny;
    }
    return null;
};

const level2TimeIso = (header) => {
    try {
        // julian_date counts 1 January 1970 as day ONE, not day zero, so a
        // day comes off before the epoch math. The old minus-one-hour fudge
        // had every Level 2 stamp reading twenty-three hours ahead.
        return new Date(((header.julian_date - 1) * 86400 * 1000) + header.mseconds).toISOString();
    } catch (e) {
        return null;
    }
};

// -- PRODUCTS FROM THE WHOLE VOLUME (GWCFC) ------------------------------------
// The MRRL radars publish only Level 2, so composite reflectivity, echo tops,
// VIL, hydrometeor class, storm relative velocity and rainfall are worked
// out here from the volume itself (the math is in derived.js). Each result
// is drawn on the lowest tilt's own radials: new numbers are written into a
// copy of that tilt and handed to the ordinary builder, so the picture has
// exactly the geometry, range and cell sizes the reflectivity picture has.
const asFloats = (arr) => Float32Array.from(arr, (x) => (typeof x === 'number' ? x : NaN));
const compactCut = (cut) => {
    if (!cut) return null;
    cut.radials.forEach((r) => { r.v = asFloats(r.v); });
    return cut;
};

// The lowest tilt that carries reflectivity, as the base every derived
// picture is drawn on: its elevation number, mean angle, radials and headers.
const baseSweep = (radar, cuts, clean) => {
    for (const c of cuts) {
        radar.setElevation(c.el);
        let data = radar.getHighresReflectivity();
        if (Array.isArray(data) && data.some((d) => d && Array.isArray(d.moment_data))) {
            const hs0 = radar.getHeader();
            let headers = Array.isArray(hs0) ? hs0 : [hs0];
            if (headers.length === data.length) ({ data, headers } = thinSweep(data, headers, 'REF'));
            const thin = (d, hs) => thinSweep(d, hs, 'REF');
            if (clean) data = denoise(radar, 'REF', data, thin);
            return { el: c.el, angle: c.a, data, headers };
        }
    }
    return null;
};

// A stand-in radar holding one sweep of new numbers, so processRadarData can
// build it exactly as it builds a real reflectivity sweep.
const sweepOf = (radar, base, values) => ({
    getHighresReflectivity: () => values,
    getHeader: () => base.headers,
    listElevations: () => [base.el],
    setElevation: () => {},
    elevation: base.el,
    hasGaps: radar.hasGaps,
    isTruncated: radar.isTruncated,
});

const planCuts = (radar) => {
    const elevations = radar.listElevations();
    const angles = elevations.map((e) => meanElevationAngle(radar, e));
    return { elevations, angles, cuts: distinctCuts(elevations, angles) };
};

const processDerived = (radar, radarLocation, layer, options = {}) => {
    const { cuts } = planCuts(radar);
    if (!cuts.length) throw new Error('no tilts in this volume');
    const clean = !!options.noise_filter;
    const base = baseSweep(radar, cuts, clean);
    if (!base) throw new Error('no reflectivity in this volume');
    // Every input thinned and cleaned here, so the builder below must not do
    // either again (it would be reading the derived numbers as if they were dBZ).
    const thinRef = (d, hs) => thinSweep(d, hs, 'REF');
    const refPrep = (d, hs) => {
        const t = hs.length === d.length ? thinRef(d, hs) : { data: d, headers: hs };
        if (clean) t.data = denoise(radar, 'REF', t.data, thinRef);
        return t;
    };
    const limitKm = Number.isFinite(options.range_limit_km) && options.range_limit_km > 0
        ? options.range_limit_km : Infinity;
    let values;
    if (layer === 'HCLS') {
        radar.setElevation(base.el);
        const thinAs = (L) => (d, hs) => (hs.length === d.length ? thinSweep(d, hs, L) : { data: d, headers: hs });
        const zdr = compactCut(readCut(radar, base.el, () => radar.getHighresDiffReflectivity(), thinAs('ZDR')));
        const rho = compactCut(readCut(radar, base.el, () => radar.getHighresCorrelationCoefficient(), thinAs('CC')));
        if (!zdr && !rho) throw new Error('this radar sends no dual polarization data');
        values = base.data.map((d, i) => {
            const h = base.headers[i];
            if (!d || !Array.isArray(d.moment_data) || !h || !Number.isFinite(h.azimuth)) return d;
            const out = new Array(d.moment_data.length).fill(null);
            for (let g = 0; g < out.length; g++) {
                const z = d.moment_data[g];
                if (!Number.isFinite(z)) continue;
                const r = d.first_gate + g * d.gate_size;
                if (r > limitKm) break;
                out[g] = classify(z, zdr ? valueAt(zdr, h.azimuth, r) : null,
                    rho ? valueAt(rho, h.azimuth, r) : null, beamHeightKm(r, base.angle));
            }
            return Object.assign({}, d, { moment_data: out });
        });
    } else {
        const stack = [];
        for (const c of cuts) {
            const cut = compactCut(readCut(radar, c.el, () => radar.getHighresReflectivity(), refPrep));
            if (cut) stack.push(cut);
        }
        const samples = [];
        values = base.data.map((d, i) => {
            const h = base.headers[i];
            if (!d || !Array.isArray(d.moment_data) || !h || !Number.isFinite(h.azimuth)) return d;
            const out = new Array(d.moment_data.length).fill(null);
            for (let g = 0; g < out.length; g++) {
                const r = d.first_gate + g * d.gate_size;
                if (r > limitKm) break;
                const s = groundKm(r, base.angle);
                samples.length = 0;
                for (const cut of stack) {
                    const sl = slantForGround(s, cut.angle);
                    const z = valueAt(cut, h.azimuth, sl);
                    if (z !== null) samples.push({ h: beamHeightKm(sl, cut.angle), z });
                }
                const v = columnValue(layer, samples);
                if (v !== null && Number.isFinite(v)) out[g] = v;
            }
            return Object.assign({}, d, { moment_data: out });
        });
    }
    const built = processRadarData(sweepOf(radar, base, values), radarLocation, null, 'REF',
        Object.assign({}, options, { noise_filter: false, thin: false }, layer === 'HCLS' ? { merge: 'first' } : {}));
    return Object.assign(built, { base });
};

// The storm motion for storm relative velocity, from the lowest tilt with
// velocity in it.
const volumeStormMotion = (radar) => {
    const { cuts } = planCuts(radar);
    for (const c of cuts) {
        const cut = readCut(radar, c.el, () => radar.getHighresVelocity(),
            (d, hs) => (hs.length === d.length ? thinSweep(d, hs, 'VEL') : { data: d, headers: hs }));
        if (cut) return estimateStormMotion(compactCut(cut));
    }
    return { u: 0, v: 0 };
};

// Rainfall over several volumes: each volume's lowest tilt turned into a
// rain rate, and each rate held for the time until the next volume (never
// more than fifteen minutes, so a gap in the feed is not counted as rain).
// Drawn on the newest volume's geometry, in millimetres.
const ACC_MAX_STEP_MS = 15 * 60 * 1000;
const processAccumulation = (buffers, options = {}) => {
    const vols = [];
    let newest = null;
    for (const buf of buffers) {
        try {
            const radar = new Level2Radar(Buffer.from(buf), { logger: false, includeMoments: ['reflect'] });
            const { elevations, cuts } = planCuts(radar);
            const head = firstUsableHeader(radar, elevations);
            const t = Date.parse(level2TimeIso(head) || '');
            if (!head || !Number.isFinite(t)) continue;
            // The same scan twice (a file fetched again) is still one scan's rain.
            if (vols.some((v) => v.t === t)) continue;
            const clean = !!options.noise_filter;
            const base = baseSweep(radar, cuts, clean);
            if (!base) continue;
            const cut = compactCut(readCut(radar, base.el, () => base.data, (d) => ({ data: d, headers: base.headers })));
            if (!cut) continue;
            vols.push({ t, cut });
            if (!newest || t > newest.t) newest = { t, radar, base, head };
        } catch (e) { /* one bad volume costs that volume */ }
    }
    if (!newest) throw new Error('no readable volume for the rainfall');
    vols.sort((p, q) => p.t - q.t);
    const steps = vols.map((v, i) => {
        const gap = i + 1 < vols.length ? vols[i + 1].t - v.t : (i > 0 ? v.t - vols[i - 1].t : 5 * 60000);
        return Math.max(0, Math.min(gap, ACC_MAX_STEP_MS)) / 3600000;       // hours
    });
    const limitKm = Number.isFinite(options.range_limit_km) && options.range_limit_km > 0
        ? options.range_limit_km : Infinity;
    const { base } = newest;
    const values = base.data.map((d, i) => {
        const h = base.headers[i];
        if (!d || !Array.isArray(d.moment_data) || !h || !Number.isFinite(h.azimuth)) return d;
        const out = new Array(d.moment_data.length).fill(null);
        for (let g = 0; g < out.length; g++) {
            const r = d.first_gate + g * d.gate_size;
            if (r > limitKm) break;
            let mm = 0;
            for (let k = 0; k < vols.length; k++) {
                const z = valueAt(vols[k].cut, h.azimuth, r);
                if (z !== null) mm += rainRate(z) * steps[k];
            }
            if (mm >= 0.25) out[g] = mm;
        }
        return Object.assign({}, d, { moment_data: out });
    });
    const loc = [newest.head.volume.latitude, newest.head.volume.longitude];
    const built = processRadarData(sweepOf(newest.radar, base, values), loc, null, 'REF',
        Object.assign({}, options, { noise_filter: false, thin: false }));
    return Object.assign(built, {
        timeIso: new Date(newest.t).toISOString(),
        elevationAngle: base.angle,
        vcp: getLevel2Vcp(newest.radar, newest.head),
        minutes: Math.round(steps.reduce((a, b) => a + b, 0) * 60),
        volumes: vols.length,
    });
};

self.onmessage = (event) => {
    const { type } = event.data || {};
    const _o = (event.data && event.data.options) || {};
    _siteFallback = (Number.isFinite(_o.siteLat) && Number.isFinite(_o.siteLon)) ? [_o.siteLat, _o.siteLon] : null;

    // --- Several whole volumes into one product (rainfall) ---
    if (type === 'process-multi') {
        const { buffers, options: multiOptions = {} } = event.data;
        try {
            const parserStartMs = toEpochMs(performance.now());
            if (!Array.isArray(buffers) || !buffers.length) throw new Error('process-multi: no buffers provided');
            const r = processAccumulation(buffers, multiOptions);
            const meshEndMs = toEpochMs(performance.now());
            self.postMessage({
                type: 'result', geojson: r.geojson, meshData: r.meshData, bounds: r.bounds,
                metadata: { station: multiOptions.station || null, product: 'ACC', timeIso: r.timeIso,
                            elevationAngle: r.elevationAngle, vcp: r.vcp,
                            accumMinutes: r.minutes, accumVolumes: r.volumes },
                timing: { parserStartMs, parserEndMs: parserStartMs, meshEndMs },
            }, [r.meshData.buffer]);
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message || String(err) });
        }
        return;
    }

    // --- Chunk-combine path (Level-II streaming) ---
    if (type === 'process-chunks') {
        const { buffers: rawBuffers, layer: chunkLayer, options: chunkOptions = {} } = event.data;
        if (!Array.isArray(rawBuffers) || rawBuffers.length === 0) {
            self.postMessage({ type: 'error', message: 'process-chunks: no buffers provided' });
            return;
        }
        try {
            const parserStartMs = toEpochMs(performance.now());
            const requestedMoment = getLevel2MomentForLayer(chunkLayer);
            const parsedChunks = rawBuffers.map(buf =>
                new Level2Radar(Buffer.from(buf), requestedMoment ? { includeMoments: [requestedMoment] } : undefined)
            );
            const radar = Level2Radar.combineData(...parsedChunks);
            const parserEndMs = toEpochMs(performance.now());

            const elevations = radar.listElevations();
            const recordHeader = firstUsableHeader(radar, elevations);
            if (!recordHeader) throw new Error('no usable sweep in the chunks');
            const radarLocation = [recordHeader.volume.latitude, recordHeader.volume.longitude];
            const extent = recordHeader.radial_length;
            radar.setElevation(radar.elevation || elevations[0] || 1);

            const { meshData, bounds, geojson } = processRadarData(radar, radarLocation, extent, chunkLayer, chunkOptions);
            const meshEndMs = toEpochMs(performance.now());

            const metadata = {
                station: chunkOptions.station || null,
                product: chunkLayer,
                timeIso: null,
                elevationAngle: recordHeader.elevation_angle,
                vcp: getLevel2Vcp(radar, recordHeader),
            };

            self.postMessage({
                type: 'result',
                geojson,
                meshData,
                bounds,
                metadata,
                timing: { parserStartMs, parserEndMs, meshEndMs },
            }, [meshData.buffer]);
        } catch (err) {
            self.postMessage({ type: 'error', message: err.message || String(err) });
        }
        return;
    }

    // --- Single-file path (archive / local upload / Level-III) ---
    const { arrayBuffer, layer } = event.data || {};
    let { options } = event.data || {};
    if (type !== 'process' || !arrayBuffer) {
        return;
    }

    try {
        const parserStartMs = toEpochMs(performance.now());
        let parserEndMs = null;
        let meshEndMs = null;
        const upperLayer = typeof layer === 'string' ? layer.toUpperCase() : '';
        // Include ZDR as a Level-II (super-res) product so ZDR archive files are
        // parsed with the Level2 parser instead of being misclassified as Level3.
        const isLevel2Product = upperLayer === 'REF' || upperLayer === 'VEL' || upperLayer === 'CC' || upperLayer === 'KDP' || upperLayer === 'SW' || upperLayer === 'ZDR' || upperLayer === 'PHI'
            || upperLayer === 'SRV' || DERIVED_LAYERS.has(upperLayer);
        const isLevel3 = !isLevel2Product;
        const buffer = Buffer.from(arrayBuffer);

        if (isLevel3) {
            const requestedParseMode = typeof options?.level3ParseMode === 'string'
                ? options.level3ParseMode.toLowerCase()
                : null;
            const level3ParseMode = requestedParseMode === 'full' ? 'full' : LEVEL3_PARSE_MODE;
            const radar = nexradLevel3Data(
                buffer,
                level3ParseMode === 'fast'
                    ? {
                        logger: false,
                        parseGraphic: false,
                        parseTabular: false,
                        parseFormatted: false,
                        includeRawBinData: false,
                        includePacketMetadata: false,
                        parseFirstRadialPacketOnly: true,
                        minimalOutput: true
                    }
                    : {
                        logger: false
                    }
            );
            parserEndMs = toEpochMs(performance.now());
            const radarLat = radar.productDescription?.latitude;
            const radarLon = radar.productDescription?.longitude;
            if (radarLat == null || radarLon == null) {
                throw new Error('Missing radar location in Level 3 product description.');
            }
            const radarLocation = [radarLat, radarLon];
            const { meshData, bounds, geojson } = processLevel3Data(radar, radarLocation, options);
            meshEndMs = toEpochMs(performance.now());
            const { timeIso, elevationAngle, vcp } = getLevel3Metadata(radar);
            const metadata = {
                station: options?.station || null,
                product: layer,
                timeIso,
                elevationAngle,
                vcp
            };

            self.postMessage({
                type: 'result',
                geojson,
                meshData,
                bounds,
                metadata,
                timing: {
                    parserStartMs,
                    parserEndMs,
                    meshEndMs
                }
            }, [meshData.buffer]);
        } else if (upperLayer === 'ACC') {
            // One volume's worth of rain: the same sum as process-multi.
            const r = processAccumulation([arrayBuffer], options || {});
            meshEndMs = toEpochMs(performance.now());
            self.postMessage({
                type: 'result', geojson: r.geojson, meshData: r.meshData, bounds: r.bounds,
                metadata: { station: options?.station || null, product: 'ACC', timeIso: r.timeIso,
                            elevationAngle: r.elevationAngle, vcp: r.vcp,
                            accumMinutes: r.minutes, accumVolumes: r.volumes },
                timing: { parserStartMs, parserEndMs: parserStartMs, meshEndMs }
            }, [r.meshData.buffer]);
        } else {
            const seenMoments = new Set();
            const radar = new Level2Radar(plainVolume(buffer), {
                logger: false,
                includeMoments: getLevel2MomentsForLayer(layer, options),
                seenMoments
            });
            // GWCFC: a radar that does not measure this product at all (many
            // MRRL radars send only reflectivity and velocity) says so, and
            // says what it does send, instead of failing as an empty volume.
            const needs = getLevel2MomentsForLayer(layer) || [];
            const lacking = needs.filter((m) => !seenMoments.has(m));
            if (seenMoments.size && lacking.length) {
                self.postMessage({ type: 'error', missing: lacking[0], moments: [...seenMoments],
                    message: `this radar does not send ${MOMENT_LABEL[lacking[0]] || lacking[0]}` });
                return;
            }
            parserEndMs = toEpochMs(performance.now());

            const elevations = radar.listElevations();
            // GWCFC: every cut's mean angle, so a caller can plan which cuts
            // it wants (one per distinct tilt - a SAILS volume repeats the
            // low tilts mid-scan and split cuts share an angle) without a
            // full parse per guess. Measured once here; parsing is the cost.
            const elevationAngles = elevations.map((e) => meanElevationAngle(radar, e));

            // GWCFC: many cuts from ONE parse. Radar 3D needs every tilt of a
            // volume; asking for them one message at a time meant re-parsing
            // a 13 MB file for each, four seconds a tilt. With `elevations`
            // the file is parsed once and each requested cut is built in
            // turn, and with `bbox` each of those is only the zone asked for.
            // `elevations: 'distinct'` asks the worker to plan the cuts itself:
            // one per distinct tilt (angles clustered at a quarter degree,
            // the lowest-numbered record of each cluster chosen, since that is
            // the surveillance cut), up to `top_angle`, and when `lane`/`lanes`
            // are given, only this lane's share of them - so several workers
            // can each parse once and split the cuts between them without a
            // separate decode to learn the angle list first.
            if (DERIVED_LAYERS.has(upperLayer) && upperLayer !== 'ACC') {
                const h0 = firstUsableHeader(radar, elevations);
                if (!h0) throw new Error('no usable sweep in this volume');
                const built = processDerived(radar, [h0.volume.latitude, h0.volume.longitude], upperLayer, options || {});
                meshEndMs = toEpochMs(performance.now());
                self.postMessage({
                    type: 'result', geojson: built.geojson, meshData: built.meshData, bounds: built.bounds,
                    metadata: { timeIso: level2TimeIso(h0), elevationAngle: built.base.angle,
                                station: options?.station || null, vcp: getLevel2Vcp(radar, h0),
                                product: upperLayer },
                    timing: { parserStartMs, parserEndMs, meshEndMs }
                }, [built.meshData.buffer]);
                return;
            }
            // Storm relative velocity is velocity with the storm's motion off.
            const procLayer = upperLayer === 'SRV' ? 'VEL' : layer;
            if (upperLayer === 'SRV') {
                options = Object.assign({}, options, { stormMotion: volumeStormMotion(radar) });
            }

            let wanted = options?.elevations;
            let distinctCount = null;
            if (wanted === 'distinct') {
                const topAngle = Number.isFinite(options.top_angle) ? options.top_angle : 20;
                const items = elevations.map((el, i) => ({ el, a: elevationAngles[i] }))
                    .filter((x) => Number.isFinite(x.a) && x.a <= topAngle)
                    .sort((p, q) => p.a - q.a || p.el - q.el);
                const clusters = [];
                for (const it of items) {
                    const c = clusters[clusters.length - 1];
                    if (c && it.a - c.a0 < 0.25) { if (it.el < c.el) c.el = it.el; }
                    else clusters.push({ a0: it.a, el: it.el });
                }
                const reps = clusters.map((c) => c.el);
                distinctCount = reps.length;
                const lanes = Number.isFinite(options.lanes) && options.lanes > 0 ? options.lanes : 1;
                const lane = Number.isFinite(options.lane) ? options.lane : 0;
                wanted = reps.filter((_, i) => i % lanes === lane);
            }
            if (Array.isArray(wanted) && (wanted.length || distinctCount !== null)) {
                const h0 = firstUsableHeader(radar, elevations);
                if (!h0) throw new Error('no usable sweep in this volume');
                const radarLocation0 = [h0.volume.latitude, h0.volume.longitude];
                const sweeps = [];
                const transfer = [];
                for (const el of wanted) {
                    if (!elevations.includes(el)) continue;
                    try {
                        radar.setElevation(el);
                        const h = radar.getHeader(0);
                        const built = processRadarData(radar, radarLocation0, h.radial_length, procLayer, options);
                        const idx = elevations.indexOf(radar.elevation);
                        const angle = idx >= 0 && Number.isFinite(elevationAngles[idx])
                            ? elevationAngles[idx] : h.elevation_angle;
                        sweeps.push({ elevationNumber: radar.elevation, elevationAngle: angle,
                                      meshData: built.meshData, bounds: built.bounds });
                        transfer.push(built.meshData.buffer);
                    } catch (e) {
                        // A cut without this moment (a Doppler-only split cut
                        // asked for reflectivity) costs that cut, not the volume.
                    }
                }
                meshEndMs = toEpochMs(performance.now());
                self.postMessage({
                    type: 'result',
                    sweeps,
                    metadata: {
                        timeIso: level2TimeIso(h0),
                        station: options?.station || null,
                        vcp: getLevel2Vcp(radar, h0),
                        availableElevations: elevations,
                        elevationAngles,
                        distinctCount
                    },
                    timing: { parserStartMs, parserEndMs, meshEndMs }
                }, transfer);
                return;
            }

            const usable = firstUsableHeader(radar, elevations);
            if (!usable) throw new Error('no usable sweep in this volume');
            const radarLocation = [usable.volume.latitude, usable.volume.longitude];
            if (options?.elevation && elevations.includes(options.elevation)) {
                radar.setElevation(options.elevation);
            } else if (!elevations.includes(radar.elevation)) {
                radar.setElevation(elevations[0] || 1);
            }
            const header = radar.getHeader(0) || usable;
            const extent = header.radial_length || usable.radial_length;

            const { meshData, bounds, geojson } = processRadarData(radar, radarLocation, extent, procLayer, options);
            meshEndMs = toEpochMs(performance.now());
            const ownIdx = elevations.indexOf(radar.elevation);
            const metadata = {
                timeIso: level2TimeIso(header),
                // The mean over the sweep where it is known, the first radial's
                // angle where it is not - see meanElevationAngle.
                elevationAngle: ownIdx >= 0 && Number.isFinite(elevationAngles[ownIdx])
                    ? elevationAngles[ownIdx] : header.elevation_angle,
                station: options?.station || null,
                vcp: getLevel2Vcp(radar, header),
                // GWCFC: the page builds its tilt picker from what this volume
                // actually carries, so the list rides back with the result.
                availableElevations: elevations,
                elevationAngles,
                elevationNumber: radar.elevation,
                // Which moments this volume carries, so the menu can offer
                // only the products this radar makes.
                moments: [...seenMoments]
            };

            self.postMessage({
                type: 'result',
                geojson,
                meshData,
                bounds,
                metadata,
                timing: {
                    parserStartMs,
                    parserEndMs,
                    meshEndMs
                }
            }, [meshData.buffer]);
        }
    } catch (error) {
        self.postMessage({ type: 'error', message: error?.message || String(error) });
    }
};