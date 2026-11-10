#!/usr/bin/env python3
"""Read-only ext4 extractor (no mounting needed on macOS).
usage: ext4extract.py <disk.raw> ls <path> | cat <path> <out> | uuid
Finds the largest ext4 GPT partition. Supports extents, 64bit, htree dirs (linear scan)."""
import struct, sys, uuid as U

def gpt_root(f):
    f.seek(512); h = f.read(92)
    lba, n, sz = struct.unpack_from('<QII', h, 72)
    best = None
    for i in range(n):
        f.seek(lba * 512 + i * sz); e = f.read(128)
        if e[:16] == b'\0' * 16: continue
        first, last = struct.unpack_from('<QQ', e, 32)
        length = (last - first + 1) * 512
        f.seek(first * 512 + 1024); sb = f.read(1024)
        if struct.unpack_from('<H', sb, 56)[0] == 0xEF53 and (best is None or length > best[1]):
            best = (first * 512, length)
    return best

class Ext4:
    def __init__(s, f, off):
        s.f, s.off = f, off
        f.seek(off + 1024); sb = f.read(1024)
        s.bs = 1024 << struct.unpack_from('<I', sb, 24)[0]
        s.ipg = struct.unpack_from('<I', sb, 40)[0]
        s.isz = struct.unpack_from('<H', sb, 88)[0]
        incompat = struct.unpack_from('<I', sb, 96)[0]
        s.desc = struct.unpack_from('<H', sb, 254)[0] if incompat & 0x80 else 32
        s.uuid = str(U.UUID(bytes=sb[104:120]))
    def blk(s, n, cnt=1):
        s.f.seek(s.off + n * s.bs); return s.f.read(s.bs * cnt)
    def inode(s, ino):
        g, i = divmod(ino - 1, s.ipg)
        base = 2 if s.bs == 1024 else 1   # group descriptor table follows the superblock
        per = s.bs // s.desc
        d = s.blk(base + g // per)[(g % per) * s.desc:][:s.desc]
        itab = struct.unpack_from('<I', d, 8)[0]
        if s.desc >= 64: itab |= struct.unpack_from('<I', d, 0x28)[0] << 32
        s.f.seek(s.off + itab * s.bs + i * s.isz); return s.f.read(s.isz)
    def extents(s, node):
        hdr = struct.unpack_from('<HHHHI', node, 0)
        assert hdr[0] == 0xF30A, "not an extent node"
        out = []
        for k in range(hdr[1]):
            e = node[12 + k * 12:][:12]
            if hdr[3] == 0:
                lb, ln, hi, lo = struct.unpack('<IHHI', e)
                out.append((lb, ln if ln <= 32768 else ln - 32768, (hi << 32) | lo))
            else:
                _, lo, hi = struct.unpack('<IIH', e[:10])
                out += s.extents(s.blk((hi << 32) | lo))
        return out
    def read(s, ino):
        raw = s.inode(ino)
        mode, = struct.unpack_from('<H', raw, 0)
        size = struct.unpack_from('<I', raw, 4)[0] | (struct.unpack_from('<I', raw, 0x6C)[0] << 32)
        flags = struct.unpack_from('<I', raw, 0x20)[0]
        if mode & 0xF000 == 0xA000 and size < 60:  # fast symlink
            return raw[0x28:0x28 + size], mode
        assert flags & 0x80000, "inode without extents"
        data = bytearray(size)
        for lb, ln, pb in s.extents(raw[0x28:0x28 + 60]):
            chunk = s.blk(pb, ln); o = lb * s.bs
            data[o:o + len(chunk)] = chunk[:max(0, size - o)]
        return bytes(data), mode
    def listdir(s, ino):
        data, _ = s.read(ino); out = {}
        for b in range(0, len(data), s.bs):
            p = b
            while p < b + s.bs:
                i, rl, nl, ft = struct.unpack_from('<IHBB', data, p)
                if rl == 0: break
                if i: out[data[p + 8:p + 8 + nl].decode(errors='replace')] = i
                p += rl
        return out
    def lookup(s, path):
        ino = 2
        for part in [x for x in path.split('/') if x]:
            ino = s.listdir(ino)[part]
        return ino

if __name__ == '__main__':
    f = open(sys.argv[1], 'rb'); off, _ = gpt_root(f); fs = Ext4(f, off)
    cmd = sys.argv[2]
    if cmd == 'uuid': print(fs.uuid)
    elif cmd == 'ls': print('\n'.join(sorted(fs.listdir(fs.lookup(sys.argv[3])))))
    elif cmd == 'cat':
        d, _ = fs.read(fs.lookup(sys.argv[3])); open(sys.argv[4], 'wb').write(d); print(len(d), 'bytes')
