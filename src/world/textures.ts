import * as THREE from 'three';
import { createRng } from './layout';
import type { FoliageClusterTextureSet, PBRTextureMaps } from './types';

// ============================================================================
// TEXTURE CACHE & ANISOTROPY MANAGEMENT
// ============================================================================

const textureCache = new Map<string, THREE.CanvasTexture>();
const bundleCache = new Map<string, PBRTextureMaps>();
let foliageCache: FoliageClusterTextureSet | null = null;
let globalAnisotropy = 4;

/**
 * Call once after creating WebGLRenderer (e.g. renderer.capabilities.getMaxAnisotropy())
 * to upgrade all cached and future procedural textures to crisp anisotropic filtering.
 */
export function setTextureAnisotropy(maxAnisotropy: number): void {
  globalAnisotropy = Math.max(1, Math.min(16, Math.floor(maxAnisotropy)));
  for (const tex of textureCache.values()) {
    tex.anisotropy = globalAnisotropy;
    tex.needsUpdate = true;
  }
}

export function disposeAllTextures(): void {
  for (const tex of textureCache.values()) {
    tex.dispose();
  }
  textureCache.clear();
  bundleCache.clear();
  foliageCache = null;
}

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to acquire 2D canvas context for procedural texture.');
  }
  return [canvas, ctx];
}

function finalizeTexture(
  cacheKey: string,
  canvas: HTMLCanvasElement,
  options: {
    srgb: boolean;
    repeat?: boolean;
    repeatX?: number;
    repeatY?: number;
  }
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = options.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = options.repeat === false ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  tex.wrapT = options.repeat === false ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  if (options.repeatX !== undefined || options.repeatY !== undefined) {
    tex.repeat.set(options.repeatX ?? 1, options.repeatY ?? 1);
  }
  tex.anisotropy = globalAnisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  textureCache.set(cacheKey, tex);
  return tex;
}

// ============================================================================
// SEAMLESS TILEABLE PROCEDURAL NOISE HELPERS
// ============================================================================

function hash2D(ix: number, iy: number, period: number, seed: number): number {
  const x = ((ix % period) + period) % period;
  const y = ((iy % period) + period) % period;
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function tileableValueNoise(u: number, v: number, period: number, seed: number): number {
  const fx = u * period;
  const fy = v * period;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);

  const n00 = hash2D(ix, iy, period, seed);
  const n10 = hash2D(ix + 1, iy, period, seed);
  const n01 = hash2D(ix, iy + 1, period, seed);
  const n11 = hash2D(ix + 1, iy + 1, period, seed);

  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

function tileableFbm(
  u: number,
  v: number,
  basePeriod: number,
  octaves: number,
  seed: number
): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileableValueNoise(u, v, period, seed + o * 97);
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return sum / norm;
}

function parseHexRGB(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const num = parseInt(clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function clampByte(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
}

/** Draw callback wrapped across 3x3 offsets so shapes crossing canvas edges tile seamlessly. */
function drawWrapped(
  size: number,
  drawFn: (ox: number, oy: number) => void
): void {
  for (let ox = -size; ox <= size; ox += size) {
    for (let oy = -size; oy <= size; oy += size) {
      drawFn(ox, oy);
    }
  }
}

// ============================================================================
// 1. MUSHROOM GRANITE ("蘑菇石" — Qingdao Laoshan Granite Masonry)
// ============================================================================

export function getMushroomGraniteTextures(): PBRTextureMaps {
  const key = 'mushroomGranite';
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);
  const [roughC, rCtx] = makeCanvas(size, size);
  const rng = createRng(190301);

  // Recessed dark mortar base
  aCtx.fillStyle = '#4e4c48';
  aCtx.fillRect(0, 0, size, size);
  bCtx.fillStyle = '#181818';
  bCtx.fillRect(0, 0, size, size);
  rCtx.fillStyle = '#f2f2f2';
  rCtx.fillRect(0, 0, size, size);

  const rows = 8;
  const cols = 4;
  const rowH = size / rows;
  const colW = size / cols;
  const mortar = 5;

  const granitePalettes: [number, number, number][] = [
    [164, 152, 144], // Warm pink-grey Laoshan granite
    [152, 150, 145], // Silver-grey granite
    [172, 156, 138], // Warm ochre-buff granite
    [138, 140, 142], // Cool slate granite
    [168, 148, 140]  // Rose-quartz granite
  ];

  for (let r = 0; r < rows; r++) {
    const stagger = (r % 2) * (colW * 0.5);
    for (let c = -1; c <= cols; c++) {
      const bx = c * colW + stagger + mortar * 0.5;
      const by = r * rowH + mortar * 0.5;
      const bw = colW - mortar;
      const bh = rowH - mortar;

      const pal = granitePalettes[Math.floor(rng() * granitePalettes.length)];
      const shadeShift = (rng() - 0.5) * 18;
      const cr = clampByte(pal[0] + shadeShift);
      const cg = clampByte(pal[1] + shadeShift);
      const cb = clampByte(pal[2] + shadeShift);

      // Chiseled flat stone margin
      aCtx.fillStyle = `rgb(${clampByte(cr - 14)},${clampByte(cg - 14)},${clampByte(cb - 14)})`;
      aCtx.fillRect(bx, by, bw, bh);

      bCtx.fillStyle = '#707070';
      bCtx.fillRect(bx, by, bw, bh);

      const roughVal = clampByte(185 + (rng() - 0.5) * 28);
      rCtx.fillStyle = `rgb(${roughVal},${roughVal},${roughVal})`;
      rCtx.fillRect(bx, by, bw, bh);

      // Iconic protruding "mushroom pillow" center (蘑菇石凸面)
      const insetX = 8 + rng() * 3;
      const insetY = 7 + rng() * 3;
      const px = bx + insetX;
      const py = by + insetY;
      const pw = bw - insetX * 2;
      const ph = bh - insetY * 2;

      // Cast underside shadow of protruding pillow
      aCtx.fillStyle = 'rgba(28, 25, 22, 0.34)';
      aCtx.beginPath();
      aCtx.roundRect(px + 2, py + 4, pw, ph, 10);
      aCtx.fill();

      // Convex lit granite face
      const aGrad = aCtx.createLinearGradient(px, py, px + pw * 0.25, py + ph);
      aGrad.addColorStop(0, `rgb(${clampByte(cr + 24)},${clampByte(cg + 22)},${clampByte(cb + 20)})`);
      aGrad.addColorStop(0.55, `rgb(${cr},${cg},${cb})`);
      aGrad.addColorStop(1, `rgb(${clampByte(cr - 28)},${clampByte(cg - 28)},${clampByte(cb - 26)})`);
      aCtx.fillStyle = aGrad;
      aCtx.beginPath();
      aCtx.roundRect(px, py, pw, ph, 9);
      aCtx.fill();

      // Convex dome in bump map
      const bGrad = bCtx.createRadialGradient(
        px + pw * 0.48,
        py + ph * 0.46,
        3,
        px + pw * 0.5,
        py + ph * 0.5,
        Math.max(pw, ph) * 0.65
      );
      bGrad.addColorStop(0, '#f4f4f4');
      bGrad.addColorStop(0.7, '#c2c2c2');
      bGrad.addColorStop(1, '#686868');
      bCtx.fillStyle = bGrad;
      bCtx.beginPath();
      bCtx.roundRect(px, py, pw, ph, 9);
      bCtx.fill();

      // Fine granite crystal speckles (quartz, pink feldspar, black mica)
      const speckles = 90;
      for (let s = 0; s < speckles; s++) {
        const sx = bx + rng() * bw;
        const sy = by + rng() * bh;
        const sr = 0.8 + rng() * 1.5;
        const kind = rng();
        if (kind < 0.36) {
          aCtx.fillStyle = 'rgba(42, 40, 44, 0.36)'; // Biotite mica
        } else if (kind < 0.72) {
          aCtx.fillStyle = 'rgba(242, 236, 228, 0.34)'; // Quartz grain
        } else {
          aCtx.fillStyle = 'rgba(205, 162, 148, 0.32)'; // Laoshan pink feldspar
        }
        aCtx.fillRect(sx, sy, sr, sr);

        const bSpeck = kind < 0.5 ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.18)';
        bCtx.fillStyle = bSpeck;
        bCtx.fillRect(sx, sy, sr, sr);
      }
    }
  }

  const bundle: PBRTextureMaps = {
    map: finalizeTexture(`${key}_map`, albedoC, { srgb: true }),
    bumpMap: finalizeTexture(`${key}_bump`, bumpC, { srgb: false }),
    roughnessMap: finalizeTexture(`${key}_rough`, roughC, { srgb: false })
  };
  bundleCache.set(key, bundle);
  return bundle;
}

// ============================================================================
// 2. HUASHI VILLA PEBBLE & GRANITE MOSAIC MASONRY (花石樓卵石花崗岩牆)
// ============================================================================

export function getHuashiPebbleStoneTextures(): PBRTextureMaps {
  const key = 'huashiPebbleStone';
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);
  const [roughC, rCtx] = makeCanvas(size, size);
  const rng = createRng(193018);

  // Warm weathered lime mortar bed
  aCtx.fillStyle = '#9b9180';
  aCtx.fillRect(0, 0, size, size);
  bCtx.fillStyle = '#303030';
  bCtx.fillRect(0, 0, size, size);
  rCtx.fillStyle = '#ececec';
  rCtx.fillRect(0, 0, size, size);

  // Subtle sandy grain on mortar
  for (let i = 0; i < 3200; i++) {
    const x = rng() * size;
    const y = rng() * size;
    aCtx.fillStyle = rng() > 0.5 ? 'rgba(255,248,234,0.14)' : 'rgba(65,58,48,0.16)';
    aCtx.fillRect(x, y, 2, 2);
  }

  const stoneColors: [number, number, number][] = [
    [142, 134, 124], // Warm grey granite
    [164, 146, 126], // Ochre sandstone
    [118, 114, 110], // Coastal slate
    [156, 122, 104], // Russet pebble
    [186, 174, 154], // Pale sea quartz
    [94, 96, 102],   // Dark reef basalt
    [148, 138, 116]  // Olive-buff stone
  ];

  // Layered irregular fieldstones & rounded coastal pebbles
  const totalStones = 240;
  for (let i = 0; i < totalStones; i++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const isFieldstone = i < 72;
    const rx = isFieldstone ? 22 + rng() * 26 : 8 + rng() * 14;
    const ry = isFieldstone ? 14 + rng() * 15 : 6 + rng() * 11;
    const angle = isFieldstone ? (rng() - 0.5) * 0.28 : rng() * Math.PI;

    const pal = stoneColors[Math.floor(rng() * stoneColors.length)];
    const jitter = (rng() - 0.5) * 24;
    const r = clampByte(pal[0] + jitter);
    const g = clampByte(pal[1] + jitter);
    const b = clampByte(pal[2] + jitter);

    const drawOneStone = (ox: number, oy: number) => {
      const x = cx + ox;
      const y = cy + oy;
      if (x < -rx * 2 || x > size + rx * 2 || y < -ry * 2 || y > size + ry * 2) return;

      // Albedo stone with shadow halo + rounded top-left lighting
      aCtx.save();
      aCtx.translate(x, y);
      aCtx.rotate(angle);

      aCtx.fillStyle = 'rgba(42, 36, 30, 0.35)';
      aCtx.beginPath();
      if (isFieldstone) {
        aCtx.roundRect(-rx + 2, -ry + 3, rx * 2, ry * 2, 7);
      } else {
        aCtx.ellipse(1.5, 2.5, rx, ry, 0, 0, Math.PI * 2);
      }
      aCtx.fill();

      const grad = aCtx.createRadialGradient(-rx * 0.25, -ry * 0.25, 1, 0, 0, Math.max(rx, ry) * 1.15);
      grad.addColorStop(0, `rgb(${clampByte(r + 28)},${clampByte(g + 26)},${clampByte(b + 24)})`);
      grad.addColorStop(0.65, `rgb(${r},${g},${b})`);
      grad.addColorStop(1, `rgb(${clampByte(r - 30)},${clampByte(g - 30)},${clampByte(b - 28)})`);
      aCtx.fillStyle = grad;
      aCtx.beginPath();
      if (isFieldstone) {
        aCtx.roundRect(-rx, -ry, rx * 2, ry * 2, 6);
      } else {
        aCtx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      }
      aCtx.fill();
      aCtx.restore();

      // Bump dome
      bCtx.save();
      bCtx.translate(x, y);
      bCtx.rotate(angle);
      const bGrad = bCtx.createRadialGradient(0, 0, 1, 0, 0, Math.max(rx, ry));
      bGrad.addColorStop(0, isFieldstone ? '#dcdcdc' : '#f2f2f2');
      bGrad.addColorStop(0.75, '#a8a8a8');
      bGrad.addColorStop(1, '#444444');
      bCtx.fillStyle = bGrad;
      bCtx.beginPath();
      if (isFieldstone) {
        bCtx.roundRect(-rx, -ry, rx * 2, ry * 2, 6);
      } else {
        bCtx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      }
      bCtx.fill();
      bCtx.restore();

      // Smooth sea-pebbles have lower roughness than mortar
      rCtx.save();
      rCtx.translate(x, y);
      rCtx.rotate(angle);
      const rv = isFieldstone ? 196 : 148;
      rCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
      rCtx.beginPath();
      if (isFieldstone) {
        rCtx.roundRect(-rx, -ry, rx * 2, ry * 2, 6);
      } else {
        rCtx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      }
      rCtx.fill();
      rCtx.restore();
    };

    drawWrapped(size, drawOneStone);
  }

  const bundle: PBRTextureMaps = {
    map: finalizeTexture(`${key}_map`, albedoC, { srgb: true }),
    bumpMap: finalizeTexture(`${key}_bump`, bumpC, { srgb: false }),
    roughnessMap: finalizeTexture(`${key}_rough`, roughC, { srgb: false })
  };
  bundleCache.set(key, bundle);
  return bundle;
}

// ============================================================================
// 3. CLASSIC QINGDAO RED CLAY BARREL ROOF TILES ("紅瓦")
// ============================================================================

export function getRedRoofTilesTextures(): PBRTextureMaps {
  const key = 'redRoofTiles';
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);
  const [roughC, rCtx] = makeCanvas(size, size);
  const rng = createRng(191208);

  aCtx.fillStyle = '#732e1f';
  aCtx.fillRect(0, 0, size, size);
  bCtx.fillStyle = '#383838';
  bCtx.fillRect(0, 0, size, size);
  rCtx.fillStyle = '#c8c8c8';
  rCtx.fillRect(0, 0, size, size);

  const cols = 12;
  const rows = 8;
  const tileW = size / cols;
  const tileH = size / rows;

  const clayTones: [number, number, number][] = [
    [186, 76, 52],  // Iconic Qingdao terracotta red
    [198, 88, 58],  // Sunlit burnt sienna
    [168, 66, 46],  // Deep kiln clay
    [204, 102, 66], // Warm ochre terracotta
    [176, 74, 54],  // Weathered heritage brick-red
    [152, 62, 46]   // Aged shadowed tile
  ];

  for (let row = 0; row < rows; row++) {
    const y = row * tileH;
    for (let col = 0; col < cols; col++) {
      const x = col * tileW;
      const base = clayTones[Math.floor(rng() * clayTones.length)];
      const shift = (rng() - 0.5) * 18;
      const r = clampByte(base[0] + shift);
      const g = clampByte(base[1] + shift * 0.7);
      const b = clampByte(base[2] + shift * 0.55);

      // Barrel half-cylinder horizontal shading across tile width
      const hGrad = aCtx.createLinearGradient(x, y, x + tileW, y);
      hGrad.addColorStop(0.0, `rgb(${clampByte(r - 48)},${clampByte(g - 30)},${clampByte(b - 22)})`);
      hGrad.addColorStop(0.24, `rgb(${clampByte(r + 18)},${clampByte(g + 12)},${clampByte(b + 8)})`);
      hGrad.addColorStop(0.52, `rgb(${clampByte(r + 28)},${clampByte(g + 18)},${clampByte(b + 12)})`);
      hGrad.addColorStop(0.84, `rgb(${clampByte(r - 12)},${clampByte(g - 8)},${clampByte(b - 6)})`);
      hGrad.addColorStop(1.0, `rgb(${clampByte(r - 58)},${clampByte(g - 34)},${clampByte(b - 24)})`);
      aCtx.fillStyle = hGrad;
      aCtx.fillRect(x, y, tileW + 0.5, tileH + 0.5);

      // Subtle vertical weathering gradient (darker near overlap seam)
      const vGrad = aCtx.createLinearGradient(x, y, x, y + tileH);
      vGrad.addColorStop(0, 'rgba(26, 12, 8, 0.34)');
      vGrad.addColorStop(0.18, 'rgba(26, 12, 8, 0.04)');
      vGrad.addColorStop(0.86, 'rgba(255, 224, 198, 0.08)');
      vGrad.addColorStop(1, 'rgba(18, 8, 6, 0.42)');
      aCtx.fillStyle = vGrad;
      aCtx.fillRect(x, y, tileW, tileH);

      // Subtle coastal olive-grey lichen/moss patina in occasional tile valleys
      if (rng() < 0.32) {
        aCtx.fillStyle = `rgba(92, 102, 72, ${0.14 + rng() * 0.16})`;
        aCtx.beginPath();
        aCtx.ellipse(
          x + (rng() < 0.5 ? 4 : tileW - 4),
          y + tileH * (0.25 + rng() * 0.5),
          4 + rng() * 5,
          8 + rng() * 12,
          0,
          0,
          Math.PI * 2
        );
        aCtx.fill();
      }

      // Bump: cylindrical barrel height profile + overlap ridge
      const bhGrad = bCtx.createLinearGradient(x, y, x + tileW, y);
      bhGrad.addColorStop(0.0, '#2c2c2c');
      bhGrad.addColorStop(0.28, '#bcbcbc');
      bhGrad.addColorStop(0.5, '#f0f0f0');
      bhGrad.addColorStop(0.78, '#b4b4b4');
      bhGrad.addColorStop(1.0, '#242424');
      bCtx.fillStyle = bhGrad;
      bCtx.fillRect(x, y, tileW + 0.5, tileH + 0.5);

      // Horizontal lip step at bottom of tile
      bCtx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      bCtx.fillRect(x, y, tileW, 4);
      bCtx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      bCtx.fillRect(x, y + tileH - 4, tileW, 3);

      // Roughness variation per tile
      const rv = clampByte(184 + (rng() - 0.5) * 32);
      rCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
      rCtx.fillRect(x, y, tileW, tileH);
      rCtx.fillStyle = 'rgba(255, 255, 255, 0.18)';
      rCtx.fillRect(x, y, 4, tileH);
    }
  }

  const bundle: PBRTextureMaps = {
    map: finalizeTexture(`${key}_map`, albedoC, { srgb: true }),
    bumpMap: finalizeTexture(`${key}_bump`, bumpC, { srgb: false }),
    roughnessMap: finalizeTexture(`${key}_rough`, roughC, { srgb: false })
  };
  bundleCache.set(key, bundle);
  return bundle;
}

// ============================================================================
// 4. WEATHERED SLATE / COPPER-PATINA TURRET ROOF (花石樓圓塔尖頂瓦)
// ============================================================================

export function getSlateTurretRoofTextures(): PBRTextureMaps {
  const key = 'slateTurretRoof';
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);
  const rng = createRng(193204);

  aCtx.fillStyle = '#2d3742';
  aCtx.fillRect(0, 0, size, size);
  bCtx.fillStyle = '#343434';
  bCtx.fillRect(0, 0, size, size);

  const rows = 12;
  const cols = 12;
  const rowH = size / rows;
  const colW = size / cols;

  // Draw from top to bottom so lower scales overlap cleanly, wrapping seamlessly
  for (let r = -1; r <= rows; r++) {
    const stagger = ((r % 2) + 2) % 2 === 1 ? colW * 0.5 : 0;
    for (let c = -1; c <= cols; c++) {
      const cx = c * colW + stagger + colW * 0.5;
      const topY = r * rowH;

      // Blend deep slate blue-grey with subtle reddish-slate & copper patina
      const patina = rng();
      let cr = 68;
      let cg = 74;
      let cb = 84;
      if (patina < 0.28) {
        cr = 92;
        cg = 64;
        cb = 62; // Reddish-slate heritage tint
      } else if (patina > 0.82) {
        cr = 62;
        cg = 94;
        cb = 92; // Subtle coastal copper verdigris
      }
      const shift = (rng() - 0.5) * 18;
      cr = clampByte(cr + shift);
      cg = clampByte(cg + shift);
      cb = clampByte(cb + shift);

      const drawScalePath = (ctx: CanvasRenderingContext2D, ox = 0, oy = 0) => {
        const hw = colW * 0.52;
        ctx.beginPath();
        ctx.moveTo(cx - hw + ox, topY + oy);
        ctx.lineTo(cx + hw + ox, topY + oy);
        ctx.lineTo(cx + hw + ox, topY + rowH * 0.65 + oy);
        ctx.quadraticCurveTo(
          cx + ox,
          topY + rowH * 1.38 + oy,
          cx - hw + ox,
          topY + rowH * 0.65 + oy
        );
        ctx.closePath();
      };

      // Shadow under scale
      drawScalePath(aCtx, 0, 3);
      aCtx.fillStyle = 'rgba(12, 16, 22, 0.5)';
      aCtx.fill();

      // Slate scale gradient
      drawScalePath(aCtx);
      const grad = aCtx.createLinearGradient(cx, topY, cx, topY + rowH * 1.15);
      grad.addColorStop(0, `rgb(${clampByte(cr - 14)},${clampByte(cg - 14)},${clampByte(cb - 12)})`);
      grad.addColorStop(0.7, `rgb(${cr},${cg},${cb})`);
      grad.addColorStop(1, `rgb(${clampByte(cr + 18)},${clampByte(cg + 18)},${clampByte(cb + 20)})`);
      aCtx.fillStyle = grad;
      aCtx.fill();
      aCtx.strokeStyle = 'rgba(20, 26, 34, 0.45)';
      aCtx.lineWidth = 1.2;
      aCtx.stroke();

      // Bump scale
      drawScalePath(bCtx);
      const bGrad = bCtx.createLinearGradient(cx, topY, cx, topY + rowH * 1.15);
      bGrad.addColorStop(0, '#5a5a5a');
      bGrad.addColorStop(0.85, '#d4d4d4');
      bGrad.addColorStop(1, '#f0f0f0');
      bCtx.fillStyle = bGrad;
      bCtx.fill();
      bCtx.strokeStyle = '#202020';
      bCtx.lineWidth = 2;
      bCtx.stroke();
    }
  }

  const bundle: PBRTextureMaps = {
    map: finalizeTexture(`${key}_map`, albedoC, { srgb: true }),
    bumpMap: finalizeTexture(`${key}_bump`, bumpC, { srgb: false })
  };
  bundleCache.set(key, bundle);
  return bundle;
}

// ============================================================================
// 5. WARM EUROPEAN STUCCO PLASTER (歐式暖黃/米白拉毛牆面)
// ============================================================================

export function getWarmStuccoTextures(tintHex = '#eadbc2'): PBRTextureMaps {
  const key = `warmStucco_${tintHex.toLowerCase()}`;
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);
  const [baseR, baseG, baseB] = parseHexRGB(tintHex);

  const aImg = aCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);
  const aData = aImg.data;
  const bData = bImg.data;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const broad = tileableFbm(u, v, 4, 3, 41) - 0.5;
      const trowel = tileableFbm(u + broad * 0.08, v - broad * 0.06, 12, 3, 83) - 0.5;
      const sand = tileableValueNoise(u, v, 128, 137) - 0.5;

      const lum = broad * 22 + trowel * 14 + sand * 10;
      const idx = (y * size + x) * 4;
      aData[idx] = clampByte(baseR + lum);
      aData[idx + 1] = clampByte(baseG + lum * 0.94);
      aData[idx + 2] = clampByte(baseB + lum * 0.84);
      aData[idx + 3] = 255;

      const bh = clampByte(128 + trowel * 72 + sand * 54);
      bData[idx] = bh;
      bData[idx + 1] = bh;
      bData[idx + 2] = bh;
      bData[idx + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  const bundle: PBRTextureMaps = {
    map: finalizeTexture(`${key}_map`, albedoC, { srgb: true }),
    bumpMap: finalizeTexture(`${key}_bump`, bumpC, { srgb: false })
  };
  bundleCache.set(key, bundle);
  return bundle;
}

// ============================================================================
// 6. PRINCESS HOUSE NORDIC PALE BLUE-GREEN WALL (公主樓北歐藍綠粉牆)
// ============================================================================

export function getNordicBlueWallTextures(): PBRTextureMaps {
  const key = 'nordicBlueWall';
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);

  const aImg = aCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);
  const aData = aImg.data;
  const bData = bImg.data;

  // Serene Danish coastal blue-green stucco with fine brushed plaster grain
  const baseR = 142;
  const baseG = 179;
  const baseB = 184;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    // Subtle horizontal Nordic timber/plaster band rhythm
    const bandPhase = (y % 64) / 64;
    const bandShade = bandPhase < 0.06 ? -14 : (0.5 - bandPhase) * 6;

    for (let x = 0; x < size; x++) {
      const u = x / size;
      const cloud = tileableFbm(u, v, 5, 3, 211) - 0.5;
      const brush = tileableValueNoise(u * 0.4, v * 2.5, 48, 307) - 0.5;
      const grain = tileableValueNoise(u, v, 128, 419) - 0.5;

      const delta = cloud * 18 + brush * 8 + grain * 8 + bandShade;
      const idx = (y * size + x) * 4;
      aData[idx] = clampByte(baseR + delta * 0.9);
      aData[idx + 1] = clampByte(baseG + delta);
      aData[idx + 2] = clampByte(baseB + delta * 1.02);
      aData[idx + 3] = 255;

      const bh = clampByte(128 + bandShade * 3.5 + brush * 34 + grain * 38);
      bData[idx] = bh;
      bData[idx + 1] = bh;
      bData[idx + 2] = bh;
      bData[idx + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  const bundle: PBRTextureMaps = {
    map: finalizeTexture(`${key}_map`, albedoC, { srgb: true }),
    bumpMap: finalizeTexture(`${key}_bump`, bumpC, { srgb: false })
  };
  bundleCache.set(key, bundle);
  return bundle;
}

// ============================================================================
// 7. WEATHERED ASPHALT ROAD (八大關柏油林蔭路)
// ============================================================================

export function getAsphaltRoadTextures(): PBRTextureMaps {
  const key = 'asphaltRoad';
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);
  const [roughC, rCtx] = makeCanvas(size, size);

  const aImg = aCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);
  const rImg = rCtx.createImageData(size, size);
  const aData = aImg.data;
  const bData = bImg.data;
  const rData = rImg.data;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const patch = tileableFbm(u, v, 4, 3, 503) - 0.5;
      const grit = tileableValueNoise(u, v, 128, 601) - 0.5;
      const micro = tileableValueNoise(u, v, 256, 709) - 0.5;

      // Subtle wheel-track sheen along road length
      const track = Math.sin(u * Math.PI * 4) * 0.5 + 0.5;
      const base = 70 + patch * 18 + grit * 20 + micro * 16 + track * 4;

      const idx = (y * size + x) * 4;
      aData[idx] = clampByte(base + 2);
      aData[idx + 1] = clampByte(base + 1);
      aData[idx + 2] = clampByte(base + 4);
      aData[idx + 3] = 255;

      const bh = clampByte(128 + grit * 90 + micro * 70);
      bData[idx] = bh;
      bData[idx + 1] = bh;
      bData[idx + 2] = bh;
      bData[idx + 3] = 255;

      const rv = clampByte(206 - track * 18 + patch * 24 + grit * 18);
      rData[idx] = rv;
      rData[idx + 1] = rv;
      rData[idx + 2] = rv;
      rData[idx + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);
  rCtx.putImageData(rImg, 0, 0);

  const bundle: PBRTextureMaps = {
    map: finalizeTexture(`${key}_map`, albedoC, { srgb: true }),
    bumpMap: finalizeTexture(`${key}_bump`, bumpC, { srgb: false }),
    roughnessMap: finalizeTexture(`${key}_rough`, roughC, { srgb: false })
  };
  bundleCache.set(key, bundle);
  return bundle;
}

// ============================================================================
// 8. GRANITE COBBLE PAVERS (青島花崗岩方磚 / 石堤條石)
// ============================================================================

export function getGraniteCobbleTextures(): PBRTextureMaps {
  const key = 'graniteCobble';
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);
  const [roughC, rCtx] = makeCanvas(size, size);
  const rng = createRng(88421);

  // Sandy recessed joints
  aCtx.fillStyle = '#686258';
  aCtx.fillRect(0, 0, size, size);
  bCtx.fillStyle = '#202020';
  bCtx.fillRect(0, 0, size, size);
  rCtx.fillStyle = '#f0f0f0';
  rCtx.fillRect(0, 0, size, size);

  const rows = 10;
  const cols = 6;
  const rowH = size / rows;
  const colW = size / cols;
  const gap = 4;

  const tones: [number, number, number][] = [
    [164, 158, 150],
    [152, 148, 144],
    [172, 160, 148],
    [144, 144, 146],
    [168, 155, 146]
  ];

  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * (colW * 0.5);
    for (let c = -1; c <= cols; c++) {
      const x = c * colW + offset + gap * 0.5;
      const y = r * rowH + gap * 0.5;
      const w = colW - gap;
      const h = rowH - gap;

      const base = tones[Math.floor(rng() * tones.length)];
      const delta = (rng() - 0.5) * 20;
      const cr = clampByte(base[0] + delta);
      const cg = clampByte(base[1] + delta);
      const cb = clampByte(base[2] + delta);

      const grad = aCtx.createLinearGradient(x, y, x, y + h);
      grad.addColorStop(0, `rgb(${clampByte(cr + 12)},${clampByte(cg + 12)},${clampByte(cb + 10)})`);
      grad.addColorStop(0.5, `rgb(${cr},${cg},${cb})`);
      grad.addColorStop(1, `rgb(${clampByte(cr - 14)},${clampByte(cg - 14)},${clampByte(cb - 12)})`);
      aCtx.fillStyle = grad;
      aCtx.beginPath();
      aCtx.roundRect(x, y, w, h, 4);
      aCtx.fill();

      // Bump bevel
      bCtx.fillStyle = '#c8c8c8';
      bCtx.beginPath();
      bCtx.roundRect(x, y, w, h, 4);
      bCtx.fill();
      bCtx.fillStyle = '#e2e2e2';
      bCtx.beginPath();
      bCtx.roundRect(x + 3, y + 3, w - 6, h - 6, 3);
      bCtx.fill();

      const rv = clampByte(178 + (rng() - 0.5) * 32);
      rCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
      rCtx.fillRect(x, y, w, h);

      // Granite mineral speckles
      for (let s = 0; s < 32; s++) {
        const sx = x + rng() * w;
        const sy = y + rng() * h;
        aCtx.fillStyle = rng() > 0.5 ? 'rgba(245,240,232,0.28)' : 'rgba(52,50,48,0.28)';
        aCtx.fillRect(sx, sy, 1.5, 1.5);
      }
    }
  }

  const bundle: PBRTextureMaps = {
    map: finalizeTexture(`${key}_map`, albedoC, { srgb: true }),
    bumpMap: finalizeTexture(`${key}_bump`, bumpC, { srgb: false }),
    roughnessMap: finalizeTexture(`${key}_rough`, roughC, { srgb: false })
  };
  bundleCache.set(key, bundle);
  return bundle;
}

// ============================================================================
// 9. GOLDEN BEACH SAND (第二海水浴場金沙)
// ============================================================================

export function getBeachSandTextures(): PBRTextureMaps {
  const key = 'beachSand';
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);

  const aImg = aCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);
  const aData = aImg.data;
  const bData = bImg.data;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const warp = tileableFbm(u, v, 4, 2, 911) * 0.28;
      // Gentle wind-blown sand ripples
      const ripple = Math.sin((v * 14 + warp * 3.5) * Math.PI * 2) * 0.5 + 0.5;
      const fine = tileableValueNoise(u, v, 192, 977) - 0.5;
      const shellSpark = tileableValueNoise(u, v, 256, 1021);

      const sparkle = shellSpark > 0.94 ? 22 : shellSpark < 0.05 ? -20 : 0;
      const r = 216 + (ripple - 0.5) * 18 + fine * 14 + sparkle;
      const g = 194 + (ripple - 0.5) * 16 + fine * 12 + sparkle * 0.9;
      const b = 152 + (ripple - 0.5) * 14 + fine * 10 + sparkle * 0.7;

      const idx = (y * size + x) * 4;
      aData[idx] = clampByte(r);
      aData[idx + 1] = clampByte(g);
      aData[idx + 2] = clampByte(b);
      aData[idx + 3] = 255;

      const bh = clampByte(118 + ripple * 54 + fine * 44);
      bData[idx] = bh;
      bData[idx + 1] = bh;
      bData[idx + 2] = bh;
      bData[idx + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  const bundle: PBRTextureMaps = {
    map: finalizeTexture(`${key}_map`, albedoC, { srgb: true }),
    bumpMap: finalizeTexture(`${key}_bump`, bumpC, { srgb: false })
  };
  bundleCache.set(key, bundle);
  return bundle;
}

// ============================================================================
// 10. WEATHERED SEASIDE WOOD PLANKS (濱海木棧道與長椅)
// ============================================================================

export function getWoodPlankTextures(): PBRTextureMaps {
  const key = 'woodPlank';
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);
  const rng = createRng(77123);

  const planks = 8;
  const plankH = size / planks;

  for (let p = 0; p < planks; p++) {
    const y0 = p * plankH;
    const toneShift = (rng() - 0.5) * 26;
    const br = clampByte(142 + toneShift);
    const bg = clampByte(106 + toneShift * 0.85);
    const bb = clampByte(78 + toneShift * 0.65);

    aCtx.fillStyle = `rgb(${br},${bg},${bb})`;
    aCtx.fillRect(0, y0, size, plankH);

    bCtx.fillStyle = '#b4b4b4';
    bCtx.fillRect(0, y0, size, plankH);

    // Flowing cedar grain fibers
    for (let g = 0; g < 26; g++) {
      const gy = y0 + 3 + rng() * (plankH - 6);
      const amp = 1.5 + rng() * 3.5;
      const phase = rng() * Math.PI * 2;
      aCtx.strokeStyle =
        rng() > 0.45 ? 'rgba(64, 42, 26, 0.22)' : 'rgba(218, 186, 146, 0.16)';
      aCtx.lineWidth = 0.8 + rng() * 1.4;
      aCtx.beginPath();
      for (let x = 0; x <= size; x += 16) {
        const yy = gy + Math.sin((x / size) * Math.PI * 2 + phase) * amp;
        if (x === 0) aCtx.moveTo(x, yy);
        else aCtx.lineTo(x, yy);
      }
      aCtx.stroke();

      bCtx.strokeStyle = 'rgba(0, 0, 0, 0.14)';
      bCtx.lineWidth = 1;
      bCtx.stroke();
    }

    // Occasional wood knot
    if (rng() < 0.45) {
      const kx = 48 + rng() * (size - 96);
      const ky = y0 + plankH * (0.3 + rng() * 0.4);
      aCtx.fillStyle = 'rgba(58, 36, 20, 0.42)';
      aCtx.beginPath();
      aCtx.ellipse(kx, ky, 10 + rng() * 6, 4 + rng() * 2, 0, 0, Math.PI * 2);
      aCtx.fill();
    }

    // Staggered vertical board butt joint + recessed nail heads
    const jointX = ((p * 173 + 92) % (size - 64)) + 32;
    aCtx.fillStyle = '#2d2016';
    aCtx.fillRect(jointX, y0, 2.5, plankH);
    bCtx.fillStyle = '#222222';
    bCtx.fillRect(jointX, y0, 3, plankH);

    for (const dx of [-10, 12]) {
      for (const dy of [plankH * 0.28, plankH * 0.72]) {
        aCtx.fillStyle = '#3c3630';
        aCtx.beginPath();
        aCtx.arc(jointX + dx, y0 + dy, 2.2, 0, Math.PI * 2);
        aCtx.fill();
      }
    }

    // Horizontal recessed plank seam
    aCtx.fillStyle = '#281d14';
    aCtx.fillRect(0, y0, size, 3);
    aCtx.fillStyle = 'rgba(255, 232, 202, 0.12)';
    aCtx.fillRect(0, y0 + 3, size, 2);

    bCtx.fillStyle = '#141414';
    bCtx.fillRect(0, y0, size, 4);
  }

  const bundle: PBRTextureMaps = {
    map: finalizeTexture(`${key}_map`, albedoC, { srgb: true }),
    bumpMap: finalizeTexture(`${key}_bump`, bumpC, { srgb: false })
  };
  bundleCache.set(key, bundle);
  return bundle;
}

// ============================================================================
// 11. TREE BARK & FRENCH SYCAMORE MOTTLED BARK (樹皮 / 法桐斑駁樹皮)
// ============================================================================

export function getTreeBarkTextures(): PBRTextureMaps {
  const key = 'treeBark';
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);

  const aImg = aCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);
  const aData = aImg.data;
  const bData = bImg.data;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // Anisotropic stretched vertical bark ridges
      const warp = tileableFbm(u, v, 4, 2, 1301) * 0.06;
      const ridge = tileableFbm((u + warp + 1) % 1, v * 0.35, 16, 4, 1409);
      const crack = Math.pow(ridge, 1.45);
      const lichen = tileableFbm(u, v, 8, 3, 1511);

      let r = 56 + crack * 62;
      let g = 46 + crack * 52;
      let b = 38 + crack * 42;

      // Occasional pale olive coastal lichen
      if (lichen > 0.72 && crack > 0.45) {
        const lAmt = (lichen - 0.72) * 2.2;
        r = r * (1 - lAmt) + 126 * lAmt;
        g = g * (1 - lAmt) + 132 * lAmt;
        b = b * (1 - lAmt) + 108 * lAmt;
      }

      const idx = (y * size + x) * 4;
      aData[idx] = clampByte(r);
      aData[idx + 1] = clampByte(g);
      aData[idx + 2] = clampByte(b);
      aData[idx + 3] = 255;

      const bh = clampByte(24 + crack * 220);
      bData[idx] = bh;
      bData[idx + 1] = bh;
      bData[idx + 2] = bh;
      bData[idx + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  const bundle: PBRTextureMaps = {
    map: finalizeTexture(`${key}_map`, albedoC, { srgb: true }),
    bumpMap: finalizeTexture(`${key}_bump`, bumpC, { srgb: false })
  };
  bundleCache.set(key, bundle);
  return bundle;
}

export function getSycamoreBarkTextures(): PBRTextureMaps {
  const key = 'sycamoreBark';
  const cached = bundleCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [albedoC, aCtx] = makeCanvas(size, size);
  const [bumpC, bCtx] = makeCanvas(size, size);

  const aImg = aCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);
  const aData = aImg.data;
  const bData = bImg.data;

  // Iconic French Sycamore (法桐) exfoliating camouflage bark: cream, olive, khaki & dark brown plates
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const patch = tileableFbm(u, v * 0.65, 5, 4, 1709);
      const subPatch = tileableFbm(u, v, 10, 3, 1811);
      const fine = tileableValueNoise(u, v, 96, 1901) - 0.5;

      let r: number;
      let g: number;
      let b: number;
      let bump: number;

      if (patch < 0.36) {
        // Freshly exfoliated pale cream-ivory inner bark
        r = 216 + fine * 14;
        g = 208 + fine * 14;
        b = 184 + fine * 12;
        bump = 96;
      } else if (patch < 0.56) {
        // Dusty sage / olive-grey middle bark
        r = 152 + subPatch * 22 + fine * 14;
        g = 154 + subPatch * 20 + fine * 14;
        b = 124 + subPatch * 16 + fine * 12;
        bump = 132;
      } else if (patch < 0.72) {
        // Warm khaki-tan plate
        r = 166 + fine * 16;
        g = 148 + fine * 14;
        b = 116 + fine * 12;
        bump = 166;
      } else {
        // Peeling charcoal-brown outer bark flakes
        r = 86 + subPatch * 24 + fine * 14;
        g = 78 + subPatch * 20 + fine * 14;
        b = 68 + subPatch * 16 + fine * 12;
        bump = 218;
      }

      const idx = (y * size + x) * 4;
      aData[idx] = clampByte(r);
      aData[idx + 1] = clampByte(g);
      aData[idx + 2] = clampByte(b);
      aData[idx + 3] = 255;

      const bh = clampByte(bump + fine * 30);
      bData[idx] = bh;
      bData[idx + 1] = bh;
      bData[idx + 2] = bh;
      bData[idx + 3] = 255;
    }
  }

  aCtx.putImageData(aImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  const bundle: PBRTextureMaps = {
    map: finalizeTexture(`${key}_map`, albedoC, { srgb: true }),
    bumpMap: finalizeTexture(`${key}_bump`, bumpC, { srgb: false })
  };
  bundleCache.set(key, bundle);
  return bundle;
}

// ============================================================================
// 12. EUROPEAN DIVIDED-LIGHT WINDOWS (DAY + WARM TWILIGHT EMISSIVE)
// ============================================================================

export function getWindowDayTexture(): THREE.CanvasTexture {
  const key = 'windowDay';
  const cached = textureCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [canvas, ctx] = makeCanvas(size, size);

  // Outer cream-ivory timber frame
  ctx.fillStyle = '#efe8da';
  ctx.fillRect(0, 0, size, size);

  // Inner sash bevel shadow
  const pad = 26;
  ctx.fillStyle = '#c9bfae';
  ctx.fillRect(pad - 6, pad - 6, size - (pad - 6) * 2, size - (pad - 6) * 2);

  // Deep reflective coastal-sky glass backdrop
  const glassGrad = ctx.createLinearGradient(pad, pad, size - pad, size - pad);
  glassGrad.addColorStop(0, '#2a4359');
  glassGrad.addColorStop(0.45, '#1d3042');
  glassGrad.addColorStop(1, '#15222e');
  ctx.fillStyle = glassGrad;
  ctx.fillRect(pad, pad, size - pad * 2, size - pad * 2);

  // Subtle warm interior curtains draped along left & right edges
  const leftCurtain = ctx.createLinearGradient(pad, 0, pad + 92, 0);
  leftCurtain.addColorStop(0, 'rgba(218, 198, 168, 0.34)');
  leftCurtain.addColorStop(0.6, 'rgba(186, 164, 134, 0.16)');
  leftCurtain.addColorStop(1, 'rgba(186, 164, 134, 0)');
  ctx.fillStyle = leftCurtain;
  ctx.fillRect(pad, pad, 95, size - pad * 2);

  const rightCurtain = ctx.createLinearGradient(size - pad, 0, size - pad - 92, 0);
  rightCurtain.addColorStop(0, 'rgba(218, 198, 168, 0.34)');
  rightCurtain.addColorStop(0.6, 'rgba(186, 164, 134, 0.16)');
  rightCurtain.addColorStop(1, 'rgba(186, 164, 134, 0)');
  ctx.fillStyle = rightCurtain;
  ctx.fillRect(size - pad - 95, pad, 95, size - pad * 2);

  // Diagonal architectural sky reflection sheen across panes
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad, pad, size - pad * 2, size - pad * 2);
  ctx.clip();
  ctx.fillStyle = 'rgba(210, 232, 248, 0.14)';
  ctx.beginPath();
  ctx.moveTo(pad, pad + 180);
  ctx.lineTo(pad + 260, pad);
  ctx.lineTo(pad + 370, pad);
  ctx.lineTo(pad, pad + 290);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Divided-light wooden muntins (2 columns x 3 rows)
  const drawMuntinBar = (x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = 'rgba(12, 18, 26, 0.35)';
    ctx.fillRect(x + 3, y + 3, w, h);
    ctx.fillStyle = '#f2ebde';
    ctx.fillRect(x, y, w, h);
  };

  drawMuntinBar(size * 0.5 - 8, pad, 16, size - pad * 2);
  drawMuntinBar(pad, pad + (size - pad * 2) * 0.33 - 7, size - pad * 2, 14);
  drawMuntinBar(pad, pad + (size - pad * 2) * 0.67 - 7, size - pad * 2, 14);

  // Crisp inner window frame outline
  ctx.strokeStyle = '#dfd5c3';
  ctx.lineWidth = 4;
  ctx.strokeRect(pad, pad, size - pad * 2, size - pad * 2);

  return finalizeTexture(key, canvas, { srgb: true, repeat: false });
}

export function getWindowNightEmissiveTexture(): THREE.CanvasTexture {
  const key = 'windowNightEmissive';
  const cached = textureCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [canvas, ctx] = makeCanvas(size, size);

  // Pitch-black outer frame so only glass panes emit warm light
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);

  const pad = 28;
  // Warm glowing European interior lamp gradient
  const glow = ctx.createRadialGradient(
    size * 0.5,
    size * 0.56,
    24,
    size * 0.5,
    size * 0.5,
    size * 0.52
  );
  glow.addColorStop(0, '#ffe29c');
  glow.addColorStop(0.45, '#ffbb5c');
  glow.addColorStop(0.82, '#d97f2e');
  glow.addColorStop(1, '#8c4416');
  ctx.fillStyle = glow;
  ctx.fillRect(pad, pad, size - pad * 2, size - pad * 2);

  // Soft silhouette of warm interior curtains & ceiling shade
  const topShade = ctx.createLinearGradient(0, pad, 0, pad + 110);
  topShade.addColorStop(0, 'rgba(42, 18, 6, 0.58)');
  topShade.addColorStop(1, 'rgba(42, 18, 6, 0)');
  ctx.fillStyle = topShade;
  ctx.fillRect(pad, pad, size - pad * 2, 110);

  const curtainL = ctx.createLinearGradient(pad, 0, pad + 88, 0);
  curtainL.addColorStop(0, 'rgba(66, 28, 10, 0.52)');
  curtainL.addColorStop(1, 'rgba(66, 28, 10, 0)');
  ctx.fillStyle = curtainL;
  ctx.fillRect(pad, pad, 88, size - pad * 2);

  const curtainR = ctx.createLinearGradient(size - pad, 0, size - pad - 88, 0);
  curtainR.addColorStop(0, 'rgba(66, 28, 10, 0.52)');
  curtainR.addColorStop(1, 'rgba(66, 28, 10, 0)');
  ctx.fillStyle = curtainR;
  ctx.fillRect(size - pad - 88, pad, 88, size - pad * 2);

  // Dark muntin bars matching windowDay exactly
  ctx.fillStyle = '#080503';
  ctx.fillRect(size * 0.5 - 9, pad - 2, 18, size - pad * 2 + 4);
  ctx.fillRect(pad - 2, pad + (size - pad * 2) * 0.33 - 8, size - pad * 2 + 4, 16);
  ctx.fillRect(pad - 2, pad + (size - pad * 2) * 0.67 - 8, size - pad * 2 + 4, 16);

  return finalizeTexture(key, canvas, { srgb: true, repeat: false });
}

// ============================================================================
// 13. BOTANICAL ALPHA-CUTOUT FOLIAGE CLUSTER TEXTURES
// ============================================================================

function drawGinkgoLeaf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  angle: number,
  fillTop: string,
  fillBase: string
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);

  // Petiole stem
  ctx.strokeStyle = '#9c7828';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(0, 14);
  ctx.lineTo(0, 0);
  ctx.stroke();

  // Iconic notched bilobed fan silhouette
  const grad = ctx.createRadialGradient(0, -10, 2, 0, -24, 34);
  grad.addColorStop(0, fillBase);
  grad.addColorStop(1, fillTop);
  ctx.fillStyle = grad;

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-24, -12, -26, -32);
  ctx.quadraticCurveTo(-15, -42, -3, -34);
  ctx.lineTo(0, -25); // Signature central notch!
  ctx.lineTo(3, -34);
  ctx.quadraticCurveTo(15, -42, 26, -32);
  ctx.quadraticCurveTo(24, -12, 0, 0);
  ctx.closePath();
  ctx.fill();

  // Delicate radiating veins
  ctx.strokeStyle = 'rgba(130, 82, 12, 0.28)';
  ctx.lineWidth = 1;
  for (const vx of [-16, -9, 9, 16]) {
    ctx.beginPath();
    ctx.moveTo(0, -2);
    ctx.lineTo(vx, -30);
    ctx.stroke();
  }
  ctx.restore();
}

function drawMapleLeaf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  angle: number,
  fillTip: string,
  fillCenter: string
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);

  // Five-pointed star maple leaf (五角楓)
  const lobeAngles = [-2.25, -1.62, -Math.PI / 2, -0.95, -0.32];
  const lobeLengths = [20, 31, 38, 31, 20];

  const grad = ctx.createRadialGradient(0, -12, 2, 0, -14, 38);
  grad.addColorStop(0, fillCenter);
  grad.addColorStop(1, fillTip);
  ctx.fillStyle = grad;

  ctx.beginPath();
  ctx.moveTo(0, 4);
  for (let i = 0; i < lobeAngles.length; i++) {
    const a = lobeAngles[i];
    const len = lobeLengths[i];
    const tipX = Math.cos(a) * len;
    const tipY = Math.sin(a) * len;
    const prevMidA = i === 0 ? a - 0.34 : (lobeAngles[i - 1] + a) * 0.5;
    const valleyR = i === 0 ? 11 : 14;
    ctx.lineTo(Math.cos(prevMidA) * valleyR, Math.sin(prevMidA) * valleyR);
    ctx.lineTo(tipX, tipY);
  }
  ctx.lineTo(Math.cos(-0.02) * 11, Math.sin(-0.02) * 11);
  ctx.closePath();
  ctx.fill();

  // Radiating veins
  ctx.strokeStyle = 'rgba(72, 12, 8, 0.32)';
  ctx.lineWidth = 1.1;
  for (let i = 0; i < lobeAngles.length; i++) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(lobeAngles[i]) * lobeLengths[i] * 0.78, Math.sin(lobeAngles[i]) * lobeLengths[i] * 0.78);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSycamoreLeaf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  angle: number,
  fillOuter: string,
  fillInner: string
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);

  const grad = ctx.createRadialGradient(0, -16, 4, 0, -18, 42);
  grad.addColorStop(0, fillInner);
  grad.addColorStop(1, fillOuter);
  ctx.fillStyle = grad;

  // Broad palmate Platanus (法桐) leaf with 5 wide lobes
  ctx.beginPath();
  ctx.moveTo(0, 8);
  ctx.lineTo(-18, 4);
  ctx.lineTo(-34, -10);
  ctx.lineTo(-22, -16);
  ctx.lineTo(-30, -34);
  ctx.lineTo(-12, -26);
  ctx.lineTo(0, -46);
  ctx.lineTo(12, -26);
  ctx.lineTo(30, -34);
  ctx.lineTo(22, -16);
  ctx.lineTo(34, -10);
  ctx.lineTo(18, 4);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(74, 52, 18, 0.3)';
  ctx.lineWidth = 1.2;
  for (const [vx, vy] of [
    [0, -38],
    [-22, -26],
    [22, -26],
    [-24, -8],
    [24, -8]
  ]) {
    ctx.beginPath();
    ctx.moveTo(0, 2);
    ctx.lineTo(vx, vy);
    ctx.stroke();
  }
  ctx.restore();
}

function buildGinkgoClusterTexture(): THREE.CanvasTexture {
  const key = 'foliage_ginkgo';
  const cached = textureCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [canvas, ctx] = makeCanvas(size, size);
  const rng = createRng(55001);

  // Subtle dark woody twigs in center
  ctx.strokeStyle = '#5e4c36';
  ctx.lineWidth = 4;
  for (let b = 0; b < 5; b++) {
    const a = (b / 5) * Math.PI * 2 + rng() * 0.5;
    ctx.beginPath();
    ctx.moveTo(size * 0.5, size * 0.5);
    ctx.lineTo(size * 0.5 + Math.cos(a) * 140, size * 0.5 + Math.sin(a) * 140);
    ctx.stroke();
  }

  const palette: [string, string][] = [
    ['#f5c538', '#d4951c'], // Pure autumn ginkgo gold
    ['#ffd859', '#e2a924'], // Sunlit bright lemon-gold
    ['#e6a626', '#b87614'], // Deep honey amber
    ['#d7b932', '#9ea12a']  // Hint of late-turning chartreuse-gold
  ];

  // Layered leaves: deeper shadow leaves first, luminous golden leaves on top
  for (let i = 0; i < 46; i++) {
    const r = Math.pow(rng(), 0.6) * 165;
    const theta = rng() * Math.PI * 2;
    const x = size * 0.5 + Math.cos(theta) * r;
    const y = size * 0.5 + Math.sin(theta) * r;
    const scale = 1.15 + rng() * 0.85;
    const angle = theta + Math.PI * 0.5 + (rng() - 0.5) * 1.4;
    const [topCol, baseCol] = palette[Math.floor(rng() * palette.length)];
    drawGinkgoLeaf(ctx, x, y, scale, angle, topCol, baseCol);
  }

  return finalizeTexture(key, canvas, { srgb: true, repeat: false });
}

function buildMapleClusterTexture(): THREE.CanvasTexture {
  const key = 'foliage_maple';
  const cached = textureCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [canvas, ctx] = makeCanvas(size, size);
  const rng = createRng(55002);

  ctx.strokeStyle = '#4c3228';
  ctx.lineWidth = 4;
  for (let b = 0; b < 5; b++) {
    const a = (b / 5) * Math.PI * 2 + 0.3;
    ctx.beginPath();
    ctx.moveTo(size * 0.5, size * 0.5);
    ctx.lineTo(size * 0.5 + Math.cos(a) * 135, size * 0.5 + Math.sin(a) * 135);
    ctx.stroke();
  }

  const palette: [string, string][] = [
    ['#cf2d1f', '#8e1612'], // Classic crimson maple
    ['#e64c24', '#b52814'], // Fiery scarlet-vermilion
    ['#a61c1b', '#6d0e10'], // Deep wine red
    ['#f07c2e', '#c93c18']  // Sunlit burnt orange-amber
  ];

  for (let i = 0; i < 42; i++) {
    const r = Math.pow(rng(), 0.62) * 168;
    const theta = rng() * Math.PI * 2;
    const x = size * 0.5 + Math.cos(theta) * r;
    const y = size * 0.5 + Math.sin(theta) * r;
    const scale = 1.1 + rng() * 0.8;
    const angle = rng() * Math.PI * 2;
    const [tipCol, centerCol] = palette[Math.floor(rng() * palette.length)];
    drawMapleLeaf(ctx, x, y, scale, angle, tipCol, centerCol);
  }

  return finalizeTexture(key, canvas, { srgb: true, repeat: false });
}

function buildSycamoreClusterTexture(): THREE.CanvasTexture {
  const key = 'foliage_sycamore';
  const cached = textureCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [canvas, ctx] = makeCanvas(size, size);
  const rng = createRng(55003);

  ctx.strokeStyle = '#5c4d3a';
  ctx.lineWidth = 4;
  for (let b = 0; b < 4; b++) {
    const a = (b / 4) * Math.PI * 2 + 0.4;
    ctx.beginPath();
    ctx.moveTo(size * 0.5, size * 0.5);
    ctx.lineTo(size * 0.5 + Math.cos(a) * 145, size * 0.5 + Math.sin(a) * 145);
    ctx.stroke();
  }

  const palette: [string, string][] = [
    ['#c6913c', '#8c6222'], // Warm autumn sycamore amber
    ['#a68438', '#6f5c24'], // Mottled olive-ochre
    ['#d4a64a', '#9c7128'], // Golden-tan sunlit leaf
    ['#8d6a32', '#5c421e'], // Russet bronze
    ['#7f8540', '#545c2a']  // Lingering autumn olive-green
  ];

  for (let i = 0; i < 32; i++) {
    const r = Math.pow(rng(), 0.65) * 162;
    const theta = rng() * Math.PI * 2;
    const x = size * 0.5 + Math.cos(theta) * r;
    const y = size * 0.5 + Math.sin(theta) * r;
    const scale = 1.15 + rng() * 0.75;
    const angle = rng() * Math.PI * 2;
    const [outerCol, innerCol] = palette[Math.floor(rng() * palette.length)];
    drawSycamoreLeaf(ctx, x, y, scale, angle, outerCol, innerCol);
  }

  return finalizeTexture(key, canvas, { srgb: true, repeat: false });
}

function buildCedarClusterTexture(): THREE.CanvasTexture {
  const key = 'foliage_cedar';
  const cached = textureCache.get(key);
  if (cached) return cached;

  const size = 512;
  const [canvas, ctx] = makeCanvas(size, size);
  const rng = createRng(55004);

  const needleColors = ['#183424', '#214530', '#2c593c', '#3b6d49', '#1f3d2b'];

  // Radiating cedar/pine boughs composed of crisp fine needles
  for (let spray = 0; spray < 28; spray++) {
    const baseAngle = (spray / 28) * Math.PI * 2 + (rng() - 0.5) * 0.25;
    const dist = 24 + rng() * 118;
    const sx = size * 0.5 + Math.cos(baseAngle) * dist * 0.45;
    const sy = size * 0.5 + Math.sin(baseAngle) * dist * 0.45;
    const len = 75 + rng() * 75;
    const ex = sx + Math.cos(baseAngle) * len;
    const ey = sy + Math.sin(baseAngle) * len;

    // Twig core
    ctx.strokeStyle = '#3c3024';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // Dense pine needles fanning along the twig
    const steps = 26;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const px = sx + (ex - sx) * t;
      const py = sy + (ey - sy) * t;
      for (const side of [-1, 1] as const) {
        const needleAngle = baseAngle + side * (0.48 + rng() * 0.42);
        const needleLen = (18 + rng() * 18) * (1 - t * 0.35);
        ctx.strokeStyle = needleColors[Math.floor(rng() * needleColors.length)];
        ctx.lineWidth = 2.4 + rng() * 1.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(
          px + Math.cos(needleAngle) * needleLen,
          py + Math.sin(needleAngle) * needleLen
        );
        ctx.stroke();
      }
    }
  }

  return finalizeTexture(key, canvas, { srgb: true, repeat: false });
}

function buildFallenLeafTexture(): THREE.CanvasTexture {
  const key = 'foliage_fallenLeaf';
  const cached = textureCache.get(key);
  if (cached) return cached;

  const size = 256;
  const [canvas, ctx] = makeCanvas(size, size);
  // Single crisp high-contrast autumn ginkgo fan leaf (tinted via instance/vertex colors!)
  drawGinkgoLeaf(ctx, size * 0.5, size * 0.72, 3.6, 0, '#fff4cf', '#e8c474');

  return finalizeTexture(key, canvas, { srgb: true, repeat: false });
}

export function getFoliageClusterTextures(): FoliageClusterTextureSet {
  if (foliageCache) return foliageCache;
  foliageCache = {
    ginkgo: buildGinkgoClusterTexture(),
    maple: buildMapleClusterTexture(),
    sycamore: buildSycamoreClusterTexture(),
    cedar: buildCedarClusterTexture(),
    fallenLeaf: buildFallenLeafTexture()
  };
  return foliageCache;
}

// ============================================================================
// 14. VINTAGE QINGDAO HERITAGE STREET SIGN FACTORY
// ============================================================================

/**
 * Generates an authentic Qingdao Badaguan heritage enameled street sign CanvasTexture.
 */
export function createRoadSignTexture(
  zhName: string,
  enName: string,
  subText?: string
): THREE.CanvasTexture {
  const key = `roadSign_${zhName}_${enName}_${subText ?? ''}`;
  const cached = textureCache.get(key);
  if (cached) return cached;

  const width = 512;
  const height = 256;
  const [canvas, ctx] = makeCanvas(width, height);

  // Vintage Qingdao heritage enamel navy-blue plate
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#1a3d63');
  bg.addColorStop(0.55, '#13304f');
  bg.addColorStop(1, '#0e253e');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Subtle top enamel sheen
  const sheen = ctx.createLinearGradient(0, 0, width, height * 0.65);
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.09)');
  sheen.addColorStop(0.5, 'rgba(255, 255, 255, 0.02)');
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, width, height);

  // Classic double ivory architectural border
  ctx.strokeStyle = '#f2eadb';
  ctx.lineWidth = 6;
  ctx.strokeRect(12, 12, width - 24, height - 24);

  ctx.strokeStyle = 'rgba(229, 178, 84, 0.72)';
  ctx.lineWidth = 2;
  ctx.strokeRect(22, 22, width - 44, height - 44);

  // Terracotta heritage corner accent band on top
  ctx.fillStyle = '#b94d34';
  ctx.fillRect(24, 24, width - 48, 34);

  ctx.fillStyle = '#f7efe2';
  ctx.font = '600 17px "Noto Sans TC", "PingFang TC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('青島 · 八大關歷史街區   BADAGUAN HERITAGE', width * 0.5, 42);

  // Primary Chinese road name
  ctx.fillStyle = '#fff9ee';
  const zhFontSize = zhName.length > 6 ? 48 : 62;
  ctx.font = `700 ${zhFontSize}px "Noto Serif TC", "Songti TC", Georgia, serif`;
  ctx.fillText(zhName, width * 0.5, subText ? 116 : 128);

  // English road name
  ctx.fillStyle = '#e5b862';
  ctx.font = '600 24px "Noto Sans TC", -apple-system, sans-serif';
  ctx.fillText(enName.toUpperCase(), width * 0.5, subText ? 174 : 188);

  // Optional tree-avenue / scenic subtitle
  if (subText) {
    ctx.fillStyle = 'rgba(242, 234, 219, 0.84)';
    ctx.font = '400 20px "Noto Sans TC", "PingFang TC", sans-serif';
    ctx.fillText(subText, width * 0.5, 210);
  }

  return finalizeTexture(key, canvas, { srgb: true, repeat: false });
}

// ============================================================================
// 15. LAZY CONVENIENCE FACADE (MATCHING SPEC IDENTIFIERS)
// ============================================================================

/**
 * Lazy-evaluating procedural texture library.
 * Accessing any property builds & caches that texture set on first use.
 */
export const TEXTURES = {
  get mushroomGranite(): PBRTextureMaps {
    return getMushroomGraniteTextures();
  },
  get huashiPebbleStone(): PBRTextureMaps {
    return getHuashiPebbleStoneTextures();
  },
  get redRoofTiles(): PBRTextureMaps {
    return getRedRoofTilesTextures();
  },
  get slateTurretRoof(): PBRTextureMaps {
    return getSlateTurretRoofTextures();
  },
  get warmStucco(): PBRTextureMaps {
    return getWarmStuccoTextures();
  },
  get nordicBlueWall(): PBRTextureMaps {
    return getNordicBlueWallTextures();
  },
  get asphaltRoad(): PBRTextureMaps {
    return getAsphaltRoadTextures();
  },
  get graniteCobble(): PBRTextureMaps {
    return getGraniteCobbleTextures();
  },
  get beachSand(): PBRTextureMaps {
    return getBeachSandTextures();
  },
  get woodPlank(): PBRTextureMaps {
    return getWoodPlankTextures();
  },
  get treeBark(): PBRTextureMaps {
    return getTreeBarkTextures();
  },
  get sycamoreBark(): PBRTextureMaps {
    return getSycamoreBarkTextures();
  },
  get windowDay(): THREE.CanvasTexture {
    return getWindowDayTexture();
  },
  get windowNightEmissive(): THREE.CanvasTexture {
    return getWindowNightEmissiveTexture();
  },
  get foliageClusterTextures(): FoliageClusterTextureSet {
    return getFoliageClusterTextures();
  },
  createRoadSignTexture
};
