import { crc32, deflateSync, inflateSync } from "node:zlib";

// 8-bit RGB, row-major
export interface Image {
  w: number;
  h: number;
  data: Uint8Array;
}

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng({ w, h, data }: Image): Buffer {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

// Supports 8-bit gray/gray+alpha/RGB/RGBA, non-interlaced. Alpha is composited over white.
export function decodePng(buf: Buffer): Image {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat: Buffer[] = [];
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p);
    const t = buf.toString("latin1", p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (t === "IHDR") {
      w = d.readUInt32BE(0);
      h = d.readUInt32BE(4);
      depth = d[8];
      type = d[9];
      interlace = d[12];
    } else if (t === "IDAT") idat.push(d);
    else if (t === "IEND") break;
    p += 12 + len;
  }
  const ch = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (depth !== 8 || !ch || interlace) throw new Error("unsupported PNG (need 8-bit gray/RGB/RGBA, non-interlaced)");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[row + x - ch] : 0;
      const b = y > 0 ? px[prev + x] : 0;
      const c = x >= ch && y > 0 ? px[prev + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[row + x] = v;
    }
  }

  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const s = i * ch;
    const [r, g, b] = ch < 3 ? [px[s], px[s], px[s]] : [px[s], px[s + 1], px[s + 2]];
    const al = ch === 2 || ch === 4 ? px[s + ch - 1] / 255 : 1;
    data[i * 3] = r * al + 255 * (1 - al);
    data[i * 3 + 1] = g * al + 255 * (1 - al);
    data[i * 3 + 2] = b * al + 255 * (1 - al);
  }
  return { w, h, data };
}

// Box-filter downscale to fit within maxW x maxH (never upscales).
export function fit(img: Image, maxW: number, maxH: number): Image {
  const s = Math.max(img.w / maxW, img.h / maxH);
  if (s <= 1) return img;
  const w = Math.max(1, Math.floor(img.w / s)), h = Math.max(1, Math.floor(img.h / s));
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * s), y1 = Math.max(y0 + 1, Math.floor((y + 1) * s));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * s), x1 = Math.max(x0 + 1, Math.floor((x + 1) * s));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * img.w + sx) * 3;
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          n++;
        }
      const o = (y * w + x) * 3;
      data[o] = r / n;
      data[o + 1] = g / n;
      data[o + 2] = b / n;
    }
  }
  return { w, h, data };
}
