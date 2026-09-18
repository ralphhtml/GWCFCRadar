import { RandomAccessFile } from '../../randomaccessfile/index.js';

const code = 134;
const abbreviation = ['DVL'];
const description = 'High Resolution Digital VIL';

// The scale parameters arrive as the RPG's own 16 bit floats: one sign
// bit, five of exponent, ten of fraction, with the exponent biased so a
// zero exponent marks a subnormal. This is the same decode py-art and the
// other Level 3 readers use, confirmed against real volumes: the linear
// half of the scale covers the drizzle end and the exponential half the
// cores, meeting at the "log start" data level.
const codedFloat16 = (value) => {
	const sign = (value >> 15) & 0x01;
	const exponent = (value >> 10) & 0x1F;
	const fraction = value & 0x3FF;
	const magnitude = exponent === 0
		? fraction * 2 ** -24
		: 2 ** (exponent - 25) * (1024 + fraction);
	return sign ? -magnitude : magnitude;
};

// delta and time are compressed into one field
const deltaTime = (value) => ({
	deltaTime: (value & 0xFFE0) >> 5,
	nonSupplementalScan: (value & 0x001F) === 0,
	sailsScan: (value & 0x001F) === 1,
	mrleScan: (value & 0x001F) === 2,
});

// eslint-disable-next-line camelcase
const halfwords30_53 = (data) => {
	// turn data into a random access file for bytewise parsing purposes
	const raf = new RandomAccessFile(data);
	const dependent30 = raf.readShort();
	const linearScale = codedFloat16(raf.readUShort());
	const linearOffset = codedFloat16(raf.readUShort());
	const logStart = raf.readShort();
	const logScale = codedFloat16(raf.readUShort());
	const logOffset = codedFloat16(raf.readUShort());

	const decodeVil = (packed) => {
		if (!Number.isFinite(packed)) return null;
		if (packed === 0) return null;   // below threshold
		if (packed === 1) return null;   // flagged
		if (packed < logStart || logScale === 0) {
			const lin = linearScale === 0 ? null : (packed - linearOffset) / linearScale;
			return lin === null ? null : (lin < 0 ? 0 : lin);
		}
		return Math.exp((packed - logOffset) / logScale);
	};

	return {
		elevationAngle: 0,               // VIL is a whole column, not a tilt
		plot: {
			minimumDataValue: 0,
			dataIncrement: 1,
			dataLevels: 255,
			decodeDataLevel: decodeVil,
			linearScale,
			linearOffset,
			logStart,
			logScale,
			logOffset,
		},
		dependent30,
		dependent36_46: raf.read(22),
		maxDigitalVil: raf.readShort(),
		artifactEditedRadials: raf.readShort(),
		dependent49: raf.read(2),
		...deltaTime(raf.readShort()),
		compressionMethod: raf.readShort(),
		uncompressedProductSize: (raf.readUShort() << 16) + raf.readUShort(),
	};
};

const product = {
	code,
	abbreviation,
	description,
	productDescription: {
		halfwords30_53,
	},
};

if (typeof module !== 'undefined') {
	module.exports = product;
}

export default product;
export { code, abbreviation, description, halfwords30_53 };
