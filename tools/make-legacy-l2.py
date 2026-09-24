#!/usr/bin/env python3
"""
A synthetic 1995-style NEXRAD Level 2 volume, for tools/test-legacy-l2.mjs.

    python3 tools/make-legacy-l2.py OUT.Z

The legacy format the archive holds from 1991 to 2008: a 24 byte ARCHIVE2
header, then fixed 2432 byte records, each a 12 byte CTM header, a 16 byte
message header (type 1) and the 100 byte digital radar data header, then 460
reflectivity gates (1 km) and 920 velocity gates (250 m). Two tilts of 360
radials, reflectivity 40 dBZ in a ring 50 to 60 km out and nothing elsewhere,
velocity +10 m/s everywhere. Compressed with Unix compress (.Z) the way the
archive stores these years. Needs the ncompress module (pip install ncompress).
"""
import struct
import sys

import ncompress

JULIAN = 9286 + 1          # 1995-06-05, counted with 1970-01-01 as day 1
MS = 22 * 3600 * 1000      # 22:00 UTC


def record(az, el_num, el_deg, radial_status):
    body = struct.pack('>IHHHHHHH', MS, JULIAN, 1150, int(round(az / 0.043945 * 8)) & 0xffff,
                       int(az) + 1, radial_status, int(round(el_deg / 0.043945 * 8)), el_num)
    body += struct.pack('>hhhhHHH', 0, 0, 1000, 250, 460, 920, 1)
    body += struct.pack('>f', -33.0)
    body += struct.pack('>HHHHH', 100, 100 + 460, 0, 2, 21)
    body += b'\0' * 8 + struct.pack('>HHH', 0, 0, 0)
    body += struct.pack('>HHHH', 2650, 0, 0, 0) + b'\0' * 32
    assert len(body) == 100, len(body)
    refl = bytearray(460)
    for g in range(460):
        refl[g] = int((40 + 33) * 2) if 50 <= g < 60 else 0
    vel = bytes([127 + 20] * 920)                 # (bin-127)*0.5 = +10 m/s
    msg = struct.pack('>HBBHHIHH', 1208, 0, 1, 0, JULIAN, MS, 1, 1) + body + bytes(refl) + vel
    rec = b'\0' * 12 + msg
    return rec + b'\0' * (2432 - len(rec))


def main(out):
    head = b'ARCHIVE2.001' + struct.pack('>II', JULIAN, MS) + b'KTLX'
    assert len(head) == 24
    parts = [head]
    for el_num, el_deg in ((1, 0.5), (2, 1.5)):
        for i in range(360):
            status = 3 if i == 0 and el_num == 1 else (0 if i == 0 else (2 if i == 359 else 1))
            parts.append(record(i + 0.5, el_num, el_deg, status))
    raw = b''.join(parts)
    open(out, 'wb').write(ncompress.compress(raw))
    open(out + '.raw', 'wb').write(raw)


if __name__ == '__main__':
    main(sys.argv[1])
