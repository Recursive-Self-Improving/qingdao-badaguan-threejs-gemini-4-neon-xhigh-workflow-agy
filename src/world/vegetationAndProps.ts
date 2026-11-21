import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  ATMOSPHERE_PRESETS,
  DEFAULT_MOOD,
  JETTY,
  VIEWPOINTS,
  VILLAS,
  WORLD_BOUNDS,
  clamp,
  createRng,
  getCoastZone,
  getRoadById,
  getRoadInfo,
  getSeawallZ,
  getTerrainHeight,
  getTerrainSlope,
  getVillaWallSegments,
  sampleRoadPoint,
  seededRange
} from './layout';
import { TEXTURES } from './textures';
import type {
  AtmosphereConfig,
  FoliageClusterTextureSet,
  PBRTextureMaps,
  RoadCurveSpec,
  TreeSpecies,
  VillaPlacement,
  WorldUpdateContext
} from './types';

// ============================================================================
// PUBLIC INTERFACES
// ============================================================================

export interface TextureLibrary {
  readonly treeBark: PBRTextureMaps;
  readonly sycamoreBark: PBRTextureMaps;
  readonly woodPlank: PBRTextureMaps;
  readonly graniteCobble: PBRTextureMaps;
  readonly mushroomGranite?: PBRTextureMaps;
  readonly foliageClusterTextures: FoliageClusterTextureSet;
  readonly createRoadSignTexture: (
    zhName: string,
    enName: string,
    subText?: string
  ) => THREE.CanvasTexture;
}

export interface VegetationAndPropsModule {
  group: THREE.Group;
  update(ctx: WorldUpdateContext): void;
  applyAtmosphere(cfg: AtmosphereConfig): void;
  dispose(): void;
}

// ============================================================================
// INTERNAL DATA STRUCTURES
// ============================================================================

interface FoliageAnchor {
  pos: THREE.Vector3;
  scale: THREE.Vector3;
  rotY: number;
  tiltX: number;
  tiltZ: number;
  /** 0 = lower/interior shaded foliage, 1 = sunlit upper crown. */
  sunBias: number;
}

interface TreeArchetype {
  trunkGeometry: THREE.BufferGeometry;
  foliageAnchors: FoliageAnchor[];
}

interface PlacedTree {
  species: TreeSpecies;
  variant: number;
  x: number;
  y: number;
  z: number;
  scaleXZ: number;
  scaleY: number;
  rotY: number;
  leanX: number;
  leanZ: number;
  colorShift: number;
  huePick: number;
}

interface PlacedLamp {
  x: number;
  y: number;
  z: number;
  rotY: number;
  isHero: boolean;
}

interface PlacedBench {
  x: number;
  y: number;
  z: number;
  rotY: number;
  pitchX: number;
  rollZ: number;
}

interface DriftingLeafState {
  x: number;
  y: number;
  z: number;
  baseX: number;
  baseZ: number;
  groundY: number;
  minY: number;
  maxY: number;
  fallSpeed: number;
  swayFreq: number;
  swayAmp: number;
  phase: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  spinX: number;
  spinY: number;
  spinZ: number;
  scale: number;
}

interface SeagullState {
  centerX: number;
  centerZ: number;
  baseY: number;
  radiusX: number;
  radiusZ: number;
  figureEight: boolean;
  angularSpeed: number;
  phase: number;
  bobAmp: number;
  bobFreq: number;
  flapRate: number;
  glideOffset: number;
  scale: number;
  dirSign: number;
}

interface FoliageUniformBundle {
  uTime: { value: number };
  uWindStrength: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uTranslucency: { value: number };
}

// ============================================================================
// 1. SPATIAL VALIDATION & SIGHTLINE PROTECTION HELPERS
// ============================================================================

const ROAD_INTERSECTIONS: readonly [number, number, number][] = [
  [-8.0, -15.5, 9.4], // Juyongguan x Jiayuguan
  [-8.0, 29.2, 9.8], // Juyongguan x Shanhaiguan
  [21.5, 27.6, 7.2] // Shanhaiguan x Huashi Cape Path
];

interface GateInfo {
  villa: VillaPlacement;
  worldX: number;
  worldZ: number;
  outX: number;
  outZ: number;
}

function worldToVillaLocal(villa: VillaPlacement, x: number, z: number): [number, number] {
  const dx = x - villa.position[0];
  const dz = z - villa.position[2];
  const c = Math.cos(villa.rotationY);
  const s = Math.sin(villa.rotationY);
  return [dx * c - dz * s, dx * s + dz * c];
}

function villaLocalToWorld(villa: VillaPlacement, lx: number, lz: number): [number, number] {
  const c = Math.cos(villa.rotationY);
  const s = Math.sin(villa.rotationY);
  return [
    villa.position[0] + lx * c + lz * s,
    villa.position[2] - lx * s + lz * c
  ];
}

function computeVillaGates(): GateInfo[] {
  return VILLAS.map((villa) => {
    const halfW = villa.courtyardWidth * 0.5;
    const halfD = villa.courtyardDepth * 0.5;
    let lx = 0;
    let lz = 0;
    let olx = 0;
    let olz = 0;
    if (villa.gateSide === 'front') {
      lz = halfD;
      olz = 1;
    } else if (villa.gateSide === 'back') {
      lz = -halfD;
      olz = -1;
    } else if (villa.gateSide === 'left') {
      lx = -halfW;
      olx = -1;
    } else {
      lx = halfW;
      olx = 1;
    }
    const [wx, wz] = villaLocalToWorld(villa, lx, lz);
    const c = Math.cos(villa.rotationY);
    const s = Math.sin(villa.rotationY);
    return {
      villa,
      worldX: wx,
      worldZ: wz,
      outX: olx * c + olz * s,
      outZ: -olx * s + olz * c
    };
  });
}

const VILLA_GATES: GateInfo[] = computeVillaGates();
const ALL_WALL_SEGMENTS = VILLAS.flatMap((v) => getVillaWallSegments(v));

function pointToSegmentDistSq(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  const t = lenSq > 1e-8 ? clamp(((px - ax) * dx + (pz - az) * dz) / lenSq, 0, 1) : 0;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  const ex = px - cx;
  const ez = pz - cz;
  return ex * ex + ez * ez;
}

function isInsideAnyVillaBuilding(x: number, z: number, margin: number): boolean {
  for (let i = 0; i < VILLAS.length; i++) {
    const v = VILLAS[i];
    const [lx, lz] = worldToVillaLocal(v, x, z);
    if (
      Math.abs(lx) < v.footprintWidth * 0.5 + margin &&
      Math.abs(lz) < v.footprintDepth * 0.5 + margin
    ) {
      return true;
    }
  }
  return false;
}

function isInsideAnyVillaCourtyard(x: number, z: number, margin: number): boolean {
  for (let i = 0; i < VILLAS.length; i++) {
    const v = VILLAS[i];
    const [lx, lz] = worldToVillaLocal(v, x, z);
    if (
      Math.abs(lx) < v.courtyardWidth * 0.5 + margin &&
      Math.abs(lz) < v.courtyardDepth * 0.5 + margin
    ) {
      return true;
    }
  }
  return false;
}

function isNearAnyVillaWall(x: number, z: number, clearance: number): boolean {
  for (let i = 0; i < ALL_WALL_SEGMENTS.length; i++) {
    const seg = ALL_WALL_SEGMENTS[i];
    const dx = x - seg.centerX;
    const dz = z - seg.centerZ;
    const c = Math.cos(seg.rotationY);
    const s = Math.sin(seg.rotationY);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    if (
      Math.abs(lx) < seg.length * 0.5 + clearance &&
      Math.abs(lz) < seg.thickness * 0.5 + clearance
    ) {
      return true;
    }
  }
  return false;
}

function isInAnyVillaGateCorridor(x: number, z: number, extraHalfWidth = 1.4): boolean {
  for (let i = 0; i < VILLA_GATES.length; i++) {
    const g = VILLA_GATES[i];
    const rx = x - g.worldX;
    const rz = z - g.worldZ;
    const along = rx * g.outX + rz * g.outZ;
    const perp = Math.abs(rx * -g.outZ + rz * g.outX);
    const halfGate = g.villa.gateWidth * 0.5 + extraHalfWidth;
    if (along >= -5.2 && along <= 10.5 && perp <= halfGate) {
      return true;
    }
  }
  return false;
}

function isNearIntersection(x: number, z: number, scale = 1.0): boolean {
  for (let i = 0; i < ROAD_INTERSECTIONS.length; i++) {
    const [ix, iz, rad] = ROAD_INTERSECTIONS[i];
    const r = rad * scale;
    const dx = x - ix;
    const dz = z - iz;
    if (dx * dx + dz * dz < r * r) {
      return true;
    }
  }
  return false;
}

function isBlockingViewpointSightline(x: number, z: number, clearanceRadius: number): boolean {
  // 1. Protect close camera bubbles for all 6 viewpoints
  for (let i = 0; i < VIEWPOINTS.length; i++) {
    const vp = VIEWPOINTS[i];
    if (vp.id === 'coastal_overview') continue; // Aerial camera at Y = 34
    const dx = x - vp.position[0];
    const dz = z - vp.position[2];
    const minBubble = 5.2 + clearanceRadius;
    if (dx * dx + dz * dz < minBubble * minBubble) {
      return true;
    }
  }

  // 2. Keep key iconic framing sightlines open so hero villas shine cleanly
  const corridors: readonly [number, number, number, number, number][] = [
    // Spawn point along Juyongguan Ave toward Princess House & sea gap
    [-8.0, -34.0, -6.5, 16.0, 3.3],
    // Princess House viewpoint straight through gate to blue-green facade
    [-5.0, -1.5, 11.5, -2.0, 3.6],
    // Huashi Cape path framing Huashi Castle turret
    [26.0, 29.8, 46.5, 43.0, 3.7],
    // Maple/Butterfly crossroads vista looking toward Butterfly Villa
    [-14.0, -15.5, -31.5, 8.0, 3.4]
  ];

  for (let i = 0; i < corridors.length; i++) {
    const [ax, az, bx, bz, halfW] = corridors[i];
    const r = halfW + clearanceRadius;
    if (pointToSegmentDistSq(x, z, ax, az, bx, bz) < r * r) {
      return true;
    }
  }

  return false;
}

function isWithinWorldPlayable(x: number, z: number, margin = 4.0): boolean {
  return (
    x >= WORLD_BOUNDS.minX + margin &&
    x <= WORLD_BOUNDS.maxX - margin &&
    z >= WORLD_BOUNDS.minZ + margin &&
    z <= WORLD_BOUNDS.maxZ - margin
  );
}

// ============================================================================
// 2. GEOMETRY NORMALIZATION & BOTANICAL BUILDER PRIMITIVES
// ============================================================================

function ensureIndexedNormalized(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const nonIndexed = geo.index ? geo.toNonIndexed() : geo.clone();
  if (!nonIndexed.getAttribute('normal')) {
    nonIndexed.computeVertexNormals();
  }
  if (!nonIndexed.getAttribute('uv')) {
    const count = nonIndexed.getAttribute('position').count;
    nonIndexed.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  // Keep only position, normal, uv so mergeGeometries never fails on mismatched attributes
  for (const attrName of Object.keys(nonIndexed.attributes)) {
    if (attrName !== 'position' && attrName !== 'normal' && attrName !== 'uv') {
      nonIndexed.deleteAttribute(attrName);
    }
  }
  return nonIndexed;
}

function safeMergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const cleaned = parts.map(ensureIndexedNormalized);
  const merged = mergeGeometries(cleaned, false);
  for (const g of cleaned) g.dispose();
  if (!merged) {
    throw new Error('Failed to merge procedural geometries in vegetationAndProps.ts');
  }
  return merged;
}

/**
 * Builds a tapered curved organic branch/trunk tube along a 3D CatmullRomCurve3,
 * with flared root option at t=0 and clean UV tiling along branch length.
 */
function buildTaperedBranchTube(
  points: THREE.Vector3[],
  radiusStart: number,
  radiusEnd: number,
  tubularSegments: number,
  radialSegments: number,
  rootFlare = 0
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points);
  const frames = curve.computeFrenetFrames(tubularSegments, false);
  const curveLen = curve.getLength();

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const p = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (let i = 0; i <= tubularSegments; i++) {
    const u = i / tubularSegments;
    curve.getPointAt(u, p);

    const N = frames.normals[i];
    const B = frames.binormals[i];

    // Taper smoothly with optional flared roots near base
    let rad = radiusStart + (radiusEnd - radiusStart) * Math.pow(u, 0.85);
    if (rootFlare > 0 && u < 0.24) {
      const ft = 1 - u / 0.24;
      rad += rootFlare * ft * ft;
    }

    for (let j = 0; j <= radialSegments; j++) {
      const v = j / radialSegments;
      const theta = v * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      // Subtle organic bark fluting at the root collar
      let localRad = rad;
      if (rootFlare > 0 && u < 0.24) {
        const flute = 1 + 0.14 * Math.sin(theta * 5 + 0.4) * (1 - u / 0.24);
        localRad *= flute;
      }

      n.set(
        cosT * N.x + sinT * B.x,
        cosT * N.y + sinT * B.y,
        cosT * N.z + sinT * B.z
      ).normalize();

      positions.push(p.x + n.x * localRad, p.y + n.y * localRad, p.z + n.z * localRad);
      normals.push(n.x, n.y, n.z);
      uvs.push(v * Math.max(1, Math.round(radiusStart * 5)), u * curveLen * 0.42);
    }
  }

  const ring = radialSegments + 1;
  for (let i = 0; i < tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * ring + j;
      const b = (i + 1) * ring + j;
      const c = (i + 1) * ring + (j + 1);
      const d = i * ring + (j + 1);
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/**
 * Volumetric multi-card botanical leaf-cluster rosette geometry with spherical
 * outward-blended normals so sunlight wraps naturally across foliage clouds
 * without harsh dark card-intersection seams.
 */
function createVolumetricFoliageClusterGeometry(flattenedTier = false): THREE.BufferGeometry {
  const cards: THREE.BufferGeometry[] = [];
  const cardConfigs = flattenedTier
    ? [
        // Broad arched evergreen bough top fan (full layered coverage from aerial & oblique views)
        { rotX: Math.PI * 0.42, rotY: 0.0, rotZ: 0.06, scaleX: 1.34, scaleY: 1.26, oy: 0.14 },
        // Three cross-angled profile skirt cards evenly spaced at 0°/60°/120° so conifer boughs stay lush from eye-level
        { rotX: 0.44, rotY: 0.0, rotZ: 0.05, scaleX: 1.22, scaleY: 0.88, oy: -0.02 },
        { rotX: -0.44, rotY: Math.PI / 3, rotZ: -0.06, scaleX: 1.20, scaleY: 0.86, oy: 0.02 },
        { rotX: 0.42, rotY: (Math.PI * 2) / 3, rotZ: 0.04, scaleX: 1.20, scaleY: 0.86, oy: -0.03 }
      ]
    : [
        // Lush ruffled 4-card botanical rosette for ginkgo, maple, & sycamore crowns
        { rotX: 0.18, rotY: 0.0, rotZ: 0.06, scaleX: 1.05, scaleY: 1.02, oy: 0.0 },
        { rotX: -0.16, rotY: Math.PI / 3, rotZ: -0.08, scaleX: 1.02, scaleY: 0.98, oy: 0.04 },
        { rotX: 0.22, rotY: (Math.PI * 2) / 3, rotZ: 0.05, scaleX: 1.04, scaleY: 1.0, oy: -0.03 },
        { rotX: Math.PI * 0.44, rotY: 0.45, rotZ: -0.06, scaleX: 0.98, scaleY: 0.98, oy: 0.16 }
      ];

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const t = new THREE.Vector3();
  const domeDepth = flattenedTier ? 0.21 : 0.18;

  for (const cfg of cardConfigs) {
    const plane = new THREE.PlaneGeometry(1.0, 1.0, 2, 2);
    // Gently cup/dome each leaf card so it looks organically ruffled from all angles
    const posAttr = plane.getAttribute('position');
    for (let i = 0; i < posAttr.count; i++) {
      const vx = posAttr.getX(i);
      const vy = posAttr.getY(i);
      const rSq = vx * vx + vy * vy;
      posAttr.setZ(i, (0.28 - rSq) * domeDepth);
    }

    e.set(cfg.rotX, cfg.rotY, cfg.rotZ);
    q.setFromEuler(e);
    s.set(cfg.scaleX, cfg.scaleY, 1.0);
    t.set(0, cfg.oy, 0);
    m.compose(t, q, s);
    plane.applyMatrix4(m);
    cards.push(plane);
  }

  const merged = safeMergeGeometries(cards);
  for (const c of cards) c.dispose();

  // Replace flat card normals with soft outward-upward volumetric crown normals
  const posAttr = merged.getAttribute('position');
  const normAttr = merged.getAttribute('normal');
  const v = new THREE.Vector3();
  for (let i = 0; i < posAttr.count; i++) {
    v.set(posAttr.getX(i), posAttr.getY(i) + (flattenedTier ? 0.42 : 0.38), posAttr.getZ(i));
    if (v.lengthSq() < 1e-5) {
      v.set(0, 1, 0);
    } else {
      v.normalize();
    }
    normAttr.setXYZ(i, v.x, v.y, v.z);
  }
  normAttr.needsUpdate = true;
  return merged;
}

/** Gently curled individual autumn leaf geometry for carpets & fluttering particles. */
function createCurledLeafGeometry(size = 0.24): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(size, size, 2, 2);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const edgeCurl = (x * x + y * y) / (size * size * 0.5);
    pos.setZ(i, edgeCurl * size * 0.14);
  }
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

// ============================================================================
// 3. SPECIES ARCHETYPE GENERATORS (GINKGO, MAPLE, SYCAMORE, CEDAR / PINE)
// ============================================================================

function buildGinkgoArchetype(seed: number): TreeArchetype {
  const rng = createRng(seed);
  const branchGeos: THREE.BufferGeometry[] = [];
  const anchors: FoliageAnchor[] = [];

  const totalH = seededRange(rng, 10.8, 12.6);
  const bendX = seededRange(rng, -0.22, 0.22);
  const bendZ = seededRange(rng, -0.22, 0.22);

  // Tall upright trunk with root flare buried below y=0
  const trunkPts = [
    new THREE.Vector3(0, -0.32, 0),
    new THREE.Vector3(bendX * 0.25, totalH * 0.22, bendZ * 0.25),
    new THREE.Vector3(bendX * 0.75, totalH * 0.52, bendZ * 0.65),
    new THREE.Vector3(bendX * 0.55, totalH * 0.78, bendZ * 0.85),
    new THREE.Vector3(bendX * 0.25, totalH * 0.96, bendZ * 0.5)
  ];
  branchGeos.push(buildTaperedBranchTube(trunkPts, 0.34, 0.065, 11, 7, 0.18));

  const trunkCurve = new THREE.CatmullRomCurve3(trunkPts);
  const branchCount = 9;

  for (let b = 0; b < branchCount; b++) {
    const t = 0.35 + (b / (branchCount - 1)) * 0.56;
    const origin = trunkCurve.getPointAt(t);
    const azimuth = b * 2.39996 + seededRange(rng, -0.25, 0.25); // Golden angle phyllotaxis
    // Iconic upright pyramidal ginkgo silhouette: wider lower boughs, narrower upper crown
    const heightProfile = Math.sin(clamp((t - 0.28) / 0.72, 0.05, 0.98) * Math.PI);
    const reach = (1.85 + heightProfile * 1.95) * seededRange(rng, 0.85, 1.15);
    const rise = reach * seededRange(rng, 0.62, 0.92);

    const dirX = Math.cos(azimuth);
    const dirZ = Math.sin(azimuth);
    const mid = new THREE.Vector3(
      origin.x + dirX * reach * 0.52,
      origin.y + rise * 0.46,
      origin.z + dirZ * reach * 0.52
    );
    const tip = new THREE.Vector3(
      origin.x + dirX * reach,
      origin.y + rise,
      origin.z + dirZ * reach
    );

    const bRad = 0.145 * (1 - (t - 0.3) * 0.65);
    branchGeos.push(buildTaperedBranchTube([origin, mid, tip], bRad, 0.032, 5, 5, 0));

    // Secondary ascending twig fork
    const forkAz = azimuth + (b % 2 === 0 ? 0.58 : -0.58);
    const forkTip = new THREE.Vector3(
      mid.x + Math.cos(forkAz) * reach * 0.56,
      mid.y + rise * 0.62,
      mid.z + Math.sin(forkAz) * reach * 0.56
    );
    branchGeos.push(buildTaperedBranchTube([mid, forkTip], bRad * 0.65, 0.024, 4, 4, 0));

    const sunBase = clamp((t - 0.32) / 0.64, 0.1, 1.0);
    // Volumetric golden ginkgo leaf clouds anchored on branch tips & forks
    anchors.push({
      pos: tip.clone().add(new THREE.Vector3(0, 0.25, 0)),
      scale: new THREE.Vector3(
        seededRange(rng, 2.25, 2.95),
        seededRange(rng, 1.95, 2.55),
        seededRange(rng, 2.25, 2.95)
      ),
      rotY: rng() * Math.PI * 2,
      tiltX: seededRange(rng, -0.22, 0.22),
      tiltZ: seededRange(rng, -0.22, 0.22),
      sunBias: clamp(sunBase + 0.14, 0, 1)
    });

    anchors.push({
      pos: forkTip.clone().add(new THREE.Vector3(0, 0.18, 0)),
      scale: new THREE.Vector3(
        seededRange(rng, 1.95, 2.55),
        seededRange(rng, 1.75, 2.3),
        seededRange(rng, 1.95, 2.55)
      ),
      rotY: rng() * Math.PI * 2,
      tiltX: seededRange(rng, -0.25, 0.25),
      tiltZ: seededRange(rng, -0.25, 0.25),
      sunBias: clamp(sunBase + 0.05, 0, 1)
    });

    // Mid-bough interior richness cluster on lower-mid limbs
    if (b < 6) {
      anchors.push({
        pos: mid.clone().add(new THREE.Vector3(0, 0.32, 0)),
        scale: new THREE.Vector3(
          seededRange(rng, 2.0, 2.6),
          seededRange(rng, 1.85, 2.3),
          seededRange(rng, 2.0, 2.6)
        ),
        rotY: rng() * Math.PI * 2,
        tiltX: seededRange(rng, -0.2, 0.2),
        tiltZ: seededRange(rng, -0.2, 0.2),
        sunBias: clamp(sunBase - 0.2, 0, 1)
      });
    }
  }

  // Luminous golden crown apex tuft
  const apex = trunkCurve.getPointAt(0.98);
  anchors.push(
    {
      pos: apex.clone().add(new THREE.Vector3(0, 0.72, 0)),
      scale: new THREE.Vector3(2.45, 2.65, 2.45),
      rotY: rng() * Math.PI * 2,
      tiltX: 0.08,
      tiltZ: -0.06,
      sunBias: 1.0
    },
    {
      pos: apex.clone().add(new THREE.Vector3(0.45, 0.15, -0.35)),
      scale: new THREE.Vector3(2.2, 2.1, 2.2),
      rotY: rng() * Math.PI * 2,
      tiltX: -0.1,
      tiltZ: 0.1,
      sunBias: 0.92
    }
  );

  const trunkGeometry = safeMergeGeometries(branchGeos);
  for (const g of branchGeos) g.dispose();
  return { trunkGeometry, foliageAnchors: anchors };
}

function buildMapleArchetype(seed: number): TreeArchetype {
  const rng = createRng(seed);
  const branchGeos: THREE.BufferGeometry[] = [];
  const anchors: FoliageAnchor[] = [];

  const totalH = seededRange(rng, 7.6, 9.2);
  const leanX = seededRange(rng, -0.42, 0.42);
  const leanZ = seededRange(rng, -0.42, 0.42);

  // Graceful gently curving crimson maple trunk forking early into wide-spreading dome
  const forkY = totalH * 0.35;
  const trunkPts = [
    new THREE.Vector3(0, -0.32, 0),
    new THREE.Vector3(leanX * 0.35, forkY * 0.52, leanZ * 0.35),
    new THREE.Vector3(leanX * 0.85, forkY, leanZ * 0.85),
    new THREE.Vector3(leanX * 0.75, totalH * 0.66, leanZ * 0.75)
  ];
  branchGeos.push(buildTaperedBranchTube(trunkPts, 0.28, 0.095, 9, 7, 0.15));

  const trunkCurve = new THREE.CatmullRomCurve3(trunkPts);
  const primaryCount = 7;

  for (let b = 0; b < primaryCount; b++) {
    const t = 0.48 + (b / (primaryCount - 1)) * 0.48;
    const origin = trunkCurve.getPointAt(t);
    const azimuth = b * 2.39996 + seededRange(rng, -0.22, 0.22);
    const reach = seededRange(rng, 2.3, 3.6) * (1.12 - (t - 0.48) * 0.45);
    const rise = reach * seededRange(rng, 0.42, 0.72);

    const dirX = Math.cos(azimuth);
    const dirZ = Math.sin(azimuth);
    const mid = new THREE.Vector3(
      origin.x + dirX * reach * 0.56,
      origin.y + rise * 0.65,
      origin.z + dirZ * reach * 0.56
    );
    const tip = new THREE.Vector3(
      origin.x + dirX * reach,
      origin.y + rise * 0.92,
      origin.z + dirZ * reach
    );

    const bRad = 0.125 * (1 - (t - 0.45) * 0.5);
    branchGeos.push(buildTaperedBranchTube([origin, mid, tip], bRad, 0.028, 5, 5, 0));

    // Two delicate arching maple sub-limbs
    for (const side of [-1, 1] as const) {
      const subAz = azimuth + side * seededRange(rng, 0.45, 0.72);
      const subTip = new THREE.Vector3(
        mid.x + Math.cos(subAz) * reach * 0.55,
        mid.y + rise * 0.45 + (side > 0 ? 0.28 : -0.1),
        mid.z + Math.sin(subAz) * reach * 0.55
      );
      branchGeos.push(buildTaperedBranchTube([mid, subTip], bRad * 0.62, 0.022, 4, 4, 0));

      anchors.push({
        pos: subTip.clone().add(new THREE.Vector3(0, 0.14, 0)),
        scale: new THREE.Vector3(
          seededRange(rng, 2.15, 2.75),
          seededRange(rng, 1.55, 2.05),
          seededRange(rng, 2.15, 2.75)
        ),
        rotY: rng() * Math.PI * 2,
        tiltX: seededRange(rng, -0.24, 0.24),
        tiltZ: seededRange(rng, -0.24, 0.24),
        sunBias: clamp(0.35 + t * 0.55 + (side > 0 ? 0.1 : -0.1), 0, 1)
      });
    }

    anchors.push({
      pos: tip.clone().add(new THREE.Vector3(0, 0.2, 0)),
      scale: new THREE.Vector3(
        seededRange(rng, 2.25, 2.9),
        seededRange(rng, 1.65, 2.15),
        seededRange(rng, 2.25, 2.9)
      ),
      rotY: rng() * Math.PI * 2,
      tiltX: seededRange(rng, -0.22, 0.22),
      tiltZ: seededRange(rng, -0.22, 0.22),
      sunBias: clamp(0.55 + t * 0.4, 0, 1)
    });
  }

  // Upper central maple dome
  const crownCenter = trunkCurve.getPointAt(0.98);
  anchors.push(
    {
      pos: crownCenter.clone().add(new THREE.Vector3(0, 1.45, 0)),
      scale: new THREE.Vector3(2.9, 2.1, 2.9),
      rotY: rng() * Math.PI * 2,
      tiltX: 0.05,
      tiltZ: 0.08,
      sunBias: 0.98
    },
    {
      pos: crownCenter.clone().add(new THREE.Vector3(-0.65, 0.95, 0.55)),
      scale: new THREE.Vector3(2.4, 1.85, 2.4),
      rotY: rng() * Math.PI * 2,
      tiltX: -0.12,
      tiltZ: 0.14,
      sunBias: 0.85
    }
  );

  const trunkGeometry = safeMergeGeometries(branchGeos);
  for (const g of branchGeos) g.dispose();
  return { trunkGeometry, foliageAnchors: anchors };
}

function buildSycamoreArchetype(seed: number): TreeArchetype {
  const rng = createRng(seed);
  const branchGeos: THREE.BufferGeometry[] = [];
  const anchors: FoliageAnchor[] = [];

  // Majestic tall coastal French Sycamore (法桐) with stout mottled trunk & broad overarching canopy
  const totalH = seededRange(rng, 12.2, 14.0);
  const curveX = seededRange(rng, -0.45, 0.45);
  const curveZ = seededRange(rng, -0.45, 0.45);

  const trunkPts = [
    new THREE.Vector3(0, -0.35, 0),
    new THREE.Vector3(curveX * 0.35, totalH * 0.18, curveZ * 0.35),
    new THREE.Vector3(curveX * 0.85, totalH * 0.36, curveZ * 0.85),
    new THREE.Vector3(curveX * 0.65, totalH * 0.58, curveZ * 0.7),
    new THREE.Vector3(curveX * 0.3, totalH * 0.78, curveZ * 0.45)
  ];
  branchGeos.push(buildTaperedBranchTube(trunkPts, 0.46, 0.14, 11, 8, 0.24));

  const trunkCurve = new THREE.CatmullRomCurve3(trunkPts);
  const limbCount = 7;

  for (let b = 0; b < limbCount; b++) {
    const t = 0.46 + (b / (limbCount - 1)) * 0.52;
    const origin = trunkCurve.getPointAt(t);
    const azimuth = b * 2.39996 + seededRange(rng, -0.25, 0.25);
    const reach = seededRange(rng, 3.2, 4.6) * (1.08 - (t - 0.46) * 0.38);
    const rise = reach * seededRange(rng, 0.52, 0.8);

    const dx = Math.cos(azimuth);
    const dz = Math.sin(azimuth);
    const elbow = new THREE.Vector3(
      origin.x + dx * reach * 0.48,
      origin.y + rise * 0.58,
      origin.z + dz * reach * 0.48
    );
    const tip = new THREE.Vector3(
      origin.x + dx * reach,
      origin.y + rise,
      origin.z + dz * reach
    );

    const bRad = 0.21 * (1 - (t - 0.45) * 0.45);
    branchGeos.push(buildTaperedBranchTube([origin, elbow, tip], bRad, 0.048, 6, 6, 0));

    for (const side of [-1, 1] as const) {
      const subAz = azimuth + side * seededRange(rng, 0.48, 0.78);
      const subTip = new THREE.Vector3(
        elbow.x + Math.cos(subAz) * reach * 0.58,
        elbow.y + rise * 0.48 + seededRange(rng, 0.1, 0.55),
        elbow.z + Math.sin(subAz) * reach * 0.58
      );
      branchGeos.push(buildTaperedBranchTube([elbow, subTip], bRad * 0.62, 0.032, 4, 5, 0));

      anchors.push({
        pos: subTip.clone().add(new THREE.Vector3(0, 0.25, 0)),
        scale: new THREE.Vector3(
          seededRange(rng, 2.75, 3.55),
          seededRange(rng, 2.1, 2.7),
          seededRange(rng, 2.75, 3.55)
        ),
        rotY: rng() * Math.PI * 2,
        tiltX: seededRange(rng, -0.2, 0.2),
        tiltZ: seededRange(rng, -0.2, 0.2),
        sunBias: clamp(0.45 + t * 0.48, 0, 1)
      });
    }

    anchors.push({
      pos: tip.clone().add(new THREE.Vector3(0, 0.35, 0)),
      scale: new THREE.Vector3(
        seededRange(rng, 2.9, 3.7),
        seededRange(rng, 2.25, 2.85),
        seededRange(rng, 2.9, 3.7)
      ),
      rotY: rng() * Math.PI * 2,
      tiltX: seededRange(rng, -0.2, 0.2),
      tiltZ: seededRange(rng, -0.2, 0.2),
      sunBias: clamp(0.6 + t * 0.38, 0, 1)
    });
  }

  // Broad sunlit overarching sycamore crown vault
  const top = trunkCurve.getPointAt(0.98);
  for (let c = 0; c < 4; c++) {
    const a = (c / 4) * Math.PI * 2 + 0.35;
    const r = c === 0 ? 0.3 : 1.55;
    anchors.push({
      pos: top.clone().add(new THREE.Vector3(Math.cos(a) * r, c === 0 ? 2.15 : 1.55, Math.sin(a) * r)),
      scale: new THREE.Vector3(3.3, 2.55, 3.3),
      rotY: rng() * Math.PI * 2,
      tiltX: seededRange(rng, -0.14, 0.14),
      tiltZ: seededRange(rng, -0.14, 0.14),
      sunBias: c === 0 ? 1.0 : 0.88
    });
  }

  const trunkGeometry = safeMergeGeometries(branchGeos);
  for (const g of branchGeos) g.dispose();
  return { trunkGeometry, foliageAnchors: anchors };
}

/**
 * Variant 0 = Stately Qingdao Deodar Cedar (雪松) with lush layered sweeping horizontal boughs
 *             clothed along inner, mid, and outer sections plus a soft full conical spire crown.
 * Variant 1 = Wind-Sculpted Coastal Black Pine (海岸黑松) for Huashi Cape & coastal bluffs
 *             with gracefully curving organic boughs and billowing layered evergreen clouds.
 */
function buildCedarOrPineArchetype(seed: number, isCoastalPine: boolean): TreeArchetype {
  const rng = createRng(seed);
  const branchGeos: THREE.BufferGeometry[] = [];
  const anchors: FoliageAnchor[] = [];

  if (!isCoastalPine) {
    // DEODAR CEDAR (雪松): Lush stately conical conifer with 6 richly clothed sweeping tiers
    const totalH = seededRange(rng, 12.2, 14.2);
    const swayX = seededRange(rng, -0.2, 0.2);
    const swayZ = seededRange(rng, -0.2, 0.2);

    const trunkPts = [
      new THREE.Vector3(0, -0.35, 0),
      new THREE.Vector3(swayX * 0.3, totalH * 0.28, swayZ * 0.3),
      new THREE.Vector3(swayX * 0.72, totalH * 0.62, swayZ * 0.68),
      new THREE.Vector3(swayX * 0.45, totalH * 0.94, swayZ * 0.45)
    ];
    branchGeos.push(buildTaperedBranchTube(trunkPts, 0.36, 0.042, 10, 7, 0.2));

    const trunkCurve = new THREE.CatmullRomCurve3(trunkPts);
    const tiers = 6;
    for (let tier = 0; tier < tiers; tier++) {
      const frac = tier / (tiers - 1);
      const t = 0.20 + frac * 0.63;
      const origin = trunkCurve.getPointAt(t);
      const tierRadius = (1 - Math.pow(frac, 0.88) * 0.76) * 3.3 + 0.52;
      const boughsInTier = tier === 0 ? 5 : tier <= 3 ? 4 : 3;

      for (let b = 0; b < boughsInTier; b++) {
        const az =
          (b / boughsInTier) * Math.PI * 2 + tier * 0.92 + seededRange(rng, -0.2, 0.2);
        const dx = Math.cos(az);
        const dz = Math.sin(az);
        const perpX = -dz;
        const perpZ = dx;
        const len = tierRadius * seededRange(rng, 0.9, 1.12);
        const latBend = seededRange(rng, -0.18, 0.18) * len * 0.28;
        const droop = (0.38 - frac * 0.26) * seededRange(rng, 0.85, 1.15);

        // Classic Deodar cedar: sweeps gracefully outward & slightly downward, then curls softly up at the tip
        const p1 = new THREE.Vector3(
          origin.x + dx * len * 0.34 + perpX * latBend * 0.45,
          origin.y - droop * 0.65,
          origin.z + dz * len * 0.34 + perpZ * latBend * 0.45
        );
        const p2 = new THREE.Vector3(
          origin.x + dx * len * 0.68 + perpX * latBend,
          origin.y - droop * 0.92,
          origin.z + dz * len * 0.68 + perpZ * latBend
        );
        const foliageTip = new THREE.Vector3(
          origin.x + dx * len + perpX * latBend * 0.55,
          origin.y - droop * 0.32 + 0.24,
          origin.z + dz * len + perpZ * latBend * 0.55
        );
        // End wooden bough slightly inside the outer needle cushion so bare wood never pokes out
        const woodTip = new THREE.Vector3().lerpVectors(p2, foliageTip, 0.65);
        branchGeos.push(
          buildTaperedBranchTube(
            [origin, p1, p2, woodTip],
            0.095 * (1 - frac * 0.56),
            0.022,
            5,
            4,
            0
          )
        );

        const boughCurve = new THREE.CatmullRomCurve3([origin, p1, p2, foliageTip]);
        const basePad = (2.52 - frac * 0.92) * seededRange(rng, 0.92, 1.1);

        if (tier === 0) {
          // Broad bottom skirt tier: INNER dark-pine core + MID emerald + OUTER sunlit sweeping tip
          const innerPos = boughCurve.getPointAt(0.28);
          anchors.push({
            pos: innerPos.add(new THREE.Vector3(0, 0.24, 0)),
            scale: new THREE.Vector3(basePad * 1.06, basePad * 0.80, basePad * 1.06),
            rotY: az + seededRange(rng, -0.5, 0.5),
            tiltX: seededRange(rng, -0.14, 0.14),
            tiltZ: seededRange(rng, -0.14, 0.14),
            sunBias: 0.08
          });

          const midPos = boughCurve.getPointAt(0.62);
          anchors.push({
            pos: midPos.add(new THREE.Vector3(0, 0.18, 0)),
            scale: new THREE.Vector3(basePad * 1.10, basePad * 0.74, basePad * 1.10),
            rotY: az + seededRange(rng, -0.45, 0.45),
            tiltX: seededRange(rng, -0.13, 0.13),
            tiltZ: seededRange(rng, -0.13, 0.13),
            sunBias: 0.36
          });

          const outerPos = boughCurve.getPointAt(0.95);
          anchors.push({
            pos: outerPos.add(new THREE.Vector3(0, 0.14, 0)),
            scale: new THREE.Vector3(basePad * 1.06, basePad * 0.68, basePad * 1.06),
            rotY: az + seededRange(rng, -0.35, 0.35),
            tiltX: seededRange(rng, -0.12, 0.12),
            tiltZ: seededRange(rng, -0.12, 0.12),
            sunBias: 0.72
          });
        } else if (tier <= 3) {
          // Mid sweeping tiers: generously scaled INNER-MID deep pine + OUTER sunlit emerald (seamless full bough coverage)
          const innerMidPos = boughCurve.getPointAt(0.35);
          anchors.push({
            pos: innerMidPos.add(new THREE.Vector3(0, 0.22, 0)),
            scale: new THREE.Vector3(basePad * 1.10, basePad * 0.80, basePad * 1.10),
            rotY: az + seededRange(rng, -0.5, 0.5),
            tiltX: seededRange(rng, -0.14, 0.14),
            tiltZ: seededRange(rng, -0.14, 0.14),
            sunBias: clamp(0.14 + frac * 0.34, 0, 1)
          });

          const outerPos = boughCurve.getPointAt(0.90);
          anchors.push({
            pos: outerPos.add(new THREE.Vector3(0, 0.15, 0)),
            scale: new THREE.Vector3(basePad * 1.08, basePad * 0.72, basePad * 1.08),
            rotY: az + seededRange(rng, -0.4, 0.4),
            tiltX: seededRange(rng, -0.12, 0.12),
            tiltZ: seededRange(rng, -0.12, 0.12),
            sunBias: clamp(0.70 + frac * 0.28, 0, 1)
          });
        } else {
          // Upper crown whorls: full lush bough cushions spanning trunk to rim
          const crownBoughPos = boughCurve.getPointAt(0.54);
          anchors.push({
            pos: crownBoughPos.add(new THREE.Vector3(0, 0.18, 0)),
            scale: new THREE.Vector3(basePad * 1.18, basePad * 0.84, basePad * 1.18),
            rotY: az + seededRange(rng, -0.45, 0.45),
            tiltX: seededRange(rng, -0.14, 0.14),
            tiltZ: seededRange(rng, -0.14, 0.14),
            sunBias: clamp(0.76 + frac * 0.22, 0, 1)
          });
        }
      }
    }

    // Soft full conical crown apex + deep inner trunk core cushions (zero hollow flagpole gaps!)
    const coreMid = trunkCurve.getPointAt(0.45);
    const collarUpper = trunkCurve.getPointAt(0.88);
    const collarTop = trunkCurve.getPointAt(0.95);
    const apex = trunkCurve.getPointAt(0.99);
    anchors.push(
      {
        pos: coreMid.clone(),
        scale: new THREE.Vector3(2.55, 2.05, 2.55),
        rotY: rng() * Math.PI * 2,
        tiltX: 0.04,
        tiltZ: -0.04,
        sunBias: 0.12
      },
      {
        pos: collarUpper.clone().add(new THREE.Vector3(0, 0.12, 0)),
        scale: new THREE.Vector3(2.35, 1.72, 2.35),
        rotY: rng() * Math.PI * 2,
        tiltX: 0.06,
        tiltZ: -0.05,
        sunBias: 0.74
      },
      {
        pos: collarTop.clone().add(new THREE.Vector3(0, 0.28, 0)),
        scale: new THREE.Vector3(1.88, 1.54, 1.88),
        rotY: rng() * Math.PI * 2,
        tiltX: -0.05,
        tiltZ: 0.06,
        sunBias: 0.88
      },
      {
        pos: apex.clone().add(new THREE.Vector3(swayX * 0.12, 0.96, swayZ * 0.12)),
        scale: new THREE.Vector3(1.32, 1.45, 1.32),
        rotY: rng() * Math.PI * 2,
        tiltX: 0.03,
        tiltZ: -0.03,
        sunBias: 1.0
      }
    );
  } else {
    // COASTAL BLACK PINE (海岸黑松): Wind-sculpted organic S-curve trunk + gently curved boughs & lush layered needle clouds
    const totalH = seededRange(rng, 7.4, 9.0);
    const windLeanX = seededRange(rng, -0.58, 0.58);
    const windLeanZ = seededRange(rng, -1.25, -0.5); // Sculpted leaning inland away from sea wind

    const trunkPts = [
      new THREE.Vector3(0, -0.35, 0),
      new THREE.Vector3(windLeanX * 0.22 + 0.14, totalH * 0.24, windLeanZ * 0.18),
      new THREE.Vector3(windLeanX * 0.78 - 0.1, totalH * 0.56, windLeanZ * 0.64),
      new THREE.Vector3(windLeanX * 0.96, totalH * 0.88, windLeanZ * 0.98)
    ];
    branchGeos.push(buildTaperedBranchTube(trunkPts, 0.32, 0.075, 11, 7, 0.18));

    const trunkCurve = new THREE.CatmullRomCurve3(trunkPts);
    const boughCount = 6;

    for (let b = 0; b < boughCount; b++) {
      const t = 0.42 + (b / (boughCount - 1)) * 0.52;
      const origin = trunkCurve.getPointAt(t);
      const az = b * 2.39996 + seededRange(rng, -0.26, 0.26);
      const reach = seededRange(rng, 2.35, 3.45) * (1.1 - (t - 0.42) * 0.36);
      const dx = Math.cos(az);
      const dz = Math.sin(az);
      const perpX = -dz;
      const perpZ = dx;

      // Gentle coastal wind-sculpted curve: dips/arcs smoothly outward with organic lateral sweep (never rigid straight sticks)
      const lateralSweep = seededRange(rng, -0.52, 0.52);
      const windDriftZ = seededRange(rng, -0.35, -0.1);
      const lowerWeight = 1 - clamp((t - 0.42) / 0.52, 0, 1);

      const p1 = new THREE.Vector3(
        origin.x + dx * reach * 0.34 + perpX * lateralSweep * 0.55,
        origin.y + seededRange(rng, -0.16, 0.18) - lowerWeight * 0.14,
        origin.z + dz * reach * 0.34 + perpZ * lateralSweep * 0.55 + windDriftZ * 0.3
      );
      const p2 = new THREE.Vector3(
        origin.x + dx * reach * 0.68 + perpX * lateralSweep,
        origin.y + seededRange(rng, 0.18, 0.52),
        origin.z + dz * reach * 0.68 + perpZ * lateralSweep + windDriftZ * 0.72
      );
      const tip = new THREE.Vector3(
        origin.x + dx * reach + perpX * lateralSweep * 0.65,
        origin.y + seededRange(rng, 0.52, 1.02),
        origin.z + dz * reach + perpZ * lateralSweep * 0.65 + windDriftZ
      );
      const woodTip = new THREE.Vector3().lerpVectors(p2, tip, 0.74);
      const bRad = 0.115 * (1 - (t - 0.42) * 0.44);
      branchGeos.push(buildTaperedBranchTube([origin, p1, p2, woodTip], bRad, 0.024, 6, 5, 0));

      // Gently curved secondary pine sub-bough forking from p2 for organic gnarled rhythm
      const sideSign = b % 2 === 0 ? 1 : -1;
      const forkAz = az + sideSign * seededRange(rng, 0.48, 0.78);
      const forkLen = reach * seededRange(rng, 0.44, 0.58);
      const forkMid = new THREE.Vector3(
        p2.x + Math.cos(forkAz) * forkLen * 0.52,
        p2.y + seededRange(rng, 0.12, 0.32),
        p2.z + Math.sin(forkAz) * forkLen * 0.52 + windDriftZ * 0.25
      );
      const forkTip = new THREE.Vector3(
        p2.x + Math.cos(forkAz) * forkLen,
        p2.y + seededRange(rng, 0.34, 0.68),
        p2.z + Math.sin(forkAz) * forkLen + windDriftZ * 0.45
      );
      branchGeos.push(
        buildTaperedBranchTube([p2, forkMid, forkTip], bRad * 0.58, 0.02, 5, 4, 0)
      );

      // Layered billowing coastal pine foliage along inner-mid, outer & forked bough sections
      const padW = seededRange(rng, 2.45, 3.2) * (1.06 - (t - 0.42) * 0.2);
      anchors.push(
        // Inner-mid dark-pine cushion wrapping organically along the inner half of the curved bough
        {
          pos: new THREE.Vector3().lerpVectors(p1, p2, 0.45).add(new THREE.Vector3(0, 0.34, 0)),
          scale: new THREE.Vector3(padW * 0.94, padW * 0.62, padW * 0.94),
          rotY: rng() * Math.PI * 2,
          tiltX: seededRange(rng, -0.14, 0.14),
          tiltZ: seededRange(rng, -0.14, 0.14),
          sunBias: clamp(0.16 + (t - 0.42) * 0.38, 0, 1)
        },
        // Outer windswept sunlit olive-emerald pine cloud
        {
          pos: tip.clone().add(new THREE.Vector3(0, 0.24, 0)),
          scale: new THREE.Vector3(padW * 1.06, padW * 0.60, padW * 1.06),
          rotY: rng() * Math.PI * 2,
          tiltX: seededRange(rng, -0.12, 0.12),
          tiltZ: seededRange(rng, -0.12, 0.12),
          sunBias: clamp(0.68 + (t - 0.42) * 0.32, 0, 1)
        },
        // Secondary curved fork needle cloud breaking symmetry
        {
          pos: forkTip.clone().add(new THREE.Vector3(0, 0.22, 0)),
          scale: new THREE.Vector3(padW * 0.90, padW * 0.58, padW * 0.90),
          rotY: rng() * Math.PI * 2,
          tiltX: seededRange(rng, -0.14, 0.14),
          tiltZ: seededRange(rng, -0.14, 0.14),
          sunBias: clamp(0.56 + (t - 0.42) * 0.40, 0, 1)
        }
      );
    }

    // Lush multi-layered windswept coastal black pine crown dome (shaded under-core + sunlit upper clouds)
    const crownTop = trunkCurve.getPointAt(0.98);
    anchors.push(
      {
        pos: crownTop.clone().add(new THREE.Vector3(0, 0.24, 0)),
        scale: new THREE.Vector3(2.95, 1.68, 2.95),
        rotY: rng() * Math.PI * 2,
        tiltX: 0.06,
        tiltZ: -0.06,
        sunBias: 0.40
      },
      {
        pos: crownTop.clone().add(new THREE.Vector3(0.58, 0.72, -0.46)),
        scale: new THREE.Vector3(2.7, 1.56, 2.7),
        rotY: rng() * Math.PI * 2,
        tiltX: -0.08,
        tiltZ: 0.07,
        sunBias: 0.85
      },
      {
        pos: crownTop.clone().add(new THREE.Vector3(-0.72, 0.58, 0.32)),
        scale: new THREE.Vector3(2.5, 1.48, 2.5),
        rotY: rng() * Math.PI * 2,
        tiltX: 0.09,
        tiltZ: -0.08,
        sunBias: 0.78
      },
      {
        pos: crownTop.clone().add(new THREE.Vector3(0.05, 1.18, -0.35)),
        scale: new THREE.Vector3(2.6, 1.45, 2.6),
        rotY: rng() * Math.PI * 2,
        tiltX: 0.04,
        tiltZ: -0.04,
        sunBias: 0.98
      }
    );
  }

  const trunkGeometry = safeMergeGeometries(branchGeos);
  for (const g of branchGeos) g.dispose();
  return { trunkGeometry, foliageAnchors: anchors };
}

// ============================================================================
// 4. CUSTOM WIND-SWAY + BACKLIT SUN TRANSLUCENCY FOLIAGE MATERIAL
// ============================================================================

function createFoliageMaterial(
  speciesKey: string,
  map: THREE.CanvasTexture,
  sharedUniforms: FoliageUniformBundle,
  translucencyMultiplier: number,
  alphaTest = 0.36
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map,
    alphaTest,
    side: THREE.DoubleSide,
    roughness: 0.82,
    metalness: 0.0
  });

  mat.customProgramCacheKey = () => `badaguan_foliage_${speciesKey}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uWindStrength = sharedUniforms.uWindStrength;
    shader.uniforms.uSunDir = sharedUniforms.uSunDir;
    shader.uniforms.uSunColor = sharedUniforms.uSunColor;
    shader.uniforms.uTranslucency = sharedUniforms.uTranslucency;
    shader.uniforms.uSpeciesSss = { value: translucencyMultiplier };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform float uWindStrength;
varying vec3 vFoliageWorldPos;
varying float vCrownLift;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec3 instOrigin = vec3(0.0);
#ifdef USE_INSTANCING
  instOrigin = instanceMatrix[3].xyz;
#endif
float swayPhase = uTime * 1.38 + instOrigin.x * 0.13 + instOrigin.z * 0.11;
float gust = sin(swayPhase) * 0.65 + sin(swayPhase * 2.07 + instOrigin.y * 0.35) * 0.35;
float flutter = sin(uTime * 3.2 + position.x * 4.2 + position.z * 4.2 + instOrigin.x * 0.7) * 0.028;
float tipWeight = clamp((position.y + 0.55) * 0.82, 0.0, 1.35);
transformed.x += (gust * 0.12 + flutter) * uWindStrength * tipWeight;
transformed.z += (cos(swayPhase * 0.85) * 0.09 + flutter) * uWindStrength * tipWeight;
transformed.y += sin(swayPhase * 1.6 + position.x * 2.2) * 0.024 * uWindStrength * tipWeight;
vCrownLift = clamp(position.y * 0.45 + 0.58, 0.25, 1.0);`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vec4 foliageWPos = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  foliageWPos = instanceMatrix * foliageWPos;
#endif
foliageWPos = modelMatrix * foliageWPos;
vFoliageWorldPos = foliageWPos.xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uTranslucency;
uniform float uSpeciesSss;
varying vec3 vFoliageWorldPos;
varying float vCrownLift;`
      )
      .replace(
        'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
        `vec3 foliageViewDir = normalize(cameraPosition - vFoliageWorldPos);
float backLit = pow(clamp(dot(-foliageViewDir, normalize(uSunDir)), 0.0, 1.0), 2.6);
vec3 sssRadiance = diffuseColor.rgb * uSunColor * (backLit * 0.78 + vCrownLift * 0.16) * uTranslucency * uSpeciesSss;
vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance + sssRadiance;`
      );
  };

  return mat;
}

// ============================================================================
// 5. VINTAGE QINGDAO STREET FURNITURE GEOMETRIES
// ============================================================================

function buildVintageLampPostGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Fluted octagonal cast-iron pedestal base (embedded -0.22m into ground)
  const baseFoot = new THREE.CylinderGeometry(0.19, 0.24, 0.46, 8);
  baseFoot.translate(0, 0.01, 0);
  parts.push(baseFoot);

  const plinth = new THREE.CylinderGeometry(0.13, 0.185, 0.62, 8);
  plinth.translate(0, 0.52, 0);
  parts.push(plinth);

  const collarLow = new THREE.TorusGeometry(0.135, 0.028, 6, 12);
  collarLow.rotateX(Math.PI / 2);
  collarLow.translate(0, 0.85, 0);
  parts.push(collarLow);

  // Tapered dark iron main column
  const shaft = new THREE.CylinderGeometry(0.055, 0.095, 2.75, 10);
  shaft.translate(0, 2.22, 0);
  parts.push(shaft);

  // Ornamental European mid-ring & capital
  const midRing = new THREE.TorusGeometry(0.088, 0.022, 6, 12);
  midRing.rotateX(Math.PI / 2);
  midRing.translate(0, 2.48, 0);
  parts.push(midRing);

  const neckCollar = new THREE.CylinderGeometry(0.115, 0.068, 0.2, 8);
  neckCollar.translate(0, 3.62, 0);
  parts.push(neckCollar);

  // Decorative miniature ladder-bar arms (signature vintage European lamp detail)
  const crossArm = new THREE.BoxGeometry(0.46, 0.035, 0.035);
  crossArm.translate(0, 3.32, 0);
  parts.push(crossArm);
  for (const sx of [-0.23, 0.23]) {
    const ball = new THREE.SphereGeometry(0.032, 7, 6);
    ball.translate(sx, 3.32, 0);
    parts.push(ball);
  }

  // Lantern lower tray
  const tray = new THREE.CylinderGeometry(0.2, 0.11, 0.09, 6);
  tray.translate(0, 3.74, 0);
  parts.push(tray);

  // 6 slender corner muntin ribs framing the hexagonal glass lantern
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const rib = new THREE.CylinderGeometry(0.011, 0.011, 0.56, 4);
    rib.rotateZ(-0.08 * Math.cos(a));
    rib.rotateX(0.08 * Math.sin(a));
    rib.translate(Math.cos(a) * 0.205, 4.04, Math.sin(a) * 0.205);
    parts.push(rib);
  }

  // Stepped hexagonal cupola roof + heritage spire finial
  const roofLower = new THREE.ConeGeometry(0.28, 0.24, 6);
  roofLower.translate(0, 4.44, 0);
  parts.push(roofLower);

  const finial = new THREE.ConeGeometry(0.04, 0.18, 6);
  finial.translate(0, 4.62, 0);
  parts.push(finial);

  const merged = safeMergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

function buildVintageLampGlassGeometry(): THREE.BufferGeometry {
  const glass = new THREE.CylinderGeometry(0.21, 0.155, 0.52, 6);
  glass.translate(0, 4.04, 0);
  return glass;
}

function buildParkBenchGeometries(): { wood: THREE.BufferGeometry; iron: THREE.BufferGeometry } {
  const woodParts: THREE.BufferGeometry[] = [];
  const ironParts: THREE.BufferGeometry[] = [];

  const benchLen = 1.78;
  // 4 contoured seat slats
  for (let i = 0; i < 4; i++) {
    const z = -0.19 + i * 0.125;
    const slat = new THREE.BoxGeometry(benchLen, 0.036, 0.098);
    slat.translate(0, 0.44 - Math.abs(i - 1.5) * 0.008, z);
    woodParts.push(slat);
  }
  // 3 gently reclined backrest slats
  for (let i = 0; i < 3; i++) {
    const y = 0.62 + i * 0.125;
    const z = -0.27 - i * 0.03;
    const slat = new THREE.BoxGeometry(benchLen, 0.092, 0.034);
    slat.rotateX(-0.22);
    slat.translate(0, y, z);
    woodParts.push(slat);
  }

  // Cast-iron leg frames & curved armrests at left & right ends
  for (const sx of [-0.74, 0.74]) {
    const frontLeg = new THREE.BoxGeometry(0.055, 0.62, 0.055);
    frontLeg.translate(sx, 0.17, 0.2);
    ironParts.push(frontLeg);

    const backLeg = new THREE.BoxGeometry(0.055, 0.62, 0.055);
    backLeg.translate(sx, 0.17, -0.22);
    ironParts.push(backLeg);

    const seatBar = new THREE.BoxGeometry(0.055, 0.05, 0.48);
    seatBar.translate(sx, 0.42, -0.01);
    ironParts.push(seatBar);

    const backPost = new THREE.BoxGeometry(0.05, 0.56, 0.048);
    backPost.rotateX(-0.22);
    backPost.translate(sx, 0.72, -0.3);
    ironParts.push(backPost);

    const armrest = new THREE.BoxGeometry(0.06, 0.038, 0.48);
    armrest.translate(sx, 0.63, -0.02);
    ironParts.push(armrest);

    const armFront = new THREE.BoxGeometry(0.045, 0.21, 0.045);
    armFront.translate(sx, 0.525, 0.2);
    ironParts.push(armFront);
  }

  // Under-seat tie stretcher
  const stretcher = new THREE.BoxGeometry(1.48, 0.036, 0.036);
  stretcher.translate(0, 0.26, -0.02);
  ironParts.push(stretcher);

  const wood = safeMergeGeometries(woodParts);
  const iron = safeMergeGeometries(ironParts);
  for (const p of woodParts) p.dispose();
  for (const p of ironParts) p.dispose();
  return { wood, iron };
}

function buildGraniteBollardGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const base = new THREE.BoxGeometry(0.38, 0.42, 0.38);
  base.translate(0, 0.02, 0);
  parts.push(base);

  const shaft = new THREE.CylinderGeometry(0.145, 0.175, 0.68, 8);
  shaft.translate(0, 0.52, 0);
  parts.push(shaft);

  const cap = new THREE.SphereGeometry(0.148, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
  cap.translate(0, 0.85, 0);
  parts.push(cap);

  const merged = safeMergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * Classic Qingdao European cast-iron heritage signpost:
 * The vertical pedestal pole terminates cleanly at a sculpted mounting collar & scroll brackets
 * UNDERNEATH the bottom sign rail, while slim perimeter side posts and bezel rails frame the
 * plaque — leaving both front AND back enamel sign text 100% unobstructed.
 */
function buildRoadSignPostGeometry(): THREE.BufferGeometry {
  const postParts: THREE.BufferGeometry[] = [];

  // Fluted octagonal cast-iron pedestal base (embedded -0.18m so zero poles float)
  const baseFoot = new THREE.CylinderGeometry(0.095, 0.132, 0.44, 8);
  baseFoot.translate(0, 0.04, 0);
  postParts.push(baseFoot);

  const basePlinth = new THREE.CylinderGeometry(0.068, 0.095, 0.16, 8);
  basePlinth.translate(0, 0.34, 0);
  postParts.push(basePlinth);

  const baseCollar = new THREE.TorusGeometry(0.068, 0.015, 6, 12);
  baseCollar.rotateX(Math.PI / 2);
  baseCollar.translate(0, 0.43, 0);
  postParts.push(baseCollar);

  // Main tapered vertical column — STOPS CLEANLY at y = 1.98 below the bottom frame rail!
  const pole = new THREE.CylinderGeometry(0.044, 0.058, 1.56, 10);
  pole.translate(0, 1.2, 0);
  postParts.push(pole);

  const midRing = new THREE.TorusGeometry(0.056, 0.014, 6, 12);
  midRing.rotateX(Math.PI / 2);
  midRing.translate(0, 1.28, 0);
  postParts.push(midRing);

  // Sculpted cast-iron mounting capital collar & angled support brackets beneath bottom rail
  const mountRing = new THREE.TorusGeometry(0.052, 0.014, 6, 12);
  mountRing.rotateX(Math.PI / 2);
  mountRing.translate(0, 1.93, 0);
  postParts.push(mountRing);

  const mountCapital = new THREE.CylinderGeometry(0.088, 0.048, 0.1, 10);
  mountCapital.translate(0, 1.99, 0);
  postParts.push(mountCapital);

  for (const sx of [-1, 1] as const) {
    const bracket = new THREE.BoxGeometry(0.028, 0.4, 0.032);
    bracket.rotateZ(-sx * 1.063);
    bracket.translate(sx * 0.18, 1.94, 0);
    postParts.push(bracket);
  }

  // Solid recessed backing plate strictly behind front (+0.026) and back (-0.026) enamel plaques
  const backing = new THREE.BoxGeometry(1.18, 0.62, 0.044);
  backing.translate(0, 2.38, 0);
  postParts.push(backing);

  // Raised perimeter bezel moldings cleanly framing the 1.12 x 0.56 plaque (y: 2.10..2.66, x: -0.56..0.56)
  const bottomRail = new THREE.BoxGeometry(1.26, 0.052, 0.068);
  bottomRail.translate(0, 2.065, 0);
  postParts.push(bottomRail);

  const topRail = new THREE.BoxGeometry(1.26, 0.052, 0.068);
  topRail.translate(0, 2.695, 0);
  postParts.push(topRail);

  // Two slim European side frame posts hugging left & right outer edges with corner orb finials
  for (const sx of [-0.605, 0.605] as const) {
    const sideStile = new THREE.CylinderGeometry(0.026, 0.026, 0.69, 8);
    sideStile.translate(sx, 2.38, 0);
    postParts.push(sideStile);

    const topCornerOrb = new THREE.SphereGeometry(0.034, 8, 6);
    topCornerOrb.translate(sx, 2.745, 0);
    postParts.push(topCornerOrb);

    const botCornerOrb = new THREE.SphereGeometry(0.03, 8, 6);
    botCornerOrb.translate(sx, 2.025, 0);
    postParts.push(botCornerOrb);
  }

  // Ornamental heritage crest finial perched cleanly ABOVE the top frame rail
  const crestBase = new THREE.CylinderGeometry(0.04, 0.068, 0.055, 8);
  crestBase.translate(0, 2.748, 0);
  postParts.push(crestBase);

  const crestOrb = new THREE.SphereGeometry(0.054, 10, 8);
  crestOrb.translate(0, 2.815, 0);
  postParts.push(crestOrb);

  const crestSpire = new THREE.ConeGeometry(0.022, 0.085, 6);
  crestSpire.translate(0, 2.895, 0);
  postParts.push(crestSpire);

  const merged = safeMergeGeometries(postParts);
  for (const p of postParts) p.dispose();
  return merged;
}

/**
 * Builds a single combined front + back enamel plaque geometry sitting cleanly in front of
 * and behind the frame backing (z = ±0.026) with optional atlas UV sub-rectangle mapping.
 */
function buildRoadSignDualPlaqueGeometry(uvBounds?: {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}): THREE.BufferGeometry {
  const applyUvBounds = (plane: THREE.PlaneGeometry): void => {
    if (!uvBounds) return;
    const uv = plane.getAttribute('uv');
    const uSpan = uvBounds.uMax - uvBounds.uMin;
    const vSpan = uvBounds.vMax - uvBounds.vMin;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(
        i,
        uvBounds.uMin + uv.getX(i) * uSpan,
        uvBounds.vMin + uv.getY(i) * vSpan
      );
    }
    uv.needsUpdate = true;
  };

  const front = new THREE.PlaneGeometry(1.12, 0.56);
  applyUvBounds(front);
  front.translate(0, 2.38, 0.026);

  const back = new THREE.PlaneGeometry(1.12, 0.56);
  applyUvBounds(back);
  back.rotateY(Math.PI);
  back.translate(0, 2.38, -0.026);

  const merged = safeMergeGeometries([front, back]);
  front.dispose();
  back.dispose();
  return merged;
}

function buildVintagePostboxGeometries(): {
  body: THREE.BufferGeometry;
  trim: THREE.BufferGeometry;
} {
  const bodyParts: THREE.BufferGeometry[] = [];
  const plinth = new THREE.CylinderGeometry(0.24, 0.27, 0.34, 12);
  plinth.translate(0, 0.02, 0);
  bodyParts.push(plinth);

  const pillar = new THREE.CylinderGeometry(0.21, 0.215, 0.96, 14);
  pillar.translate(0, 0.64, 0);
  bodyParts.push(pillar);

  const rim = new THREE.CylinderGeometry(0.245, 0.245, 0.055, 14);
  rim.translate(0, 1.12, 0);
  bodyParts.push(rim);

  const dome = new THREE.SphereGeometry(0.225, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.52);
  dome.translate(0, 1.14, 0);
  bodyParts.push(dome);

  const knob = new THREE.SphereGeometry(0.042, 8, 6);
  knob.translate(0, 1.38, 0);
  bodyParts.push(knob);

  const body = safeMergeGeometries(bodyParts);
  for (const p of bodyParts) p.dispose();

  // Classic brass mail-slot hood & gold-ochre stripe band
  const bandGeo = new THREE.CylinderGeometry(0.216, 0.216, 0.08, 14);
  bandGeo.translate(0, 0.88, 0);
  const slotGeo = new THREE.BoxGeometry(0.18, 0.055, 0.06);
  slotGeo.translate(0, 0.98, 0.2);
  const trim = safeMergeGeometries([bandGeo, slotGeo]);
  bandGeo.dispose();
  slotGeo.dispose();

  return { body, trim };
}

/** Soft radial glow canvas texture for blue-hour vintage lantern halos. */
function createLanternHaloTexture(): THREE.CanvasTexture {
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
    grad.addColorStop(0, 'rgba(255, 232, 174, 0.92)');
    grad.addColorStop(0.28, 'rgba(255, 190, 96, 0.45)');
    grad.addColorStop(0.62, 'rgba(255, 152, 62, 0.12)');
    grad.addColorStop(1, 'rgba(255, 130, 40, 0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ============================================================================
// 6. SCULPTED SEAGULL GEOMETRIES (BODY + ARTICULATED LEFT & RIGHT WINGS)
// ============================================================================

function buildSeagullGeometries(): {
  body: THREE.BufferGeometry;
  leftWing: THREE.BufferGeometry;
  rightWing: THREE.BufferGeometry;
} {
  // Streamlined gull body (+Z forward)
  const bodyParts: THREE.BufferGeometry[] = [];
  const torso = new THREE.SphereGeometry(0.13, 10, 8);
  torso.scale(0.9, 0.72, 2.55);
  bodyParts.push(torso);

  const head = new THREE.SphereGeometry(0.085, 8, 6);
  head.scale(0.88, 0.85, 1.15);
  head.translate(0, 0.05, 0.34);
  bodyParts.push(head);

  const beak = new THREE.ConeGeometry(0.028, 0.14, 5);
  beak.rotateX(Math.PI / 2);
  beak.translate(0, 0.035, 0.47);
  bodyParts.push(beak);

  const tail = new THREE.ConeGeometry(0.12, 0.28, 4);
  tail.scale(1.2, 0.18, 1.0);
  tail.rotateX(-Math.PI / 2);
  tail.translate(0, 0.01, -0.38);
  bodyParts.push(tail);

  const body = safeMergeGeometries(bodyParts);
  for (const p of bodyParts) p.dispose();

  // Sculpted swept gull wing with natural inner cambered section + outer swept wingtip
  const makeWing = (side: -1 | 1): THREE.BufferGeometry => {
    // Vertex layout: shoulder root -> elbow arch -> swept pointed primary tip
    const s = side;
    const pts = [
      // Root chord (front, mid, back)
      0.04 * s, 0.02, 0.14,
      0.04 * s, 0.035, 0.0,
      0.04 * s, 0.01, -0.15,
      // Elbow chord (arched slightly upward & forward)
      0.46 * s, 0.09, 0.12,
      0.46 * s, 0.105, -0.02,
      0.46 * s, 0.06, -0.14,
      // Outer mid chord (tapering & sweeping aft)
      0.84 * s, 0.03, 0.02,
      0.84 * s, 0.02, -0.11,
      // Pointed primary wingtip
      1.12 * s, -0.02, -0.14
    ];

    const idx =
      s > 0
        ? [
            0, 3, 1, 1, 3, 4,
            1, 4, 2, 2, 4, 5,
            3, 6, 4, 4, 6, 7,
            4, 7, 5,
            6, 8, 7
          ]
        : [
            0, 1, 3, 1, 4, 3,
            1, 2, 4, 2, 5, 4,
            3, 4, 6, 4, 7, 6,
            4, 5, 7,
            6, 7, 8
          ];

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    // Vertex colors: crisp sea-gull white with slate-grey mantle & charcoal primary wingtips
    const colors: number[] = [];
    for (let i = 0; i < pts.length; i += 3) {
      const spanDist = Math.abs(pts[i]);
      if (spanDist > 0.78) {
        colors.push(0.22, 0.24, 0.28); // Iconic dark gull wingtips
      } else if (spanDist > 0.42) {
        colors.push(0.84, 0.87, 0.91); // Pale silvery-grey mantle
      } else {
        colors.push(0.97, 0.97, 0.96); // Bright white inner wing
      }
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return geo;
  };

  return {
    body,
    leftWing: makeWing(-1),
    rightWing: makeWing(1)
  };
}

// ============================================================================
// 7. MAIN FACTORY: createVegetationAndProps
// ============================================================================

export function createVegetationAndProps(
  textures: TextureLibrary = TEXTURES
): VegetationAndPropsModule {
  const group = new THREE.Group();
  group.name = 'BadaguanVegetationAndProps';

  const disposablesGeo: THREE.BufferGeometry[] = [];
  const disposablesMat: THREE.Material[] = [];
  const disposablesTex: THREE.Texture[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    disposablesGeo.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    disposablesMat.push(m);
    return m;
  };

  const rng = createRng(20241108);

  // Shared GPU shader uniforms for foliage sway & backlit autumn translucency
  const defaultAtm = ATMOSPHERE_PRESETS[DEFAULT_MOOD];
  const foliageUniforms: FoliageUniformBundle = {
    uTime: { value: 0 },
    uWindStrength: { value: defaultAtm.windStrength },
    uSunDir: {
      value: new THREE.Vector3(
        defaultAtm.sunDirection[0],
        defaultAtm.sunDirection[1],
        defaultAtm.sunDirection[2]
      ).normalize()
    },
    uSunColor: { value: new THREE.Color(defaultAtm.sunColor) },
    uTranslucency: { value: 1.0 }
  };

  // --------------------------------------------------------------------------
  // A. DETERMINISTIC BOTANICAL TREE PLACEMENT ("一關一樹、十關十景")
  // --------------------------------------------------------------------------

  const placedTrees: PlacedTree[] = [];

  const isTooCloseToExistingTree = (x: number, z: number, minDist: number): boolean => {
    const minSq = minDist * minDist;
    for (let i = 0; i < placedTrees.length; i++) {
      const t = placedTrees[i];
      const dx = x - t.x;
      const dz = z - t.z;
      if (dx * dx + dz * dz < minSq) return true;
    }
    return false;
  };

  const tryPlaceTree = (
    species: TreeSpecies,
    x: number,
    z: number,
    options: {
      variant?: number;
      scaleXZ: number;
      scaleY: number;
      minSpacing: number;
      roadClearance?: number;
      allowCourtyard?: boolean;
      allowHeadland?: boolean;
      allowNearIntersection?: boolean;
    }
  ): boolean => {
    if (!isWithinWorldPlayable(x, z, 3.0)) return false;

    const y = getTerrainHeight(x, z);
    const coastZone = getCoastZone(x, z);
    if (coastZone === 'sea' || coastZone === 'beach' || coastZone === 'seawall') {
      return false;
    }
    if (!options.allowHeadland && z > 37.5) {
      return false;
    }
    if (options.allowHeadland) {
      if (y < 2.9 || getTerrainSlope(x, z) > 0.84) return false;
    } else if (y < 2.2 || getTerrainSlope(x, z) > 0.72) {
      return false;
    }

    // Strict road clearance across ALL 5 roads
    const roadInfo = getRoadInfo(x, z);
    const reqRoadClear = options.roadClearance ?? 1.1;
    if (roadInfo.edgeDistance < reqRoadClear) return false;

    if (!options.allowNearIntersection && isNearIntersection(x, z, 0.92)) {
      return false;
    }

    // Never collide with villas, walls, or gate corridors
    if (isInsideAnyVillaBuilding(x, z, 2.7)) return false;
    if (!options.allowCourtyard && isInsideAnyVillaCourtyard(x, z, 1.15)) return false;
    if (isNearAnyVillaWall(x, z, 1.35)) return false;
    if (isInAnyVillaGateCorridor(x, z, 1.6)) return false;
    if (isBlockingViewpointSightline(x, z, 0.75)) return false;
    if (isTooCloseToExistingTree(x, z, options.minSpacing)) return false;

    placedTrees.push({
      species,
      variant: options.variant ?? (rng() < 0.5 ? 0 : 1),
      x,
      y: y - 0.15, // Grounded solidly beneath terrain so zero trunks ever float
      z,
      scaleXZ: options.scaleXZ,
      scaleY: options.scaleY,
      rotY: rng() * Math.PI * 2,
      leanX: seededRange(rng, -0.038, 0.038),
      leanZ: seededRange(rng, -0.038, 0.038),
      colorShift: seededRange(rng, -0.07, 0.07),
      huePick: rng()
    });
    return true;
  };

  // Helper to line both sides of an iconic Badaguan avenue
  const populateAvenueTrees = (
    road: RoadCurveSpec,
    species: TreeSpecies,
    spacingMeters: number,
    offsetFromCenter: number,
    sides: readonly (-1 | 1)[],
    scaleRangeXZ: [number, number],
    scaleRangeY: [number, number]
  ): void => {
    const count = Math.floor(road.totalLength / spacingMeters);
    for (let i = 1; i < count; i++) {
      const baseT = i / count;
      for (const side of sides) {
        const staggerT = clamp(
          baseT + (side > 0 ? 0.0 : 0.22 / count) + seededRange(rng, -0.14, 0.14) / count,
          0.025,
          0.975
        );
        const sample = sampleRoadPoint(road, staggerT);
        const offset = offsetFromCenter + seededRange(rng, -0.32, 0.42);
        const tx = sample.x + sample.normalX * side * offset;
        const tz = sample.z + sample.normalZ * side * offset;

        tryPlaceTree(species, tx, tz, {
          scaleXZ: seededRange(rng, scaleRangeXZ[0], scaleRangeXZ[1]),
          scaleY: seededRange(rng, scaleRangeY[0], scaleRangeY[1]),
          minSpacing: 5.4,
          roadClearance: 1.05
        });
      }
    }
  };

  // 1) 居庸關路 — Golden Ginkgo Avenue (銀杏大道)
  const juyongguanRoad = getRoadById('juyongguan');
  populateAvenueTrees(juyongguanRoad, 'ginkgo', 9.4, 5.55, [-1, 1], [0.92, 1.18], [0.95, 1.22]);

  // Extra layered golden ginkgos backing Juyongguan's upper/lower flanks for rich depth
  for (let i = 0; i < 24; i++) {
    const t = seededRange(rng, 0.04, 0.94);
    const sample = sampleRoadPoint(juyongguanRoad, t);
    const side = rng() < 0.5 ? -1 : 1;
    const dist = seededRange(rng, 9.2, 15.5);
    tryPlaceTree('ginkgo', sample.x + sample.normalX * side * dist, sample.z + sample.normalZ * side * dist, {
      scaleXZ: seededRange(rng, 0.85, 1.15),
      scaleY: seededRange(rng, 0.9, 1.18),
      minSpacing: 5.8,
      roadClearance: 1.8
    });
  }

  // 2) 嘉峪關路 — Crimson Five-Point Maple Avenue (五角楓大道)
  const jiayuguanRoad = getRoadById('jiayuguan');
  populateAvenueTrees(jiayuguanRoad, 'maple', 9.2, 5.25, [-1, 1], [0.9, 1.2], [0.88, 1.15]);

  // Extra crimson maple grove pockets weaving around Jiayuguan Rd & villa lawns
  for (let i = 0; i < 32; i++) {
    const t = seededRange(rng, 0.04, 0.96);
    const sample = sampleRoadPoint(jiayuguanRoad, t);
    const side = rng() < 0.5 ? -1 : 1;
    const dist = seededRange(rng, 8.8, 16.5);
    tryPlaceTree('maple', sample.x + sample.normalX * side * dist, sample.z + sample.normalZ * side * dist, {
      scaleXZ: seededRange(rng, 0.82, 1.18),
      scaleY: seededRange(rng, 0.84, 1.14),
      minSpacing: 5.2,
      roadClearance: 1.6
    });
  }

  // 3) 山海關路 — French Sycamore Coastal Avenue (法桐林蔭道)
  // North side (-1 in sample normal since road runs West->East so normal points South/+Z -> check!)
  // Road tangent is roughly (+1, 0) => normalX = -tangentZ ≈ 0, normalZ = tangentX ≈ +1 (South!)
  // So side = -1 is North (villa/inland side), side = +1 is South (seaside/east cape side)
  const shanhaiguanRoad = getRoadById('shanhaiguan');
  populateAvenueTrees(shanhaiguanRoad, 'sycamore', 10.6, 5.85, [-1], [0.92, 1.18], [0.94, 1.16]);
  // South side where open (West of boardwalk & East of Huashi junction climbing East Hill)
  populateAvenueTrees(shanhaiguanRoad, 'sycamore', 11.4, 5.95, [1], [0.88, 1.12], [0.9, 1.12]);

  // 4) 黃海路海岬與花石樓周邊 — Wind-Sculpted Coastal Black Pines & Emerald Cedars
  const huashiCapePath = getRoadById('huashi_cape');
  for (let i = 0; i < 6; i++) {
    const t = 0.14 + (i / 5) * 0.76;
    const sample = sampleRoadPoint(huashiCapePath, t);
    for (const side of [-1, 1] as const) {
      const dist = seededRange(rng, 4.2, 6.2);
      tryPlaceTree('cedar', sample.x + sample.normalX * side * dist, sample.z + sample.normalZ * side * dist, {
        variant: 1, // Wind-sculpted coastal black pine
        scaleXZ: seededRange(rng, 0.84, 1.12),
        scaleY: seededRange(rng, 0.85, 1.1),
        minSpacing: 4.4,
        roadClearance: 1.0,
        allowHeadland: true,
        allowNearIntersection: true
      });
    }
  }

  // Dramatic Huashi Cape rocky headland pines framing Huashi Villa castle silhouette
  const huashiHeadlandCandidates: [number, number, number][] = [
    [32.5, 42.5, 1],
    [35.2, 47.8, 1],
    [40.0, 53.5, 1],
    [57.5, 53.2, 1],
    [62.2, 46.5, 1],
    [63.5, 36.2, 1],
    [60.8, 30.2, 0],
    [53.0, 27.4, 0],
    [44.2, 26.8, 1],
    [36.0, 27.6, 1],
    [67.5, 41.0, 1],
    [66.2, 32.0, 1],
    [29.5, 39.2, 1],
    // Western Huiquan-style rocky headland pines
    [-70.5, 39.5, 1],
    [-76.0, 42.0, 1],
    [-82.5, 38.0, 1],
    [-86.0, 43.2, 1]
  ];
  for (const [hx, hz, variant] of huashiHeadlandCandidates) {
    tryPlaceTree('cedar', hx + seededRange(rng, -1.2, 1.2), hz + seededRange(rng, -1.2, 1.2), {
      variant,
      scaleXZ: seededRange(rng, 0.88, 1.2),
      scaleY: seededRange(rng, 0.86, 1.18),
      minSpacing: 4.2,
      roadClearance: 1.2,
      allowHeadland: true,
      allowNearIntersection: true
    });
  }

  // 5) Curated Evergreen Cedars framing Princess House, Butterfly Villa & Villa Courtyard Corners
  const heroFramingCedars: [number, number, number, boolean][] = [
    // Framing Princess House (12, -2) courtyard flanks & backdrop (emerald contrast to blue-green stucco!)
    [25.5, -5.5, 0, false],
    [25.2, 4.5, 0, false],
    [16.5, 10.5, 0, false],
    [6.5, 10.8, 0, false],
    [18.8, 4.2, 1, true], // Corner specimen pine inside Princess House SE courtyard
    [19.2, -8.4, 0, true], // Corner cedar inside Princess House NE courtyard
    // Framing Butterfly Villa (-32, 11) garden backdrop
    [-46.8, 15.5, 0, false],
    [-47.0, 5.2, 0, false],
    [-17.2, 14.5, 0, false],
    [-16.8, 5.5, 0, false],
    [-40.5, 17.2, 1, true], // Butterfly courtyard SW specimen pine
    // Framing East Hill & Northern Villas
    [40.5, -14.5, 0, false],
    [40.8, 2.8, 0, false],
    [67.5, -14.2, 0, false],
    [67.2, 1.2, 0, false]
  ];
  for (const [cx, cz, variant, allowCourtyard] of heroFramingCedars) {
    tryPlaceTree('cedar', cx, cz, {
      variant,
      scaleXZ: seededRange(rng, 0.9, 1.14),
      scaleY: seededRange(rng, 0.92, 1.18),
      minSpacing: 4.5,
      roadClearance: 1.5,
      allowCourtyard
    });
  }

  // 6) Hillside Evergreen Cedar & Mixed Autumn Forest Backdrop ("紅瓦綠樹" dense garden canopy)
  for (let attempt = 0; attempt < 520; attempt++) {
    const x = seededRange(rng, -92, 92);
    const z = seededRange(rng, -89, 25);
    const rRoll = rng();
    let species: TreeSpecies;
    let variant: number;
    if (rRoll < 0.54) {
      species = 'cedar';
      variant = rng() < 0.72 ? 0 : 1; // Predominantly tall emerald Deodar cedars
    } else if (rRoll < 0.74) {
      species = 'ginkgo';
      variant = rng() < 0.5 ? 0 : 1;
    } else if (rRoll < 0.9) {
      species = 'maple';
      variant = rng() < 0.5 ? 0 : 1;
    } else {
      species = 'sycamore';
      variant = rng() < 0.5 ? 0 : 1;
    }

    tryPlaceTree(species, x, z, {
      variant,
      scaleXZ: seededRange(rng, 0.84, 1.24),
      scaleY: seededRange(rng, 0.86, 1.28),
      minSpacing: species === 'cedar' ? 5.2 : 6.0,
      roadClearance: 2.3
    });
  }

  // --------------------------------------------------------------------------
  // B. BUILD TREE ARCHETYPES & INSTANCED MESHES (TRUNKS + FOLIAGE CLUSTERS)
  // --------------------------------------------------------------------------

  const archetypes: Record<TreeSpecies, [TreeArchetype, TreeArchetype]> = {
    ginkgo: [buildGinkgoArchetype(1101), buildGinkgoArchetype(1102)],
    maple: [buildMapleArchetype(2201), buildMapleArchetype(2202)],
    sycamore: [buildSycamoreArchetype(3301), buildSycamoreArchetype(3302)],
    cedar: [buildCedarOrPineArchetype(4401, false), buildCedarOrPineArchetype(4402, true)]
  };

  for (const sp of ['ginkgo', 'maple', 'sycamore', 'cedar'] as const) {
    trackGeo(archetypes[sp][0].trunkGeometry);
    trackGeo(archetypes[sp][1].trunkGeometry);
  }

  // Bark materials
  const standardBarkMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: textures.treeBark.map,
      bumpMap: textures.treeBark.bumpMap,
      bumpScale: 0.08,
      roughness: 0.92,
      metalness: 0.0
    })
  );

  const sycamoreBarkMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: textures.sycamoreBark.map,
      bumpMap: textures.sycamoreBark.bumpMap,
      bumpScale: 0.07,
      roughness: 0.86,
      metalness: 0.0
    })
  );

  // Volumetric leaf-cluster rosette geometries & custom backlit wind materials
  const broadleafClusterGeo = trackGeo(createVolumetricFoliageClusterGeometry(false));
  const coniferClusterGeo = trackGeo(createVolumetricFoliageClusterGeometry(true));

  const foliageMats: Record<TreeSpecies, THREE.MeshStandardMaterial> = {
    ginkgo: trackMat(
      createFoliageMaterial(
        'ginkgo',
        textures.foliageClusterTextures.ginkgo,
        foliageUniforms,
        1.15,
        0.35
      )
    ),
    maple: trackMat(
      createFoliageMaterial(
        'maple',
        textures.foliageClusterTextures.maple,
        foliageUniforms,
        1.05,
        0.35
      )
    ),
    sycamore: trackMat(
      createFoliageMaterial(
        'sycamore',
        textures.foliageClusterTextures.sycamore,
        foliageUniforms,
        0.85,
        0.35
      )
    ),
    cedar: trackMat(
      createFoliageMaterial(
        'cedar',
        textures.foliageClusterTextures.cedar,
        foliageUniforms,
        0.58,
        0.22
      )
    )
  };

  // Foliage color palettes per species (multiplied with hand-painted leaf cluster textures!)
  const foliagePalettes: Record<TreeSpecies, { sunlit: THREE.Color[]; shade: THREE.Color[] }> = {
    ginkgo: {
      sunlit: [
        new THREE.Color('#fff5bf'),
        new THREE.Color('#ffe88c'),
        new THREE.Color('#ffdf70'),
        new THREE.Color('#f7ec9c')
      ],
      shade: [
        new THREE.Color('#d9a942'),
        new THREE.Color('#c79430'),
        new THREE.Color('#ccd46a')
      ]
    },
    maple: {
      sunlit: [
        new THREE.Color('#ff9d80'),
        new THREE.Color('#ff8266'),
        new THREE.Color('#ffc278'),
        new THREE.Color('#ff6e5c')
      ],
      shade: [
        new THREE.Color('#bf3b3b'),
        new THREE.Color('#9e2932'),
        new THREE.Color('#d1573b')
      ]
    },
    sycamore: {
      sunlit: [
        new THREE.Color('#f7df9e'),
        new THREE.Color('#ebd088'),
        new THREE.Color('#d8d68d')
      ],
      shade: [
        new THREE.Color('#b89a5c'),
        new THREE.Color('#9e834e'),
        new THREE.Color('#9ca865')
      ]
    },
    cedar: {
      sunlit: [
        new THREE.Color('#d8f2b6'),
        new THREE.Color('#c8ebb0'),
        new THREE.Color('#e2f5be')
      ],
      shade: [
        new THREE.Color('#6d9b7b'),
        new THREE.Color('#5e8c70'),
        new THREE.Color('#77a582')
      ]
    }
  };

  const treesBySpeciesVariant: Record<TreeSpecies, [PlacedTree[], PlacedTree[]]> = {
    ginkgo: [[], []],
    maple: [[], []],
    sycamore: [[], []],
    cedar: [[], []]
  };
  const foliageCounts: Record<TreeSpecies, number> = {
    ginkgo: 0,
    maple: 0,
    sycamore: 0,
    cedar: 0
  };

  for (const tree of placedTrees) {
    treesBySpeciesVariant[tree.species][tree.variant].push(tree);
    foliageCounts[tree.species] += archetypes[tree.species][tree.variant].foliageAnchors.length;
  }

  const tmpTreeMat = new THREE.Matrix4();
  const tmpClusterLocalMat = new THREE.Matrix4();
  const tmpClusterWorldMat = new THREE.Matrix4();
  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpEuler = new THREE.Euler();
  const tmpScale = new THREE.Vector3();
  const tmpColor = new THREE.Color();
  const tmpColorShade = new THREE.Color();

  for (const sp of ['ginkgo', 'maple', 'sycamore', 'cedar'] as const) {
    const barkMat = sp === 'sycamore' ? sycamoreBarkMat : standardBarkMat;
    const fCount = foliageCounts[sp];
    const clusterGeo = sp === 'cedar' ? coniferClusterGeo : broadleafClusterGeo;
    const foliageInst = new THREE.InstancedMesh(clusterGeo, foliageMats[sp], Math.max(1, fCount));
    foliageInst.castShadow = true;
    foliageInst.receiveShadow = true;
    foliageInst.frustumCulled = false;

    let fIdx = 0;

    for (let v = 0; v < 2; v++) {
      const list = treesBySpeciesVariant[sp][v];
      if (list.length === 0) continue;

      const arch = archetypes[sp][v];
      const trunkInst = new THREE.InstancedMesh(arch.trunkGeometry, barkMat, list.length);
      trunkInst.castShadow = true;
      trunkInst.receiveShadow = true;
      trunkInst.frustumCulled = false;

      for (let i = 0; i < list.length; i++) {
        const tree = list[i];
        tmpEuler.set(tree.leanX, tree.rotY, tree.leanZ);
        tmpQuat.setFromEuler(tmpEuler);
        tmpPos.set(tree.x, tree.y, tree.z);
        tmpScale.set(tree.scaleXZ, tree.scaleY, tree.scaleXZ);
        tmpTreeMat.compose(tmpPos, tmpQuat, tmpScale);
        trunkInst.setMatrixAt(i, tmpTreeMat);

        // Subtle organic bark tone variation per tree
        const bTone = 0.88 + tree.colorShift * 1.1;
        tmpColor.setRGB(bTone, bTone * 0.98, bTone * 0.95);
        trunkInst.setColorAt(i, tmpColor);

        // Populate every foliage rosette anchored on this tree's real branch tips
        const pal = foliagePalettes[sp];
        const sunChoice = pal.sunlit[Math.floor(tree.huePick * pal.sunlit.length) % pal.sunlit.length];
        const shadeChoice = pal.shade[Math.floor(tree.huePick * pal.shade.length) % pal.shade.length];

        for (let a = 0; a < arch.foliageAnchors.length; a++) {
          const anchor = arch.foliageAnchors[a];
          tmpEuler.set(anchor.tiltX, anchor.rotY, anchor.tiltZ);
          tmpQuat.setFromEuler(tmpEuler);
          tmpClusterLocalMat.compose(anchor.pos, tmpQuat, anchor.scale);
          tmpClusterWorldMat.multiplyMatrices(tmpTreeMat, tmpClusterLocalMat);
          foliageInst.setMatrixAt(fIdx, tmpClusterWorldMat);

          // Blend lower interior shade -> upper sunlit warmth + subtle per-cluster jitter
          const blend = clamp(anchor.sunBias + seededRange(rng, -0.14, 0.14), 0, 1);
          tmpColorShade.copy(shadeChoice);
          tmpColor.copy(tmpColorShade).lerp(sunChoice, blend);
          // Compensate for dark base conifer needle texture so sunlit outer needles glow rich olive-emerald while interior stays deep pine
          const speciesLift = sp === 'cedar' ? 1.08 + blend * 0.34 : 1.0;
          const bright = (1.0 + tree.colorShift + seededRange(rng, -0.05, 0.06)) * speciesLift;
          tmpColor.multiplyScalar(bright);
          foliageInst.setColorAt(fIdx, tmpColor);
          fIdx++;
        }
      }

      trunkInst.instanceMatrix.needsUpdate = true;
      if (trunkInst.instanceColor) trunkInst.instanceColor.needsUpdate = true;
      group.add(trunkInst);
    }

    foliageInst.count = fIdx;
    foliageInst.instanceMatrix.needsUpdate = true;
    if (foliageInst.instanceColor) foliageInst.instanceColor.needsUpdate = true;
    if (fIdx > 0) group.add(foliageInst);
  }

  // --------------------------------------------------------------------------
  // C. COURTYARD SHRUBS, HYDRANGEA BLOOMS & AUTUMN CRIMSON IVY ON STONE WALLS
  // --------------------------------------------------------------------------

  const shrubTransforms: { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number; col: THREE.Color }[] = [];
  const hydrangeaTransforms: { x: number; y: number; z: number; s: number; col: THREE.Color }[] = [];

  const shrubColors = [
    new THREE.Color('#84ba86'),
    new THREE.Color('#6da478'),
    new THREE.Color('#98c88c'),
    new THREE.Color('#a6bf7a'),
    new THREE.Color('#c87458') // Late-autumn crimson-tipped ornamental shrub
  ];
  const hydrangeaColors = [
    new THREE.Color('#9ab6e0'),
    new THREE.Color('#c2b2e0'),
    new THREE.Color('#e8d5de'),
    new THREE.Color('#8eaad4')
  ];

  // 1) Lush garden shrubs & autumn hydrangeas nestled inside all 7 villa courtyards
  for (const villa of VILLAS) {
    const innerHalfW = villa.courtyardWidth * 0.5 - 1.3;
    const innerHalfD = villa.courtyardDepth * 0.5 - 1.3;
    const bHalfW = villa.footprintWidth * 0.5 + 1.15;
    const bHalfD = villa.footprintDepth * 0.5 + 1.15;

    for (let s = 0; s < 34; s++) {
      const lx = seededRange(rng, -innerHalfW, innerHalfW);
      const lz = seededRange(rng, -innerHalfD, innerHalfD);
      // Keep outside main house footprint
      if (Math.abs(lx) < bHalfW && Math.abs(lz) < bHalfD) continue;
      const [wx, wz] = villaLocalToWorld(villa, lx, lz);
      if (isInAnyVillaGateCorridor(wx, wz, 0.8)) continue;
      if (isNearAnyVillaWall(wx, wz, 0.48)) continue;

      const wy = getTerrainHeight(wx, wz);
      const isWarmAccent = rng() < 0.18;
      const col = isWarmAccent
        ? shrubColors[4]
        : shrubColors[Math.floor(rng() * 4)];
      const sx = seededRange(rng, 1.05, 1.85);
      const sy = seededRange(rng, 0.72, 1.25);

      shrubTransforms.push({
        x: wx,
        y: wy + sy * 0.34,
        z: wz,
        sx,
        sy,
        sz: sx * seededRange(rng, 0.85, 1.15),
        ry: rng() * Math.PI * 2,
        col
      });

      // Hydrangea blossom clusters inside Princess House & Butterfly Villa gardens
      if ((villa.id === 'princess' || villa.id === 'butterfly') && rng() < 0.42) {
        for (let h = 0; h < 3; h++) {
          hydrangeaTransforms.push({
            x: wx + seededRange(rng, -0.42, 0.42),
            y: wy + sy * 0.65 + seededRange(rng, -0.08, 0.16),
            z: wz + seededRange(rng, -0.42, 0.42),
            s: seededRange(rng, 0.14, 0.22),
            col: hydrangeaColors[Math.floor(rng() * hydrangeaColors.length)]
          });
        }
      }
    }
  }

  // 2) Coastal hillside & roadside verge low greenery framing Huashi Cape & seawall pockets
  for (let i = 0; i < 95; i++) {
    const t = rng();
    const road = i < 42 ? shanhaiguanRoad : i < 70 ? huashiCapePath : jiayuguanRoad;
    const sample = sampleRoadPoint(road, clamp(t, 0.04, 0.96));
    const side = rng() < 0.5 ? -1 : 1;
    const dist = road.width * 0.5 + seededRange(rng, 1.3, 3.2);
    const wx = sample.x + sample.normalX * side * dist;
    const wz = sample.z + sample.normalZ * side * dist;

    if (!isWithinWorldPlayable(wx, wz, 3.0)) continue;
    const cz = getCoastZone(wx, wz);
    if (cz === 'sea' || cz === 'beach') continue;
    if (getRoadInfo(wx, wz).edgeDistance < 0.9) continue;
    if (isInsideAnyVillaBuilding(wx, wz, 1.4)) continue;
    if (isInAnyVillaGateCorridor(wx, wz, 0.8)) continue;
    if (isNearAnyVillaWall(wx, wz, 0.55)) continue;

    const wy = getTerrainHeight(wx, wz);
    if (wy < 2.2) continue;

    const sx = seededRange(rng, 1.0, 1.75);
    const sy = seededRange(rng, 0.58, 1.05);
    shrubTransforms.push({
      x: wx,
      y: wy + sy * 0.3,
      z: wz,
      sx,
      sy,
      sz: sx * seededRange(rng, 0.85, 1.15),
      ry: rng() * Math.PI * 2,
      col: shrubColors[Math.floor(rng() * shrubColors.length)]
    });
  }

  if (shrubTransforms.length > 0) {
    const shrubMat = trackMat(
      createFoliageMaterial(
        'shrub',
        textures.foliageClusterTextures.cedar,
        foliageUniforms,
        0.54,
        0.24
      )
    );
    const shrubInst = new THREE.InstancedMesh(coniferClusterGeo, shrubMat, shrubTransforms.length);
    shrubInst.castShadow = true;
    shrubInst.receiveShadow = true;
    shrubInst.frustumCulled = false;

    for (let i = 0; i < shrubTransforms.length; i++) {
      const st = shrubTransforms[i];
      tmpEuler.set(0, st.ry, 0);
      tmpQuat.setFromEuler(tmpEuler);
      tmpPos.set(st.x, st.y, st.z);
      tmpScale.set(st.sx, st.sy, st.sz);
      tmpTreeMat.compose(tmpPos, tmpQuat, tmpScale);
      shrubInst.setMatrixAt(i, tmpTreeMat);
      tmpColor.copy(st.col).multiplyScalar(1.32);
      shrubInst.setColorAt(i, tmpColor);
    }
    shrubInst.instanceMatrix.needsUpdate = true;
    if (shrubInst.instanceColor) shrubInst.instanceColor.needsUpdate = true;
    group.add(shrubInst);
  }

  if (hydrangeaTransforms.length > 0) {
    const hydGeo = trackGeo(new THREE.IcosahedronGeometry(1.0, 1));
    const hydMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.84,
        metalness: 0.0
      })
    );
    const hydInst = new THREE.InstancedMesh(hydGeo, hydMat, hydrangeaTransforms.length);
    hydInst.frustumCulled = false;
    for (let i = 0; i < hydrangeaTransforms.length; i++) {
      const h = hydrangeaTransforms[i];
      tmpPos.set(h.x, h.y, h.z);
      tmpQuat.identity();
      tmpScale.set(h.s, h.s * 0.85, h.s);
      tmpTreeMat.compose(tmpPos, tmpQuat, tmpScale);
      hydInst.setMatrixAt(i, tmpTreeMat);
      hydInst.setColorAt(i, h.col);
    }
    hydInst.instanceMatrix.needsUpdate = true;
    if (hydInst.instanceColor) hydInst.instanceColor.needsUpdate = true;
    group.add(hydInst);
  }

  // 3) Autumn Crimson Ivy (爬山虎) cascading along granite courtyard walls
  const ivyGeo = trackGeo(new THREE.PlaneGeometry(1.15, 0.95, 2, 2));
  {
    const ip = ivyGeo.getAttribute('position');
    for (let i = 0; i < ip.count; i++) {
      ip.setZ(i, Math.sin(ip.getX(i) * 2.5 + ip.getY(i) * 2.5) * 0.06);
    }
    ivyGeo.computeVertexNormals();
  }
  const ivyMat = trackMat(
    createFoliageMaterial(
      'wall_ivy',
      textures.foliageClusterTextures.maple,
      foliageUniforms,
      0.65,
      0.34
    )
  );
  const ivyTransforms: { x: number; y: number; z: number; rotY: number; sx: number; sy: number; col: THREE.Color }[] = [];
  const ivyColors = [
    new THREE.Color('#c22b26'),
    new THREE.Color('#a11d20'),
    new THREE.Color('#d94b2b'),
    new THREE.Color('#7a2220'),
    new THREE.Color('#5a7538') // Lingering green-crimson ivy transition
  ];

  for (const seg of ALL_WALL_SEGMENTS) {
    const patches = Math.max(2, Math.floor(seg.length * 0.42));
    const cosR = Math.cos(seg.rotationY);
    const sinR = Math.sin(seg.rotationY);
    for (let p = 0; p < patches; p++) {
      if (rng() < 0.25) continue; // Organic gaps showing mushroom-stone masonry!
      const along = seededRange(rng, -seg.length * 0.44, seg.length * 0.44);
      for (const face of [-1, 1] as const) {
        if (rng() < 0.35) continue;
        const offset = face * (seg.thickness * 0.5 + 0.08);
        const wx = seg.centerX + along * cosR + offset * sinR;
        const wz = seg.centerZ - along * sinR + offset * cosR;
        const wy = seg.baseY + seededRange(rng, 0.55, 1.48);
        ivyTransforms.push({
          x: wx,
          y: wy,
          z: wz,
          rotY: seg.rotationY + (face > 0 ? 0 : Math.PI),
          sx: seededRange(rng, 0.85, 1.55),
          sy: seededRange(rng, 0.72, 1.35),
          col: ivyColors[Math.floor(rng() * ivyColors.length)]
        });
      }
    }
  }

  if (ivyTransforms.length > 0) {
    const ivyInst = new THREE.InstancedMesh(ivyGeo, ivyMat, ivyTransforms.length);
    ivyInst.receiveShadow = true;
    ivyInst.frustumCulled = false;
    for (let i = 0; i < ivyTransforms.length; i++) {
      const iv = ivyTransforms[i];
      tmpEuler.set(seededRange(rng, -0.08, 0.08), iv.rotY, seededRange(rng, -0.18, 0.18));
      tmpQuat.setFromEuler(tmpEuler);
      tmpPos.set(iv.x, iv.y, iv.z);
      tmpScale.set(iv.sx, iv.sy, 1.0);
      tmpTreeMat.compose(tmpPos, tmpQuat, tmpScale);
      ivyInst.setMatrixAt(i, tmpTreeMat);
      ivyInst.setColorAt(i, iv.col);
    }
    ivyInst.instanceMatrix.needsUpdate = true;
    if (ivyInst.instanceColor) ivyInst.instanceColor.needsUpdate = true;
    group.add(ivyInst);
  }

  // --------------------------------------------------------------------------
  // D. FALLEN AUTUMN LEAF CARPETS ("落葉緩掃" — GINKGO GOLD & MAPLE CRIMSON)
  // --------------------------------------------------------------------------

  const fallenLeafGeo = trackGeo(createCurledLeafGeometry(0.24));
  const fallenLeafMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: textures.foliageClusterTextures.fallenLeaf,
      alphaTest: 0.34,
      side: THREE.DoubleSide,
      roughness: 0.76,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    })
  );

  const ginkgoFallColors = [
    new THREE.Color('#ffda4d'),
    new THREE.Color('#f5be2c'),
    new THREE.Color('#ffe875'),
    new THREE.Color('#e09e22'),
    new THREE.Color('#d4b435')
  ];
  const mapleFallColors = [
    new THREE.Color('#d93424'),
    new THREE.Color('#e8592a'),
    new THREE.Color('#b02022'),
    new THREE.Color('#f08230'),
    new THREE.Color('#8f1a1c')
  ];
  const sycamoreFallColors = [
    new THREE.Color('#cf973c'),
    new THREE.Color('#b57c30'),
    new THREE.Color('#deb352'),
    new THREE.Color('#96682c')
  ];

  const maxFallenLeaves = 3600;
  const fallenInst = new THREE.InstancedMesh(fallenLeafGeo, fallenLeafMat, maxFallenLeaves);
  fallenInst.receiveShadow = true;
  fallenInst.frustumCulled = false;

  let leafIdx = 0;
  const pushFallenLeaf = (x: number, z: number, palette: THREE.Color[], scaleRange: [number, number]) => {
    if (leafIdx >= maxFallenLeaves) return;
    if (!isWithinWorldPlayable(x, z, 2.0)) return;
    const cz = getCoastZone(x, z);
    if (cz === 'sea' || cz === 'beach') return;
    if (isInsideAnyVillaBuilding(x, z, 0.5)) return;

    const y = getTerrainHeight(x, z);
    if (y < 1.8) return;

    const info = getRoadInfo(x, z);
    // Keep leaves visibly nestled right on top of road gutters, curbs, & lawns without clipping
    const lift = info.onRoad ? 0.055 : info.onShoulder ? 0.095 : 0.065;

    tmpPos.set(x, y + lift + seededRange(rng, 0.0, 0.025), z);
    tmpEuler.set(
      seededRange(rng, -0.18, 0.18),
      rng() * Math.PI * 2,
      seededRange(rng, -0.18, 0.18)
    );
    tmpQuat.setFromEuler(tmpEuler);
    const sc = seededRange(rng, scaleRange[0], scaleRange[1]);
    tmpScale.set(sc, sc, sc);
    tmpTreeMat.compose(tmpPos, tmpQuat, tmpScale);
    fallenInst.setMatrixAt(leafIdx, tmpTreeMat);

    const col = palette[Math.floor(rng() * palette.length)];
    tmpColor.copy(col).multiplyScalar(seededRange(rng, 0.88, 1.1));
    fallenInst.setColorAt(leafIdx, tmpColor);
    leafIdx++;
  };

  // 1) Rich golden ginkgo leaf drifts hugging Juyongguan Rd curbs, gutters & lawns (1550 leaves)
  for (let i = 0; i < 1550; i++) {
    const t = seededRange(rng, 0.02, 0.98);
    const sample = sampleRoadPoint(juyongguanRoad, t);
    const side = rng() < 0.5 ? -1 : 1;
    // Concentrate thickly along road edges/gutters & sidewalks, sparser near center lane
    const band = rng();
    let offset: number;
    if (band < 0.48) {
      offset = side * seededRange(rng, 2.9, 4.15); // Lush golden gutter drift
    } else if (band < 0.84) {
      offset = side * seededRange(rng, 4.2, 7.8); // Sidewalk & tree-verge golden carpet
    } else {
      offset = side * seededRange(rng, 0.3, 2.8); // Scattered leaves across asphalt
    }
    const lx = sample.x + sample.normalX * offset;
    const lz = sample.z + sample.normalZ * offset;
    // Blend golden + crimson near the Jiayuguan intersection!
    const nearMapleCross = Math.hypot(lx + 8.0, lz + 15.5) < 12.0;
    const pal = nearMapleCross && rng() < 0.35 ? mapleFallColors : ginkgoFallColors;
    pushFallenLeaf(lx, lz, pal, [0.85, 1.55]);
  }

  // 2) Fiery crimson maple leaf carpets along Jiayuguan Rd (1250 leaves)
  for (let i = 0; i < 1250; i++) {
    const t = seededRange(rng, 0.02, 0.98);
    const sample = sampleRoadPoint(jiayuguanRoad, t);
    const side = rng() < 0.5 ? -1 : 1;
    const band = rng();
    let offset: number;
    if (band < 0.46) {
      offset = side * seededRange(rng, 2.6, 3.85);
    } else if (band < 0.84) {
      offset = side * seededRange(rng, 3.9, 7.6);
    } else {
      offset = side * seededRange(rng, 0.2, 2.5);
    }
    const lx = sample.x + sample.normalX * offset;
    const lz = sample.z + sample.normalZ * offset;
    const nearGinkgoCross = Math.hypot(lx + 8.0, lz + 15.5) < 12.0;
    const pal = nearGinkgoCross && rng() < 0.35 ? ginkgoFallColors : mapleFallColors;
    pushFallenLeaf(lx, lz, pal, [0.95, 1.65]);
  }

  // 3) Warm amber French Sycamore leaves along Shanhaiguan coastal promenade (450 leaves)
  for (let i = 0; i < 450; i++) {
    const t = seededRange(rng, 0.03, 0.96);
    const sample = sampleRoadPoint(shanhaiguanRoad, t);
    const side = rng() < 0.65 ? -1 : 1; // Heavier on north sycamore side
    const offset = side * seededRange(rng, 2.8, 7.2);
    pushFallenLeaf(
      sample.x + sample.normalX * offset,
      sample.z + sample.normalZ * offset,
      sycamoreFallColors,
      [1.15, 1.95]
    );
  }

  // 4) Courtyard lawn autumn leaves inside the 7 European villas (350 leaves)
  for (let i = 0; i < 350; i++) {
    const villa = VILLAS[i % VILLAS.length];
    const lx = seededRange(rng, -villa.courtyardWidth * 0.46, villa.courtyardWidth * 0.46);
    const lz = seededRange(rng, -villa.courtyardDepth * 0.46, villa.courtyardDepth * 0.46);
    const [wx, wz] = villaLocalToWorld(villa, lx, lz);
    const pal = rng() < 0.55 ? ginkgoFallColors : mapleFallColors;
    pushFallenLeaf(wx, wz, pal, [0.85, 1.45]);
  }

  fallenInst.count = leafIdx;
  fallenInst.instanceMatrix.needsUpdate = true;
  if (fallenInst.instanceColor) fallenInst.instanceColor.needsUpdate = true;
  group.add(fallenInst);

  // --------------------------------------------------------------------------
  // E. VINTAGE QINGDAO CAST-IRON STREETLAMPS + WARM TWILIGHT POINT LIGHTS
  // --------------------------------------------------------------------------

  const castIronGreenMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: '#1d362b',
      roughness: 0.44,
      metalness: 0.62
    })
  );

  const lampGlassMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: '#f5eedc',
      emissive: new THREE.Color('#ffb95c'),
      emissiveIntensity: 0.08,
      roughness: 0.25,
      metalness: 0.05,
      transparent: true,
      opacity: 0.92
    })
  );

  const lanternHaloTex = createLanternHaloTexture();
  disposablesTex.push(lanternHaloTex);
  const lanternHaloMat = trackMat(
    new THREE.MeshBasicMaterial({
      map: lanternHaloTex,
      color: '#ffca78',
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );

  const placedLamps: PlacedLamp[] = [];
  const tryPlaceLamp = (x: number, z: number, rotY: number, isHero: boolean): boolean => {
    if (!isWithinWorldPlayable(x, z, 3.0)) return false;
    const cz = getCoastZone(x, z);
    if (cz === 'sea' || cz === 'beach') return false;
    const info = getRoadInfo(x, z);
    if (info.edgeDistance < 0.24) return false; // Never inside paved roadway
    if (isInsideAnyVillaBuilding(x, z, 1.5)) return false;
    if (isInsideAnyVillaCourtyard(x, z, 0.35)) return false;
    if (isInAnyVillaGateCorridor(x, z, 0.55)) return false;
    if (isBlockingViewpointSightline(x, z, 0.25)) return false;
    if (isTooCloseToExistingTree(x, z, 1.35)) return false;
    for (let i = 0; i < placedLamps.length; i++) {
      const l = placedLamps[i];
      if (Math.hypot(x - l.x, z - l.z) < 9.5) return false;
    }

    const y = getTerrainHeight(x, z);
    if (y < 2.2) return false;
    placedLamps.push({ x, y: y - 0.05, z, rotY, isHero });
    return true;
  };

  // Hero point-light target coordinates (12 carefully chosen atmospheric twilight pools!)
  const heroLampZones: readonly [number, number][] = [
    [-3.2, -31.0], // Spawn ginkgo avenue
    [-12.8, -19.5], // Juyongguan x Jiayuguan crossroads
    [-3.2, 3.0], // Near Princess House gate
    [-12.8, 22.5], // Juyongguan south approaching sea
    [-32.0, -11.0], // Jiayuguan Rd west (maple lane)
    [16.0, -23.0], // Jiayuguan Rd east
    [-36.0, 24.8], // Shanhaiguan Rd Butterfly Villa front
    [-18.0, 34.4], // Shanhaiguan / Second Beach jetty promenade
    [4.0, 34.2], // Shanhaiguan promenade east
    [25.5, 25.0], // Huashi Cape junction
    [34.5, 34.8], // Huashi Cape path approaching castle
    [46.0, 17.5] // Shanhaiguan climbing East Hill
  ];

  const isNearHeroLampZone = (x: number, z: number): boolean => {
    for (let i = 0; i < heroLampZones.length; i++) {
      if (Math.hypot(x - heroLampZones[i][0], z - heroLampZones[i][1]) < 10.5) {
        return true;
      }
    }
    return false;
  };

  const populateRoadLamps = (
    road: RoadCurveSpec,
    spacing: number,
    offset: number,
    preferSide?: -1 | 1
  ): void => {
    const count = Math.floor(road.totalLength / spacing);
    for (let i = 1; i < count; i++) {
      const baseT = i / count;
      const side: -1 | 1 = preferSide ?? (i % 2 === 0 ? 1 : -1);
      // Try exact rhythmic position first; if a tree or gate sits there, gently nudge along curb
      const nudges = [0, 0.022, -0.022, 0.044, -0.044];
      for (const dt of nudges) {
        const t = clamp(baseT + dt, 0.03, 0.97);
        const sample = sampleRoadPoint(road, t);
        const lx = sample.x + sample.normalX * side * offset;
        const lz = sample.z + sample.normalZ * side * offset;
        const rotY = Math.atan2(sample.tangentX, sample.tangentZ);
        if (tryPlaceLamp(lx, lz, rotY, isNearHeroLampZone(lx, lz))) {
          break;
        }
      }
    }
  };

  populateRoadLamps(juyongguanRoad, 14.5, 4.55);
  populateRoadLamps(jiayuguanRoad, 16.5, 4.35);
  // North villa side of Shanhaiguan Rd + select south promenade lamps
  populateRoadLamps(shanhaiguanRoad, 16.5, 4.85, -1);
  populateRoadLamps(shanhaiguanRoad, 22.0, 4.75, 1);
  // Coastal seaside promenade verge lamps (between Shanhaiguan & Boardwalk overlooking the sea)
  const seasidePromenadeLamps: [number, number][] = [
    [-55.0, 35.15],
    [-36.0, 34.65],
    [-19.0, 34.1],
    [-1.5, 34.25],
    [13.5, 34.65]
  ];
  for (const [lx, lz] of seasidePromenadeLamps) {
    tryPlaceLamp(lx, lz, 0, isNearHeroLampZone(lx, lz));
  }
  // Huashi Cape path heritage lamps
  populateRoadLamps(huashiCapePath, 9.5, 2.8);

  // Accumulate all static dark cast-iron street furniture (lamps, signs, benches, postboxes)
  // so they render together in ONE single batched draw call!
  const staticCastIronParts: THREE.BufferGeometry[] = [];
  const pushStaticPart = (
    target: THREE.BufferGeometry[],
    template: THREE.BufferGeometry,
    matrix: THREE.Matrix4
  ): void => {
    const cloned = template.clone();
    cloned.applyMatrix4(matrix);
    target.push(cloned);
  };

  const lampPostGeo = buildVintageLampPostGeometry();
  const lampGlassGeo = trackGeo(buildVintageLampGlassGeometry());
  const haloPlaneA = new THREE.PlaneGeometry(2.2, 2.2);
  const haloPlaneB = new THREE.PlaneGeometry(2.2, 2.2).rotateY(Math.PI / 2);
  const haloPlaneC = new THREE.PlaneGeometry(2.0, 2.0).rotateX(Math.PI / 2);
  const haloCardGeo = trackGeo(safeMergeGeometries([haloPlaneA, haloPlaneB, haloPlaneC]));
  haloPlaneA.dispose();
  haloPlaneB.dispose();
  haloPlaneC.dispose();

  const lampPointLights: THREE.PointLight[] = [];
  const maxPointLights = 12;
  let haloInstMesh: THREE.InstancedMesh | null = null;

  if (placedLamps.length > 0) {
    const glassInst = new THREE.InstancedMesh(lampGlassGeo, lampGlassMat, placedLamps.length);
    glassInst.frustumCulled = false;

    const haloInst = new THREE.InstancedMesh(haloCardGeo, lanternHaloMat, placedLamps.length);
    haloInst.frustumCulled = false;
    haloInst.visible = false;
    haloInstMesh = haloInst;

    for (let i = 0; i < placedLamps.length; i++) {
      const lamp = placedLamps[i];
      tmpEuler.set(0, lamp.rotY, 0);
      tmpQuat.setFromEuler(tmpEuler);
      tmpPos.set(lamp.x, lamp.y, lamp.z);
      tmpScale.set(1, 1, 1);
      tmpTreeMat.compose(tmpPos, tmpQuat, tmpScale);

      pushStaticPart(staticCastIronParts, lampPostGeo, tmpTreeMat);
      glassInst.setMatrixAt(i, tmpTreeMat);

      tmpPos.set(lamp.x, lamp.y + 4.04, lamp.z);
      tmpTreeMat.compose(tmpPos, tmpQuat, tmpScale);
      haloInst.setMatrixAt(i, tmpTreeMat);

      if (lamp.isHero && lampPointLights.length < maxPointLights) {
        const pt = new THREE.PointLight('#ffbd69', 0, 25, 1.8);
        pt.position.set(lamp.x, lamp.y + 3.92, lamp.z);
        pt.castShadow = false;
        pt.visible = false;
        group.add(pt);
        lampPointLights.push(pt);
      }
    }

    // Ensure at least 10 hero warm lights even if spacing filtered some candidates
    for (let i = 0; i < placedLamps.length && lampPointLights.length < 10; i += 3) {
      const lamp = placedLamps[i];
      const alreadyHas = lampPointLights.some(
        (l) => Math.hypot(l.position.x - lamp.x, l.position.z - lamp.z) < 6
      );
      if (alreadyHas) continue;
      const pt = new THREE.PointLight('#ffbd69', 0, 25, 1.8);
      pt.position.set(lamp.x, lamp.y + 3.92, lamp.z);
      pt.castShadow = false;
      pt.visible = false;
      group.add(pt);
      lampPointLights.push(pt);
    }

    glassInst.instanceMatrix.needsUpdate = true;
    haloInst.instanceMatrix.needsUpdate = true;
    group.add(glassInst, haloInst);
  }
  lampPostGeo.dispose();

  // --------------------------------------------------------------------------
  // F. AUTHENTIC QINGDAO HERITAGE STREET SIGNS & LANDMARK PLAQUES
  // --------------------------------------------------------------------------

  const signSpecs: {
    zh: string;
    en: string;
    sub: string;
    x: number;
    z: number;
    rotY: number;
  }[] = [
    {
      zh: '居庸關路',
      en: 'Juyongguan Rd',
      sub: '銀杏大道 · Golden Ginkgo',
      x: -3.25,
      z: -25.8,
      rotY: -0.35 // Readable walking South from spawn
    },
    {
      zh: '嘉峪關路',
      en: 'Jiayuguan Rd',
      sub: '五角楓徑 · Crimson Maple',
      x: -13.6,
      z: -10.5,
      rotY: 0.42
    },
    {
      zh: '山海關路',
      en: 'Shanhaiguan Rd',
      sub: '法桐濱海路 · Sycamore Ave',
      x: -14.2,
      z: 24.3,
      rotY: 0.28
    },
    {
      zh: '公主樓',
      en: 'Princess House',
      sub: '居庸關路 10 號 · 1930s',
      x: 0.45,
      z: 1.55,
      rotY: -Math.PI * 0.42 // Beside Princess House courtyard gate
    },
    {
      zh: '花石樓',
      en: 'Huashi Villa',
      sub: '黃海路 18 號 · 1930–1932',
      x: 34.8,
      z: 29.8,
      rotY: -0.58 // Beside Huashi Cape Path welcoming visitors up to the sea castle
    },
    {
      zh: '第二海水浴場',
      en: 'Second Bathing Beach',
      sub: '濱海石堤 · Yellow Sea Cove',
      x: -11.4,
      z: 34.1,
      rotY: 0.08 // Overlooking Second Bathing Beach & Stone Jetty
    },
    {
      zh: '蝴蝶樓',
      en: 'Butterfly Villa',
      sub: '山海關路 21 號 · 1934',
      x: -28.1,
      z: 21.8,
      rotY: 0.12
    }
  ];

  const signPostGeo = buildRoadSignPostGeometry();
  const signTextures = signSpecs.map((spec) =>
    textures.createRoadSignTexture(spec.zh, spec.en, spec.sub)
  );
  const signMatrices = signSpecs.map((spec) => {
    const sy = getTerrainHeight(spec.x, spec.z);
    const mat = new THREE.Matrix4();
    tmpEuler.set(0, spec.rotY, 0);
    tmpQuat.setFromEuler(tmpEuler);
    tmpPos.set(spec.x, sy - 0.04, spec.z);
    tmpScale.set(1, 1, 1);
    mat.compose(tmpPos, tmpQuat, tmpScale);
    pushStaticPart(staticCastIronParts, signPostGeo, mat);
    return mat;
  });
  signPostGeo.dispose();

  // Pack all 7 crisp 512x256 enamel road signs into one 1024x1024 atlas (1 draw call for all plaques!)
  const atlasCols = 2;
  const atlasRows = Math.ceil(signSpecs.length / atlasCols);
  const slotW = 512;
  const slotH = 256;
  const atlasW = atlasCols * slotW;
  const atlasH = atlasRows * slotH;
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = atlasW;
  atlasCanvas.height = atlasH;
  const atlasCtx = atlasCanvas.getContext('2d');

  let batchedSignAtlasOk = false;
  if (atlasCtx) {
    atlasCtx.fillStyle = '#13304f';
    atlasCtx.fillRect(0, 0, atlasW, atlasH);
    batchedSignAtlasOk = true;
    const plaqueParts: THREE.BufferGeometry[] = [];
    const uvPadX = 1.5 / atlasW;
    const uvPadY = 1.5 / atlasH;

    for (let i = 0; i < signSpecs.length; i++) {
      const img = signTextures[i].image as CanvasImageSource | undefined;
      if (!img) {
        batchedSignAtlasOk = false;
        break;
      }
      const col = i % atlasCols;
      const row = Math.floor(i / atlasCols);
      atlasCtx.drawImage(img, col * slotW, row * slotH, slotW, slotH);

      const uMin = (col * slotW) / atlasW + uvPadX;
      const uMax = ((col + 1) * slotW) / atlasW - uvPadX;
      const vMax = 1 - (row * slotH) / atlasH - uvPadY;
      const vMin = 1 - ((row + 1) * slotH) / atlasH + uvPadY;

      const dualPlaque = buildRoadSignDualPlaqueGeometry({ uMin, uMax, vMin, vMax });
      dualPlaque.applyMatrix4(signMatrices[i]);
      plaqueParts.push(dualPlaque);
    }

    if (batchedSignAtlasOk && plaqueParts.length > 0) {
      const signAtlasTex = new THREE.CanvasTexture(atlasCanvas);
      signAtlasTex.colorSpace = THREE.SRGBColorSpace;
      signAtlasTex.anisotropy = Math.max(4, signTextures[0]?.anisotropy ?? 4);
      signAtlasTex.generateMipmaps = true;
      signAtlasTex.minFilter = THREE.LinearMipmapLinearFilter;
      signAtlasTex.magFilter = THREE.LinearFilter;
      signAtlasTex.needsUpdate = true;
      disposablesTex.push(signAtlasTex);

      const signAtlasMat = trackMat(
        new THREE.MeshStandardMaterial({
          map: signAtlasTex,
          roughness: 0.34,
          metalness: 0.14
        })
      );
      const mergedPlaquesGeo = trackGeo(safeMergeGeometries(plaqueParts));
      for (const p of plaqueParts) p.dispose();
      const mergedPlaquesMesh = new THREE.Mesh(mergedPlaquesGeo, signAtlasMat);
      mergedPlaquesMesh.receiveShadow = true;
      group.add(mergedPlaquesMesh);
    } else {
      for (const p of plaqueParts) p.dispose();
    }
  }

  if (!batchedSignAtlasOk) {
    // Graceful fallback: 1 dual-sided plaque mesh per sign
    const sharedPlaqueGeo = trackGeo(buildRoadSignDualPlaqueGeometry());
    for (let i = 0; i < signSpecs.length; i++) {
      const plaqueMat = trackMat(
        new THREE.MeshStandardMaterial({
          map: signTextures[i],
          roughness: 0.34,
          metalness: 0.14
        })
      );
      const mesh = new THREE.Mesh(sharedPlaqueGeo, plaqueMat);
      mesh.applyMatrix4(signMatrices[i]);
      group.add(mesh);
    }
  }

  // --------------------------------------------------------------------------
  // G. COASTAL WOODEN PARK BENCHES, VINTAGE POSTBOXES & GRANITE BOLLARDS
  // --------------------------------------------------------------------------

  const placedBenches: PlacedBench[] = [];
  const tryPlaceBench = (x: number, z: number, facingAngle: number): void => {
    if (!isWithinWorldPlayable(x, z, 3.0)) return;
    const cz = getCoastZone(x, z);
    if (cz === 'sea' || cz === 'beach') return;
    if (getRoadInfo(x, z).edgeDistance < 0.22) return;
    if (isInsideAnyVillaBuilding(x, z, 1.5)) return;
    if (isNearAnyVillaWall(x, z, 0.55)) return;
    if (isInAnyVillaGateCorridor(x, z, 0.6)) return;
    if (isTooCloseToExistingTree(x, z, 1.6)) return;

    const y = getTerrainHeight(x, z);
    if (y < 2.2) return;

    // Sample terrain along bench length to sit both legs cleanly on gently sloping streets
    const dirX = Math.cos(facingAngle);
    const dirZ = -Math.sin(facingAngle);
    const yL = getTerrainHeight(x - dirX * 0.75, z - dirZ * 0.75);
    const yR = getTerrainHeight(x + dirX * 0.75, z + dirZ * 0.75);
    const rollZ = clamp(Math.atan2(yR - yL, 1.5), -0.14, 0.14);

    placedBenches.push({ x, y: y - 0.04, z, rotY: facingAngle, pitchX: 0, rollZ });
  };

  // Seaside promenade benches gazing South out over Second Bathing Beach & Stone Jetty
  const boardwalkBenches: [number, number, number][] = [
    [-52.0, 35.1, 0.04],
    [-40.0, 34.8, 0.02],
    [-25.5, 34.4, 0.0],
    [-6.5, 34.5, -0.03],
    [6.5, 34.8, -0.05],
    [15.2, 35.2, -0.08]
  ];
  for (const [bx, bz, rot] of boardwalkBenches) {
    tryPlaceBench(bx, bz, rot);
  }

  // Avenue & scenic vista benches along Juyongguan, Jiayuguan, Shanhaiguan, & Huashi Cape
  const avenueBenchSpecs: { road: RoadCurveSpec; ts: number[]; side: -1 | 1; offset: number }[] = [
    { road: juyongguanRoad, ts: [0.32, 0.52, 0.78], side: -1, offset: 4.95 },
    { road: juyongguanRoad, ts: [0.42, 0.84], side: 1, offset: 4.95 },
    { road: jiayuguanRoad, ts: [0.26, 0.66, 0.82], side: -1, offset: 4.65 },
    { road: jiayuguanRoad, ts: [0.36, 0.74], side: 1, offset: 4.65 },
    { road: shanhaiguanRoad, ts: [0.22, 0.54, 0.78], side: -1, offset: 5.15 },
    { road: huashiCapePath, ts: [0.48], side: 1, offset: 3.0 }
  ];
  for (const spec of avenueBenchSpecs) {
    for (const t of spec.ts) {
      const sample = sampleRoadPoint(spec.road, t);
      const bx = sample.x + sample.normalX * spec.side * spec.offset;
      const bz = sample.z + sample.normalZ * spec.side * spec.offset;
      // Face inward toward the road/scenery
      const faceX = -sample.normalX * spec.side;
      const faceZ = -sample.normalZ * spec.side;
      tryPlaceBench(bx, bz, Math.atan2(faceX, faceZ));
    }
  }

  if (placedBenches.length > 0) {
    const benchGeos = buildParkBenchGeometries();
    trackGeo(benchGeos.wood);

    const benchWoodMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: '#d8c3a5',
        map: textures.woodPlank.map,
        bumpMap: textures.woodPlank.bumpMap,
        bumpScale: 0.04,
        roughness: 0.78,
        metalness: 0.0
      })
    );

    const woodInst = new THREE.InstancedMesh(benchGeos.wood, benchWoodMat, placedBenches.length);
    woodInst.castShadow = true;
    woodInst.receiveShadow = true;
    woodInst.frustumCulled = false;

    for (let i = 0; i < placedBenches.length; i++) {
      const b = placedBenches[i];
      tmpEuler.set(b.pitchX, b.rotY, b.rollZ, 'YXZ');
      tmpQuat.setFromEuler(tmpEuler);
      tmpPos.set(b.x, b.y, b.z);
      tmpScale.set(1, 1, 1);
      tmpTreeMat.compose(tmpPos, tmpQuat, tmpScale);
      woodInst.setMatrixAt(i, tmpTreeMat);
      pushStaticPart(staticCastIronParts, benchGeos.iron, tmpTreeMat);
    }
    benchGeos.iron.dispose();
    woodInst.instanceMatrix.needsUpdate = true;
    group.add(woodInst);
  }

  // 2 Vintage Qingdao Cast-Iron Postboxes (百年青島郵筒) — bodies merged into cast-iron batch, trims merged into 1 brass mesh
  const postboxCoords: [number, number, number][] = [
    [-2.8, -10.8, -Math.PI * 0.45], // Juyongguan x Jiayuguan heritage corner
    [-22.5, 24.3, 0.12] // Shanhaiguan Rd seaside promenade
  ];
  const postboxGeos = buildVintagePostboxGeometries();
  const postboxTrimParts: THREE.BufferGeometry[] = [];
  for (const [px, pz, rotY] of postboxCoords) {
    tmpEuler.set(0, rotY, 0);
    tmpQuat.setFromEuler(tmpEuler);
    tmpPos.set(px, getTerrainHeight(px, pz) - 0.05, pz);
    tmpScale.set(1, 1, 1);
    tmpTreeMat.compose(tmpPos, tmpQuat, tmpScale);
    pushStaticPart(staticCastIronParts, postboxGeos.body, tmpTreeMat);
    pushStaticPart(postboxTrimParts, postboxGeos.trim, tmpTreeMat);
  }
  postboxGeos.body.dispose();
  postboxGeos.trim.dispose();

  if (postboxTrimParts.length > 0) {
    const postboxBrassMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: '#c99b44',
        roughness: 0.36,
        metalness: 0.65
      })
    );
    const mergedTrimGeo = trackGeo(safeMergeGeometries(postboxTrimParts));
    for (const p of postboxTrimParts) p.dispose();
    const trimMesh = new THREE.Mesh(mergedTrimGeo, postboxBrassMat);
    group.add(trimMesh);
  }

  // Single merged draw call for ALL static cast-iron street furniture (lamp posts + sign frames + bench frames + postboxes)
  if (staticCastIronParts.length > 0) {
    const mergedCastIronGeo = trackGeo(safeMergeGeometries(staticCastIronParts));
    for (const p of staticCastIronParts) p.dispose();
    const castIronPropsMesh = new THREE.Mesh(mergedCastIronGeo, castIronGreenMat);
    castIronPropsMesh.castShadow = true;
    castIronPropsMesh.receiveShadow = true;
    group.add(castIronPropsMesh);
  }

  // Granite Heritage Stone Mile-Markers & Bollards (青島花崗岩石墩與界碑)
  const bollardCoords: [number, number][] = [];
  // Line coastal promenade overlook verge between Shanhaiguan Rd & Boardwalk
  for (let x = -56; x <= 14; x += 10) {
    const z = getSeawallZ(x) - 2.65;
    if (getRoadInfo(x, z).edgeDistance > 0.14) {
      bollardCoords.push([x, z]);
    }
  }
  for (let i = 0; i < 6; i++) {
    const t = 0.08 + (i / 5) * 0.84;
    const sample = sampleRoadPoint(huashiCapePath, t);
    for (const side of [-1, 1] as const) {
      const bx = sample.x + sample.normalX * side * 2.75;
      const bz = sample.z + sample.normalZ * side * 2.75;
      if (getRoadInfo(bx, bz).edgeDistance > 0.18 && !isInAnyVillaGateCorridor(bx, bz, 0.4)) {
        bollardCoords.push([bx, bz]);
      }
    }
  }
  // Stone corner mile markers at key crossroads
  const cornerMarkers: [number, number][] = [
    [-12.9, -20.4],
    [-3.1, -20.6],
    [-3.1, 24.4],
    [-12.8, 24.6],
    [-3.1, -55.0],
    [-12.8, -55.0]
  ];
  for (const [mx, mz] of cornerMarkers) {
    if (getRoadInfo(mx, mz).edgeDistance > 0.2) bollardCoords.push([mx, mz]);
  }

  if (bollardCoords.length > 0) {
    const bollardGeo = trackGeo(buildGraniteBollardGeometry());
    const bollardMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: '#dcd6cc',
        map: textures.graniteCobble.map,
        bumpMap: textures.graniteCobble.bumpMap,
        bumpScale: 0.04,
        roughness: 0.82,
        metalness: 0.04
      })
    );
    const bollardInst = new THREE.InstancedMesh(bollardGeo, bollardMat, bollardCoords.length);
    bollardInst.castShadow = true;
    bollardInst.receiveShadow = true;
    bollardInst.frustumCulled = false;

    for (let i = 0; i < bollardCoords.length; i++) {
      const [bx, bz] = bollardCoords[i];
      tmpPos.set(bx, getTerrainHeight(bx, bz) - 0.05, bz);
      tmpQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (i * 0.7) % (Math.PI * 2));
      tmpScale.set(1, 1, 1);
      tmpTreeMat.compose(tmpPos, tmpQuat, tmpScale);
      bollardInst.setMatrixAt(i, tmpTreeMat);
    }
    bollardInst.instanceMatrix.needsUpdate = true;
    group.add(bollardInst);
  }

  // --------------------------------------------------------------------------
  // H. ANIMATED DRIFTING AUTUMN LEAVES (440 FLUTTERING GOLD & CRIMSON LEAVES)
  // --------------------------------------------------------------------------

  const DRIFTING_LEAF_COUNT = 440;
  const driftLeafGeo = trackGeo(createCurledLeafGeometry(0.22));
  const driftLeafMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: textures.foliageClusterTextures.fallenLeaf,
      alphaTest: 0.32,
      side: THREE.DoubleSide,
      roughness: 0.7,
      metalness: 0.0
    })
  );

  const driftingInst = new THREE.InstancedMesh(driftLeafGeo, driftLeafMat, DRIFTING_LEAF_COUNT);
  driftingInst.frustumCulled = false;
  const driftingLeaves: DriftingLeafState[] = [];

  for (let i = 0; i < DRIFTING_LEAF_COUNT; i++) {
    const isGinkgoZone = i < 270;
    let bx: number;
    let bz: number;
    if (isGinkgoZone) {
      const s = sampleRoadPoint(juyongguanRoad, seededRange(rng, 0.05, 0.96));
      bx = s.x + seededRange(rng, -11.5, 11.5);
      bz = s.z + seededRange(rng, -5.5, 5.5);
    } else {
      const s = sampleRoadPoint(jiayuguanRoad, seededRange(rng, 0.08, 0.92));
      bx = s.x + seededRange(rng, -6.0, 6.0);
      bz = s.z + seededRange(rng, -11.0, 11.0);
    }

    const gy = Math.max(2.0, getTerrainHeight(bx, bz));
    const maxY = gy + seededRange(rng, 8.2, 13.4);
    const startY = seededRange(rng, gy + 0.5, maxY);

    driftingLeaves.push({
      x: bx,
      y: startY,
      z: bz,
      baseX: bx,
      baseZ: bz,
      groundY: gy,
      minY: gy + 0.12,
      maxY,
      fallSpeed: seededRange(rng, 0.42, 0.88),
      swayFreq: seededRange(rng, 1.1, 2.3),
      swayAmp: seededRange(rng, 0.65, 1.65),
      phase: rng() * Math.PI * 2,
      rotX: rng() * Math.PI * 2,
      rotY: rng() * Math.PI * 2,
      rotZ: rng() * Math.PI * 2,
      spinX: seededRange(rng, -2.1, 2.1),
      spinY: seededRange(rng, -1.7, 1.7),
      spinZ: seededRange(rng, -2.4, 2.4),
      scale: seededRange(rng, 0.85, 1.48)
    });

    const pal = isGinkgoZone ? ginkgoFallColors : mapleFallColors;
    const col = pal[Math.floor(rng() * pal.length)];
    driftingInst.setColorAt(i, col);
  }
  if (driftingInst.instanceColor) driftingInst.instanceColor.needsUpdate = true;
  group.add(driftingInst);

  // --------------------------------------------------------------------------
  // I. ANIMATED COASTAL WHITE SEAGULLS (14 SCULPTED ARTICULATED GULLS)
  // --------------------------------------------------------------------------

  const gullGeos = buildSeagullGeometries();
  trackGeo(gullGeos.body);
  trackGeo(gullGeos.leftWing);
  trackGeo(gullGeos.rightWing);

  const gullBodyMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: '#f7f7f5',
      roughness: 0.68,
      metalness: 0.0
    })
  );
  const gullWingMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.65,
      metalness: 0.0
    })
  );

  const SEAGULL_COUNT = 14;
  const gullBodyInst = new THREE.InstancedMesh(gullGeos.body, gullBodyMat, SEAGULL_COUNT);
  const gullLeftWingInst = new THREE.InstancedMesh(gullGeos.leftWing, gullWingMat, SEAGULL_COUNT);
  const gullRightWingInst = new THREE.InstancedMesh(gullGeos.rightWing, gullWingMat, SEAGULL_COUNT);
  gullBodyInst.frustumCulled = false;
  gullLeftWingInst.frustumCulled = false;
  gullRightWingInst.frustumCulled = false;

  const seagulls: SeagullState[] = [];
  for (let i = 0; i < SEAGULL_COUNT; i++) {
    // 3 iconic Qingdao coastal flight zones
    let cx: number;
    let cz: number;
    let baseY: number;
    let rx: number;
    let rz: number;
    if (i < 5) {
      // Second Bathing Beach & Stone Jetty cove thermals
      cx = JETTY.endX + seededRange(rng, -4, 14);
      cz = 64 + seededRange(rng, -10, 12);
      baseY = seededRange(rng, 11.5, 20.5);
      rx = seededRange(rng, 17, 29);
      rz = seededRange(rng, 14, 24);
    } else if (i < 10) {
      // Circling gracefully over Huashi Villa Gothic spire & rocky sea bluff
      cx = 48 + seededRange(rng, -6, 8);
      cz = 46 + seededRange(rng, -6, 10);
      baseY = seededRange(rng, 17.5, 27.0);
      rx = seededRange(rng, 16, 26);
      rz = seededRange(rng, 14, 24);
    } else {
      // High sweeping bay glides over Shanhaiguan coastal promenade
      cx = 8 + seededRange(rng, -14, 14);
      cz = 36 + seededRange(rng, -6, 14);
      baseY = seededRange(rng, 20.0, 30.5);
      rx = seededRange(rng, 24, 38);
      rz = seededRange(rng, 16, 26);
    }

    seagulls.push({
      centerX: cx,
      centerZ: cz,
      baseY,
      radiusX: rx,
      radiusZ: rz,
      figureEight: i % 3 === 0,
      angularSpeed: seededRange(rng, 0.16, 0.27),
      phase: rng() * Math.PI * 2,
      bobAmp: seededRange(rng, 0.8, 1.9),
      bobFreq: seededRange(rng, 0.4, 0.75),
      flapRate: seededRange(rng, 5.4, 7.2),
      glideOffset: rng() * Math.PI * 2,
      scale: seededRange(rng, 0.92, 1.24),
      dirSign: i % 2 === 0 ? 1 : -1
    });
  }

  group.add(gullBodyInst, gullLeftWingInst, gullRightWingInst);

  // Reusable animation scratch objects (zero per-frame allocations!)
  const animMat = new THREE.Matrix4();
  const animWingLocal = new THREE.Matrix4();
  const animWingWorld = new THREE.Matrix4();
  const animPos = new THREE.Vector3();
  const animQuat = new THREE.Quaternion();
  const animEuler = new THREE.Euler();
  const animScale = new THREE.Vector3();

  // --------------------------------------------------------------------------
  // J. ATMOSPHERE SYNCHRONIZATION & PER-FRAME LIVING UPDATE
  // --------------------------------------------------------------------------

  let lastNightFactor = -1;

  const syncLightingState = (
    nightFactor: number,
    windStrength: number,
    sunDirX: number,
    sunDirY: number,
    sunDirZ: number,
    sunColorHex?: string
  ) => {
    foliageUniforms.uWindStrength.value = windStrength;
    foliageUniforms.uSunDir.value.set(sunDirX, sunDirY, sunDirZ).normalize();
    if (sunColorHex) {
      foliageUniforms.uSunColor.value.set(sunColorHex);
    }
    // Strongest warm sunlit autumn translucency in day/sunset, softly dimmed in blue-hour
    foliageUniforms.uTranslucency.value = 1.0 - nightFactor * 0.72;

    if (Math.abs(nightFactor - lastNightFactor) > 0.002) {
      lastNightFactor = nightFactor;
      const glowCurve = Math.pow(clamp(nightFactor, 0, 1), 0.78);
      lampGlassMat.emissiveIntensity = 0.08 + glowCurve * 2.85;
      const haloOpacity = clamp((nightFactor - 0.08) * 0.78, 0, 0.72);
      lanternHaloMat.opacity = haloOpacity;
      if (haloInstMesh) {
        haloInstMesh.visible = haloOpacity > 0.01;
      }

      const lightIntensity = glowCurve * 15.5;
      const lightsActive = lightIntensity > 0.08;
      for (let i = 0; i < lampPointLights.length; i++) {
        const pt = lampPointLights[i];
        pt.intensity = lightIntensity;
        pt.visible = lightsActive;
      }
    }
  };

  const applyAtmosphere = (cfg: AtmosphereConfig): void => {
    syncLightingState(
      cfg.nightFactor,
      cfg.windStrength,
      cfg.sunDirection[0],
      cfg.sunDirection[1],
      cfg.sunDirection[2],
      cfg.sunColor
    );
  };

  // Initialize default mood (Golden Autumn Afternoon)
  applyAtmosphere(defaultAtm);

  const updateSeagulls = (time: number): void => {
    for (let i = 0; i < SEAGULL_COUNT; i++) {
      const g = seagulls[i];
      const theta = time * g.angularSpeed * g.dirSign + g.phase;

      let x: number;
      let z: number;
      let vx: number;
      let vz: number;
      let bankAngle: number;

      if (g.figureEight) {
        // Lazy figure-eight coastal thermal
        x = g.centerX + Math.sin(theta) * g.radiusX;
        z = g.centerZ + Math.sin(theta * 2) * g.radiusZ * 0.55;
        vx = Math.cos(theta) * g.radiusX * g.angularSpeed * g.dirSign;
        vz = Math.cos(theta * 2) * g.radiusZ * 1.1 * g.angularSpeed * g.dirSign;
        bankAngle = clamp(-Math.sin(theta * 2) * 0.34 * g.dirSign, -0.38, 0.38);
      } else {
        // Wide graceful circular thermal
        x = g.centerX + Math.cos(theta) * g.radiusX;
        z = g.centerZ + Math.sin(theta) * g.radiusZ;
        vx = -Math.sin(theta) * g.radiusX * g.angularSpeed * g.dirSign;
        vz = Math.cos(theta) * g.radiusZ * g.angularSpeed * g.dirSign;
        bankAngle = 0.24 * g.dirSign;
      }

      const y = g.baseY + Math.sin(time * g.bobFreq + g.phase) * g.bobAmp;
      const vy = Math.cos(time * g.bobFreq + g.phase) * g.bobAmp * g.bobFreq;
      const horizSpeed = Math.hypot(vx, vz) || 1;
      const yaw = Math.atan2(vx, vz);
      const pitch = clamp(-Math.atan2(vy, horizSpeed) * 0.55, -0.22, 0.22);

      animPos.set(x, y, z);
      animEuler.set(pitch, yaw, bankAngle, 'YXZ');
      animQuat.setFromEuler(animEuler);
      animScale.set(g.scale, g.scale, g.scale);
      animMat.compose(animPos, animQuat, animScale);
      gullBodyInst.setMatrixAt(i, animMat);

      // Smooth natural cycle alternating rhythmic wingbeats with serene soaring glides
      const glideCycle = Math.sin(time * 0.55 + g.glideOffset);
      const flapAmp = glideCycle > -0.15 ? clamp((glideCycle + 0.15) * 0.52, 0.04, 0.52) : 0.04;
      const flapAngle = Math.sin(time * g.flapRate + g.phase) * flapAmp + 0.08;

      // Left wing (pivots around shoulder Z axis)
      animPos.set(0, 0, 0);
      animScale.set(1, 1, 1);
      animEuler.set(0, 0, -flapAngle);
      animQuat.setFromEuler(animEuler);
      animWingLocal.compose(animPos, animQuat, animScale);
      animWingWorld.multiplyMatrices(animMat, animWingLocal);
      gullLeftWingInst.setMatrixAt(i, animWingWorld);

      // Right wing (mirrored flap)
      animEuler.set(0, 0, flapAngle);
      animQuat.setFromEuler(animEuler);
      animWingLocal.compose(animPos, animQuat, animScale);
      animWingWorld.multiplyMatrices(animMat, animWingLocal);
      gullRightWingInst.setMatrixAt(i, animWingWorld);
    }

    gullBodyInst.instanceMatrix.needsUpdate = true;
    gullLeftWingInst.instanceMatrix.needsUpdate = true;
    gullRightWingInst.instanceMatrix.needsUpdate = true;
  };

  const updateDriftingLeaves = (time: number, dt: number, windStrength: number): void => {
    const safeDt = Math.min(dt, 0.08);
    // Gentle Qingdao coastal sea breeze blowing inland-northeast
    const windX = 0.42 * windStrength;
    const windZ = -0.58 * windStrength;

    for (let i = 0; i < DRIFTING_LEAF_COUNT; i++) {
      const leaf = driftingLeaves[i];
      const sway = Math.sin(time * leaf.swayFreq + leaf.phase);
      const cross = Math.cos(time * leaf.swayFreq * 0.78 + leaf.phase * 1.3);

      // Gliding descent slows slightly during horizontal leaf-swoop peaks
      const glideMod = 1.0 - Math.abs(sway) * 0.34;
      leaf.y -= leaf.fallSpeed * glideMod * safeDt;
      leaf.x += (windX + sway * leaf.swayAmp * 0.55) * safeDt;
      leaf.z += (windZ + cross * leaf.swayAmp * 0.45) * safeDt;

      leaf.rotX += leaf.spinX * safeDt;
      leaf.rotY += leaf.spinY * safeDt;
      leaf.rotZ += leaf.spinZ * safeDt;

      if (
        leaf.y < leaf.minY ||
        Math.abs(leaf.x - leaf.baseX) > 18 ||
        Math.abs(leaf.z - leaf.baseZ) > 18
      ) {
        leaf.x = leaf.baseX + Math.sin(time + leaf.phase) * 3.5;
        leaf.z = leaf.baseZ + Math.cos(time * 0.7 + leaf.phase) * 3.5;
        leaf.y = leaf.maxY;
      }

      animPos.set(leaf.x, leaf.y, leaf.z);
      animEuler.set(leaf.rotX, leaf.rotY, leaf.rotZ);
      animQuat.setFromEuler(animEuler);
      animScale.set(leaf.scale, leaf.scale, leaf.scale);
      animMat.compose(animPos, animQuat, animScale);
      driftingInst.setMatrixAt(i, animMat);
    }

    driftingInst.instanceMatrix.needsUpdate = true;
  };

  // Seed initial animated matrices before frame 0
  updateSeagulls(0);
  updateDriftingLeaves(0, 0.016, defaultAtm.windStrength);

  const update = (ctx: WorldUpdateContext): void => {
    foliageUniforms.uTime.value = ctx.time;
    syncLightingState(
      ctx.nightFactor,
      ctx.windStrength,
      ctx.sunDirection.x,
      ctx.sunDirection.y,
      ctx.sunDirection.z,
      ctx.atmosphere?.sunColor
    );

    updateDriftingLeaves(ctx.time, ctx.dt, ctx.windStrength);
    updateSeagulls(ctx.time);
  };

  const dispose = (): void => {
    for (const g of disposablesGeo) g.dispose();
    for (const m of disposablesMat) m.dispose();
    for (const t of disposablesTex) t.dispose();
  };

  return {
    group,
    update,
    applyAtmosphere,
    dispose
  };
}
