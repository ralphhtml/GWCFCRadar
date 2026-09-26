// GWCFC: how wide one radial is drawn, in degrees.
//
// `delta` is the gap to the next radial in the list, `ars` is the radial's
// own azimuth resolution spacing code (1: half a degree, 2: one degree), and
// `thinK` is how many radials thinning folded into this one.
//
// The gap to the next radial is only the width when the list holds one scan
// in order. When it holds two scans' radials mixed together (a terminal
// radar's long and short range passes at the same angle, or a repeated cut),
// the next one belongs to the other scan and sits half a beam over, so every
// beam was drawn half as wide as it is: solid close in where both scans have
// echo, striped further out where only one does. A radial repeated in the list
// is the other failure: the gap to its twin is nothing, which wrapped round to
// a beam 360 degrees wide. The declared width wins in both cases; an ordinary
// sweep, whose next radial is one width on, keeps its measured gap.
//
// A thinned sweep is left to its measured gap. Thinning only happens to radars
// that sample far finer than a NEXRAD (several on the MRRL feed), and those
// fill the spacing code in loosely: Cancun says half a degree and sends a
// radial every quarter of one.
export const rayWidth = (delta, ars, thinK = 1) => {
    const declared = ars === 1 ? 0.5 : ars === 2 ? 1 : null;
    if (declared && !(thinK > 1)) {
        if (!(delta > 0.7 * declared) || delta > Math.max(5, 4 * declared)) return declared;
    }
    return Number.isFinite(delta) && delta > 0 ? delta : 1;
};
