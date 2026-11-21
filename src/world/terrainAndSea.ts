import * as THREE from 'three';
import {
  ATMOSPHERE_PRESETS,
  DEFAULT_MOOD,
  JETTY,
  ROADS,
  SEA_LEVEL,
  VILLAS,
  clamp,
  createRng,
  getJettyHeight,
  getRoadById,
  getSeawallZ,
  getTerrainHeight,
  sampleRoadPoint,
  seededRange,
  smoothstep
} from './layout';
import { TEXTURES } from './textures';
import type {
  AtmosphereConfig,
  RoadCurveSpec,
  RoadId,
  WorldUpdateContext
} from './types';

// ============================================================================
// PUBLIC CONTRACT TYPES
// ============================================================================

export type TextureLibrary = Pick<
  typeof TEXTURES,
  'mushroomGranite' | 'asphaltRoad' | 'graniteCobble' | 'beachSand' | 'woodPlank'
> &
  Partial<typeof TEXTURES>;

export interface TerrainAndSeaModule {
  group: THREE.Group;
  update(ctx: WorldUpdateContext): void;
  applyAtmosphere(cfg: AtmosphereConfig): void;
}

// ============================================================================
// INTERNAL DATA STRUCTURES
// ============================================================================

interface RoadStation {
  x: number;
  z: number;
  t: number;
  arcLen: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
}

interface ReefRockPlacement {
  x: number;
  z: number;
  y: number;
  rx: number;
  ry: number;
  rz: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  variant: number;
  tint: number;
}

interface SailboatInstance {
  root: THREE.Group;
  sailMesh: THREE.Mesh;
  beaconMat: THREE.MeshBasicMaterial;
  baseX: number;
  baseZ: number;
  heading: number;
  orbitRadiusX: number;
  orbitRadiusZ: number;
  speed: number;
  phase: number;
  scale: number;
}

// Depth map domain covering Second Bathing Beach, Stone Jetty, West Point, and Huashi Cape
const DEPTH_MAP_MIN_X = -150;
const DEPTH_MAP_MAX_X = 150;
const DEPTH_MAP_MIN_Z = 14;
const DEPTH_MAP_MAX_Z = 166;
const DEPTH_MAP_SIZE = 256;

// ============================================================================
// DETERMINISTIC NOISE & GEOMETRY HELPERS
// ============================================================================

function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function valueNoise2D(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm2D(x: number, z: number, octaves = 3): number {
  let value = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    value += amp * valueNoise2D(x * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return value / norm;
}

/** Merge multiple BufferGeometries with matching position/normal/uv/(optional color) attributes. */
function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geometries.length === 0) {
    return new THREE.BufferGeometry();
  }

  const normalized = geometries.map((g) => (g.index ? g.toNonIndexed() : g));
  const hasColor = normalized.every((g) => g.getAttribute('color') !== undefined);

  let totalVerts = 0;
  for (const g of normalized) {
    const pos = g.getAttribute('position');
    if (pos) totalVerts += pos.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const colors = hasColor ? new Float32Array(totalVerts * 3) : null;

  let vOffset = 0;
  for (const g of normalized) {
    const pos = g.getAttribute('position');
    if (!pos) continue;
    let norm = g.getAttribute('normal');
    if (!norm) {
      g.computeVertexNormals();
      norm = g.getAttribute('normal');
    }
    const uv = g.getAttribute('uv');
    const col = hasColor ? g.getAttribute('color') : null;

    for (let i = 0; i < pos.count; i++) {
      const i3 = (vOffset + i) * 3;
      const i2 = (vOffset + i) * 2;
      positions[i3] = pos.getX(i);
      positions[i3 + 1] = pos.getY(i);
      positions[i3 + 2] = pos.getZ(i);

      normals[i3] = norm ? norm.getX(i) : 0;
      normals[i3 + 1] = norm ? norm.getY(i) : 1;
      normals[i3 + 2] = norm ? norm.getZ(i) : 0;

      uvs[i2] = uv ? uv.getX(i) : 0;
      uvs[i2 + 1] = uv ? uv.getY(i) : 0;

      if (colors && col) {
        colors[i3] = col.getX(i);
        colors[i3 + 1] = col.getY(i);
        colors[i3 + 2] = col.getZ(i);
      }
    }
    vOffset += pos.count;
  }

  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] !== geometries[i]) {
      normalized[i].dispose();
    }
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (colors) {
    merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  return merged;
}

/** Creates a BoxGeometry whose UVs match real-world meters on all 6 faces (never stretches textures). */
function createBoxWorldUV(
  width: number,
  height: number,
  depth: number,
  tileMeters = 2.6
): THREE.BoxGeometry {
  const geom = new THREE.BoxGeometry(width, height, depth);
  const uv = geom.getAttribute('uv');
  // BoxGeometry face order: +X (d x h), -X (d x h), +Y (w x d), -Y (w x d), +Z (w x h), -Z (w x h)
  const faceScales: [number, number][] = [
    [depth / tileMeters, height / tileMeters],
    [depth / tileMeters, height / tileMeters],
    [width / tileMeters, depth / tileMeters],
    [width / tileMeters, depth / tileMeters],
    [width / tileMeters, height / tileMeters],
    [width / tileMeters, height / tileMeters]
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = faceScales[f];
    const start = f * 4;
    for (let i = 0; i < 4; i++) {
      const idx = start + i;
      uv.setXY(idx, uv.getX(idx) * su, uv.getY(idx) * sv);
    }
  }
  uv.needsUpdate = true;
  return geom;
}

/** Scales existing UVs of a geometry without mutating shared Texture.repeat. */
function scaleGeometryUVs(geom: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = geom.getAttribute('uv');
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
}

// ============================================================================
// ROAD SPLINE SAMPLING & INTERSECTION QUERIES
// ============================================================================

function sampleRoadStations(road: RoadCurveSpec, stepMeters = 1.25): RoadStation[] {
  const count = Math.max(8, Math.ceil(road.totalLength / stepMeters));
  const raw: { x: number; z: number; t: number }[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const p = sampleRoadPoint(road, t);
    raw.push({ x: p.x, z: p.z, t });
  }

  const stations: RoadStation[] = [];
  let arcLen = 0;
  for (let i = 0; i < raw.length; i++) {
    if (i > 0) {
      arcLen += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z);
    }
    const prev = raw[Math.max(0, i - 1)];
    const next = raw[Math.min(raw.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;

    stations.push({
      x: raw[i].x,
      z: raw[i].z,
      t: raw[i].t,
      arcLen,
      tx,
      tz,
      nx: -tz,
      nz: tx
    });
  }
  return stations;
}

function distanceToSingleRoad(road: RoadCurveSpec, x: number, z: number): number {
  let bestSq = Infinity;
  const segs = road.segments;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const dx = s.x1 - s.x0;
    const dz = s.z1 - s.z0;
    const lenSq = dx * dx + dz * dz;
    const proj = lenSq > 1e-8 ? clamp(((x - s.x0) * dx + (z - s.z0) * dz) / lenSq, 0, 1) : 0;
    const cx = s.x0 + dx * proj;
    const cz = s.z0 + dz * proj;
    const ex = x - cx;
    const ez = z - cz;
    const dSq = ex * ex + ez * ez;
    if (dSq < bestSq) bestSq = dSq;
  }
  return Math.sqrt(bestSq);
}

function signedEdgeDistToOtherRoads(
  x: number,
  z: number,
  excludeId: RoadId
): { edgeDist: number; otherId: RoadId | null } {
  let best = Infinity;
  let otherId: RoadId | null = null;
  for (let i = 0; i < ROADS.length; i++) {
    const r = ROADS[i];
    if (r.id === excludeId) continue;
    const d = distanceToSingleRoad(r, x, z) - r.width * 0.5;
    if (d < best) {
      best = d;
      otherId = r.id;
    }
  }
  return { edgeDist: best, otherId };
}

function isNearVillaCourtyard(x: number, z: number, extraMargin = 0.35): boolean {
  for (let i = 0; i < VILLAS.length; i++) {
    const v = VILLAS[i];
    const dx = x - v.position[0];
    const dz = z - v.position[2];
    const c = Math.cos(v.rotationY);
    const s = Math.sin(v.rotationY);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    if (
      Math.abs(lx) <= v.courtyardWidth * 0.5 + extraMargin &&
      Math.abs(lz) <= v.courtyardDepth * 0.5 + extraMargin
    ) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// COASTAL REEF PLACEMENT GENERATION (SHARED BETWEEN ROCK MESHES & DEPTH MAP)
// ============================================================================

function generateCoastalReefPlacements(): ReefRockPlacement[] {
  const rng = createRng(20260418);
  const rocks: ReefRockPlacement[] = [];

  const huashiVilla = VILLAS[0]; // 花石樓: position [48, 6.4, 44], rotY = -0.75
  const hCos = Math.cos(huashiVilla.rotationY);
  const hSin = Math.sin(huashiVilla.rotationY);
  const huashiLocalToWorld = (lx: number, lz: number): [number, number] => [
    huashiVilla.position[0] + lx * hCos + lz * hSin,
    huashiVilla.position[2] - lx * hSin + lz * hCos
  ];
  const isInsideHuashiCourtyard = (x: number, z: number, margin = 0.55): boolean => {
    const dx = x - huashiVilla.position[0];
    const dz = z - huashiVilla.position[2];
    const lx = dx * hCos - dz * hSin;
    const lz = dx * hSin + dz * hCos;
    return (
      Math.abs(lx) <= huashiVilla.courtyardWidth * 0.5 + margin &&
      Math.abs(lz) <= huashiVilla.courtyardDepth * 0.5 + margin
    );
  };

  const huashiPath = getRoadById('huashi_cape');

  const pushRock = (
    x: number,
    z: number,
    rx: number,
    ry: number,
    rz: number,
    yOffset = 0,
    fixedY?: number,
    opts?: {
      variant?: number;
      rotX?: number;
      rotY?: number;
      rotZ?: number;
      tint?: number;
      allowCliffHugging?: boolean;
    }
  ) => {
    // Never intrude inside villa courtyards or onto roads
    if (opts?.allowCliffHugging) {
      if (isInsideHuashiCourtyard(x, z, 0.45)) return;
    } else {
      if (isNearVillaCourtyard(x, z, 1.4)) return;
    }
    if (distanceToSingleRoad(huashiPath, x, z) < huashiPath.width * 0.5 + 1.85) return;

    const ty = fixedY !== undefined ? fixedY : getTerrainHeight(x, z);
    rocks.push({
      x,
      z,
      y: ty + yOffset,
      rx,
      ry,
      rz,
      rotX: opts?.rotX ?? seededRange(rng, -0.14, 0.14),
      rotY: opts?.rotY ?? seededRange(rng, 0, Math.PI * 2),
      rotZ: opts?.rotZ ?? seededRange(rng, -0.14, 0.14),
      variant: opts?.variant ?? Math.floor(rng() * 4),
      tint: opts?.tint ?? seededRange(rng, 0.84, 1.12)
    });
  };

  // ---------------------------------------------------------------------------
  // 1. HUASHI CAPE MULTI-TIER LAOSHAN GRANITE CLIFF FACE (花石樓海岬花崗岩峭壁)
  //    Wraps organically around X in [24, 72], Z in [38, 65] directly beneath
  //    Huashi Villa's stone perimeter wall:
  //      - Variant 4: Sculpted angular vertical granite cliff buttresses
  //      - Variant 5: Stepped stratified coastal granite rock ledges
  //      - Variants 0..3: Fractured angular coastal reef boulders
  // ---------------------------------------------------------------------------

  // 1A. SW Front Cliff Face (directly facing Second Bathing Beach & Stone Jetty!)
  //     Courtyard front wall runs along local lz = +10.5, lx in [-13, +13] at Y = 6.4m.
  const frontWallYaw = huashiVilla.rotationY;
  for (let i = 0; i <= 11; i++) {
    const frac = i / 11;
    const lx = -13.6 + frac * 27.6;

    // Tier 1: Tall angular granite cliff buttress anchored directly under the perimeter wall brow
    const dOut1 = 2.05 + (i % 2 === 0 ? 0.25 : 0.72) + seededRange(rng, -0.18, 0.22);
    const [bx, bz] = huashiLocalToWorld(lx + seededRange(rng, -0.35, 0.35), 10.5 + dOut1);
    const buttressRY = seededRange(rng, 2.75, 3.35);
    const topTarget = seededRange(rng, 5.45, 5.98);
    pushRock(
      bx,
      bz,
      seededRange(rng, 2.35, 3.25),
      buttressRY,
      seededRange(rng, 1.85, 2.55),
      0,
      topTarget - buttressRY * 1.0,
      {
        variant: 4,
        rotX: seededRange(rng, -0.06, 0.08),
        rotY: frontWallYaw + seededRange(rng, -0.26, 0.26),
        rotZ: seededRange(rng, -0.07, 0.07),
        tint: seededRange(rng, 0.88, 1.08),
        allowCliffHugging: true
      }
    );

    // Tier 1B: Interlocking stepped horizontal rock ledge jutting out at mid-upper cliff height
    if (i < 11) {
      const midLx = lx + 1.35 + seededRange(rng, -0.25, 0.25);
      const dOutLedge = 2.95 + seededRange(rng, -0.25, 0.55);
      const [lxW, lzW] = huashiLocalToWorld(midLx, 10.5 + dOutLedge);
      const ledgeRY = seededRange(rng, 1.55, 2.15);
      const ledgeTop = seededRange(rng, 3.85, 4.95);
      pushRock(
        lxW,
        lzW,
        seededRange(rng, 2.6, 3.55),
        ledgeRY,
        seededRange(rng, 2.1, 2.85),
        0,
        ledgeTop - ledgeRY * 0.82,
        {
          variant: 5,
          rotX: seededRange(rng, -0.05, 0.09),
          rotY: frontWallYaw + seededRange(rng, -0.22, 0.22),
          rotZ: seededRange(rng, -0.06, 0.06),
          tint: seededRange(rng, 0.85, 1.06),
          allowCliffHugging: true
        }
      );
    }

    // Tier 2: Lower stepped cliff bench & sea-washed rock spur anchoring cliff toe to shoreline
    const dOut2 = 4.45 + seededRange(rng, -0.35, 0.85);
    const [tx, tz] = huashiLocalToWorld(lx + seededRange(rng, -0.5, 0.5), 10.5 + dOut2);
    const benchRY = seededRange(rng, 1.35, 2.05);
    const benchTop = seededRange(rng, 1.85, 3.05);
    pushRock(
      tx,
      tz,
      seededRange(rng, 2.4, 3.45),
      benchRY,
      seededRange(rng, 2.0, 2.85),
      0,
      benchTop - benchRY * 0.8,
      {
        variant: i % 2 === 0 ? 5 : 4,
        rotX: seededRange(rng, -0.08, 0.1),
        rotY: frontWallYaw + seededRange(rng, -0.38, 0.38),
        rotZ: seededRange(rng, -0.08, 0.08),
        tint: seededRange(rng, 0.82, 1.02),
        allowCliffHugging: true
      }
    );
  }

  // 1B. Dramatic South Promontory Corner (where SW wall meets SE wall near (50.4, 60.5))
  for (let c = 0; c < 6; c++) {
    const ang = -0.15 + (c / 5) * (Math.PI * 0.55);
    const rad = 2.3 + (c % 2) * 1.35;
    const clx = 13.0 + Math.sin(ang) * rad;
    const clz = 10.5 + Math.cos(ang) * rad;
    const [wx, wz] = huashiLocalToWorld(clx, clz);
    const ry = c % 2 === 0 ? seededRange(rng, 2.85, 3.45) : seededRange(rng, 1.75, 2.35);
    const topY = c % 2 === 0 ? seededRange(rng, 5.15, 5.85) : seededRange(rng, 2.4, 3.5);
    pushRock(
      wx,
      wz,
      seededRange(rng, 2.6, 3.6),
      ry,
      seededRange(rng, 2.2, 3.0),
      0,
      topY - ry * 0.98,
      {
        variant: c % 2 === 0 ? 4 : 5,
        rotX: seededRange(rng, -0.07, 0.07),
        rotY: frontWallYaw + ang + seededRange(rng, -0.2, 0.2),
        rotZ: seededRange(rng, -0.07, 0.07),
        tint: seededRange(rng, 0.84, 1.05),
        allowCliffHugging: true
      }
    );
  }

  // 1C. SE / East Seaward Cliff Wall (local lx = +13, lz in [-9.5, +10.0])
  const eastWallYaw = huashiVilla.rotationY + Math.PI * 0.5;
  for (let i = 0; i <= 8; i++) {
    const frac = i / 8;
    const lz = -9.0 + frac * 19.2;

    // Upper granite buttress under east perimeter wall
    const dOut1 = 2.15 + (i % 2 === 0 ? 0.2 : 0.65);
    const [bx, bz] = huashiLocalToWorld(13.0 + dOut1, lz);
    const buttressRY = seededRange(rng, 2.65, 3.25);
    const topTarget = seededRange(rng, 5.1, 5.85);
    pushRock(
      bx,
      bz,
      seededRange(rng, 2.4, 3.2),
      buttressRY,
      seededRange(rng, 1.9, 2.6),
      0,
      topTarget - buttressRY * 0.98,
      {
        variant: i % 3 === 0 ? 5 : 4,
        rotX: seededRange(rng, -0.06, 0.07),
        rotY: eastWallYaw + seededRange(rng, -0.25, 0.25),
        rotZ: seededRange(rng, -0.06, 0.06),
        tint: seededRange(rng, 0.86, 1.06),
        allowCliffHugging: true
      }
    );

    // Mid-lower stepped rock bench facing the eastern bay
    const dOut2 = 4.4 + seededRange(rng, -0.25, 0.75);
    const [tx, tz] = huashiLocalToWorld(13.0 + dOut2, lz + seededRange(rng, -0.45, 0.45));
    const benchRY = seededRange(rng, 1.45, 2.1);
    const benchTop = seededRange(rng, 1.8, 3.15);
    pushRock(
      tx,
      tz,
      seededRange(rng, 2.5, 3.4),
      benchRY,
      seededRange(rng, 2.0, 2.8),
      0,
      benchTop - benchRY * 0.82,
      {
        variant: 5,
        rotX: seededRange(rng, -0.07, 0.09),
        rotY: eastWallYaw + seededRange(rng, -0.32, 0.32),
        rotZ: seededRange(rng, -0.07, 0.07),
        tint: seededRange(rng, 0.82, 1.02),
        allowCliffHugging: true
      }
    );
  }

  // 1D. West-SW Beach-Facing Cliff Shoulder (organic rocky transition from Second Bathing Beach sand
  //     around X in [24, 33], Z in [38, 49] up to Huashi Villa's west corner!)
  const westShoulderCoords: [number, number, number, number, number, number, number][] = [
    // [lx, lz, rx, ry, rz, topY, variant]
    [-14.8, 10.6, 2.9, 2.5, 2.4, 5.45, 4],
    [-15.4, 7.8, 3.1, 2.2, 2.5, 4.95, 5],
    [-15.8, 5.0, 2.8, 1.85, 2.3, 4.25, 5],
    [-17.2, 9.6, 3.2, 1.75, 2.6, 3.35, 5],
    [-17.8, 6.6, 3.0, 1.5, 2.5, 2.85, 4],
    [-19.2, 11.4, 3.1, 1.35, 2.6, 2.35, 5],
    [-19.8, 8.2, 2.8, 1.15, 2.4, 2.15, 0]
  ];
  for (const [wlx, wlz, rx, ry, rz, topY, variant] of westShoulderCoords) {
    const [wx, wz] = huashiLocalToWorld(wlx, wlz);
    pushRock(wx, wz, rx, ry, rz, 0, topY - ry * 0.82, {
      variant,
      rotX: seededRange(rng, -0.08, 0.08),
      rotY: frontWallYaw - 0.55 + seededRange(rng, -0.3, 0.3),
      rotZ: seededRange(rng, -0.08, 0.08),
      tint: seededRange(rng, 0.86, 1.06),
      allowCliffHugging: true
    });
  }

  // 2. Hero granite cliff-guard buttress boulders aligned with layout.ts COLLIDERS cliff guards!
  const heroCliffGuards: [number, number, number, number, number][] = [
    [42.0, 57.5, 2.9, 2.15, 2.6],
    [52.0, 58.0, 3.1, 2.25, 2.7],
    [63.5, 48.0, 3.0, 2.2, 2.7],
    [64.0, 38.5, 2.7, 1.95, 2.5]
  ];
  for (const [x, z, rx, ry, rz] of heroCliffGuards) {
    pushRock(x, z, rx, ry, rz, -ry * 0.45, undefined, {
      variant: 5,
      tint: seededRange(rng, 0.88, 1.05),
      allowCliffHugging: true
    });
  }

  // 3. Huashi Cape sea-washed shoreline boulder clusters & outer surf reefs (花石樓礁石群)
  const huashiReefAnchors: [number, number, number, number, number][] = [
    // Western cove flank of Huashi Cape (facing Second Bathing Beach)
    [24.4, 39.8, 2.7, 1.3, 2.3],
    [27.0, 43.2, 3.3, 1.65, 2.6],
    [25.2, 47.2, 3.0, 1.25, 2.5],
    [29.6, 49.4, 3.8, 1.95, 3.0],
    [26.4, 52.8, 3.1, 1.15, 2.6],
    [32.0, 54.4, 4.2, 1.95, 3.2],
    [30.2, 59.2, 3.4, 1.1, 2.9],
    // Southern sea-washed shoreline boulder belt directly beneath Huashi Cliff
    [34.6, 56.2, 3.6, 1.65, 2.9],
    [37.2, 59.0, 4.4, 1.85, 3.4],
    [37.5, 63.8, 3.8, 1.1, 3.1],
    [41.4, 60.8, 4.1, 1.7, 3.2],
    [44.6, 63.0, 4.6, 1.75, 3.5],
    [47.8, 67.2, 3.6, 1.0, 3.0],
    [52.6, 63.8, 4.5, 1.75, 3.5],
    [57.2, 65.8, 3.7, 1.1, 3.1],
    [59.8, 60.5, 4.6, 1.95, 3.5],
    // Outer dramatic sea-stack reefs in surf
    [41.0, 70.8, 3.0, 1.25, 2.4],
    [53.5, 72.0, 2.8, 1.15, 2.2],
    [66.5, 64.0, 3.5, 1.3, 2.8],
    // Eastern cliff toe & reef apron
    [66.2, 54.5, 4.2, 2.1, 3.4],
    [71.6, 56.5, 3.8, 1.3, 3.1],
    [70.2, 46.2, 4.4, 1.95, 3.5],
    [75.5, 49.0, 3.4, 1.2, 2.8],
    [72.4, 38.0, 3.8, 1.7, 3.1],
    [77.8, 40.5, 3.6, 1.25, 3.0],
    [69.0, 31.2, 3.2, 1.35, 2.6]
  ];
  for (const [x, z, rx, ry, rz] of huashiReefAnchors) {
    const ty = getTerrainHeight(x, z);
    const fixedY = ty < -0.6 ? -0.32 : undefined;
    pushRock(x, z, rx, ry, rz, -ry * 0.34, fixedY, {
      variant: rng() > 0.65 ? 5 : Math.floor(rng() * 4)
    });

    // Add 2 companion jagged shoreline boulders around each anchor for natural clustered reefs
    const subCount = rng() > 0.35 ? 2 : 1;
    for (let s = 0; s < subCount; s++) {
      const ang = seededRange(rng, 0, Math.PI * 2);
      const dist = seededRange(rng, rx * 0.62, rx * 1.28);
      const sx = x + Math.cos(ang) * dist;
      const sz = z + Math.sin(ang) * dist;
      const srx = seededRange(rng, 1.1, 2.35);
      const sry = seededRange(rng, 0.6, 1.25);
      const srz = seededRange(rng, 1.0, 2.15);
      const sty = getTerrainHeight(sx, sz);
      pushRock(sx, sz, srx, sry, srz, -sry * 0.34, sty < -0.7 ? -0.4 : undefined);
    }
  }

  // 4. Western Rocky Point Reefs framing Second Bathing Beach (西岬礁石)
  const westReefAnchors: [number, number, number, number, number][] = [
    [-64.5, 42.5, 3.1, 1.4, 2.5],
    [-68.0, 46.5, 3.9, 1.8, 3.1],
    [-65.8, 51.2, 3.0, 1.15, 2.5],
    [-73.5, 49.0, 4.4, 2.1, 3.6],
    [-71.0, 55.8, 3.6, 1.25, 3.0],
    [-78.5, 53.5, 4.6, 2.0, 3.8],
    [-76.0, 61.5, 3.5, 1.15, 2.8],
    [-84.5, 50.0, 4.8, 2.2, 3.7],
    [-86.0, 58.0, 4.0, 1.4, 3.4],
    [-69.0, 62.0, 2.8, 0.95, 2.4]
  ];
  for (const [x, z, rx, ry, rz] of westReefAnchors) {
    const ty = getTerrainHeight(x, z);
    pushRock(x, z, rx, ry, rz, -ry * 0.3, ty < -0.6 ? -0.38 : undefined);
    const ang = seededRange(rng, 0, Math.PI * 2);
    const sx = x + Math.cos(ang) * rx * 0.95;
    const sz = z + Math.sin(ang) * rz * 0.95;
    const sty = getTerrainHeight(sx, sz);
    pushRock(
      sx,
      sz,
      seededRange(rng, 1.2, 2.4),
      seededRange(rng, 0.65, 1.2),
      seededRange(rng, 1.1, 2.2),
      -0.3,
      sty < -0.7 ? -0.42 : undefined
    );
  }

  // 5. Scattered barnacle & wave-breaker coastal boulders hugging the Stone Jetty base
  const jdx = JETTY.endX - JETTY.startX;
  const jdz = JETTY.endZ - JETTY.startZ;
  const jLen = JETTY.length;
  const fx = jdx / jLen;
  const fz = jdz / jLen;
  const rxDir = -fz;
  const rzDir = fx;

  for (let d = 12; d <= jLen + 1.5; d += 3.6) {
    for (const side of [-1, 1] as const) {
      if (rng() < 0.22) continue;
      const lat = side * (JETTY.width * 0.5 + seededRange(rng, 0.9, 2.2));
      const bx = JETTY.startX + fx * d + rxDir * lat;
      const bz = JETTY.startZ + fz * d + rzDir * lat;
      const brx = seededRange(rng, 0.85, 1.65);
      const bry = seededRange(rng, 0.55, 1.05);
      const brz = seededRange(rng, 0.85, 1.6);
      rocks.push({
        x: bx,
        z: bz,
        y: seededRange(rng, -0.35, 0.12),
        rx: brx,
        ry: bry,
        rz: brz,
        rotX: seededRange(rng, -0.2, 0.2),
        rotY: seededRange(rng, 0, Math.PI * 2),
        rotZ: seededRange(rng, -0.2, 0.2),
        variant: Math.floor(rng() * 4),
        tint: seededRange(rng, 0.72, 0.96)
      });
    }
  }
  // Curved wave-breaker boulders around the seaward pier head
  for (let i = 0; i < 11; i++) {
    const a = -0.35 + (i / 10) * (Math.PI + 0.7);
    const rad = JETTY.pierHeadRadius + seededRange(rng, 0.75, 1.85);
    const bx = JETTY.endX + Math.cos(a) * rad;
    const bz = JETTY.endZ + Math.sin(a) * rad;
    rocks.push({
      x: bx,
      z: bz,
      y: seededRange(rng, -0.32, 0.16),
      rx: seededRange(rng, 1.0, 1.85),
      ry: seededRange(rng, 0.65, 1.15),
      rz: seededRange(rng, 0.95, 1.7),
      rotX: seededRange(rng, -0.18, 0.18),
      rotY: seededRange(rng, 0, Math.PI * 2),
      rotZ: seededRange(rng, -0.18, 0.18),
      variant: Math.floor(rng() * 4),
      tint: seededRange(rng, 0.72, 0.94)
    });
  }

  return rocks;
}

// ============================================================================
// 1. CONTINUOUS HIGH-RESOLUTION COASTAL HILLSIDE TERRAIN
// ============================================================================

function buildCoastalTerrain(
  textures: TextureLibrary
): {
  mesh: THREE.Mesh;
  uniforms: { uTime: { value: number } };
  sampleHeight: (x: number, z: number) => number;
} {
  const width = 300;
  const depth = 280;
  const segX = 228;
  const segZ = 212;
  const cols = segX + 1;
  const stepX = width / segX;
  const stepZ = depth / segZ;

  const geom = new THREE.PlaneGeometry(width, depth, segX, segZ);
  geom.rotateX(-Math.PI / 2);

  const pos = geom.getAttribute('position');
  const uv = geom.getAttribute('uv');
  const vertCount = pos.count;

  // Pass 1: Evaluate authoritative terrain elevation strictly once per vertex
  const heights = new Float32Array(vertCount);
  for (let i = 0; i < vertCount; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = getTerrainHeight(x, z);
    heights[i] = y;
    pos.setY(i, y);
    uv.setXY(i, x / 6.0, z / 6.0);
  }

  // Bilinear height sampler shared with seabed depth baking (eliminates duplicate queries)
  const sampleHeight = (x: number, z: number): number => {
    if (z > depth * 0.5) return -4.8;
    const gx = clamp(((x + width * 0.5) / width) * segX, 0, segX - 1e-4);
    const gz = clamp(((z + depth * 0.5) / depth) * segZ, 0, segZ - 1e-4);
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const h00 = heights[iz * cols + ix];
    const h10 = heights[iz * cols + ix + 1];
    const h01 = heights[(iz + 1) * cols + ix];
    const h11 = heights[(iz + 1) * cols + ix + 1];
    const hx0 = h00 + (h10 - h00) * fx;
    const hx1 = h01 + (h11 - h01) * fx;
    return hx0 + (hx1 - hx0) * fz;
  };

  const colors = new Float32Array(vertCount * 3);
  // vec4(beachSandWeight, cliffRockWeight, wetMask, grassWeight)
  const biomeWeights = new Float32Array(vertCount * 4);

  const juyongguan = getRoadById('juyongguan');
  const jiayuguan = getRoadById('jiayuguan');
  const shanhaiguan = getRoadById('shanhaiguan');

  // Linear color palette helpers (setHex converts sRGB hex -> linear cleanly)
  const colGrassOlive = new THREE.Color('#53683f');
  const colGrassSage = new THREE.Color('#6b7b48');
  const colGrassAutumnOchre = new THREE.Color('#8c7f4a');
  const colSoilLoam = new THREE.Color('#5c523b');
  const colGinkgoLeafDust = new THREE.Color('#b89238');
  const colMapleLeafDust = new THREE.Color('#8f452d');
  const colSycamoreLeafDust = new THREE.Color('#8d723e');
  const colGardenLawn = new THREE.Color('#5c6e44');
  const colDrySand = new THREE.Color('#dbc297');
  const colDampSand = new THREE.Color('#bfa276');
  const colSeabedShallow = new THREE.Color('#9e9069');
  const colSeabedDeep = new THREE.Color('#354f52');
  const colGraniteRock = new THREE.Color('#69645e');
  const colGraniteDark = new THREE.Color('#474545');
  const colGraniteWarm = new THREE.Color('#7f7368');
  const colRoadSubbase = new THREE.Color('#5c5953');
  const tmp = new THREE.Color();
  const tmp2 = new THREE.Color();

  // Pass 2: Painterly biome coloring & weights using cached grid heights & slopes
  for (let i = 0; i < vertCount; i++) {
    const iz = Math.floor(i / cols);
    const ix = i - iz * cols;
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = heights[i];

    const hL = heights[iz * cols + Math.max(0, ix - 1)];
    const hR = heights[iz * cols + Math.min(segX, ix + 1)];
    const hD = heights[Math.max(0, iz - 1) * cols + ix];
    const hU = heights[Math.min(segZ, iz + 1) * cols + ix];
    const dhdx = (hR - hL) / ((ix === 0 || ix === segX ? 1 : 2) * stepX);
    const dhdz = (hU - hD) / ((iz === 0 || iz === segZ ? 1 : 2) * stepZ);
    const slope = Math.hypot(dhdx, dhdz);

    const huashiZoneDist = Math.hypot((x - 48) / 29, (z - 45) / 23);
    const isReefZone =
      y >= -0.35 &&
      ((huashiZoneDist < 1.15 && (z > 36 || x > 58) && y < 6.1) ||
        (x < -64 && z > 37 && y < 4.5));

    const nLarge = fbm2D(x * 0.032 + 11.3, z * 0.032 - 7.1, 3);
    const nMed = fbm2D(x * 0.11 - 4.2, z * 0.11 + 19.4, 2);
    const nFine = valueNoise2D(x * 0.34, z * 0.34);

    // 1. Base inland hillside autumn turf blend
    tmp.copy(colGrassOlive).lerp(colGrassSage, smoothstep(0.28, 0.72, nLarge));
    tmp.lerp(colGrassAutumnOchre, smoothstep(0.55, 0.88, nMed) * 0.42);
    tmp.lerp(colSoilLoam, smoothstep(0.24, 0.58, slope) * 0.55);

    // Gentle groomed courtyard turf inside villa grounds
    if (z < 58 && isNearVillaCourtyard(x, z, -0.4)) {
      tmp.lerp(colGardenLawn, 0.42);
    }

    // Subtle poetic fallen-leaf autumn edge tint & road sub-base (only inland where roads exist)
    if (z < 46) {
      if (x > -24 && x < 8) {
        const dGinkgo = distanceToSingleRoad(juyongguan, x, z);
        if (dGinkgo < 8.5) {
          const w = (1 - smoothstep(3.6, 8.5, dGinkgo)) * (0.28 + 0.32 * nMed);
          tmp.lerp(colGinkgoLeafDust, w);
        }
      }
      if (z > -38 && z < -2) {
        const dMaple = distanceToSingleRoad(jiayuguan, x, z);
        if (dMaple < 8.0) {
          const w = (1 - smoothstep(3.4, 8.0, dMaple)) * (0.24 + 0.28 * nMed);
          tmp.lerp(colMapleLeafDust, w);
        }
      }
      if (z > 4 && z < 44) {
        const dSycamore = distanceToSingleRoad(shanhaiguan, x, z);
        if (dSycamore < 8.5 && z < getSeawallZ(x) - 0.5) {
          const w = (1 - smoothstep(3.8, 8.5, dSycamore)) * (0.2 + 0.24 * nMed);
          tmp.lerp(colSycamoreLeafDust, w);
        }
      }

      let roadUnder = 0;
      for (let r = 0; r < ROADS.length; r++) {
        const road = ROADS[r];
        const d = distanceToSingleRoad(road, x, z);
        const hw = road.width * 0.5;
        if (d < hw + 1.2) {
          roadUnder = Math.max(roadUnder, 1 - smoothstep(hw * 0.85, hw + 1.2, d));
        }
      }
      if (roadUnder > 0) {
        tmp.lerp(colRoadSubbase, roadUnder * 0.65);
      }
    }

    // 2. Beach & seabed sand weight
    const seawallZ = getSeawallZ(x);
    const inBeachSpanX = smoothstep(-74, -56, x) * (1 - smoothstep(18, 32, x));
    const beachSouthMask = smoothstep(seawallZ - 0.6, seawallZ + 2.4, z);
    let beachW = inBeachSpanX * beachSouthMask;
    // Also sandy submerged seabed everywhere deep south
    if (y < 0.35 && !isReefZone) {
      beachW = Math.max(beachW, (1 - smoothstep(-0.2, 0.4, y)) * 0.72);
    }

    // 3. Huashi Cape & West Point granite cliff rock weight
    const huashiDist = Math.hypot((x - 48) / 29.5, (z - 44.5) / 23.0);
    let rockW = 0;
    if (huashiDist < 1.28 && (z > 30 || x > 56)) {
      const edgeMask = smoothstep(0.62, 1.05, huashiDist) * (1 - smoothstep(1.12, 1.32, huashiDist));
      const slopeRock = smoothstep(0.28, 0.72, slope);
      const lowRock = 1 - smoothstep(3.8, 6.2, y);
      rockW = Math.max(rockW, clamp(Math.max(edgeMask * 0.85, slopeRock * 1.1, lowRock * 0.9), 0, 1));
    }
    if (x < -58 && z > 35) {
      const westMask = smoothstep(-58, -68, x) * smoothstep(34, 42, z);
      rockW = Math.max(rockW, westMask * clamp(0.45 + slope * 1.15, 0, 1));
    }
    if (isReefZone) {
      rockW = Math.max(rockW, 0.86);
    }
    // Keep Huashi Villa's flat courtyard lawn subtly green-stone rather than bare dark cliff
    if (y > 6.0 && isNearVillaCourtyard(x, z, -0.6)) {
      rockW *= 0.28;
    }

    // Blend beach sand color
    if (beachW > 0.001) {
      tmp2.copy(colDrySand);
      // Warm ripple variation
      tmp2.lerp(colDampSand, smoothstep(1.25, 0.15, y) * 0.75 + (nFine - 0.5) * 0.12);
      if (y < 0.0) {
        tmp2.lerp(colSeabedShallow, smoothstep(0.0, -1.2, y) * 0.75);
        tmp2.lerp(colSeabedDeep, smoothstep(-1.0, -4.4, y) * 0.92);
      }
      tmp.lerp(tmp2, beachW * (1 - rockW * 0.75));
    }

    // Blend Laoshan coastal granite cliff rock color
    if (rockW > 0.001) {
      tmp2.copy(colGraniteRock).lerp(colGraniteWarm, nLarge * 0.65);
      tmp2.lerp(colGraniteDark, smoothstep(0.45, 0.95, slope) * 0.6 + (1 - smoothstep(-0.3, 0.75, y)) * 0.55);
      tmp.lerp(tmp2, rockW);
    }

    // Subtle natural micro-value variation so terrain never looks uniform
    const micro = 0.94 + nFine * 0.12;
    colors[i * 3] = tmp.r * micro;
    colors[i * 3 + 1] = tmp.g * micro;
    colors[i * 3 + 2] = tmp.b * micro;

    const wetMask = 1 - smoothstep(-0.1, 0.62, y);
    const grassW = clamp(1 - beachW - rockW, 0, 1);
    biomeWeights[i * 4] = beachW * (1 - rockW * 0.7);
    biomeWeights[i * 4 + 1] = rockW;
    biomeWeights[i * 4 + 2] = wetMask;
    biomeWeights[i * 4 + 3] = grassW;
  }

  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setAttribute('aBiomeWeights', new THREE.BufferAttribute(biomeWeights, 4));
  geom.computeVertexNormals();

  const uniforms = {
    uTime: { value: 0 },
    uBeachSandMap: { value: textures.beachSand.map }
  };

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.02
  });

  mat.customProgramCacheKey = () => 'badaguan-coastal-terrain-v1';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uBeachSandMap = uniforms.uBeachSandMap;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aBiomeWeights;
        varying vec3 vTerrainWorldPos;
        varying vec4 vBiomeWeights;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vTerrainWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vBiomeWeights = aBiomeWeights;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform sampler2D uBeachSandMap;
        varying vec3 vTerrainWorldPos;
        varying vec4 vBiomeWeights;

        float terrainHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float terrainNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(terrainHash(i), terrainHash(i + vec2(1.0, 0.0)), u.x),
            mix(terrainHash(i + vec2(0.0, 1.0)), terrainHash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 wpXZ = vTerrainWorldPos.xz;
        float distFade = 1.0 - smoothstep(45.0, 175.0, length(vViewPosition));

        // 1. Crisp beach sand ripples from procedural beachSand texture
        float sandW = vBiomeWeights.x;
        if (sandW > 0.01) {
          vec3 sandTex = texture2D(uBeachSandMap, wpXZ * 0.145).rgb;
          vec3 sandFine = texture2D(uBeachSandMap, wpXZ * 0.42 + vec2(0.37, 0.19)).rgb;
          vec3 sandDetail = mix(sandTex, sandFine, 0.35);
          // High-pass ripple & shell-sparkle modulation centered around 1.0 to keep sand luminous golden
          vec3 sandRippleMod = clamp(sandDetail / vec3(0.68, 0.54, 0.32), 0.72, 1.28);
          diffuseColor.rgb *= mix(vec3(1.0), sandRippleMod, sandW * (0.55 + 0.35 * distFade));
        }

        // 2. Organic hillside turf & moss micro-variation
        float grassW = vBiomeWeights.w;
        if (grassW > 0.01) {
          float g1 = terrainNoise(wpXZ * 0.72);
          float g2 = terrainNoise(wpXZ * 2.65);
          float g3 = terrainNoise(wpXZ * 8.4);
          float turfGrain = (g1 * 0.45 + g2 * 0.35 + g3 * 0.20) - 0.5;
          diffuseColor.rgb *= 1.0 + turfGrain * 0.24 * grassW * (0.4 + 0.6 * distFade);
        }

        // 3. Stratified Laoshan granite rock grain & fracture crevices on cliffs & headlands
        float rockW = vBiomeWeights.y;
        if (rockW > 0.01) {
          float strataWarp = terrainNoise(wpXZ * 0.28) * 1.4;
          float strata = terrainNoise(vec2(wpXZ.x * 0.42 + wpXZ.y * 0.34, vTerrainWorldPos.y * 2.9 + strataWarp));
          float beds = sin(vTerrainWorldPos.y * 5.8 + strataWarp * 2.4) * 0.5 + 0.5;
          float fissure = smoothstep(0.24, 0.68, terrainNoise(wpXZ * 1.15 + vec2(vTerrainWorldPos.y * 0.55)));
          float speck = terrainNoise(wpXZ * 5.2);
          float rockPattern = (strata * 0.45 + beds * 0.28 + speck * 0.27) - 0.5;
          diffuseColor.rgb *= (0.84 + 0.22 * fissure) * (1.0 + rockPattern * 0.42 * rockW);
        }

        // 4. Dynamic wet-shoreline swash darkening (waves lapping sand & reefs)
        float swashWave = sin(wpXZ.x * 0.08 + uTime * 1.15) * 0.07 + 0.04;
        float wetShore = (1.0 - smoothstep(0.02, 0.56 + swashWave, vTerrainWorldPos.y)) *
          smoothstep(-1.8, -0.05, vTerrainWorldPos.y) *
          clamp(sandW + rockW, 0.0, 1.0);
        diffuseColor.rgb *= mix(1.0, 0.68, wetShore * 0.85);`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float swashRoughWave = sin(vTerrainWorldPos.x * 0.08 + uTime * 1.15) * 0.07 + 0.04;
        float wetBand = (1.0 - smoothstep(0.0, 0.52 + swashRoughWave, vTerrainWorldPos.y)) *
          smoothstep(-1.4, -0.02, vTerrainWorldPos.y) *
          clamp(vBiomeWeights.x + vBiomeWeights.y, 0.0, 1.0);
        float dryRough = mix(0.94, 0.84, vBiomeWeights.x);
        dryRough = mix(dryRough, 0.78, vBiomeWeights.y);
        roughnessFactor = mix(dryRough, 0.20, wetBand);`
      );
  };

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'CoastalTerrain';
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  return { mesh, uniforms, sampleHeight };
}

// ============================================================================
// 2. ICONIC BADAGUAN ROADS, GRANITE CURBS, SIDEWALKS, & WOODEN BOARDWALK
// ============================================================================

/** Build a smooth spline-conforming paved ribbon mesh with real-world meter UVs. */
function buildRoadSurfaceGeometry(
  stations: RoadStation[],
  halfWidth: number,
  yOffset: number,
  crownHeight: number,
  uRepeatAcross: number,
  vTileMeters: number,
  startT = 0,
  endT = 1,
  useGutterShading = true
): THREE.BufferGeometry {
  const filtered = stations.filter((s) => s.t >= startT - 1e-4 && s.t <= endT + 1e-4);
  if (filtered.length < 2) return new THREE.BufferGeometry();

  // 5 lateral slices across road width for crisp camber & terrain conformance
  const latFrac = [-1.0, -0.55, 0.0, 0.55, 1.0];
  const crownProfile = [0.0, 0.75, 1.0, 0.75, 0.0];
  const cols = latFrac.length;
  const rows = filtered.length;

  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const colors = new Float32Array(rows * cols * 3);
  const indices: number[] = [];

  for (let r = 0; r < rows; r++) {
    const st = filtered[r];
    for (let c = 0; c < cols; c++) {
      const f = latFrac[c];
      const vx = st.x + st.nx * (f * halfWidth);
      const vz = st.z + st.nz * (f * halfWidth);
      const groundY = getTerrainHeight(vx, vz);
      const edgeDip = Math.abs(f) > 0.95 ? -0.012 : 0;
      const vy = groundY + yOffset + crownProfile[c] * crownHeight + edgeDip;

      const idx = r * cols + c;
      positions[idx * 3] = vx;
      positions[idx * 3 + 1] = vy;
      positions[idx * 3 + 2] = vz;

      uvs[idx * 2] = (f * 0.5 + 0.5) * uRepeatAcross;
      uvs[idx * 2 + 1] = st.arcLen / vTileMeters;

      // Subtle authentic weathered curb-gutter darkening & autumn edge warmth
      if (useGutterShading) {
        const edgeFactor = Math.abs(f);
        const shade = 1.0 - edgeFactor * edgeFactor * 0.14;
        colors[idx * 3] = shade;
        colors[idx * 3 + 1] = shade * (1.0 - edgeFactor * 0.02);
        colors[idx * 3 + 2] = shade * (1.0 - edgeFactor * 0.04);
      } else {
        colors[idx * 3] = 1;
        colors[idx * 3 + 1] = 1;
        colors[idx * 3 + 2] = 1;
      }
    }
  }

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = (r + 1) * cols + c;
      const e = d + 1;
      // Right-hand counter-clockwise upward winding
      indices.push(a, b, d);
      indices.push(b, e, d);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

/**
 * Builds raised 3D granite curbstones (with inner face, beveled top, outer face, and end caps)
 * along continuous valid runs, automatically breaking cleanly at road intersections!
 */
function buildCurbGeometryForSide(
  road: RoadCurveSpec,
  stations: RoadStation[],
  side: -1 | 1,
  curbWidth = 0.24,
  curbHeight = 0.145,
  curbBuried = 0.14
): THREE.BufferGeometry[] {
  const halfW = road.width * 0.5;
  const innerOffset = side * halfW;
  const outerOffset = side * (halfW + curbWidth);
  const runs: RoadStation[][] = [];
  let current: RoadStation[] = [];

  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const midOff = side * (halfW + curbWidth * 0.5);
    const px = st.x + st.nx * midOff;
    const pz = st.z + st.nz * midOff;

    // Skip curb segments crossing another road intersection or villa gate endpoint
    const other = signedEdgeDistToOtherRoads(px, pz, road.id);
    const blockedByIntersection = other.edgeDist < 0.72;
    const blockedHuashiEnd = road.id === 'huashi_cape' && (st.t < 0.22 || st.t > 0.94);
    const blockedJuyongEnd = road.id === 'juyongguan' && st.t > 0.955;

    if (blockedByIntersection || blockedHuashiEnd || blockedJuyongEnd) {
      if (current.length >= 2) runs.push(current);
      current = [];
    } else {
      current.push(st);
    }
  }
  if (current.length >= 2) runs.push(current);

  const pieces: THREE.BufferGeometry[] = [];
  const tileM = 2.2;

  for (const run of runs) {
    // 4-point cross-section per station:
    // 0: inner bottom (buried below road), 1: inner top, 2: outer top, 3: outer bottom (buried)
    const rows = run.length;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const pushRing = (st: RoadStation) => {
      const ix = st.x + st.nx * innerOffset;
      const iz = st.z + st.nz * innerOffset;
      const ox = st.x + st.nx * outerOffset;
      const oz = st.z + st.nz * outerOffset;
      const iy = getTerrainHeight(ix, iz);
      const oy = getTerrainHeight(ox, oz);
      // Keep top crisp along road grade, or stepped cleanly up when retaining a hillside bank
      const topY = Math.max(iy, Math.min(oy, iy + 0.24)) + curbHeight;
      const outerBotY = Math.min(iy, oy) - curbBuried;

      const v = st.arcLen / tileM;
      // Order cross-section so outward normals point UP and AWAY from road cleanly regardless of side
      if (side > 0) {
        positions.push(
          ix, iy - curbBuried, iz,
          ix, topY, iz,
          ox, topY - 0.01, oz,
          ox, outerBotY, oz
        );
      } else {
        positions.push(
          ox, outerBotY, oz,
          ox, topY - 0.01, oz,
          ix, topY, iz,
          ix, iy - curbBuried, iz
        );
      }
      uvs.push(0, v, 0.28, v, 0.62, v, 1.0, v);
    };

    for (let r = 0; r < rows; r++) {
      pushRing(run[r]);
    }

    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < 3; c++) {
        const a = r * 4 + c;
        const b = a + 1;
        const d = (r + 1) * 4 + c;
        const e = d + 1;
        indices.push(a, b, d);
        indices.push(b, e, d);
      }
    }

    // Outward-facing end caps so curb breaks at intersections look like solid chiseled granite blocks
    const firstBase = 0;
    indices.push(firstBase, firstBase + 2, firstBase + 1);
    indices.push(firstBase, firstBase + 3, firstBase + 2);
    const lastBase = (rows - 1) * 4;
    indices.push(lastBase, lastBase + 1, lastBase + 2);
    indices.push(lastBase, lastBase + 2, lastBase + 3);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    g.computeVertexNormals();
    pieces.push(g);
  }

  return pieces;
}

/**
 * Builds weathered granite cobble sidewalks outside the curbstones, dynamically trimmed
 * at road intersections, villa courtyards, and Shanhaiguan's coastal boardwalk adjacency.
 */
function buildSidewalkGeometryForSide(
  road: RoadCurveSpec,
  stations: RoadStation[],
  side: -1 | 1,
  curbWidth = 0.24,
  baseSidewalkWidth = 1.75
): THREE.BufferGeometry[] {
  const halfW = road.width * 0.5;
  const boardwalk = getRoadById('beach_boardwalk');

  interface SidewalkNode {
    st: RoadStation;
    width: number;
  }
  const runs: SidewalkNode[][] = [];
  let current: SidewalkNode[] = [];

  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const startOff = halfW + curbWidth;
    const testX = st.x + st.nx * (side * (startOff + 0.55));
    const testZ = st.z + st.nz * (side * (startOff + 0.55));

    const other = signedEdgeDistToOtherRoads(testX, testZ, road.id);
    const blockedByRoad =
      other.edgeDist < 0.35 && !(road.id === 'shanhaiguan' && other.otherId === 'beach_boardwalk');
    const blockedEnd =
      (road.id === 'juyongguan' && st.t > 0.94) ||
      (road.id === 'huashi_cape' && (st.t < 0.25 || st.t > 0.94));

    let width = baseSidewalkWidth;

    // On Shanhaiguan Rd south side, gracefully trim sidewalk so it kisses beach_boardwalk cleanly!
    if (road.id === 'shanhaiguan' && side > 0) {
      const innerEdgeX = st.x + st.nx * startOff;
      const innerEdgeZ = st.z + st.nz * startOff;
      const dBoardwalkEdge = distanceToSingleRoad(boardwalk, innerEdgeX, innerEdgeZ) - boardwalk.width * 0.5;
      if (dBoardwalkEdge < baseSidewalkWidth + 0.1) {
        width = Math.max(0, Math.min(baseSidewalkWidth, dBoardwalkEdge - 0.08));
      }
    }

    // Avoid overlapping any villa courtyard wall
    const innerEdgeX = st.x + st.nx * (side * startOff);
    const innerEdgeZ = st.z + st.nz * (side * startOff);
    const yInner = getTerrainHeight(innerEdgeX, innerEdgeZ);

    let outerX = st.x + st.nx * (side * (startOff + width));
    let outerZ = st.z + st.nz * (side * (startOff + width));
    if (isNearVillaCourtyard(outerX, outerZ, 0.25)) {
      width = Math.min(width, 0.95);
      outerX = st.x + st.nx * (side * (startOff + width));
      outerZ = st.z + st.nz * (side * (startOff + width));
    }

    // Prevent cobble sidewalks from stretching up steep hillside embankments (e.g. Shanhaiguan Rd
    // south flank alongside Huashi Cape's ramp): trim gracefully or stop cleanly at the granite curb!
    let blockedBySteepBank = false;
    if (width >= 0.35) {
      const yOuter = getTerrainHeight(outerX, outerZ);
      const rise = yOuter - yInner;
      const crossGrade = Math.abs(rise) / Math.max(width, 0.35);
      if (rise > 0.25 || crossGrade > 0.22) {
        // Try narrowing into a level roadside shoulder; if bank climbs steeply immediately, omit sidewalk
        let fitted = 0;
        for (const frac of [0.65, 0.45]) {
          const candW = width * frac;
          if (candW < 0.55) continue;
          const cx = st.x + st.nx * (side * (startOff + candW));
          const cz = st.z + st.nz * (side * (startOff + candW));
          const cy = getTerrainHeight(cx, cz);
          if (cy - yInner <= 0.2 && Math.abs(cy - yInner) / candW <= 0.2) {
            fitted = candW;
            break;
          }
        }
        if (fitted >= 0.55) {
          width = fitted;
        } else {
          blockedBySteepBank = true;
        }
      }
    }

    // On Shanhaiguan south bank facing Huashi Cape path wedge, keep a crisp granite retaining curb
    // meeting lush turf rather than a pinched cobble strip next to Huashi Cape ramp
    if (road.id === 'shanhaiguan' && side > 0 && st.x > 24.5 && st.x < 50.0) {
      blockedBySteepBank = true;
    }

    if (blockedByRoad || blockedEnd || blockedBySteepBank || width < 0.35) {
      if (current.length >= 2) runs.push(current);
      current = [];
    } else {
      current.push({ st, width });
    }
  }
  if (current.length >= 2) runs.push(current);

  const pieces: THREE.BufferGeometry[] = [];
  const tileM = 2.6;

  for (const run of runs) {
    const rows = run.length;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let r = 0; r < rows; r++) {
      const { st, width } = run[r];
      const offIn = side * (halfW + curbWidth - 0.02);
      const offOut = side * (halfW + curbWidth + width);
      const offSkirt = side * (halfW + curbWidth + width + 0.14);

      const x0 = st.x + st.nx * offIn;
      const z0 = st.z + st.nz * offIn;
      const x1 = st.x + st.nx * offOut;
      const z1 = st.z + st.nz * offOut;
      const x2 = st.x + st.nx * offSkirt;
      const z2 = st.z + st.nz * offSkirt;

      const y0 = getTerrainHeight(x0, z0) + 0.125;
      const rawY1 = getTerrainHeight(x1, z1) + 0.105;
      const y1 = clamp(rawY1, y0 - 0.24, y0 + 0.22);
      const y2 = Math.min(getTerrainHeight(x2, z2), y1) - 0.14;

      const v = st.arcLen / tileM;
      const uW = width / tileM;

      if (side > 0) {
        positions.push(x0, y0, z0, x1, y1, z1, x2, y2, z2);
        uvs.push(0, v, uW, v, uW + 0.1, v);
      } else {
        positions.push(x2, y2, z2, x1, y1, z1, x0, y0, z0);
        uvs.push(uW + 0.1, v, uW, v, 0, v);
      }
    }

    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < 2; c++) {
        const a = r * 3 + c;
        const b = a + 1;
        const d = (r + 1) * 3 + c;
        const e = d + 1;
        indices.push(a, b, d);
        indices.push(b, e, d);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    g.computeVertexNormals();
    pieces.push(g);
  }

  return pieces;
}

/** Builds the wooden seaside boardwalk deck (濱海木棧道) with fascia edge beams & sleepers. */
function buildCoastalBoardwalk(textures: TextureLibrary): THREE.Group {
  const group = new THREE.Group();
  group.name = 'CoastalBoardwalk';

  const boardwalk = getRoadById('beach_boardwalk');
  const stations = sampleRoadStations(boardwalk, 1.15);
  const halfW = boardwalk.width * 0.5;
  const deckLift = 0.11;
  const deckThickness = 0.18;

  // 1. Main timber plank top surface (planks running transversely across the boardwalk!)
  const rows = stations.length;
  const topPos = new Float32Array(rows * 2 * 3);
  const topUV = new Float32Array(rows * 2 * 2);
  const topIdx: number[] = [];

  for (let r = 0; r < rows; r++) {
    const st = stations[r];
    const centerY = getTerrainHeight(st.x, st.z) + deckLift;
    const lx = st.x - st.nx * halfW;
    const lz = st.z - st.nz * halfW;
    const rx = st.x + st.nx * halfW;
    const rz = st.z + st.nz * halfW;

    const i0 = r * 2;
    topPos[i0 * 3] = lx;
    topPos[i0 * 3 + 1] = centerY;
    topPos[i0 * 3 + 2] = lz;
    topPos[(i0 + 1) * 3] = rx;
    topPos[(i0 + 1) * 3 + 1] = centerY;
    topPos[(i0 + 1) * 3 + 2] = rz;

    // woodPlank texture has horizontal planks along U, seams along V -> swap U/V for transverse planks!
    const vAlong = st.arcLen / 2.2;
    topUV[i0 * 2] = 0;
    topUV[i0 * 2 + 1] = vAlong;
    topUV[(i0 + 1) * 2] = boardwalk.width / 2.6;
    topUV[(i0 + 1) * 2 + 1] = vAlong;
  }

  for (let r = 0; r < rows - 1; r++) {
    const a = r * 2;
    const b = a + 1;
    const d = (r + 1) * 2;
    const e = d + 1;
    topIdx.push(a, b, d, b, e, d);
  }

  const deckGeom = new THREE.BufferGeometry();
  deckGeom.setAttribute('position', new THREE.BufferAttribute(topPos, 3));
  deckGeom.setAttribute('uv', new THREE.BufferAttribute(topUV, 2));
  deckGeom.setIndex(topIdx);
  deckGeom.computeVertexNormals();

  const deckMat = new THREE.MeshStandardMaterial({
    map: textures.woodPlank.map,
    bumpMap: textures.woodPlank.bumpMap,
    bumpScale: 0.03,
    roughness: 0.82,
    metalness: 0.04,
    color: new THREE.Color('#efe4d4')
  });

  const deckMesh = new THREE.Mesh(deckGeom, deckMat);
  deckMesh.receiveShadow = true;
  deckMesh.castShadow = true;
  group.add(deckMesh);

  // 2. Dark weathered timber edge fascia beams flanking north & south edges
  const beamPieces: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1] as const) {
    const bPos: number[] = [];
    const bUV: number[] = [];
    const bIdx: number[] = [];
    const beamIn = side * (halfW - 0.02);
    const beamOut = side * (halfW + 0.13);

    for (let r = 0; r < rows; r++) {
      const st = stations[r];
      const topY = getTerrainHeight(st.x, st.z) + deckLift + 0.025;
      const botY = topY - deckThickness - 0.18;

      const ix = st.x + st.nx * beamIn;
      const iz = st.z + st.nz * beamIn;
      const ox = st.x + st.nx * beamOut;
      const oz = st.z + st.nz * beamOut;
      const u = st.arcLen / 3.0;

      if (side > 0) {
        bPos.push(ix, topY, iz, ox, topY, oz, ox, botY, oz);
      } else {
        bPos.push(ox, botY, oz, ox, topY, oz, ix, topY, iz);
      }
      bUV.push(u, 0, u, 0.3, u, 1.0);
    }

    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < 2; c++) {
        const a = r * 3 + c;
        const b = a + 1;
        const d = (r + 1) * 3 + c;
        const e = d + 1;
        bIdx.push(a, b, d, b, e, d);
      }
    }

    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(bPos, 3));
    bg.setAttribute('uv', new THREE.Float32BufferAttribute(bUV, 2));
    bg.setIndex(bIdx);
    bg.computeVertexNormals();
    beamPieces.push(bg);
  }

  // Cross-sleepers every 4.5m anchoring deck cleanly into terrain
  for (let i = 0; i < stations.length; i += 4) {
    const st = stations[i];
    const sleeper = createBoxWorldUV(boardwalk.width + 0.16, 0.34, 0.24, 2.0);
    const angle = Math.atan2(st.tx, st.tz);
    sleeper.rotateY(angle + Math.PI * 0.5);
    const y = getTerrainHeight(st.x, st.z) + deckLift - 0.19;
    sleeper.translate(st.x, y, st.z);
    beamPieces.push(sleeper);
  }

  const beamMat = new THREE.MeshStandardMaterial({
    map: textures.woodPlank.map,
    bumpMap: textures.woodPlank.bumpMap,
    bumpScale: 0.025,
    roughness: 0.88,
    color: new THREE.Color('#6c533c')
  });
  const beamMesh = new THREE.Mesh(mergeGeometries(beamPieces), beamMat);
  beamMesh.castShadow = true;
  beamMesh.receiveShadow = true;
  group.add(beamMesh);

  return group;
}

function buildRoadsAndBoardwalk(textures: TextureLibrary): THREE.Group {
  const group = new THREE.Group();
  group.name = 'BadaguanRoads';

  // Shared granite curb & sidewalk materials
  const curbMat = new THREE.MeshStandardMaterial({
    map: textures.graniteCobble.map,
    bumpMap: textures.graniteCobble.bumpMap,
    bumpScale: 0.028,
    roughnessMap: textures.graniteCobble.roughnessMap,
    roughness: 0.84,
    metalness: 0.04,
    color: new THREE.Color('#dcd5ca')
  });

  const sidewalkMat = new THREE.MeshStandardMaterial({
    map: textures.graniteCobble.map,
    bumpMap: textures.graniteCobble.bumpMap,
    bumpScale: 0.032,
    roughnessMap: textures.graniteCobble.roughnessMap,
    roughness: 0.88,
    metalness: 0.03,
    color: new THREE.Color('#c8bfb2')
  });

  const allCurbGeoms: THREE.BufferGeometry[] = [];
  const allSidewalkGeoms: THREE.BufferGeometry[] = [];

  // Asphalt elevation priority avoids any Z-fighting at 4-way & T-junction intersections
  const asphaltSpecs: {
    id: RoadId;
    yOffset: number;
    polygonOffsetFactor: number;
    sidewalkWidth: number;
  }[] = [
    { id: 'shanhaiguan', yOffset: 0.058, polygonOffsetFactor: -3, sidewalkWidth: 1.85 },
    { id: 'juyongguan', yOffset: 0.048, polygonOffsetFactor: -2, sidewalkWidth: 1.75 },
    { id: 'jiayuguan', yOffset: 0.038, polygonOffsetFactor: -1, sidewalkWidth: 1.65 }
  ];

  for (const spec of asphaltSpecs) {
    const road = getRoadById(spec.id);
    const stations = sampleRoadStations(road, 1.25);

    const roadGeom = buildRoadSurfaceGeometry(
      stations,
      road.width * 0.5,
      spec.yOffset,
      0.028,
      1.35,
      5.2,
      0,
      1,
      true
    );

    const asphaltMat = new THREE.MeshStandardMaterial({
      map: textures.asphaltRoad.map,
      bumpMap: textures.asphaltRoad.bumpMap,
      bumpScale: 0.024,
      roughnessMap: textures.asphaltRoad.roughnessMap,
      roughness: 0.9,
      metalness: 0.04,
      vertexColors: true,
      color: new THREE.Color('#cbc8c4'),
      polygonOffset: true,
      polygonOffsetFactor: spec.polygonOffsetFactor,
      polygonOffsetUnits: -1
    });

    const roadMesh = new THREE.Mesh(roadGeom, asphaltMat);
    roadMesh.name = `Road_${road.id}`;
    roadMesh.receiveShadow = true;
    group.add(roadMesh);

    // Raised granite curbstones + granite cobble sidewalks on both sides
    for (const side of [-1, 1] as const) {
      allCurbGeoms.push(...buildCurbGeometryForSide(road, stations, side, 0.24, 0.145, 0.15));
      allSidewalkGeoms.push(
        ...buildSidewalkGeometryForSide(road, stations, side, 0.24, spec.sidewalkWidth)
      );
    }
  }

  // Huashi Cape Path (黃海路 · 海岬小徑): weathered granite cobble climb to Huashi Villa gate
  const huashiRoad = getRoadById('huashi_cape');
  const huashiStations = sampleRoadStations(huashiRoad, 0.95);
  const huashiGeom = buildRoadSurfaceGeometry(
    huashiStations,
    huashiRoad.width * 0.5,
    0.052,
    0.02,
    1.7,
    2.7,
    0.19, // Starts cleanly right at Shanhaiguan Rd south edge!
    1.0,
    true
  );
  const huashiPathMat = new THREE.MeshStandardMaterial({
    map: textures.graniteCobble.map,
    bumpMap: textures.graniteCobble.bumpMap,
    bumpScale: 0.038,
    roughnessMap: textures.graniteCobble.roughnessMap,
    roughness: 0.86,
    metalness: 0.04,
    vertexColors: true,
    color: new THREE.Color('#cfc6b8'),
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -1
  });
  const huashiMesh = new THREE.Mesh(huashiGeom, huashiPathMat);
  huashiMesh.name = 'Road_huashi_cape';
  huashiMesh.receiveShadow = true;
  group.add(huashiMesh);

  // Deep-rooted dressed granite hillside retaining curbs flanking Huashi Cape ramp
  for (const side of [-1, 1] as const) {
    allCurbGeoms.push(...buildCurbGeometryForSide(huashiRoad, huashiStations, side, 0.3, 0.19, 0.55));
  }

  // Merge all curbstones and sidewalks into just 2 ultra-fast draw calls
  if (allCurbGeoms.length > 0) {
    const curbMesh = new THREE.Mesh(mergeGeometries(allCurbGeoms), curbMat);
    curbMesh.name = 'RoadGraniteCurbs';
    curbMesh.castShadow = true;
    curbMesh.receiveShadow = true;
    group.add(curbMesh);
    for (const g of allCurbGeoms) g.dispose();
  }

  if (allSidewalkGeoms.length > 0) {
    const sidewalkMesh = new THREE.Mesh(mergeGeometries(allSidewalkGeoms), sidewalkMat);
    sidewalkMesh.name = 'RoadGraniteSidewalks';
    sidewalkMesh.receiveShadow = true;
    group.add(sidewalkMesh);
    for (const g of allSidewalkGeoms) g.dispose();
  }

  // Coastal Wooden Boardwalk (濱海木棧道)
  group.add(buildCoastalBoardwalk(textures));

  return group;
}

// ============================================================================
// 3. GRANITE SEAWALL, BEACH STAIRCASES, & COASTAL SAFETY RAILINGS
// ============================================================================

interface SeawallSample {
  x: number;
  z: number;
  topY: number;
  arcLen: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
}

function buildSeawallPromenade(textures: TextureLibrary): THREE.Group {
  const group = new THREE.Group();
  group.name = 'SeawallPromenade';

  // Curved seawall crest hugging the exact southern edge of beach_boardwalk from West Point to Huashi Cape
  const boardwalk = getRoadById('beach_boardwalk');
  const bwStations = sampleRoadStations(boardwalk, 1.0);
  const getBoardwalkSouthZ = (x: number): number | null => {
    const first = bwStations[0];
    const last = bwStations[bwStations.length - 1];
    if (x < first.x || x > last.x) return null;
    for (let i = 0; i < bwStations.length - 1; i++) {
      const a = bwStations[i];
      const b = bwStations[i + 1];
      if (x >= a.x && x <= b.x) {
        const f = b.x !== a.x ? (x - a.x) / (b.x - a.x) : 0;
        const cz = a.z + (b.z - a.z) * f;
        return cz + boardwalk.width * 0.5 + 0.36;
      }
    }
    return null;
  };

  const startX = -65.5;
  const endX = 22.5;
  const steps = 88;
  const rawPts: { x: number; z: number }[] = [];

  for (let i = 0; i <= steps; i++) {
    const x = startX + (endX - startX) * (i / steps);
    const bwSouthZ = getBoardwalkSouthZ(x);
    let z: number;
    if (bwSouthZ !== null) {
      z = bwSouthZ;
    } else if (x < bwStations[0].x) {
      const edgeZ = bwStations[0].z + boardwalk.width * 0.5 + 0.36;
      const t = clamp((bwStations[0].x - x) / 3.5, 0, 1);
      z = edgeZ * (1 - t) + (getSeawallZ(x) + 1.25) * t;
    } else {
      const last = bwStations[bwStations.length - 1];
      const edgeZ = last.z + boardwalk.width * 0.5 + 0.36;
      const t = clamp((x - last.x) / 4.5, 0, 1);
      z = edgeZ * (1 - t) + (getSeawallZ(x) + 1.55) * t;
    }
    rawPts.push({ x, z });
  }

  const samples: SeawallSample[] = [];
  let arcLen = 0;
  for (let i = 0; i < rawPts.length; i++) {
    if (i > 0) {
      arcLen += Math.hypot(rawPts[i].x - rawPts[i - 1].x, rawPts[i].z - rawPts[i - 1].z);
    }
    const prev = rawPts[Math.max(0, i - 1)];
    const next = rawPts[Math.min(rawPts.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    // Right-hand normal points South (+Z, seaward)
    const nx = -tz;
    const nz = tx;

    // Match boardwalk crest height smoothly
    const inlandRefY = getTerrainHeight(rawPts[i].x - nx * 1.4, rawPts[i].z - nz * 1.4);
    const crestY = Math.max(2.96, inlandRefY + 0.08);
    samples.push({ x: rawPts[i].x, z: rawPts[i].z, topY: crestY, arcLen, tx, tz, nx, nz });
  }

  // Three open granite staircases descending cleanly onto Second Bathing Beach sand
  const staircases: { centerX: number; halfWidth: number }[] = [
    { centerX: -46.0, halfWidth: 2.0 },
    { centerX: -16.0, halfWidth: 2.65 }, // Grand main stairs aligned straight with the Stone Jetty!
    { centerX: 7.5, halfWidth: 1.95 }
  ];

  const isInStairOpening = (x: number, pad = 0): boolean => {
    for (const s of staircases) {
      if (Math.abs(x - s.centerX) < s.halfWidth + pad) return true;
    }
    return false;
  };

  // 1. Battered Mushroom-Stone Masonry Retaining Wall (蘑菇石防波堤)
  // Built in unbroken runs between the three beach staircases
  const wallGeoms: THREE.BufferGeometry[] = [];
  const copingGeoms: THREE.BufferGeometry[] = [];
  const runs: SeawallSample[][] = [];
  let curRun: SeawallSample[] = [];

  for (const s of samples) {
    if (isInStairOpening(s.x, -0.15)) {
      if (curRun.length >= 2) runs.push(curRun);
      curRun = [];
    } else {
      curRun.push(s);
    }
  }
  if (curRun.length >= 2) runs.push(curRun);

  for (const run of runs) {
    const rows = run.length;
    const wPos: number[] = [];
    const wUV: number[] = [];
    const wIdx: number[] = [];

    const cPos: number[] = [];
    const cUV: number[] = [];
    const cIdx: number[] = [];

    for (let r = 0; r < rows; r++) {
      const s = run[r];
      const topY = s.topY;
      const botY = 0.75; // Extends deeply below beach sand (Y≈2.0) so it never floats!

      // Back top, front top, front battered toe, back buried
      const bx = s.x - s.nx * 0.42;
      const bz = s.z - s.nz * 0.42;
      const ftx = s.x + s.nx * 0.24;
      const ftz = s.z + s.nz * 0.24;
      const fbx = s.x + s.nx * 0.64; // Authentic coastal battered masonry slope
      const fbz = s.z + s.nz * 0.64;

      const u = s.arcLen / 2.6;
      const vH = (topY - botY) / 2.4;

      wPos.push(
        bx, topY, bz,
        ftx, topY, ftz,
        fbx, botY, fbz,
        bx, botY, bz
      );
      wUV.push(u, 0, u, 0.25, u, 0.25 + vH, u, 0.5 + vH);

      // Overhanging dressed granite coping stone strip along crest
      const cTop = topY + 0.13;
      const cBot = topY - 0.02;
      const cInX = s.x - s.nx * 0.46;
      const cInZ = s.z - s.nz * 0.46;
      const cOutX = s.x + s.nx * 0.34;
      const cOutZ = s.z + s.nz * 0.34;

      cPos.push(
        cInX, cBot, cInZ,
        cInX, cTop, cInZ,
        cOutX, cTop, cOutZ,
        cOutX, cBot, cOutZ
      );
      cUV.push(u, 0, u, 0.2, u, 0.75, u, 1.0);
    }

    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < 3; c++) {
        const a = r * 4 + c;
        const b = a + 1;
        const d = (r + 1) * 4 + c;
        const e = d + 1;
        wIdx.push(a, b, d, b, e, d);
        cIdx.push(a, b, d, b, e, d);
      }
    }
    // Outward-facing end caps
    wIdx.push(0, 2, 1, 0, 3, 2);
    cIdx.push(0, 2, 1, 0, 3, 2);
    const lb = (rows - 1) * 4;
    wIdx.push(lb, lb + 1, lb + 2, lb, lb + 2, lb + 3);
    cIdx.push(lb, lb + 1, lb + 2, lb, lb + 2, lb + 3);

    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
    wg.setAttribute('uv', new THREE.Float32BufferAttribute(wUV, 2));
    wg.setIndex(wIdx);
    wg.computeVertexNormals();
    wallGeoms.push(wg);

    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cPos, 3));
    cg.setAttribute('uv', new THREE.Float32BufferAttribute(cUV, 2));
    cg.setIndex(cIdx);
    cg.computeVertexNormals();
    copingGeoms.push(cg);
  }

  // 2. Three Grand Granite Coastal Staircases down to Second Bathing Beach
  const stairStepGeoms: THREE.BufferGeometry[] = [];
  const cheekWallGeoms: THREE.BufferGeometry[] = [];

  for (const stair of staircases) {
    const refSample = samples.reduce((best, s) =>
      Math.abs(s.x - stair.centerX) < Math.abs(best.x - stair.centerX) ? s : best
    );
    const yaw = Math.atan2(refSample.nx, refSample.nz);
    const stepCount = 6;
    const stepWidth = stair.halfWidth * 2.0;
    const treadDepth = 0.46;
    const totalDrop = 1.08;

    for (let st = 0; st < stepCount; st++) {
      const frac = st / (stepCount - 1);
      const stepY = refSample.topY + 0.04 - frac * totalDrop;
      const forwardDist = -0.1 + st * treadDepth;
      const blockH = 0.52;
      const stepG = createBoxWorldUV(stepWidth, blockH, treadDepth + 0.08, 2.2);
      stepG.rotateY(yaw);
      stepG.translate(
        refSample.x + refSample.nx * forwardDist,
        stepY - blockH * 0.5,
        refSample.z + refSample.nz * forwardDist
      );
      stairStepGeoms.push(stepG);
    }

    // Flanking stepped mushroom-stone cheek walls on left & right of each staircase
    for (const side of [-1, 1] as const) {
      const cx = refSample.x + refSample.tx * (side * (stair.halfWidth + 0.28)) + refSample.nx * 0.95;
      const cz = refSample.z + refSample.tz * (side * (stair.halfWidth + 0.28)) + refSample.nz * 0.95;
      const cheek = createBoxWorldUV(0.56, 1.55, 2.75, 2.2);
      cheek.rotateY(yaw);
      cheek.translate(cx, refSample.topY - 0.65, cz);
      cheekWallGeoms.push(cheek);

      // Stepped granite coping cap on cheek wall
      const cap = createBoxWorldUV(0.66, 0.14, 2.86, 2.0);
      cap.rotateY(yaw);
      cap.translate(cx, refSample.topY + 0.16, cz);
      copingGeoms.push(cap);
    }
  }

  const mushroomMat = new THREE.MeshStandardMaterial({
    map: textures.mushroomGranite.map,
    bumpMap: textures.mushroomGranite.bumpMap,
    bumpScale: 0.055,
    roughnessMap: textures.mushroomGranite.roughnessMap,
    roughness: 0.88,
    metalness: 0.04,
    color: new THREE.Color('#dbd4c9')
  });

  const graniteTrimMat = new THREE.MeshStandardMaterial({
    map: textures.graniteCobble.map,
    bumpMap: textures.graniteCobble.bumpMap,
    bumpScale: 0.03,
    roughnessMap: textures.graniteCobble.roughnessMap,
    roughness: 0.82,
    metalness: 0.04,
    color: new THREE.Color('#e2dbd0')
  });

  const wallMesh = new THREE.Mesh(
    mergeGeometries([...wallGeoms, ...cheekWallGeoms]),
    mushroomMat
  );
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  group.add(wallMesh);

  for (const g of [...wallGeoms, ...cheekWallGeoms]) {
    g.dispose();
  }

  // 3. Classic Qingdao Seaside Stone Balustrade Piers & Slender Dark-Iron Railings
  const pierGeoms: THREE.BufferGeometry[] = [];
  const ironGeoms: THREE.BufferGeometry[] = [];

  for (const run of runs) {
    // Choose evenly spaced pier stations along each continuous seawall section
    const runLen = run[run.length - 1].arcLen - run[0].arcLen;
    const bayCount = Math.max(1, Math.round(runLen / 6.2));
    const pierSamples: SeawallSample[] = [];

    for (let b = 0; b <= bayCount; b++) {
      const targetArc = run[0].arcLen + (runLen * b) / bayCount;
      let nearest = run[0];
      let bestDiff = Infinity;
      for (const s of run) {
        const diff = Math.abs(s.arcLen - targetArc);
        if (diff < bestDiff) {
          bestDiff = diff;
          nearest = s;
        }
      }
      pierSamples.push(nearest);
    }

    // Build granite piers
    for (let p = 0; p < pierSamples.length; p++) {
      const ps = pierSamples[p];
      const isTerminal = p === 0 || p === pierSamples.length - 1;
      const pw = isTerminal ? 0.46 : 0.38;
      const ph = isTerminal ? 1.12 : 1.02;
      const yaw = Math.atan2(ps.tx, ps.tz);

      const base = createBoxWorldUV(pw, ph, pw, 1.8);
      base.rotateY(yaw);
      base.translate(ps.x, ps.topY + 0.12 + ph * 0.5, ps.z);
      pierGeoms.push(base);

      // Chamfered granite cap & subtle finial pyramid
      const cap = createBoxWorldUV(pw + 0.1, 0.11, pw + 0.1, 1.8);
      cap.rotateY(yaw);
      cap.translate(ps.x, ps.topY + 0.12 + ph + 0.055, ps.z);
      pierGeoms.push(cap);

      if (isTerminal) {
        const finial = new THREE.ConeGeometry(pw * 0.42, 0.16, 4);
        finial.rotateY(yaw + Math.PI * 0.25);
        finial.translate(ps.x, ps.topY + 0.12 + ph + 0.19, ps.z);
        pierGeoms.push(finial);
      }
    }

    // Build slender wrought-iron seaside railings between consecutive stone piers
    for (let p = 0; p < pierSamples.length - 1; p++) {
      const a = pierSamples[p];
      const b = pierSamples[p + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const span = Math.hypot(dx, dz);
      if (span < 0.8) continue;

      const midX = (a.x + b.x) * 0.5;
      const midZ = (a.z + b.z) * 0.5;
      const midY = (a.topY + b.topY) * 0.5 + 0.12;
      const yaw = Math.atan2(dx, dz);
      const pitch = -Math.atan2(b.topY - a.topY, span);

      // Top handrail, middle decorative bar, and bottom rail
      const railHeights: [number, number][] = [
        [0.92, 0.055],
        [0.74, 0.032],
        [0.16, 0.038]
      ];
      for (const [ry, thick] of railHeights) {
        const bar = new THREE.BoxGeometry(thick, thick * 0.9, span - 0.3);
        bar.rotateX(pitch);
        bar.rotateY(yaw);
        bar.translate(midX, midY + ry, midZ);
        ironGeoms.push(bar);
      }

      // Vertical pickets along the span
      const picketCount = Math.max(4, Math.floor((span - 0.5) / 0.34));
      for (let k = 1; k <= picketCount; k++) {
        const f = k / (picketCount + 1);
        const px = a.x + dx * f;
        const pz = a.z + dz * f;
        const py = a.topY + (b.topY - a.topY) * f + 0.12;
        const picket = new THREE.BoxGeometry(0.024, 0.76, 0.024);
        picket.translate(px, py + 0.54, pz);
        ironGeoms.push(picket);
      }
    }
  }

  // Merge granite coping, beach stair steps, and balustrade piers into 1 draw call
  const trimGeoms = [...copingGeoms, ...stairStepGeoms, ...pierGeoms];
  const pierMesh = new THREE.Mesh(mergeGeometries(trimGeoms), graniteTrimMat);
  pierMesh.castShadow = true;
  pierMesh.receiveShadow = true;
  group.add(pierMesh);

  const ironMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#232a30'),
    roughness: 0.46,
    metalness: 0.72
  });
  const ironMesh = new THREE.Mesh(mergeGeometries(ironGeoms), ironMat);
  ironMesh.castShadow = true;
  ironMesh.receiveShadow = true;
  group.add(ironMesh);

  for (const g of [...trimGeoms, ...ironGeoms]) g.dispose();

  return group;
}

// ============================================================================
// 4. SECOND BATHING BEACH ICONIC STONE JETTY / BREAKWATER (海濱石堤)
// ============================================================================

function buildStoneJetty(textures: TextureLibrary): {
  group: THREE.Group;
  lanternMat: THREE.MeshStandardMaterial;
  lanternGlow: THREE.Sprite;
} {
  const root = new THREE.Group();
  root.name = 'StoneJetty';

  const dx = JETTY.endX - JETTY.startX;
  const dz = JETTY.endZ - JETTY.startZ;
  const len = JETTY.length;
  const yaw = Math.atan2(dx, dz);

  // Align local +Z directly along the jetty centerline from start to seaward tip
  root.position.set(JETTY.startX, 0, JETTY.startZ);
  root.rotation.y = yaw;

  const deckY = JETTY.deckY; // Exact 1.32m matching getJettyHeight(x, z)
  const halfW = JETTY.width * 0.5; // 2.2m
  const pierR = JETTY.pierHeadRadius; // 3.4m
  const startLocalZ = -1.6; // Embedded cleanly into upper golden beach sand!
  const causewayLen = len - startLocalZ;

  // Materials
  const cobbleMat = new THREE.MeshStandardMaterial({
    map: textures.graniteCobble.map,
    bumpMap: textures.graniteCobble.bumpMap,
    bumpScale: 0.04,
    roughnessMap: textures.graniteCobble.roughnessMap,
    roughness: 0.84,
    metalness: 0.04,
    color: new THREE.Color('#d7cfc2')
  });

  const wallMat = new THREE.MeshStandardMaterial({
    map: textures.mushroomGranite.map,
    bumpMap: textures.mushroomGranite.bumpMap,
    bumpScale: 0.06,
    roughnessMap: textures.mushroomGranite.roughnessMap,
    roughness: 0.86,
    metalness: 0.05,
    color: new THREE.Color('#cac2b6')
  });

  // Wet lower tidal stone band for authentic wave-washed breakwater masonry
  const wetStoneMat = new THREE.MeshStandardMaterial({
    map: textures.mushroomGranite.map,
    bumpMap: textures.mushroomGranite.bumpMap,
    bumpScale: 0.065,
    roughness: 0.34,
    metalness: 0.08,
    color: new THREE.Color('#5a5b58')
  });

  const graniteCapMat = new THREE.MeshStandardMaterial({
    map: textures.graniteCobble.map,
    bumpMap: textures.graniteCobble.bumpMap,
    bumpScale: 0.03,
    roughness: 0.78,
    metalness: 0.04,
    color: new THREE.Color('#e0d8cb')
  });

  const darkIronMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#272b2f'),
    roughness: 0.5,
    metalness: 0.78
  });

  // 1. Walkable cobbled causeway deck (top strictly at Y = deckY = 1.32m)
  const deckH = 0.22;
  const deckGeom = createBoxWorldUV(JETTY.width, deckH, causewayLen, 2.5);
  deckGeom.translate(0, deckY - deckH * 0.5, startLocalZ + causewayLen * 0.5);

  // Circular seaward pier head cobbled deck (exact radius = 3.4m, top at Y = deckY)
  const headDeckGeom = new THREE.CylinderGeometry(pierR, pierR, deckH, 28);
  scaleGeometryUVs(headDeckGeom, 3.0, 1.0);
  headDeckGeom.translate(0, deckY - deckH * 0.5, len);

  const deckMesh = new THREE.Mesh(mergeGeometries([deckGeom, headDeckGeom]), cobbleMat);
  deckMesh.castShadow = true;
  deckMesh.receiveShadow = true;
  root.add(deckMesh);
  deckGeom.dispose();
  headDeckGeom.dispose();

  // 2. Stout upper mushroom-stone breakwater body (Y = 0.38..1.14)
  const upperH = deckY - deckH - 0.36;
  const upperCauseway = createBoxWorldUV(JETTY.width + 0.32, upperH, causewayLen + 0.2, 2.6);
  upperCauseway.translate(0, 0.36 + upperH * 0.5, startLocalZ + causewayLen * 0.5);

  const upperHead = new THREE.CylinderGeometry(pierR + 0.14, pierR + 0.34, upperH, 28);
  scaleGeometryUVs(upperHead, 6.0, 0.55);
  upperHead.translate(0, 0.36 + upperH * 0.5, len);

  const upperBodyMesh = new THREE.Mesh(mergeGeometries([upperCauseway, upperHead]), wallMat);
  upperBodyMesh.castShadow = true;
  upperBodyMesh.receiveShadow = true;
  root.add(upperBodyMesh);
  upperCauseway.dispose();
  upperHead.dispose();

  // 3. Lower wet wave-splashed battered base plunging deeply into seabed (Y = -2.4..0.42)
  const lowerH = 2.82;
  const lowerCauseway = createBoxWorldUV(JETTY.width + 1.12, lowerH, causewayLen + 0.7, 2.8);
  lowerCauseway.translate(0, 0.42 - lowerH * 0.5, startLocalZ + causewayLen * 0.5);

  const lowerHead = new THREE.CylinderGeometry(pierR + 0.32, pierR + 1.05, lowerH, 28);
  scaleGeometryUVs(lowerHead, 7.0, 1.1);
  lowerHead.translate(0, 0.42 - lowerH * 0.5, len);

  // Stepped granite wave-breaker armour blocks flanking the breakwater sides
  const armourGeoms: THREE.BufferGeometry[] = [lowerCauseway, lowerHead];
  for (let z = 6; z < len - 2.5; z += 4.2) {
    for (const side of [-1, 1] as const) {
      const stepBlock = createBoxWorldUV(1.05, 0.95, 2.6, 2.2);
      stepBlock.translate(side * (halfW + 0.58), 0.08, z);
      armourGeoms.push(stepBlock);
    }
  }
  const lowerBodyMesh = new THREE.Mesh(mergeGeometries(armourGeoms), wetStoneMat);
  lowerBodyMesh.castShadow = true;
  lowerBodyMesh.receiveShadow = true;
  root.add(lowerBodyMesh);
  for (const g of armourGeoms) g.dispose();

  // 4. Raised heavy granite edge curbstones + circular pier-head coping + stone bollards
  const capGeoms: THREE.BufferGeometry[] = [];
  const ironGeoms: THREE.BufferGeometry[] = [];

  const curbW = 0.34;
  const curbH = 0.13;
  const curbRunLen = len - pierR * 0.72 - startLocalZ;
  for (const side of [-1, 1] as const) {
    const cBlock = createBoxWorldUV(curbW, curbH, curbRunLen, 2.1);
    cBlock.translate(
      side * (halfW - curbW * 0.5 + 0.04),
      deckY + curbH * 0.5,
      startLocalZ + curbRunLen * 0.5
    );
    capGeoms.push(cBlock);
  }

  // Curved granite rim stones around the seaward circular pier head
  const rimSegs = 18;
  for (let i = 0; i < rimSegs; i++) {
    const a = -Math.PI * 0.78 + (i / (rimSegs - 1)) * (Math.PI * 1.56);
    // Keep north-side entry onto circular head completely open!
    const rimX = Math.sin(a) * (pierR - 0.18);
    const rimZ = len + Math.cos(a) * (pierR - 0.18);
    const segLen = ((Math.PI * 1.56) / rimSegs) * pierR + 0.06;
    const stone = createBoxWorldUV(segLen, curbH, 0.36, 1.8);
    stone.rotateY(a);
    stone.translate(rimX, deckY + curbH * 0.5, rimZ);
    capGeoms.push(stone);
  }

  // Paired weathered granite mooring bollards with dark iron rings
  const bollardZList = [6.5, 16.5, 26.5, 36.5, 45.2];
  for (const bz of bollardZList) {
    for (const side of [-1, 1] as const) {
      const bx = side * (halfW - 0.18);
      const post = new THREE.CylinderGeometry(0.15, 0.19, 0.54, 10);
      post.translate(bx, deckY + curbH + 0.27, bz);
      capGeoms.push(post);

      const cap = new THREE.CylinderGeometry(0.19, 0.16, 0.09, 10);
      cap.translate(bx, deckY + curbH + 0.56, bz);
      capGeoms.push(cap);

      // Mooring iron collar & ring facing the sea
      const ring = new THREE.TorusGeometry(0.085, 0.018, 6, 12);
      ring.rotateY(Math.PI * 0.5);
      ring.translate(bx + side * 0.18, deckY + curbH + 0.36, bz);
      ironGeoms.push(ring);
    }
  }

  // Pier head bollards (west & east rim)
  for (const angle of [-Math.PI * 0.55, Math.PI * 0.55]) {
    const bx = Math.sin(angle) * (pierR - 0.36);
    const bz = len + Math.cos(angle) * (pierR - 0.36);
    const post = new THREE.CylinderGeometry(0.16, 0.21, 0.58, 10);
    post.translate(bx, deckY + curbH + 0.29, bz);
    capGeoms.push(post);
    const cap = new THREE.CylinderGeometry(0.21, 0.17, 0.09, 10);
    cap.translate(bx, deckY + curbH + 0.6, bz);
    capGeoms.push(cap);
  }

  // Shoreward flared granite wing blocks welcoming pedestrians from the sandy beach
  for (const side of [-1, 1] as const) {
    const wing = createBoxWorldUV(0.6, 0.72, 2.2, 2.0);
    wing.rotateY(side * 0.38);
    wing.translate(side * (halfW + 0.38), deckY - 0.12, startLocalZ + 0.4);
    capGeoms.push(wing);
  }

  // 5. Heritage Maritime Pier-Head Beacon Bollard at the southern tip of the circular pier head
  const beaconZ = len + pierR - 0.42;
  const pedestal = createBoxWorldUV(0.56, 0.88, 0.56, 1.6);
  pedestal.translate(0, deckY + curbH + 0.44, beaconZ);
  capGeoms.push(pedestal);
  const pedCap = createBoxWorldUV(0.68, 0.1, 0.68, 1.6);
  pedCap.translate(0, deckY + curbH + 0.92, beaconZ);
  capGeoms.push(pedCap);

  // Iron lantern cage & cap atop stone pedestal
  const cageBase = new THREE.CylinderGeometry(0.22, 0.25, 0.08, 8);
  cageBase.translate(0, deckY + curbH + 1.01, beaconZ);
  ironGeoms.push(cageBase);
  const cageRoof = new THREE.ConeGeometry(0.29, 0.24, 8);
  cageRoof.translate(0, deckY + curbH + 1.48, beaconZ);
  ironGeoms.push(cageRoof);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI * 0.25;
    const strut = new THREE.CylinderGeometry(0.014, 0.014, 0.34, 6);
    strut.translate(Math.cos(a) * 0.17, deckY + curbH + 1.21, beaconZ + Math.sin(a) * 0.17);
    ironGeoms.push(strut);
  }

  const capMesh = new THREE.Mesh(mergeGeometries(capGeoms), graniteCapMat);
  capMesh.castShadow = true;
  capMesh.receiveShadow = true;
  root.add(capMesh);

  const ironMesh = new THREE.Mesh(mergeGeometries(ironGeoms), darkIronMat);
  ironMesh.castShadow = true;
  ironMesh.receiveShadow = true;
  root.add(ironMesh);

  for (const g of [...capGeoms, ...ironGeoms]) g.dispose();

  // Warm glowing maritime lantern glass + soft additive halo sprite
  const lanternMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#ffe4ad'),
    emissive: new THREE.Color('#ffaa44'),
    emissiveIntensity: 0.25,
    roughness: 0.2,
    metalness: 0.05
  });
  const lanternGlass = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.3, 12), lanternMat);
  lanternGlass.position.set(0, deckY + curbH + 1.21, beaconZ);
  root.add(lanternGlass);

  const glowTex = createSoftGlowTexture('#ffca6a', '#ff7b24');
  const lanternGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTex,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  lanternGlow.position.set(0, deckY + curbH + 1.21, beaconZ);
  lanternGlow.scale.set(2.8, 2.8, 1);
  root.add(lanternGlow);

  return { group: root, lanternMat, lanternGlow };
}

// ============================================================================
// 5. SCULPTED COASTAL REEFS & LAOSHAN GRANITE BOULDERS (花石樓礁石群)
// ============================================================================

function createSculptedRockVariant(seed: number): THREE.BufferGeometry {
  const geom = new THREE.IcosahedronGeometry(1.0, 2);
  const nonIndexed = geom.index ? geom.toNonIndexed() : geom;
  if (nonIndexed !== geom) geom.dispose();

  const pos = nonIndexed.getAttribute('position');
  const uv = nonIndexed.getAttribute('uv');
  const rng = createRng(seed);
  // Crisp geological cleavage planes for authentic angular Laoshan coastal granite
  const planes: { nx: number; ny: number; nz: number; cut: number }[] = [];
  for (let p = 0; p < 7; p++) {
    const theta = seededRange(rng, 0, Math.PI * 2);
    const phi = seededRange(rng, 0.2, Math.PI * 0.78);
    planes.push({
      nx: Math.sin(phi) * Math.cos(theta),
      ny: Math.cos(phi),
      nz: Math.sin(phi) * Math.sin(theta),
      cut: seededRange(rng, 0.56, 0.82)
    });
  }

  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    // Stratified coastal granite crag displacement with angular horizontal bench steps
    const n1 = valueNoise2D(x * 2.2 + seed * 0.13, z * 2.2 - y * 1.5);
    const n2 = valueNoise2D(y * 4.2 + x * 1.9, z * 3.6 + seed * 0.37);
    const strataStep = Math.sin(y * 6.5 + n1 * 2.1) * 0.06;
    const disp = 0.76 + n1 * 0.34 + (n2 - 0.5) * 0.2 + strataStep;
    x *= disp;
    y *= disp;
    z *= disp;

    // Flatten slightly on top & base like wave-eroded Qingdao coastal rock benches
    if (y > 0.42) y = 0.42 + (y - 0.42) * 0.52;
    if (y < -0.52) y = -0.52 + (y + 0.52) * 0.42;

    // Apply crisp geological cleavage planes
    for (const pl of planes) {
      const dot = x * pl.nx + y * pl.ny + z * pl.nz;
      if (dot > pl.cut) {
        const excess = (dot - pl.cut) * 0.82;
        x -= pl.nx * excess;
        y -= pl.ny * excess;
        z -= pl.nz * excess;
      }
    }

    pos.setXYZ(i, x, y, z);
    if (uv) {
      uv.setXY(i, (x + z) * 1.15, y * 1.35 + (x - z) * 0.35);
    }
  }

  nonIndexed.computeVertexNormals();
  return nonIndexed;
}

/**
 * Creates a tall, battered, faceted Laoshan granite cliff buttress (unit Y in [-1.05, +0.96])
 * with stepped horizontal strata ledges and crisp diagonal geological cleavage planes.
 */
function createCliffButtressVariant(seed: number): THREE.BufferGeometry {
  const base = new THREE.CylinderGeometry(0.76, 1.18, 2.0, 10, 6, false);
  const nonIndexed = base.index ? base.toNonIndexed() : base;
  if (nonIndexed !== base) base.dispose();

  const pos = nonIndexed.getAttribute('position');
  const uv = nonIndexed.getAttribute('uv');
  const rng = createRng(seed);

  const planes: { nx: number; ny: number; nz: number; cut: number }[] = [];
  for (let p = 0; p < 6; p++) {
    const theta = (p / 6) * Math.PI * 2 + seededRange(rng, -0.35, 0.35);
    const tilt = seededRange(rng, 0.14, 0.42);
    planes.push({
      nx: Math.cos(theta) * Math.cos(tilt),
      ny: Math.sin(tilt),
      nz: Math.sin(theta) * Math.cos(tilt),
      cut: seededRange(rng, 0.58, 0.86)
    });
  }

  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    // Normalize vertical height u in [0, 1] from base to cliff brow
    const u = clamp((y + 1.0) * 0.5, 0, 1);

    // Quantized stepped horizontal strata ledges along the cliff face
    const strataBand = Math.floor(u * 4.5) / 4.5;
    const strataShelf = 1.0 + (1.0 - strataBand) * 0.14 + Math.sin(u * Math.PI * 6.0) * 0.065;
    const angNoise = valueNoise2D(x * 1.9 + seed * 0.21, z * 1.9 + y * 1.4);
    const fineNoise = valueNoise2D(y * 4.5 + x * 2.4, z * 2.7 - seed * 0.17);

    // Broaden slightly along cliff tangent (X) and batter outward toward base (+Z)
    x *= (0.94 + angNoise * 0.28) * strataShelf;
    z *= (0.86 + angNoise * 0.24) * strataShelf;
    z += (1.0 - u) * 0.22; // Natural coastal cliff batter sloping seaward

    // Rugged stepped flat-ish top shelf so buttresses tuck cleanly under Huashi Villa's stone wall
    if (y > 0.72) {
      y = 0.72 + (y - 0.72) * 0.65 + (fineNoise - 0.5) * 0.12;
    } else {
      y += (fineNoise - 0.5) * 0.08;
    }

    // Crisp granite vertical & diagonal cleavage facets
    for (const pl of planes) {
      const dot = x * pl.nx + y * pl.ny + z * pl.nz;
      if (dot > pl.cut) {
        const excess = (dot - pl.cut) * 0.86;
        x -= pl.nx * excess;
        y -= pl.ny * excess;
        z -= pl.nz * excess;
      }
    }

    pos.setXYZ(i, x, y, z);
    if (uv) {
      uv.setXY(i, (x + z * 0.65) * 1.1, y * 1.4);
    }
  }

  nonIndexed.computeVertexNormals();
  return nonIndexed;
}

/**
 * Creates a broad, stepped stratified coastal granite rock ledge (unit Y in [-0.92, +0.76])
 * with flat bench shoulders, jagged escarpment face, and deep buried backing into the slope.
 */
function createCliffLedgeVariant(seed: number): THREE.BufferGeometry {
  const base = new THREE.BoxGeometry(2.0, 1.5, 1.75, 5, 4, 4);
  const nonIndexed = base.index ? base.toNonIndexed() : base;
  if (nonIndexed !== base) base.dispose();

  const pos = nonIndexed.getAttribute('position');
  const uv = nonIndexed.getAttribute('uv');
  const rng = createRng(seed);

  const planes: { nx: number; ny: number; nz: number; cut: number }[] = [];
  for (let p = 0; p < 5; p++) {
    const theta = seededRange(rng, -Math.PI, Math.PI);
    const ny = seededRange(rng, 0.18, 0.55);
    const horiz = Math.sqrt(Math.max(0.05, 1 - ny * ny));
    planes.push({
      nx: Math.cos(theta) * horiz,
      ny,
      nz: Math.sin(theta) * horiz,
      cut: seededRange(rng, 0.68, 0.96)
    });
  }

  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    const n1 = valueNoise2D(x * 1.6 + seed * 0.19, z * 1.6 - y * 1.3);
    const n2 = valueNoise2D(y * 3.8 - x * 1.8, z * 2.5 + seed * 0.41);

    // Taper upward slightly while forming a bold stepped horizontal rock bench
    const hNorm = clamp((y + 0.75) / 1.5, 0, 1);
    const step = hNorm > 0.52 ? 0.84 : 1.04;
    x *= step * (0.86 + n1 * 0.28);
    z *= step * (0.84 + n2 * 0.28);

    // Keep upper bench relatively flat with crisp geological step terracing
    if (y > 0.35) {
      y = 0.45 + (y - 0.35) * 0.48 + (n1 - 0.5) * 0.14;
    } else if (y < -0.45) {
      y = -0.68 + (y + 0.45) * 0.55;
    } else {
      y += Math.sin(y * 7.0 + n1 * 2.0) * 0.06;
    }

    for (const pl of planes) {
      const dot = x * pl.nx + y * pl.ny + z * pl.nz;
      if (dot > pl.cut) {
        const excess = (dot - pl.cut) * 0.8;
        x -= pl.nx * excess;
        y -= pl.ny * excess;
        z -= pl.nz * excess;
      }
    }

    pos.setXYZ(i, x, y, z);
    if (uv) {
      uv.setXY(i, (x + z * 0.5) * 1.0, y * 1.35 + z * 0.35);
    }
  }

  nonIndexed.computeVertexNormals();
  return nonIndexed;
}

function buildCoastalReefs(
  placements: ReefRockPlacement[],
  textures: TextureLibrary
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'CoastalReefs';

  const variants = [
    createSculptedRockVariant(701),
    createSculptedRockVariant(709),
    createSculptedRockVariant(719),
    createSculptedRockVariant(733),
    createCliffButtressVariant(751),
    createCliffLedgeVariant(769)
  ];

  // Weathered Qingdao Laoshan grey-ochre granite reef & cliff material with world-space
  // geological strata, dry sun-warmed feldspar upper ledges, and wet basaltic tidal splash band
  const reefMat = new THREE.MeshStandardMaterial({
    map: textures.mushroomGranite.map,
    bumpMap: textures.mushroomGranite.bumpMap,
    bumpScale: 0.095,
    roughness: 0.86,
    metalness: 0.05,
    color: new THREE.Color('#8a8175')
  });

  reefMat.customProgramCacheKey = () => 'badaguan-coastal-reef-v2';
  reefMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vReefWorldPos;
        varying vec3 vReefWorldNormal;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 reefWP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          reefWP = instanceMatrix * reefWP;
        #endif
        reefWP = modelMatrix * reefWP;
        vReefWorldPos = reefWP.xyz;
        mat3 reefNormalMat = mat3(modelMatrix);
        #ifdef USE_INSTANCING
          reefNormalMat = reefNormalMat * mat3(instanceMatrix);
        #endif
        vReefWorldNormal = normalize(reefNormalMat * objectNormal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vReefWorldPos;
        varying vec3 vReefWorldNormal;

        float reefHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float reefNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(reefHash(i), reefHash(i + vec2(1.0, 0.0)), u.x),
            mix(reefHash(i + vec2(0.0, 1.0)), reefHash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // World-space stratified Laoshan granite bedding & weathered mineral veins
        float strataWarp = reefNoise(vReefWorldPos.xz * 0.24) * 1.3;
        float strataBands = sin(vReefWorldPos.y * 5.2 + strataWarp * 2.8) * 0.5 + 0.5;
        float mineralGrain = reefNoise(vReefWorldPos.xz * 1.85 + vec2(vReefWorldPos.y * 1.4));
        float creviceShade = 0.86 + 0.24 * (strataBands * 0.55 + mineralGrain * 0.45);
        diffuseColor.rgb *= creviceShade;

        // Warm weathered grey-ochre granite patina on upper dry cliff buttresses (Y > 1.8m)
        float dryCliff = smoothstep(1.2, 4.2, vReefWorldPos.y);
        vec3 ochreGranite = diffuseColor.rgb * vec3(1.12, 1.05, 0.94);
        diffuseColor.rgb = mix(diffuseColor.rgb, ochreGranite, dryCliff * (0.42 + 0.35 * mineralGrain));

        // Wave-splashed wet dark basaltic granite near sea level (Y < 0.82m)
        float wetTide = 1.0 - smoothstep(-0.1, 0.82, vReefWorldPos.y);
        // Subtle olive-brown tidal seaweed/barnacle band right around Y = 0.0..0.44
        float algaeBand = smoothstep(-0.18, 0.14, vReefWorldPos.y) * (1.0 - smoothstep(0.22, 0.58, vReefWorldPos.y));
        // Sun-bleached warm Laoshan feldspar highlights on upward flat rock benches
        float topSun = smoothstep(0.48, 0.92, vReefWorldNormal.y) * smoothstep(0.75, 2.2, vReefWorldPos.y);

        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.48, 0.50, 0.52), wetTide * 0.84);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.14, 0.18, 0.11), algaeBand * 0.32);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.16, 1.11, 1.03), topSun * 0.45);`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float wetRough = 1.0 - smoothstep(-0.05, 0.76, vReefWorldPos.y);
        roughnessFactor = mix(0.86, 0.22, wetRough);`
      );
  };

  // Group placements by variant for clean low-draw-call InstancedMeshes (6 draw calls total!)
  const variantCount = variants.length;
  const buckets: ReefRockPlacement[][] = Array.from({ length: variantCount }, () => []);
  for (const r of placements) {
    buckets[r.variant % variantCount].push(r);
  }

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  for (let v = 0; v < variantCount; v++) {
    const list = buckets[v];
    if (list.length === 0) continue;

    const inst = new THREE.InstancedMesh(variants[v], reefMat, list.length);
    inst.castShadow = true;
    inst.receiveShadow = true;

    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      dummy.position.set(r.x, r.y, r.z);
      dummy.rotation.set(r.rotX, r.rotY, r.rotZ);
      dummy.scale.set(r.rx, r.ry, r.rz);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);

      color.setRGB(r.tint, r.tint * 0.97, r.tint * 0.93);
      inst.setColorAt(i, color);
    }

    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    group.add(inst);
  }

  return group;
}

// ============================================================================
// 6. BAKED 256×256 SEABED DEPTH & SURF DATA TEXTURE + YELLOW SEA GLSL OCEAN
// ============================================================================

function bakeSeabedDepthTexture(
  reefs: ReefRockPlacement[],
  sampleTerrainHeight: (x: number, z: number) => number
): THREE.DataTexture {
  const size = DEPTH_MAP_SIZE;
  const data = new Uint8Array(size * size * 4);

  const dxJetty = JETTY.endX - JETTY.startX;
  const dzJetty = JETTY.endZ - JETTY.startZ;
  const jLenSq = dxJetty * dxJetty + dzJetty * dzJetty;

  // Only include shoreline & tidal rocks that interact with the water surface when baking surf foam
  const tidalReefs = reefs.filter(
    (rock) => rock.y - rock.ry < 1.35 && rock.y + rock.ry > -1.0
  );

  for (let iz = 0; iz < size; iz++) {
    const v = iz / (size - 1);
    const z = DEPTH_MAP_MIN_Z + v * (DEPTH_MAP_MAX_Z - DEPTH_MAP_MIN_Z);

    for (let ix = 0; ix < size; ix++) {
      const u = ix / (size - 1);
      const x = DEPTH_MAP_MIN_X + u * (DEPTH_MAP_MAX_X - DEPTH_MAP_MIN_X);

      let elev = sampleTerrainHeight(x, z);
      let surfEnergy = 0.0;

      // Include Stone Jetty solid footprint + foam break collar along its flanks & pier head
      const jettyY = getJettyHeight(x, z);
      if (jettyY !== null) {
        elev = Math.max(elev, jettyY);
        surfEnergy = 1.0;
      } else {
        // Compute distance to Stone Jetty for crisp lapping breakwater surf foam
        const rx = x - JETTY.startX;
        const rz = z - JETTY.startZ;
        const proj = clamp((rx * dxJetty + rz * dzJetty) / jLenSq, 0, 1);
        const cx = JETTY.startX + dxJetty * proj;
        const cz = JETTY.startZ + dzJetty * proj;
        const distCauseway = Math.hypot(x - cx, z - cz) - (JETTY.width * 0.5 + 0.55);
        const distTip = Math.hypot(x - JETTY.endX, z - JETTY.endZ) - (JETTY.pierHeadRadius + 0.55);
        const distJetty = Math.min(distCauseway, distTip);
        if (distJetty < 4.5) {
          const collar = 1 - smoothstep(0.0, 4.5, Math.max(0, distJetty));
          // Gently shallow effective depth right next to breakwater walls so foam hugs it!
          elev = Math.max(elev, -3.2 * (1 - collar) + 0.15 * collar);
          surfEnergy = Math.max(surfEnergy, collar * 0.95);
        }
      }

      // Include every sculpted shoreline reef rock so foaming surf wraps organically around each boulder!
      for (let r = 0; r < tidalReefs.length; r++) {
        const rock = tidalReefs[r];
        const rx = (x - rock.x) / (rock.rx + 1.8);
        const rz = (z - rock.z) / (rock.rz + 1.8);
        const dSq = rx * rx + rz * rz;
        if (dSq < 1.0) {
          const rockPeak = rock.y + rock.ry * 0.85;
          const dome = 1 - smoothstep(0.18, 1.0, Math.sqrt(dSq));
          if (rockPeak > -0.65) {
            elev = Math.max(elev, -1.2 + (rockPeak + 1.2) * dome);
            surfEnergy = Math.max(surfEnergy, dome * 1.0);
          }
        }
      }

      // Extra rocky headland wave energy around Huashi Cape & West Point cliffs
      const huashiDist = Math.hypot((x - 48) / 31, (z - 48) / 24);
      if (huashiDist < 1.35) {
        surfEnergy = Math.max(surfEnergy, (1 - smoothstep(0.75, 1.35, huashiDist)) * 0.85);
      }
      if (x < -58 && z > 36 && z < 70) {
        surfEnergy = Math.max(surfEnergy, smoothstep(-58, -72, x) * 0.72);
      }

      // Sheltered Second Bathing Beach cove calmness (1 inside bay, 0 open sea)
      const coveCalm =
        smoothstep(-70, -45, x) *
        (1 - smoothstep(14, 34, x)) *
        (1 - smoothstep(55, 96, z));

      // Pack RGBA8 channels:
      // R: normalized water depth below SEA_LEVEL [0..5.5m] -> [0..255]
      // G: signed elevation [-2.5m..+2.5m] -> [0..255] (128 = exact waterline Y=0)
      // B: rocky reef / jetty surf foam energy [0..1] -> [0..255]
      // A: cove calm factor [0..1] -> [0..255]
      const depthMeters = Math.max(0, SEA_LEVEL - elev);
      const normDepth = clamp(depthMeters / 5.5, 0, 1);
      const normElev = clamp((elev + 2.5) / 5.0, 0, 1);

      const idx = (iz * size + ix) * 4;
      data[idx] = Math.round(normDepth * 255);
      data[idx + 1] = Math.round(normElev * 255);
      data[idx + 2] = Math.round(clamp(surfEnergy, 0, 1) * 255);
      data[idx + 3] = Math.round(clamp(coveCalm, 0, 1) * 255);
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.flipY = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds a shore-concentrated non-linear ocean mesh extending out to ~950m radius!
 * Dense (~1.3m) triangles around Second Bathing Beach, Stone Jetty, and Huashi Cape,
 * smoothly stretching toward the distant Yellow Sea horizon with zero seams.
 */
function buildShoreDenseOceanGeometry(): THREE.BufferGeometry {
  const segX = 184;
  const segZ = 184;
  const geom = new THREE.PlaneGeometry(2, 2, segX, segZ);
  geom.rotateX(-Math.PI / 2);

  const pos = geom.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    // Original PlaneGeometry rotated -PI/2 maps x in [-1, 1], z in [-1, 1]
    const ux = pos.getX(i); // [-1, 1]
    const uz = pos.getZ(i) * 0.5 + 0.5; // [0, 1] from north shore edge to far south horizon

    // Cubic-blended non-linear stretch: ultra-dense inside [-120, 120] x [16, 130], reaching ±960m!
    const signX = ux < 0 ? -1 : 1;
    const ax = Math.abs(ux);
    const worldX = signX * (155.0 * ax + 805.0 * ax * ax * ax);
    const worldZ = 18.0 + 135.0 * uz + 810.0 * uz * uz * uz;

    pos.setXYZ(i, worldX, SEA_LEVEL, worldZ);
  }

  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  return geom;
}

const OCEAN_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uWindStrength;
  uniform sampler2D uDepthMap;
  uniform vec4 uDepthBounds; // (minX, minZ, invSpanX, invSpanZ)

  varying vec3 vWorldPos;
  varying vec3 vWaveNormal;
  varying float vWaveCrest;
  varying vec2 vDepthUV;
  varying float vInDepthMap;

  #include <fog_pars_vertex>

  void addGerstnerWave(
    vec2 xz,
    vec2 dir,
    float steepness,
    float wavelength,
    float speed,
    float ampScale,
    inout vec3 disp,
    inout vec3 tangentX,
    inout vec3 tangentZ
  ) {
    float k = 6.2831853 / wavelength;
    float c = sqrt(9.81 / k) * speed;
    vec2 d = normalize(dir);
    float f = k * (dot(d, xz) - c * uTime);
    float a = (steepness / k) * ampScale;

    float cosF = cos(f);
    float sinF = sin(f);

    disp.x += d.x * (a * cosF);
    disp.y += a * sinF;
    disp.z += d.y * (a * cosF);

    float s = steepness * ampScale;
    tangentX += vec3(-d.x * d.x * s * sinF, d.x * s * cosF, -d.x * d.y * s * sinF);
    tangentZ += vec3(-d.x * d.y * s * sinF, d.y * s * cosF, -d.y * d.y * s * sinF);
  }

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec2 depthUV = vec2(
      (wp.x - uDepthBounds.x) * uDepthBounds.z,
      (wp.z - uDepthBounds.y) * uDepthBounds.w
    );

    float inside =
      step(0.0, depthUV.x) * step(depthUV.x, 1.0) *
      step(0.0, depthUV.y) * step(depthUV.y, 1.0);

    vec4 depthData = texture2D(uDepthMap, clamp(depthUV, 0.002, 0.998));
    float depthNorm = mix(1.0, depthData.r, inside);
    float coveCalm = mix(0.0, depthData.a, inside);

    // Damp swells gracefully near shallow sand & inside the sheltered bathing cove
    float shallowDamp = smoothstep(0.015, 0.32, depthNorm);
    float distAtten = 1.0 - smoothstep(260.0, 860.0, length(wp.xz));
    float ampScale = (0.45 + 0.55 * uWindStrength) * shallowDamp * mix(1.0, 0.52, coveCalm) * (0.25 + 0.75 * distAtten);

    vec3 disp = vec3(0.0);
    vec3 tX = vec3(1.0, 0.0, 0.0);
    vec3 tZ = vec3(0.0, 0.0, 1.0);

    // Four Qingdao Yellow Sea coastal swells rolling toward the bay from SSE / SSW
    addGerstnerWave(wp.xz, vec2(-0.18, -0.98), 0.105, 24.0, 0.92, ampScale, disp, tX, tZ);
    addGerstnerWave(wp.xz, vec2(0.32, -0.95),  0.082, 14.5, 1.04, ampScale, disp, tX, tZ);
    addGerstnerWave(wp.xz, vec2(-0.56, -0.83), 0.064, 8.2,  1.15, ampScale, disp, tX, tZ);
    addGerstnerWave(wp.xz, vec2(0.68, -0.73),  0.045, 4.7,  1.28, ampScale, disp, tX, tZ);

    wp.xyz += disp;

    vWorldPos = wp.xyz;
    vWaveNormal = normalize(cross(tZ, tX));
    vWaveCrest = disp.y;
    vDepthUV = depthUV;
    vInDepthMap = inside;

    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const OCEAN_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uWindStrength;
  uniform float uNightFactor;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uSkyTopColor;
  uniform vec3 uSkyHorizonColor;
  uniform vec3 uSkySunGlowColor;
  uniform vec3 uWaterDeepColor;
  uniform vec3 uWaterShallowColor;
  uniform vec3 uWaterSunColor;
  uniform vec3 uFallbackFogColor;
  uniform float uFallbackFogDensity;
  uniform sampler2D uDepthMap;

  varying vec3 vWorldPos;
  varying vec3 vWaveNormal;
  varying float vWaveCrest;
  varying vec2 vDepthUV;
  varying float vInDepthMap;

  #include <fog_pars_fragment>

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p = rot * p * 2.04;
      a *= 0.5;
    }
    return v;
  }

  // Multi-octave procedural ripple heightfield for shimmering coastal micro-normals
  float waveRippleHeight(vec2 p, float t) {
    float h = 0.0;
    h += vnoise(p * 0.24 + vec2(t * 0.26, -t * 0.44)) * 0.50;
    h += vnoise(p * 0.54 + vec2(-t * 0.38, -t * 0.62)) * 0.28;
    h += vnoise(p * 1.25 + vec2(t * 0.65, t * 0.42)) * 0.14;
    h += vnoise(p * 2.65 + vec2(-t * 0.92, -t * 0.55)) * 0.08;
    return h;
  }

  void main() {
    vec3 viewVec = cameraPosition - vWorldPos;
    float viewDist = length(viewVec);
    vec3 V = viewVec / max(viewDist, 0.0001);
    vec3 L = normalize(uSunDirection);

    // Sample baked coastal depth texture + seamless edge fallback toward distant horizon
    float edgeMask =
      smoothstep(0.0, 0.04, vDepthUV.x) * (1.0 - smoothstep(0.96, 1.0, vDepthUV.x)) *
      smoothstep(0.0, 0.04, vDepthUV.y) * (1.0 - smoothstep(0.96, 1.0, vDepthUV.y));

    vec4 depthSample = texture2D(uDepthMap, clamp(vDepthUV, 0.002, 0.998));

    // Smooth analytic coastline fallback outside [-150, 150] x [14, 166]
    float fallbackDepth = clamp((vWorldPos.z - 48.0) / 28.0, 0.0, 1.0);
    float depthNorm = mix(fallbackDepth, depthSample.r, edgeMask);
    float signedElev = mix((0.5 - fallbackDepth * 0.5), depthSample.g, edgeMask) * 5.0 - 2.5;
    float surfEnergy = mix(0.0, depthSample.b, edgeMask);
    float depthMeters = depthNorm * 5.5;

    // Discard pixels strictly inland above any possible swash wave
    if (signedElev > 0.22 && edgeMask > 0.5) {
      discard;
    }

    // Distance-attenuated procedural multi-octave ripple normal perturbation
    float detailFade = 1.0 - smoothstep(65.0, 420.0, viewDist);
    float eps = 0.22;
    float t = uTime * (0.72 + 0.38 * uWindStrength);
    float hC = waveRippleHeight(vWorldPos.xz, t);
    float hX = waveRippleHeight(vWorldPos.xz + vec2(eps, 0.0), t);
    float hZ = waveRippleHeight(vWorldPos.xz + vec2(0.0, eps), t);

    float rippleStrength = (0.28 + 0.16 * uWindStrength) * (0.28 + 0.72 * detailFade);
    vec3 rippleN = normalize(vec3((hC - hX) * rippleStrength / eps, 1.0, (hC - hZ) * rippleStrength / eps));
    vec3 N = normalize(vec3(
      vWaveNormal.x + rippleN.x * 0.85,
      max(0.25, vWaveNormal.y),
      vWaveNormal.z + rippleN.z * 0.85
    ));

    // 1. Depth-based Yellow Sea watercolor absorption (sandy shoal -> jade turquoise -> deep cerulean)
    float shallowFactor = exp(-depthMeters * 0.62);
    float turquoiseBand = exp(-depthMeters * 0.28);
    vec3 waterBody = mix(uWaterDeepColor, uWaterShallowColor, turquoiseBand);

    // Warm translucent golden sand shoal glow + animated solar caustics in shallow water (< 1.6m)
    float shoalGlowMask = exp(-depthMeters * 1.45) * (1.0 - surfEnergy * 0.55);
    float caust1 = vnoise(vWorldPos.xz * 1.35 + vec2(uTime * 0.42, -uTime * 0.31));
    float caust2 = vnoise(vWorldPos.xz * 1.65 + vec2(-uTime * 0.36, uTime * 0.48));
    float caustic = pow(clamp(caust1 * caust2 * 2.2, 0.0, 1.0), 2.4) * (1.0 - uNightFactor * 0.82);
    vec3 sandShoalColor = mix(vec3(0.76, 0.68, 0.48), uWaterShallowColor * 1.32, 0.45);
    waterBody = mix(waterBody, sandShoalColor + uWaterSunColor * caustic * 0.22, shoalGlowMask * 0.55);

    // 2. Subsurface scattering emerald-turquoise glow on sun-grazed wave crests
    vec3 backLightDir = normalize(L + N * 0.42);
    float sss = pow(clamp(dot(V, -backLightDir), 0.0, 1.0), 3.0) * (0.45 + 0.55 * clamp(vWaveCrest * 3.5 + 0.5, 0.0, 1.0));
    float sunHeightFactor = clamp(L.y * 2.2 + 0.25, 0.15, 1.0);
    waterBody += uWaterShallowColor * uSunColor * sss * (0.34 * sunHeightFactor * (1.0 - uNightFactor * 0.65));

    // Subtle diffuse directional shading on wave faces
    float ndl = clamp(dot(N, L), 0.0, 1.0);
    waterBody *= 0.68 + 0.42 * ndl;

    // 3. Physically plausible Schlick Fresnel sky reflection
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float fresnel = 0.03 + 0.97 * pow(1.0 - ndv, 4.6);
    vec3 R = reflect(-V, N);
    float skyElev = clamp(R.y * 1.35 + 0.06, 0.0, 1.0);
    vec3 skyReflect = mix(uSkyHorizonColor, uSkyTopColor, pow(skyElev, 0.62));
    // Soft reflected sun halo along sky reflection direction
    float reflSun = pow(clamp(dot(normalize(R), L), 0.0, 1.0), 10.0);
    skyReflect += uSkySunGlowColor * reflSun * (0.55 - 0.35 * uNightFactor);

    vec3 surfaceColor = mix(waterBody, skyReflect, clamp(fresnel * 0.84, 0.04, 0.88));

    // 4. Dual-lobe sparkling sun specular glitter trail across the Yellow Sea (金光波粼)
    vec3 H = normalize(L + V);
    float ndh = clamp(dot(N, H), 0.0, 1.0);
    float broadSheen = pow(ndh, 48.0) * (0.28 - 0.14 * uNightFactor);
    float crispGlint = pow(ndh, 360.0) * (1.85 - 1.15 * uNightFactor);
    // Fine diamond sparkle modulated by micro-ripple variation
    float sparkleMask = smoothstep(0.46, 0.74, hC) * (0.45 + 0.55 * detailFade);
    vec3 specular = uWaterSunColor * (broadSheen + crispGlint * (0.55 + 0.95 * sparkleMask));
    surfaceColor += specular * (0.35 + 0.65 * fresnel);

    // 5. Animated rolling shoreline swash foam & crashing jetty/reef surf collars!
    float foamNoise1 = fbm(vWorldPos.xz * 0.34 + vec2(uTime * 0.16, -uTime * 0.24));
    float foamNoise2 = fbm(vWorldPos.xz * 1.15 + vec2(-uTime * 0.28, uTime * 0.18));
    float lacyFoam = smoothstep(0.32, 0.72, foamNoise1 * 0.62 + foamNoise2 * 0.38);

    // Rhythmic crescent shoreline waves rolling onto Second Bathing Beach
    float shoreZone = (1.0 - smoothstep(0.05, 1.45, depthMeters)) * edgeMask;
    float wavePhase = depthMeters * 6.8 - uTime * 2.05 + foamNoise1 * 3.4;
    float rollingArcs = pow(clamp(sin(wavePhase) * 0.5 + 0.5, 0.0, 1.0), 3.6);
    float swashEdge = smoothstep(0.06, -0.06, signedElev) * (1.0 - smoothstep(-0.08, -0.45, signedElev));
    float beachFoam = shoreZone * (rollingArcs * (0.42 + 0.58 * lacyFoam) + swashEdge * (0.62 + 0.38 * foamNoise2));

    // Churning surf foam hugging the Stone Jetty & every Huashi Cape granite reef outcrop
    float reefZone = surfEnergy * (1.0 - smoothstep(0.2, 2.35, depthMeters));
    float reefPulse = 0.55 + 0.45 * sin(uTime * 2.4 - depthMeters * 5.2 + foamNoise1 * 4.5);
    float reefFoam = reefZone * reefPulse * smoothstep(0.24, 0.68, foamNoise1 * 0.5 + foamNoise2 * 0.5 + reefZone * 0.36);

    // Subtle open-sea whitecaps on higher wave crests
    float whitecap = smoothstep(0.11, 0.24, vWaveCrest) * smoothstep(0.42, 0.78, foamNoise2) * uWindStrength * 0.38;

    float totalFoam = clamp(beachFoam * 0.92 + reefFoam * 1.05 + whitecap, 0.0, 0.96);

    // Atmosphere-harmonized foam tint (warm ivory in sun, golden peach at sunset, cool silver-blue at twilight)
    vec3 foamColor = mix(vec3(0.95, 0.97, 0.99), uSkyHorizonColor * 1.15, 0.28);
    foamColor = mix(foamColor, uSunColor * 1.05, 0.22 * (1.0 - uNightFactor));
    foamColor *= mix(1.0, 0.34, uNightFactor);

    vec3 finalColor = mix(surfaceColor, foamColor, totalFoam);

    // Crystal-clear shallow edge alpha feathering (0..0.38m) transitioning smoothly to rich deep sea
    float waterAlpha = smoothstep(-0.04, 0.32, depthMeters + 0.06 * (foamNoise1 - 0.5));
    waterAlpha = clamp(max(waterAlpha * (0.78 + 0.22 * (1.0 - shallowFactor)), totalFoam * 0.95), 0.0, 0.985);
    // Fully opaque far out so distant horizon blends seamlessly into fog
    waterAlpha = mix(waterAlpha, 1.0, smoothstep(45.0, 140.0, viewDist));

    #ifndef USE_FOG
      float manualFog = 1.0 - exp(-uFallbackFogDensity * uFallbackFogDensity * viewDist * viewDist);
      finalColor = mix(finalColor, uFallbackFogColor, clamp(manualFog, 0.0, 1.0));
    #endif

    gl_FragColor = vec4(finalColor, waterAlpha);

    #include <fog_fragment>
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

interface OceanUniforms {
  [uniform: string]: THREE.IUniform<unknown>;
  uTime: THREE.IUniform<number>;
  uWindStrength: THREE.IUniform<number>;
  uNightFactor: THREE.IUniform<number>;
  uSunDirection: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSkyTopColor: THREE.IUniform<THREE.Color>;
  uSkyHorizonColor: THREE.IUniform<THREE.Color>;
  uSkySunGlowColor: THREE.IUniform<THREE.Color>;
  uWaterDeepColor: THREE.IUniform<THREE.Color>;
  uWaterShallowColor: THREE.IUniform<THREE.Color>;
  uWaterSunColor: THREE.IUniform<THREE.Color>;
  uFallbackFogColor: THREE.IUniform<THREE.Color>;
  uFallbackFogDensity: THREE.IUniform<number>;
  uDepthMap: THREE.IUniform<THREE.DataTexture>;
  uDepthBounds: THREE.IUniform<THREE.Vector4>;
}

function buildYellowSeaOcean(
  reefs: ReefRockPlacement[],
  sampleTerrainHeight: (x: number, z: number) => number
): {
  mesh: THREE.Mesh;
  uniforms: OceanUniforms;
} {
  const depthTex = bakeSeabedDepthTexture(reefs, sampleTerrainHeight);
  const geom = buildShoreDenseOceanGeometry();

  const uniforms: OceanUniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uTime: { value: 0 },
    uWindStrength: { value: 1.0 },
    uNightFactor: { value: 0.0 },
    uSunDirection: { value: new THREE.Vector3(-0.52, 0.44, 0.73).normalize() },
    uSunColor: { value: new THREE.Color('#ffe1ad') },
    uSkyTopColor: { value: new THREE.Color('#2a6aa6') },
    uSkyHorizonColor: { value: new THREE.Color('#dbd1c0') },
    uSkySunGlowColor: { value: new THREE.Color('#ffdfa0') },
    uWaterDeepColor: { value: new THREE.Color('#12556b') },
    uWaterShallowColor: { value: new THREE.Color('#2c99a0') },
    uWaterSunColor: { value: new THREE.Color('#ffe7b3') },
    uFallbackFogColor: { value: new THREE.Color('#d5cdc0') },
    uFallbackFogDensity: { value: 0.0021 },
    uDepthMap: { value: depthTex },
    uDepthBounds: {
      value: new THREE.Vector4(
        DEPTH_MAP_MIN_X,
        DEPTH_MAP_MIN_Z,
        1 / (DEPTH_MAP_MAX_X - DEPTH_MAP_MIN_X),
        1 / (DEPTH_MAP_MAX_Z - DEPTH_MAP_MIN_Z)
      )
    }
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: OCEAN_VERTEX_SHADER,
    fragmentShader: OCEAN_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    fog: true
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'YellowSeaOcean';
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;

  return { mesh, uniforms };
}

// ============================================================================
// 7. DISTANT QINGDAO COASTLINE, LITTLE QINGDAO LIGHTHOUSE, & SAILBOATS
// ============================================================================

function createSoftGlowTexture(innerHex: string, outerHex: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(
      size * 0.5,
      size * 0.5,
      2,
      size * 0.5,
      size * 0.5,
      size * 0.5
    );
    grad.addColorStop(0.0, '#ffffff');
    grad.addColorStop(0.22, innerHex);
    grad.addColorStop(0.55, outerHex);
    grad.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

interface DistantHeadlandSpec {
  lengthX: number;
  lengthZ: number;
  maxHeight: number;
  seed: number;
  posX: number;
  posZ: number;
  rotY: number;
}

/** Exact shared analytical surface elevation for any distant coastal headland or islet. */
function sampleDistantHeadlandLocalY(
  spec: Pick<DistantHeadlandSpec, 'lengthX' | 'lengthZ' | 'maxHeight' | 'seed'>,
  lx: number,
  lz: number
): number {
  const nx = lx / (spec.lengthX * 0.5);
  const nz = lz / (spec.lengthZ * 0.5);
  const radial = Math.hypot(nx, nz);
  const mask = Math.pow(clamp(1 - radial, 0, 1), 1.55);
  const ridge =
    0.55 +
    0.32 * fbm2D(lx * 0.025 + spec.seed, lz * 0.025 - spec.seed * 0.7, 3) +
    0.13 * Math.sin(lx * 0.045 + spec.seed);
  return -2.2 + mask * spec.maxHeight * ridge;
}

function createDistantHeadlandGeometry(
  spec: Pick<DistantHeadlandSpec, 'lengthX' | 'lengthZ' | 'maxHeight' | 'seed'>
): THREE.BufferGeometry {
  const geom = new THREE.PlaneGeometry(spec.lengthX, spec.lengthZ, 34, 24);
  geom.rotateX(-Math.PI / 2);
  const pos = geom.getAttribute('position');

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, sampleDistantHeadlandLocalY(spec, x, z));
  }

  geom.computeVertexNormals();
  return geom;
}

/** Assigns a uniform RGB vertex color attribute to a geometry so multi-part meshes batch cleanly. */
function tintGeometryVertexColor(geom: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const nonIdx = geom.index ? geom.toNonIndexed() : geom;
  if (nonIdx !== geom) geom.dispose();
  const count = nonIdx.getAttribute('position').count;
  const col = new THREE.Color(hex);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  nonIdx.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return nonIdx;
}

function buildSailboat(scale: number, hullHex: string, stripeHex: string): {
  root: THREE.Group;
  sailMesh: THREE.Mesh;
  beaconMat: THREE.MeshBasicMaterial;
} {
  const root = new THREE.Group();

  // Merge rigid hull, deckhouse cabin, mast, and boom into 1 lean vertex-colored mesh
  const bodyMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.44,
    metalness: 0.18
  });
  const sailMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#f7f2e8'),
    roughness: 0.74,
    metalness: 0.02,
    side: THREE.DoubleSide
  });

  // Sleek tapered yacht hull along local +Z
  const hullGeom = new THREE.CylinderGeometry(0.95, 0.55, 8.2, 8);
  hullGeom.rotateX(Math.PI * 0.5);
  hullGeom.scale(1.15, 0.62, 1.0);
  hullGeom.translate(0, 0.42, 0);

  // Cabin deckhouse
  const cabinGeom = new THREE.BoxGeometry(1.15, 0.55, 2.8);
  cabinGeom.translate(0, 0.88, -0.35);

  // Tall graceful mast & boom
  const mastGeom = new THREE.CylinderGeometry(0.06, 0.09, 10.6, 8);
  mastGeom.translate(0, 5.8, 0.25);

  const boomGeom = new THREE.CylinderGeometry(0.045, 0.055, 4.2, 6);
  boomGeom.rotateX(Math.PI * 0.5);
  boomGeom.translate(0, 1.95, -1.85);

  const coloredParts = [
    tintGeometryVertexColor(hullGeom, hullHex),
    tintGeometryVertexColor(cabinGeom, stripeHex),
    tintGeometryVertexColor(mastGeom, '#c8ccd0'),
    tintGeometryVertexColor(boomGeom, '#c8ccd0')
  ];
  const bodyMesh = new THREE.Mesh(mergeGeometries(coloredParts), bodyMat);
  for (const p of coloredParts) p.dispose();
  root.add(bodyMesh);

  // Billowing curved mainsail + foresail jib
  const sailShape = new THREE.BufferGeometry();
  const sailVerts = new Float32Array([
    // Mainsail (curved subtly sideways by sea breeze)
    0.0, 10.7, 0.2,
    0.0, 2.0, 0.2,
    0.58, 2.0, -3.95,
    // Jib foresail
    0.0, 9.6, 0.32,
    0.42, 1.6, 0.55,
    0.0, 1.25, 3.85
  ]);
  sailShape.setAttribute('position', new THREE.BufferAttribute(sailVerts, 3));
  sailShape.computeVertexNormals();
  const sailMesh = new THREE.Mesh(sailShape, sailMat);
  root.add(sailMesh);

  // Subtle white bow-to-stern foam wake strip
  const wakeMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#eaf4f6'),
    transparent: true,
    opacity: 0.26,
    depthWrite: false
  });
  const wake = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 9.5), wakeMat);
  wake.rotation.x = -Math.PI * 0.5;
  wake.position.set(0, 0.08, -5.2);
  root.add(wake);

  // Tiny warm masthead twilight navigation beacon
  const beaconMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#ffcf7a'),
    transparent: true,
    opacity: 0.0
  });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), beaconMat);
  beacon.position.set(0, 11.2, 0.25);
  root.add(beacon);

  root.scale.setScalar(scale);
  return { root, sailMesh, beaconMat };
}

function buildDistantCoastline(textures: TextureLibrary): {
  group: THREE.Group;
  lighthouseBeaconMat: THREE.MeshBasicMaterial;
  lighthouseHalo: THREE.Sprite;
  headlandMat: THREE.MeshStandardMaterial;
  sailboats: SailboatInstance[];
} {
  const group = new THREE.Group();
  group.name = 'DistantCoastline';

  // Misty coastal pine headland material
  const headlandMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#4d6056'),
    roughness: 0.94,
    metalness: 0.02
  });

  // 1. Far West (Huiquan Cape / Lu Xun Park) & Far East (Taiping Cape) distant headlands
  const huiquanSpec: DistantHeadlandSpec = {
    lengthX: 240,
    lengthZ: 145,
    maxHeight: 22,
    seed: 13.7,
    posX: -255,
    posZ: 58,
    rotY: 0.22
  };
  const westFarSpec: DistantHeadlandSpec = {
    lengthX: 260,
    lengthZ: 130,
    maxHeight: 31,
    seed: 41.2,
    posX: -395,
    posZ: 125,
    rotY: 0.48
  };
  const taipingSpec: DistantHeadlandSpec = {
    lengthX: 255,
    lengthZ: 160,
    maxHeight: 26,
    seed: 29.4,
    posX: 248,
    posZ: 74,
    rotY: -0.34
  };
  const eastOuterSpec: DistantHeadlandSpec = {
    lengthX: 230,
    lengthZ: 135,
    maxHeight: 34,
    seed: 67.8,
    posX: 390,
    posZ: 165,
    rotY: -0.58
  };

  // Merge all 4 distant mainland coastal headlands into 1 lean mesh
  const headlandGeoms: THREE.BufferGeometry[] = [];
  for (const spec of [huiquanSpec, westFarSpec, taipingSpec, eastOuterSpec]) {
    const g = createDistantHeadlandGeometry(spec);
    g.rotateY(spec.rotY);
    g.translate(spec.posX, 0, spec.posZ);
    headlandGeoms.push(g);
  }
  const mainlandHeadlands = new THREE.Mesh(mergeGeometries(headlandGeoms), headlandMat);
  mainlandHeadlands.name = 'DistantMainlandHeadlands';
  mainlandHeadlands.receiveShadow = false;
  mainlandHeadlands.castShadow = false;
  group.add(mainlandHeadlands);
  for (const g of headlandGeoms) g.dispose();

  // 2. Grounded Qingdao "Red-Tile & Cream-Wall" Distant Hillside Villas on Taiping & Huiquan Capes
  //    Each villa queries exact headland elevation across its entire footprint so its solid cream
  //    masonry body extends well below the slope and its terracotta hipped roof sits flush atop!
  const distantWallMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#eae1d0'),
    roughness: 0.88,
    metalness: 0.02
  });
  const distantRoofMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#a64d36'),
    roughness: 0.82
  });

  const villaWallGeoms: THREE.BufferGeometry[] = [];
  const villaRoofGeoms: THREE.BufferGeometry[] = [];

  const distantVillas: {
    spec: DistantHeadlandSpec;
    lx: number;
    lz: number;
    w: number;
    d: number;
    wallVisH: number;
    roofH: number;
    localYaw: number;
  }[] = [
    // Taiping Cape (太平角) coastal hillside villas visible across the eastern bay
    { spec: taipingSpec, lx: -42, lz: -12, w: 6.4, d: 5.2, wallVisH: 2.3, roofH: 2.4, localYaw: 0.18 },
    { spec: taipingSpec, lx: -18, lz: 6, w: 7.4, d: 5.8, wallVisH: 2.7, roofH: 2.7, localYaw: -0.14 },
    { spec: taipingSpec, lx: 14, lz: -8, w: 6.8, d: 5.4, wallVisH: 2.5, roofH: 2.5, localYaw: 0.25 },
    { spec: taipingSpec, lx: 32, lz: 14, w: 6.0, d: 4.8, wallVisH: 2.2, roofH: 2.2, localYaw: -0.22 },
    // Huiquan Cape (匯泉角) coastal hillside villas framing the western bay
    { spec: huiquanSpec, lx: 35, lz: -10, w: 6.4, d: 5.2, wallVisH: 2.4, roofH: 2.3, localYaw: -0.2 },
    { spec: huiquanSpec, lx: 10, lz: 8, w: 7.2, d: 5.8, wallVisH: 2.6, roofH: 2.6, localYaw: 0.16 },
    { spec: huiquanSpec, lx: -22, lz: -6, w: 6.2, d: 5.0, wallVisH: 2.2, roofH: 2.3, localYaw: 0.3 }
  ];

  for (const dv of distantVillas) {
    // Sample headland slope across center + all 4 corners + 4 edge midpoints
    const hw = dv.w * 0.55;
    const hd = dv.d * 0.55;
    const cosY = Math.cos(dv.localYaw);
    const sinY = Math.sin(dv.localYaw);
    let minY = Infinity;
    let maxY = -Infinity;
    for (const sx of [-1, 0, 1]) {
      for (const sz of [-1, 0, 1]) {
        const px = dv.lx + sx * hw * cosY + sz * hd * sinY;
        const pz = dv.lz - sx * hw * sinY + sz * hd * cosY;
        const y = sampleDistantHeadlandLocalY(dv.spec, px, pz);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    // Solid grounded cream masonry body plunging 5.0m below the lowest slope corner!
    const foundationBotY = minY - 5.0;
    const eaveY = maxY + dv.wallVisH;
    const bodyH = eaveY - foundationBotY;

    const wallGeom = new THREE.BoxGeometry(dv.w, bodyH, dv.d);
    wallGeom.rotateY(dv.localYaw);
    wallGeom.translate(dv.lx, foundationBotY + bodyH * 0.5, dv.lz);
    wallGeom.rotateY(dv.spec.rotY);
    wallGeom.translate(dv.spec.posX, 0, dv.spec.posZ);
    villaWallGeoms.push(wallGeom);

    // Snug terracotta-red hipped-pyramid roof aligned squarely with masonry walls & overlapping eaves
    const roofGeom = new THREE.ConeGeometry(Math.SQRT1_2, dv.roofH, 4);
    roofGeom.rotateY(Math.PI * 0.25);
    roofGeom.scale(dv.w + 0.9, 1, dv.d + 0.9);
    roofGeom.rotateY(dv.localYaw);
    roofGeom.translate(dv.lx, eaveY - 0.2 + dv.roofH * 0.5, dv.lz);
    roofGeom.rotateY(dv.spec.rotY);
    roofGeom.translate(dv.spec.posX, 0, dv.spec.posZ);
    villaRoofGeoms.push(roofGeom);
  }

  const distantWallsMesh = new THREE.Mesh(mergeGeometries(villaWallGeoms), distantWallMat);
  distantWallsMesh.name = 'DistantVillaWalls';
  group.add(distantWallsMesh);

  const distantRoofsMesh = new THREE.Mesh(mergeGeometries(villaRoofGeoms), distantRoofMat);
  distantRoofsMesh.name = 'DistantVillaRoofs';
  group.add(distantRoofsMesh);

  for (const g of [...villaWallGeoms, ...villaRoofGeoms]) g.dispose();

  // 3. Iconic 小青島 (Little Qingdao Islet) & White Octagonal 小青島燈塔 (Little Qingdao Lighthouse)!
  const islandGroup = new THREE.Group();
  islandGroup.name = 'LittleQingdaoIsland';
  islandGroup.position.set(-252, 0, 215);

  const isletSpec: DistantHeadlandSpec = {
    lengthX: 78,
    lengthZ: 56,
    maxHeight: 13.5,
    seed: 88.3,
    posX: -252,
    posZ: 215,
    rotY: 0
  };
  const isletTerrain = new THREE.Mesh(createDistantHeadlandGeometry(isletSpec), headlandMat);
  isletTerrain.receiveShadow = false;
  isletTerrain.castShadow = false;
  islandGroup.add(isletTerrain);

  // Query exact islet summit & rim height so the lighthouse plinth sits 100% flush with zero gap
  const isletCenterY = sampleDistantHeadlandLocalY(isletSpec, 0, 0);
  let isletMinRimY = isletCenterY;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const ry = sampleDistantHeadlandLocalY(isletSpec, Math.cos(a) * 3.8, Math.sin(a) * 3.8);
    if (ry < isletMinRimY) isletMinRimY = ry;
  }

  // Rocky islet shoreline ring + deep-rooted octagonal lighthouse stone plinth (merged into 1 draw call)
  const isletRockMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#5a5856'),
    roughness: 0.9
  });
  const shoreRingGeom = new THREE.CylinderGeometry(28, 34, 3.2, 14);
  shoreRingGeom.scale(1.12, 1.0, 0.82);
  shoreRingGeom.translate(0, 0.4, 0);

  const plinthBotY = isletMinRimY - 3.2;
  const plinthTopY = isletCenterY + 2.25;
  const plinthH = plinthTopY - plinthBotY;
  const plinthGeom = new THREE.CylinderGeometry(3.2, 4.1, plinthH, 8);
  plinthGeom.translate(0, plinthBotY + plinthH * 0.5, 0);

  const isletRockMesh = new THREE.Mesh(
    mergeGeometries([shoreRingGeom, plinthGeom]),
    isletRockMat
  );
  islandGroup.add(isletRockMesh);
  shoreRingGeom.dispose();
  plinthGeom.dispose();

  // Iconic White Octagonal Little Qingdao Lighthouse (小青島白塔, ~15m tall atop grounded plinth)
  const stuccoTex = (textures.warmStucco ?? TEXTURES.warmStucco).map;
  const towerWhiteMat = new THREE.MeshStandardMaterial({
    map: stuccoTex,
    color: new THREE.Color('#f7f4ec'),
    roughness: 0.72,
    metalness: 0.04
  });
  const towerRedMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#b63d2c'),
    roughness: 0.68
  });

  const shaftBaseY = plinthTopY - 0.15;
  const shaftGeom = new THREE.CylinderGeometry(1.75, 2.75, 11.8, 8);
  shaftGeom.translate(0, shaftBaseY + 5.9, 0);

  const galleryGeom = new THREE.CylinderGeometry(2.35, 2.0, 0.85, 8);
  galleryGeom.translate(0, shaftBaseY + 12.0, 0);

  const towerWhiteMesh = new THREE.Mesh(
    mergeGeometries([shaftGeom, galleryGeom]),
    towerWhiteMat
  );
  islandGroup.add(towerWhiteMesh);
  shaftGeom.dispose();
  galleryGeom.dispose();

  const lighthouseBeaconMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#fff2c4')
  });
  const lanternRoom = new THREE.Mesh(
    new THREE.CylinderGeometry(1.38, 1.38, 2.1, 8),
    lighthouseBeaconMat
  );
  lanternRoom.position.y = shaftBaseY + 13.45;
  islandGroup.add(lanternRoom);

  const cupola = new THREE.Mesh(new THREE.ConeGeometry(1.9, 2.6, 8), towerRedMat);
  cupola.position.y = shaftBaseY + 15.7;
  islandGroup.add(cupola);

  // Warm pulsing maritime lighthouse halo sprite (glows luminously across the bay at sunset & twilight!)
  const haloTex = createSoftGlowTexture('#ffe49e', '#ff8c2e');
  const lighthouseHalo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: haloTex,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  lighthouseHalo.position.set(0, shaftBaseY + 13.5, 0);
  lighthouseHalo.scale.set(16, 16, 1);
  islandGroup.add(lighthouseHalo);

  group.add(islandGroup);

  // 4. Three Graceful Distant Sailboats Drifting on the Yellow Sea Horizon (青島帆船)
  const sailboatConfigs = [
    {
      baseX: -62,
      baseZ: 196,
      orbitRadiusX: 52,
      orbitRadiusZ: 18,
      speed: 0.024,
      phase: 0.4,
      scale: 1.15,
      hull: '#f2f0ea',
      stripe: '#1f4466'
    },
    {
      baseX: 38,
      baseZ: 242,
      orbitRadiusX: 64,
      orbitRadiusZ: 22,
      speed: -0.019,
      phase: 2.3,
      scale: 1.3,
      hull: '#eef1f4',
      stripe: '#8c3426'
    },
    {
      baseX: 118,
      baseZ: 184,
      orbitRadiusX: 44,
      orbitRadiusZ: 16,
      speed: 0.028,
      phase: 4.1,
      scale: 1.0,
      hull: '#f6f2e9',
      stripe: '#264d44'
    }
  ];

  const sailboats: SailboatInstance[] = [];
  for (const cfg of sailboatConfigs) {
    const built = buildSailboat(cfg.scale, cfg.hull, cfg.stripe);
    built.root.position.set(cfg.baseX, 0, cfg.baseZ);
    group.add(built.root);
    sailboats.push({
      root: built.root,
      sailMesh: built.sailMesh,
      beaconMat: built.beaconMat,
      baseX: cfg.baseX,
      baseZ: cfg.baseZ,
      heading: 0,
      orbitRadiusX: cfg.orbitRadiusX,
      orbitRadiusZ: cfg.orbitRadiusZ,
      speed: cfg.speed,
      phase: cfg.phase,
      scale: cfg.scale
    });
  }

  return { group, lighthouseBeaconMat, lighthouseHalo, headlandMat, sailboats };
}

// ============================================================================
// MAIN MODULE FACTORY
// ============================================================================

export function createTerrainAndSea(
  textures: TextureLibrary = TEXTURES
): TerrainAndSeaModule {
  const group = new THREE.Group();
  group.name = 'TerrainAndSea';

  // Generate deterministic coastal reef coordinates first so BOTH the rock meshes
  // and the baked 256x256 seabed depth map share 100% identical geometry!
  const reefPlacements = generateCoastalReefPlacements();

  const terrain = buildCoastalTerrain(textures);
  const roads = buildRoadsAndBoardwalk(textures);
  const seawall = buildSeawallPromenade(textures);
  const jetty = buildStoneJetty(textures);
  const reefs = buildCoastalReefs(reefPlacements, textures);
  const ocean = buildYellowSeaOcean(reefPlacements, terrain.sampleHeight);
  const distant = buildDistantCoastline(textures);

  group.add(terrain.mesh);
  group.add(roads);
  group.add(seawall);
  group.add(jetty.group);
  group.add(reefs);
  group.add(ocean.mesh);
  group.add(distant.group);

  let currentNightFactor = 0;
  let currentWindStrength = 1;
  let lastAppliedSig = '';
  const beaconWarmColor = new THREE.Color('#ffda82');
  const beaconDayColor = new THREE.Color('#f4f2e8');
  const headlandTargetColor = new THREE.Color('#4c6154');

  const getHeadlandColorHex = (id: AtmosphereConfig['id']): string => {
    if (id === 'morning') return '#586c68';
    if (id === 'sunset') return '#54484d';
    if (id === 'twilight') return '#1f2f45';
    return '#4c6154';
  };

  const applyAtmosphere = (cfg: AtmosphereConfig): void => {
    lastAppliedSig = `${cfg.id}|${cfg.waterDeepColor}|${cfg.fogColor}|${cfg.skyHorizonColor}|${cfg.sunColor}|${cfg.fogDensity.toFixed(5)}`;
    currentNightFactor = cfg.nightFactor;
    currentWindStrength = cfg.windStrength;

    // Update Yellow Sea custom GLSL shader uniforms
    const u = ocean.uniforms;
    u.uSunDirection.value.set(cfg.sunDirection[0], cfg.sunDirection[1], cfg.sunDirection[2]).normalize();
    u.uSunColor.value.set(cfg.sunColor);
    u.uSkyTopColor.value.set(cfg.skyTopColor);
    u.uSkyHorizonColor.value.set(cfg.skyHorizonColor);
    u.uSkySunGlowColor.value.set(cfg.skySunGlowColor);
    u.uWaterDeepColor.value.set(cfg.waterDeepColor);
    u.uWaterShallowColor.value.set(cfg.waterShallowColor);
    u.uWaterSunColor.value.set(cfg.waterSunColor);
    u.uFallbackFogColor.value.set(cfg.fogColor);
    u.uFallbackFogDensity.value = cfg.fogDensity;
    u.uNightFactor.value = cfg.nightFactor;
    u.uWindStrength.value = cfg.windStrength;

    // Harmonize distant coastal pine headlands with the mood palette
    headlandTargetColor.set(getHeadlandColorHex(cfg.id));
    distant.headlandMat.color.copy(headlandTargetColor);

    // Pier-head harbor lantern & sailboat twilight navigation lights
    const lampGlow = smoothstep(0.08, 0.72, cfg.nightFactor);
    jetty.lanternMat.emissiveIntensity = 0.18 + lampGlow * 3.2;
    jetty.lanternGlow.material.opacity = lampGlow * 0.75;

    for (const boat of distant.sailboats) {
      boat.beaconMat.opacity = lampGlow * 0.9;
    }
  };

  // Initialize immediately with Qingdao's signature Golden Autumn mood
  applyAtmosphere(ATMOSPHERE_PRESETS[DEFAULT_MOOD]);

  const update = (ctx: WorldUpdateContext): void => {
    const t = ctx.time;

    // Smoothly stay in sync whenever atmosphere config interpolates or changes
    if (ctx.atmosphere) {
      const cfg = ctx.atmosphere;
      const sig = `${cfg.id}|${cfg.waterDeepColor}|${cfg.fogColor}|${cfg.skyHorizonColor}|${cfg.sunColor}|${cfg.fogDensity.toFixed(5)}`;
      if (sig !== lastAppliedSig) {
        lastAppliedSig = sig;
        const u = ocean.uniforms;
        u.uSunColor.value.set(cfg.sunColor);
        u.uSkyTopColor.value.set(cfg.skyTopColor);
        u.uSkyHorizonColor.value.set(cfg.skyHorizonColor);
        u.uSkySunGlowColor.value.set(cfg.skySunGlowColor);
        u.uWaterDeepColor.value.set(cfg.waterDeepColor);
        u.uWaterShallowColor.value.set(cfg.waterShallowColor);
        u.uWaterSunColor.value.set(cfg.waterSunColor);
        u.uFallbackFogColor.value.set(cfg.fogColor);
        u.uFallbackFogDensity.value = cfg.fogDensity;
        headlandTargetColor.set(getHeadlandColorHex(cfg.id));
      }
      distant.headlandMat.color.lerp(headlandTargetColor, Math.min(1, ctx.dt * 3.0));
    }

    currentNightFactor = ctx.nightFactor;
    currentWindStrength = ctx.windStrength;

    // 1. Animate Yellow Sea shader & wet-sand shoreline swash
    terrain.uniforms.uTime.value = t;
    ocean.uniforms.uTime.value = t;
    ocean.uniforms.uSunDirection.value.copy(ctx.sunDirection).normalize();
    ocean.uniforms.uNightFactor.value = currentNightFactor;
    ocean.uniforms.uWindStrength.value = currentWindStrength;

    // 2. Pulse iconic Little Qingdao Lighthouse warm maritime beacon
    const beaconPulse = Math.pow(Math.sin(t * 1.45) * 0.5 + 0.5, 2.8);
    const duskStrength = smoothstep(0.05, 0.75, currentNightFactor);
    distant.lighthouseBeaconMat.color
      .copy(beaconDayColor)
      .lerp(beaconWarmColor, 0.35 + 0.65 * duskStrength);

    const haloOpacity = 0.14 + duskStrength * (0.42 + 0.48 * beaconPulse) + (1 - duskStrength) * beaconPulse * 0.16;
    const haloScale = 11.0 + duskStrength * 14.0 + beaconPulse * (6.0 + duskStrength * 12.0);
    distant.lighthouseHalo.material.opacity = haloOpacity;
    distant.lighthouseHalo.scale.set(haloScale, haloScale, 1);

    // Subtle living shimmer on the Stone Jetty pier-head harbor lantern & sailboat beacons
    const lampGlow = smoothstep(0.08, 0.72, currentNightFactor);
    if (duskStrength > 0.01) {
      const flicker = 0.92 + 0.08 * Math.sin(t * 3.7 + 1.1);
      jetty.lanternMat.emissiveIntensity = (0.18 + duskStrength * 3.2) * flicker;
      jetty.lanternGlow.material.opacity = duskStrength * 0.78 * flicker;
      const gScale = 2.6 + duskStrength * 1.4 * flicker;
      jetty.lanternGlow.scale.set(gScale, gScale, 1);
    } else {
      jetty.lanternMat.emissiveIntensity = 0.18;
      jetty.lanternGlow.material.opacity = 0;
    }

    for (let i = 0; i < distant.sailboats.length; i++) {
      distant.sailboats[i].beaconMat.opacity = lampGlow * 0.9;
    }

    // 3. Glide distant sailboats gently across the Yellow Sea horizon
    const waveMod = 0.65 + 0.45 * currentWindStrength;
    for (let i = 0; i < distant.sailboats.length; i++) {
      const b = distant.sailboats[i];
      const ang = t * b.speed + b.phase;
      const x = b.baseX + Math.cos(ang) * b.orbitRadiusX;
      const z = b.baseZ + Math.sin(ang) * b.orbitRadiusZ;
      const vx = -Math.sin(ang) * b.orbitRadiusX * b.speed;
      const vz = Math.cos(ang) * b.orbitRadiusZ * b.speed;

      b.root.position.set(
        x,
        Math.sin(t * 1.15 + b.phase * 2.0) * 0.14 * waveMod,
        z
      );
      b.root.rotation.y = Math.atan2(vx, vz);
      // Natural heel in sea breeze + gentle pitch on coastal swells
      b.root.rotation.z = (0.065 + 0.045 * Math.sin(t * 0.85 + b.phase)) * waveMod * (b.speed >= 0 ? 1 : -1);
      b.root.rotation.x = Math.sin(t * 1.32 + b.phase * 1.5) * 0.032 * waveMod;
    }
  };

  return {
    group,
    update,
    applyAtmosphere
  };
}
