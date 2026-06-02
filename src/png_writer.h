#pragma once
// ============================================================================
//  Tiny, dependency-free PNG writer (8-bit RGB).
//  Uses uncompressed DEFLATE ("stored" blocks) so it needs no zlib.
//  Produces valid, viewable PNG files (larger than compressed ones).
// ============================================================================
#include <cstdint>
#include <cstdio>
#include <vector>
#include <string>

namespace png {

inline uint32_t crc32_byte(uint32_t crc, uint8_t b) {
    crc ^= b;
    for (int k = 0; k < 8; ++k)
        crc = (crc >> 1) ^ (0xEDB88320u & (~(crc & 1) + 1));
    return crc;
}

inline uint32_t crc32_buf(const uint8_t* data, size_t n, uint32_t crc = 0xFFFFFFFFu) {
    for (size_t i = 0; i < n; ++i) crc = crc32_byte(crc, data[i]);
    return crc;
}

inline void put_u32(std::vector<uint8_t>& v, uint32_t x) {
    v.push_back((x >> 24) & 0xFF);
    v.push_back((x >> 16) & 0xFF);
    v.push_back((x >> 8) & 0xFF);
    v.push_back(x & 0xFF);
}

inline void write_chunk(std::vector<uint8_t>& out, const char* type,
                        const std::vector<uint8_t>& data) {
    put_u32(out, (uint32_t)data.size());
    size_t crc_start = out.size();
    out.push_back(type[0]); out.push_back(type[1]);
    out.push_back(type[2]); out.push_back(type[3]);
    out.insert(out.end(), data.begin(), data.end());
    uint32_t crc = crc32_buf(out.data() + crc_start, out.size() - crc_start);
    put_u32(out, crc ^ 0xFFFFFFFFu);
}

// rgb: width*height*3 bytes, row-major, top-to-bottom.
inline bool write(const std::string& path, int w, int h, const std::vector<uint8_t>& rgb) {
    if ((int)rgb.size() != w * h * 3) return false;

    // Build raw scanline data with filter byte 0 per row.
    std::vector<uint8_t> raw;
    raw.reserve((size_t)h * (w * 3 + 1));
    for (int y = 0; y < h; ++y) {
        raw.push_back(0); // filter type "None"
        const uint8_t* row = rgb.data() + (size_t)y * w * 3;
        raw.insert(raw.end(), row, row + w * 3);
    }

    // zlib stream: 2-byte header + stored DEFLATE blocks + Adler32.
    std::vector<uint8_t> zlib;
    zlib.push_back(0x78); // CMF
    zlib.push_back(0x01); // FLG (no compression, check bits)

    const size_t MAXBLK = 65535;
    size_t pos = 0, n = raw.size();
    while (pos < n) {
        size_t blk = (n - pos < MAXBLK) ? (n - pos) : MAXBLK;
        uint8_t bfinal = (pos + blk >= n) ? 1 : 0;
        zlib.push_back(bfinal);                 // BFINAL=bfinal, BTYPE=00 (stored)
        uint16_t len = (uint16_t)blk;
        uint16_t nlen = ~len;
        zlib.push_back(len & 0xFF);  zlib.push_back((len >> 8) & 0xFF);
        zlib.push_back(nlen & 0xFF); zlib.push_back((nlen >> 8) & 0xFF);
        zlib.insert(zlib.end(), raw.begin() + pos, raw.begin() + pos + blk);
        pos += blk;
    }

    // Adler32 of raw.
    uint32_t a = 1, b = 0;
    for (size_t i = 0; i < raw.size(); ++i) {
        a = (a + raw[i]) % 65521;
        b = (b + a) % 65521;
    }
    uint32_t adler = (b << 16) | a;
    put_u32(zlib, adler);

    // Assemble PNG.
    std::vector<uint8_t> out;
    const uint8_t sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
    out.insert(out.end(), sig, sig + 8);

    std::vector<uint8_t> ihdr;
    put_u32(ihdr, (uint32_t)w);
    put_u32(ihdr, (uint32_t)h);
    ihdr.push_back(8);  // bit depth
    ihdr.push_back(2);  // colour type 2 = truecolour RGB
    ihdr.push_back(0);  // compression
    ihdr.push_back(0);  // filter
    ihdr.push_back(0);  // interlace
    write_chunk(out, "IHDR", ihdr);
    write_chunk(out, "IDAT", zlib);
    write_chunk(out, "IEND", {});

    FILE* f = fopen(path.c_str(), "wb");
    if (!f) return false;
    fwrite(out.data(), 1, out.size(), f);
    fclose(f);
    return true;
}

} // namespace png
