// Unix `compress` (.Z, LZW) decompression, for the NEXRAD Level 2 archive's
// 1991 to 2008 volumes, which are stored in that format.
//
// A faithful port of ncompress's decompress(): codes are read least
// significant bit first, start at 9 bits and widen to the stream's maximum,
// code 256 clears the table in block mode, and (the part every naive port
// gets wrong) each time the code width changes or the table is cleared the
// input skips to the end of the current group of eight codes, because the
// compressor wrote codes in groups of eight at one width.
//
// A truncated stream decodes as far as it goes: a capped read of a big volume
// still yields its whole low sweeps.
const INIT_BITS = 9;
const CLEAR = 256;
const FIRST = 257;

export default function lzwDecompress(src) {
	const data = src instanceof Uint8Array ? src : new Uint8Array(src);
	if (data.length < 3 || data[0] !== 0x1f || data[1] !== 0x9d) throw new Error('not a .Z (compress) stream');
	const maxbits = data[2] & 0x1f;
	const blockMode = (data[2] & 0x80) !== 0;
	if (maxbits < INIT_BITS || maxbits > 16) throw new Error(`.Z stream with ${maxbits} bit codes`);
	const maxmaxcode = 1 << maxbits;
	const prefix = new Uint16Array(maxmaxcode);
	const suffix = new Uint8Array(maxmaxcode);
	for (let i = 0; i < 256; i += 1) suffix[i] = i;
	const stack = new Uint8Array(maxmaxcode);

	let out = new Uint8Array(Math.max(1024, data.length * 4));
	let outLen = 0;
	const put = (b) => {
		if (outLen >= out.length) { const n = new Uint8Array(out.length * 2); n.set(out); out = n; }
		out[outLen] = b; outLen += 1;
	};

	const body = data.subarray(3);
	const inbits = body.length * 8;
	let nbits = INIT_BITS;
	let maxcode = (1 << nbits) - 1;
	let bitmask = (1 << nbits) - 1;
	let freeEnt = blockMode ? FIRST : 256;
	let oldcode = -1;
	let finchar = 0;
	let posbits = 0;
	// Skip to the end of the current group of eight codes at this width.
	// ncompress measures the groups from where its input buffer was last
	// reset, which is exactly the last realignment, so `base` tracks that.
	let base = 0;
	const align = () => {
		const g = nbits << 3;
		const rel = posbits - base;
		posbits = base + (rel - 1) + (g - ((rel - 1 + g) % g));
		base = posbits;
	};

	while (posbits + nbits <= inbits) {
		if (freeEnt > maxcode) {
			align();
			nbits += 1;
			maxcode = nbits === maxbits ? maxmaxcode : (1 << nbits) - 1;
			bitmask = (1 << nbits) - 1;
			continue;
		}
		const p = posbits >> 3;
		let code = (body[p] | ((body[p + 1] || 0) << 8) | ((body[p + 2] || 0) << 16)) >> (posbits & 7);
		code &= bitmask;
		posbits += nbits;

		if (oldcode === -1) {
			if (code >= 256) throw new Error('corrupt .Z stream (first code)');
			finchar = code; oldcode = code;
			put(code);
			continue;
		}
		if (code === CLEAR && blockMode) {
			prefix.fill(0);
			freeEnt = FIRST - 1;
			align();
			nbits = INIT_BITS;
			maxcode = (1 << nbits) - 1;
			bitmask = (1 << nbits) - 1;
			continue;
		}
		const incode = code;
		let sp = maxmaxcode;
		if (code >= freeEnt) {
			if (code > freeEnt) break;             // corrupt or cut mid-code: keep what we have
			sp -= 1; stack[sp] = finchar;
			code = oldcode;
		}
		while (code >= 256) {
			sp -= 1; stack[sp] = suffix[code];
			code = prefix[code];
		}
		finchar = suffix[code];
		sp -= 1; stack[sp] = finchar;
		for (let i = sp; i < maxmaxcode; i += 1) put(stack[i]);
		if (freeEnt < maxmaxcode) {
			prefix[freeEnt] = oldcode;
			suffix[freeEnt] = finchar;
			freeEnt += 1;
		}
		oldcode = incode;
	}
	return out.subarray(0, outLen);
}
