import type {
  AtmosphereConfig,
  CoastZone,
  ColliderBox,
  ColliderCircle,
  JettySpec,
  LandmarkDef,
  RoadCurveSpec,
  RoadId,
  RoadInfo,
  RoadSample,
  RoadSegment,
  TimeOfDayId,
  ViewpointDef,
  VillaPlacement,
  VillaWallSegment,
  WorldBounds,
  WorldCollisionData
} from './types';

// ============================================================================
// 1. DETERMINISTIC SEEDED PRNG & MATH UTILITIES
// ============================================================================

/** Mulberry32 deterministic PRNG yielding values uniformly in [0, 1). */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

// ============================================================================
// 2. WORLD BOUNDS, SEA LEVEL, & STONE BREAKWATER (JETTY)
// ============================================================================

export const SEA_LEVEL = 0.0;

export const WORLD_BOUNDS: WorldBounds = {
  minX: -98,
  maxX: 98,
  minZ: -94,
  maxZ: 102
};

/** Iconic Stone Breakwater / Jetty (海濱石堤) of Second Bathing Beach. */
export const JETTY: JettySpec = (() => {
  const startX = -16;
  const startZ = 42;
  const endX = -22;
  const endZ = 92;
  return {
    startX,
    startZ,
    endX,
    endZ,
    width: 4.4,
    deckY: 1.32,
    pierHeadRadius: 3.4,
    length: Math.hypot(endX - startX, endZ - startZ)
  };
})();

/**
 * Returns the walkable surface elevation of the Stone Jetty if (x, z) lies on it,
 * or null if off the jetty.
 */
export function getJettyHeight(x: number, z: number): number | null {
  const dx = JETTY.endX - JETTY.startX;
  const dz = JETTY.endZ - JETTY.startZ;
  const lenSq = dx * dx + dz * dz;
  const len = Math.sqrt(lenSq);

  const rx = x - JETTY.startX;
  const rz = z - JETTY.startZ;
  const t = (rx * dx + rz * dz) / lenSq;
  const perp = Math.abs(rx * (-dz / len) + rz * (dx / len));

  // Main granite causeway
  if (t >= -0.03 && t <= 1.0 && perp <= JETTY.width * 0.5) {
    return JETTY.deckY;
  }

  // Circular stone pier head at seaward tip
  const tipDist = Math.hypot(x - JETTY.endX, z - JETTY.endZ);
  if (tipDist <= JETTY.pierHeadRadius) {
    return JETTY.deckY;
  }

  return null;
}

// ============================================================================
// 3. ICONIC BADAGUAN ROADS ("一關一樹")
// ============================================================================

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function buildRoadSpec(spec: {
  id: RoadId;
  nameZh: string;
  nameEn: string;
  treeSpecies: RoadCurveSpec['treeSpecies'];
  treeLabelZh: string;
  width: number;
  shoulderWidth: number;
  surface: RoadCurveSpec['surface'];
  controlPoints: [number, number][];
  subdivisionsPerSpan?: number;
}): RoadCurveSpec {
  const pts = spec.controlPoints;
  const subs = spec.subdivisionsPerSpan ?? 14;
  const sampled: [number, number][] = [];

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const steps = i === pts.length - 2 ? subs : subs;
    for (let s = 0; s < steps; s++) {
      const u = s / subs;
      sampled.push([
        catmullRom(p0[0], p1[0], p2[0], p3[0], u),
        catmullRom(p0[1], p1[1], p2[1], p3[1], u)
      ]);
    }
  }
  sampled.push(pts[pts.length - 1]);

  let totalLength = 0;
  const lengths: number[] = [];
  for (let i = 0; i < sampled.length - 1; i++) {
    const len = Math.hypot(
      sampled[i + 1][0] - sampled[i][0],
      sampled[i + 1][1] - sampled[i][1]
    );
    lengths.push(len);
    totalLength += len;
  }

  const segments: RoadSegment[] = [];
  let accum = 0;
  for (let i = 0; i < sampled.length - 1; i++) {
    const x0 = sampled[i][0];
    const z0 = sampled[i][1];
    const x1 = sampled[i + 1][0];
    const z1 = sampled[i + 1][1];
    const len = lengths[i] || 1e-6;
    const t0 = accum / totalLength;
    accum += len;
    const t1 = accum / totalLength;
    segments.push({
      x0,
      z0,
      x1,
      z1,
      t0,
      t1,
      length: len,
      tangentX: (x1 - x0) / len,
      tangentZ: (z1 - z0) / len
    });
  }

  return {
    id: spec.id,
    nameZh: spec.nameZh,
    nameEn: spec.nameEn,
    treeSpecies: spec.treeSpecies,
    treeLabelZh: spec.treeLabelZh,
    width: spec.width,
    shoulderWidth: spec.shoulderWidth,
    surface: spec.surface,
    controlPoints: spec.controlPoints,
    segments,
    totalLength
  };
}

/** All 5 iconic roads & coastal promenades of Qingdao Badaguan. */
export const ROADS: RoadCurveSpec[] = [
  buildRoadSpec({
    id: 'juyongguan',
    nameZh: '居庸關路',
    nameEn: 'Juyongguan Rd',
    treeSpecies: 'ginkgo',
    treeLabelZh: '銀杏大道',
    width: 8.0,
    shoulderWidth: 2.2,
    surface: 'asphalt',
    controlPoints: [
      [-10.2, -86],
      [-9.0, -58],
      [-8.0, -34],
      [-8.0, -15.5],
      [-8.2, 6],
      [-8.0, 29.2]
    ]
  }),
  buildRoadSpec({
    id: 'jiayuguan',
    nameZh: '嘉峪關路',
    nameEn: 'Jiayuguan Rd',
    treeSpecies: 'maple',
    treeLabelZh: '五角楓林',
    width: 7.5,
    shoulderWidth: 2.0,
    surface: 'asphalt',
    controlPoints: [
      [-84, -13.2],
      [-58, -15.2],
      [-32, -16.0],
      [-8.0, -15.5],
      [14, -18.4],
      [38, -21.8],
      [62, -24.6],
      [86, -26.2]
    ]
  }),
  buildRoadSpec({
    id: 'shanhaiguan',
    nameZh: '山海關路',
    nameEn: 'Shanhaiguan Rd',
    treeSpecies: 'sycamore',
    treeLabelZh: '法桐濱海路',
    width: 8.5,
    shoulderWidth: 2.4,
    surface: 'asphalt',
    controlPoints: [
      [-92, 33.2],
      [-62, 31.6],
      [-34, 30.0],
      [-8.0, 29.2],
      [16, 28.4],
      [34, 24.4],
      [56, 17.8],
      [84, 14.5]
    ]
  }),
  buildRoadSpec({
    id: 'huashi_cape',
    nameZh: '黃海路 · 海岬小徑',
    nameEn: 'Huashi Cape Path',
    treeSpecies: 'cedar',
    treeLabelZh: '雪松海岬徑',
    width: 4.6,
    shoulderWidth: 1.4,
    surface: 'granite',
    controlPoints: [
      [21.5, 27.6],
      [27.5, 29.8],
      [33.0, 32.4],
      [38.4, 35.1]
    ]
  }),
  buildRoadSpec({
    id: 'beach_boardwalk',
    nameZh: '濱海木棧道',
    nameEn: 'Coastal Boardwalk',
    treeSpecies: 'sycamore',
    treeLabelZh: '第二浴場棧道',
    width: 3.2,
    shoulderWidth: 0.9,
    surface: 'wood',
    controlPoints: [
      [-62, 37.4],
      [-38, 36.8],
      [-16, 36.2],
      [4, 36.6],
      [18, 37.8]
    ]
  })
];

export function getRoadById(id: RoadId): RoadCurveSpec {
  const found = ROADS.find((r) => r.id === id);
  if (!found) {
    throw new Error(`Unknown road id: ${id}`);
  }
  return found;
}

/** Sample position, unit tangent, and right-hand normal at normalized parameter t in [0, 1]. */
export function sampleRoadPoint(road: RoadCurveSpec, t: number): RoadSample {
  const clampedT = clamp(t, 0, 1);
  const segs = road.segments;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (clampedT <= s.t1 || i === segs.length - 1) {
      const span = s.t1 - s.t0 || 1e-6;
      const local = clamp((clampedT - s.t0) / span, 0, 1);
      return {
        x: s.x0 + (s.x1 - s.x0) * local,
        z: s.z0 + (s.z1 - s.z0) * local,
        tangentX: s.tangentX,
        tangentZ: s.tangentZ,
        normalX: -s.tangentZ,
        normalZ: s.tangentX
      };
    }
  }
  const last = segs[segs.length - 1];
  return {
    x: last.x1,
    z: last.z1,
    tangentX: last.tangentX,
    tangentZ: last.tangentZ,
    normalX: -last.tangentZ,
    normalZ: last.tangentX
  };
}

interface SingleRoadQuery {
  distance: number;
  edgeDistance: number;
  t: number;
  tangentX: number;
  tangentZ: number;
  closestX: number;
  closestZ: number;
}

function querySingleRoad(road: RoadCurveSpec, x: number, z: number): SingleRoadQuery {
  let bestDistSq = Infinity;
  let bestT = 0;
  let bestTx = 0;
  let bestTz = 1;
  let bestCx = 0;
  let bestCz = 0;

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
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestT = s.t0 + (s.t1 - s.t0) * proj;
      bestTx = s.tangentX;
      bestTz = s.tangentZ;
      bestCx = cx;
      bestCz = cz;
    }
  }

  const dist = Math.sqrt(bestDistSq);
  return {
    distance: dist,
    edgeDistance: dist - road.width * 0.5,
    t: bestT,
    tangentX: bestTx,
    tangentZ: bestTz,
    closestX: bestCx,
    closestZ: bestCz
  };
}

/**
 * Query any world (x, z) point against all Badaguan roads.
 * Prioritizes the road with the smallest signed distance from its paved edge.
 */
export function getRoadInfo(x: number, z: number): RoadInfo {
  let bestRoad: RoadCurveSpec | null = null;
  let bestQuery: SingleRoadQuery | null = null;

  for (let i = 0; i < ROADS.length; i++) {
    const road = ROADS[i];
    const q = querySingleRoad(road, x, z);
    if (!bestQuery || q.edgeDistance < bestQuery.edgeDistance) {
      bestRoad = road;
      bestQuery = q;
    }
  }

  if (!bestRoad || !bestQuery) {
    return {
      onRoad: false,
      onShoulder: false,
      distance: Infinity,
      edgeDistance: Infinity,
      roadId: null,
      roadNameZh: null,
      t: 0,
      tangent: [0, 1],
      closestPoint: [x, z]
    };
  }

  const onRoad = bestQuery.edgeDistance <= 0;
  const onShoulder = !onRoad && bestQuery.edgeDistance <= bestRoad.shoulderWidth;

  return {
    onRoad,
    onShoulder,
    distance: bestQuery.distance,
    edgeDistance: bestQuery.edgeDistance,
    roadId: bestRoad.id,
    roadNameZh: bestRoad.nameZh,
    t: bestQuery.t,
    tangent: [bestQuery.tangentX, bestQuery.tangentZ],
    closestPoint: [bestQuery.closestX, bestQuery.closestZ]
  };
}

// ============================================================================
// 4. HERO LANDMARKS & EUROPEAN VILLAS ("萬國建築博覽館")
// ============================================================================

/**
 * Authoritative villa placements.
 * Convention: rotationY = 0 means the villa's front facade faces +Z (South).
 * Local gateSide 'front' is +Z, 'back' is -Z, 'left' is -X, 'right' is +X.
 */
export const VILLAS: VillaPlacement[] = [
  {
    id: 'huashi',
    nameZh: '花石樓',
    style: 'huashi',
    position: [48, 6.4, 44],
    rotationY: -0.75, // Front overlooks SW toward Second Bathing Beach & bay
    footprintWidth: 15.5,
    footprintDepth: 12.5,
    courtyardWidth: 26.0,
    courtyardDepth: 21.0,
    baseElevation: 6.4,
    gateSide: 'left', // Local -X maps to world (38.5, 35.1) — exact end of Huashi Cape Path!
    gateWidth: 4.6,
    padMargin: 4.8
  },
  {
    id: 'princess',
    nameZh: '公主樓',
    style: 'princess',
    position: [12, 5.5, -2],
    rotationY: -Math.PI / 2, // Front faces West (-X) toward Juyongguan Rd
    footprintWidth: 13.5,
    footprintDepth: 10.8,
    courtyardWidth: 18.0, // World Z span [-11, +7]
    courtyardDepth: 21.0, // World X span [+1.5, +22.5]
    baseElevation: 5.5,
    gateSide: 'front', // Opens West onto Juyongguan Rd at (1.5, -2)
    gateWidth: 4.4,
    padMargin: 3.4
  },
  {
    id: 'butterfly',
    nameZh: '蝴蝶樓',
    style: 'butterfly',
    position: [-32, 4.7, 11],
    rotationY: 0, // Front faces South (+Z) toward Shanhaiguan Rd & Yellow Sea
    footprintWidth: 15.0,
    footprintDepth: 11.0,
    courtyardWidth: 24.0,
    courtyardDepth: 19.0,
    baseElevation: 4.7,
    gateSide: 'front', // Opens South onto Shanhaiguan Rd at (-32, 20.5)
    gateWidth: 4.4,
    padMargin: 4.0
  },
  {
    id: 'villa_west_ginkgo',
    nameZh: '德式紅瓦洋房·居庸關西',
    style: 'german_ginkgo',
    position: [-32, 7.6, -38],
    rotationY: Math.PI / 2, // Front faces East (+X) toward Juyongguan Rd
    footprintWidth: 13.0,
    footprintDepth: 10.5,
    courtyardWidth: 20.0, // World Z span [-48, -28]
    courtyardDepth: 21.0, // World X span [-42.5, -21.5]
    baseElevation: 7.6,
    gateSide: 'front', // Opens East toward Juyongguan Rd at (-21.5, -38)
    gateWidth: 4.0,
    padMargin: 4.2
  },
  {
    id: 'villa_north_maple',
    nameZh: '山石木構別墅·嘉峪關北',
    style: 'stone_timber',
    position: [24, 7.8, -40],
    rotationY: 0, // Front faces South (+Z) toward Jiayuguan Rd
    footprintWidth: 14.0,
    footprintDepth: 10.8,
    courtyardWidth: 22.0,
    courtyardDepth: 19.0,
    baseElevation: 7.8,
    gateSide: 'front', // Opens South toward Jiayuguan Rd at (24, -30.5)
    gateWidth: 4.0,
    padMargin: 4.2
  },
  {
    id: 'villa_east_hill',
    nameZh: '紅瓦林蔭洋房·東坡',
    style: 'east_hill',
    position: [54, 6.0, -8],
    rotationY: -Math.PI / 2, // Front faces West (-X)
    footprintWidth: 13.0,
    footprintDepth: 10.5,
    courtyardWidth: 18.0, // World Z span [-17, +1]
    courtyardDepth: 20.0, // World X span [44, 64]
    baseElevation: 6.0,
    gateSide: 'front', // Opens West at (44, -8)
    gateWidth: 4.0,
    padMargin: 3.4
  },
  {
    id: 'villa_west_maple',
    nameZh: '紅磚拱廊洋房·楓林西',
    style: 'red_brick_arcade',
    position: [-58, 7.2, -32],
    rotationY: 0, // Front faces South (+Z) toward Jiayuguan Rd
    footprintWidth: 13.2,
    footprintDepth: 10.4,
    courtyardWidth: 20.0,
    courtyardDepth: 17.0,
    baseElevation: 7.2,
    gateSide: 'front', // Opens South toward Jiayuguan Rd at (-58, -23.5)
    gateWidth: 4.0,
    padMargin: 3.8
  }
];

export function getVillaById(id: string): VillaPlacement | undefined {
  return VILLAS.find((v) => v.id === id);
}

// ============================================================================
// 5. COASTAL TERRAIN HEIGHT & ZONE MATH (SINGLE SOURCE OF TRUTH)
// ============================================================================

/** Crescent seawall Z coordinate along Second Bathing Beach. */
export function getSeawallZ(x: number): number {
  return 38.4 - 1.6 * Math.exp(-(((x + 20) / 38) ** 2));
}

/**
 * Unflattened analytical coastal landscape + villa pads (used both directly
 * and by road cross-section leveling without recursion).
 */
function getBaseTerrainHeight(x: number, z: number): number {
  // 1. Inland hillside slope (North -Z climbs smoothly to ~11.5m at Z=-100)
  const inlandDist = Math.max(0, 36 - z);
  let y = 3.25 + inlandDist * 0.056 + 0.000038 * inlandDist * inlandDist;

  // Gentle organic Badaguan coastal hillside undulation
  const undulation =
    0.34 * Math.sin(x * 0.031 + 0.45) * Math.cos(z * 0.027 - 0.35) +
    0.2 * Math.sin((x * 0.65 + z * 0.75) * 0.044);
  const inlandFade = smoothstep(42, 18, z);
  y += undulation * inlandFade;

  // Subtle rise along far northern / eastern / western framing flanks
  const eastHill = smoothstep(42, 105, x) * smoothstep(26, -20, z) * 2.1;
  const westHill = smoothstep(-50, -108, x) * smoothstep(32, -25, z) * 1.9;
  y += eastHill + westHill;

  // 2. Second Bathing Beach crescent cove & Yellow Sea floor drop
  const seawallZ = getSeawallZ(x);
  const dz = z - seawallZ;

  if (dz > -2.5) {
    // Smooth drop over the granite seawall onto upper beach sand (Y ≈ 2.05)
    const wallT = smootherstep(-2.5, 2.8, dz);
    const upperBeachY = 2.08;
    let coastalY = y * (1 - wallT) + upperBeachY * wallT;

    if (dz > 2.2) {
      // Gentle crescent sandy beach sloping from +2.08 down through Y=0 (dz≈16) to -1.7 (dz≈25)
      const sandT = smootherstep(2.2, 25.5, dz);
      const lowTideY = -1.72;
      coastalY = coastalY * (1 - sandT) + lowTideY * sandT;

      // Subtle sandbar ripple on the beach face
      const beachRipple = 0.07 * Math.sin(x * 0.14 + z * 0.09) * (1 - sandT) * sandT * 4;
      coastalY += beachRipple;
    }

    if (dz > 24.0) {
      // Deep Yellow Sea seabed out to horizon
      const seaT = smootherstep(24.0, 68.0, dz);
      coastalY = coastalY * (1 - seaT) + -4.8 * seaT;
    }

    // Western rocky framing point beyond X < -64 (echoing Huiquan Cape)
    const westPointMask =
      smoothstep(-58, -76, x) *
      (1 - smootherstep(44, 62, z)) *
      smoothstep(28, 39, z);
    if (westPointMask > 0) {
      const crag = 0.45 * Math.sin(x * 0.24) * Math.cos(z * 0.22);
      coastalY += westPointMask * (2.6 + crag);
    }

    y = coastalY;
  }

  // 3. Dramatic Rocky Headland: Huashi Cape (花石樓海岬, X in [24, 78], Z in [24, 68])
  // Rotated promontory centered near (48, 43) with rocky coastal reefs plunging into the sea
  const hx = x - 48;
  const hz = z - 42.5;
  const cosC = Math.cos(-0.22);
  const sinC = Math.sin(-0.22);
  const rx = hx * cosC - hz * sinC;
  const rz = hx * sinC + hz * cosC;

  // Jagged granite coastline perturbation for authentic rocky cape silhouette
  const reefPerturb =
    0.08 * Math.sin(Math.atan2(rz, rx) * 5.0 + 0.7) +
    0.05 * Math.cos(x * 0.17 - z * 0.19);
  const capeNormDist = Math.hypot(rx / 21.5, rz / 14.5) + reefPerturb;

  // Smooth plateau core + steep rocky coastal cliff skirt dropping to reefs at Z≈58..66
  const capeCore = 1 - smootherstep(0.58, 1.02, capeNormDist);
  const capeReefShelf = 1 - smootherstep(0.92, 1.38, capeNormDist);

  // Connecting ridge along Huashi Cape Path from (21.5, 27.6) up to (38.4, 35.1)
  const p0x = 21.5;
  const p0z = 27.6;
  const pdx = 38.4 - p0x;
  const pdz = 35.1 - p0z;
  const pLenSq = pdx * pdx + pdz * pdz;
  const pLen = Math.sqrt(pLenSq);
  const ridgeDot = ((x - p0x) * pdx + (z - p0z) * pdz) / pLenSq;
  const ridgePerp = Math.abs((x - p0x) * -pdz + (z - p0z) * pdx) / pLen;
  const pathBridge =
    smoothstep(-0.18, 0.18, ridgeDot) *
    (1 - smoothstep(0.88, 1.25, ridgeDot)) *
    (1 - smootherstep(3.2, 10.5, ridgePerp));

  if (capeReefShelf > 0.001 || pathBridge > 0.001) {
    const rockyCrags =
      0.55 * Math.sin(x * 0.21 + 0.3) * Math.cos(z * 0.24 - 0.5) +
      0.32 * Math.sin((x - z) * 0.37);
    // Keep plateau high (6.4..7.0m) and drop via jagged coastal reefs into foaming waves
    const bluffTarget = 6.5 + rockyCrags * smootherstep(0.45, 0.92, capeNormDist);
    const reefTarget = 0.75 + rockyCrags * 1.1;

    const shelfY = Math.max(y, y * (1 - capeReefShelf) + reefTarget * capeReefShelf);
    y = shelfY * (1 - capeCore) + bluffTarget * capeCore;

    if (pathBridge > 0.001) {
      const pathElev = 3.9 + clamp(ridgeDot, 0, 1) * 2.5;
      y = y * (1 - pathBridge * 0.9) + pathElev * (pathBridge * 0.9);
    }
  }

  // 4. Smooth oriented pad flattening for every villa & courtyard (zero floating/sinking!)
  for (let i = 0; i < VILLAS.length; i++) {
    const v = VILLAS[i];
    const dx = x - v.position[0];
    const dz = z - v.position[2];
    const c = Math.cos(v.rotationY);
    const s = Math.sin(v.rotationY);
    // Inverse Y-rotation into villa local coordinates
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;

    const halfW = v.courtyardWidth * 0.5 + 0.6;
    const halfD = v.courtyardDepth * 0.5 + 0.6;
    const ex = Math.max(0, Math.abs(lx) - halfW);
    const ez = Math.max(0, Math.abs(lz) - halfD);
    const distOutside = Math.hypot(ex, ez);

    if (distOutside < v.padMargin) {
      const padWeight = 1 - smootherstep(0, v.padMargin, distOutside);
      y = y * (1 - padWeight) + v.baseElevation * padWeight;
    }
  }

  return y;
}

/**
 * Authoritative terrain elevation Y (meters) at world position (x, z).
 * Applies smooth road cross-section grading so streets sit level with crisp curbs.
 */
export function getTerrainHeight(x: number, z: number): number {
  let y = getBaseTerrainHeight(x, z);

  // Level road cross-sections smoothly across intersections
  let roadWeightSum = 0;
  let roadHeightAccum = 0;

  for (let i = 0; i < ROADS.length; i++) {
    const road = ROADS[i];
    const q = querySingleRoad(road, x, z);
    const halfW = road.width * 0.5;
    const blendOuter = halfW + 2.2;
    if (q.distance < blendOuter) {
      const w = 1 - smootherstep(halfW * 0.88, blendOuter, q.distance);
      const centerY = getBaseTerrainHeight(q.closestX, q.closestZ);
      roadWeightSum += w;
      roadHeightAccum += w * centerY;
    }
  }

  if (roadWeightSum > 0) {
    const targetY = roadHeightAccum / roadWeightSum;
    const blend = Math.min(1, roadWeightSum);
    y = y * (1 - blend) + targetY * blend;
  }

  return y;
}

/**
 * Walkable surface elevation at (x, z): seamlessly steps from beach sand onto
 * the Stone Jetty deck (Y = 1.32m) and everywhere on land.
 */
export function getWalkableHeight(x: number, z: number): number {
  const terrainY = getTerrainHeight(x, z);
  const jettyY = getJettyHeight(x, z);
  return jettyY !== null ? Math.max(terrainY, jettyY) : terrainY;
}

/** Finite-difference surface normal [nx, ny, nz] of terrain at (x, z). */
export function getTerrainNormal(x: number, z: number): [number, number, number] {
  const eps = 0.5;
  const hL = getTerrainHeight(x - eps, z);
  const hR = getTerrainHeight(x + eps, z);
  const hD = getTerrainHeight(x, z - eps);
  const hU = getTerrainHeight(x, z + eps);
  return normalize3(hL - hR, 2 * eps, hD - hU);
}

/** Terrain gradient magnitude (rise/run) at (x, z). */
export function getTerrainSlope(x: number, z: number): number {
  const eps = 0.5;
  const dhdx = (getTerrainHeight(x + eps, z) - getTerrainHeight(x - eps, z)) / (2 * eps);
  const dhdz = (getTerrainHeight(x, z + eps) - getTerrainHeight(x, z - eps)) / (2 * eps);
  return Math.hypot(dhdx, dhdz);
}

/** Classifies world (x, z) into semantic coastal terrain zones for shading & prop scatter. */
export function getCoastZone(x: number, z: number): CoastZone {
  const y = getTerrainHeight(x, z);
  if (y < -0.35) return 'sea';

  // Huashi Cape rocky bluff & reefs (East) or West rocky point
  const distHuashi = Math.hypot((x - 48) / 29, (z - 45) / 23);
  if (distHuashi < 1.15 && (z > 36 || x > 58) && y < 6.1) {
    return 'reef';
  }
  if (x < -64 && z > 37 && y < 4.5) {
    return 'reef';
  }

  const seawallZ = getSeawallZ(x);
  if (z >= seawallZ + 1.5 && x >= -66 && x <= 26) {
    return y < -0.35 ? 'sea' : 'beach';
  }
  if (Math.abs(z - seawallZ) <= 2.2 && x >= -68 && x <= 26) {
    return 'seawall';
  }
  return 'inland';
}

// ============================================================================
// 6. VILLA COURTYARD WALLS & WORLD COLLIDERS
// ============================================================================

function localToWorldXZ(
  cx: number,
  cz: number,
  rotationY: number,
  lx: number,
  lz: number
): [number, number] {
  const c = Math.cos(rotationY);
  const s = Math.sin(rotationY);
  return [cx + lx * c + lz * s, cz - lx * s + lz * c];
}

/**
 * Generates exact world-space courtyard wall segments for a villa, splitting
 * the gateSide wall cleanly so the open gate aligns identically for visuals and physics.
 */
export function getVillaWallSegments(villa: VillaPlacement): VillaWallSegment[] {
  const segments: VillaWallSegment[] = [];
  const halfW = villa.courtyardWidth * 0.5;
  const halfD = villa.courtyardDepth * 0.5;
  const wallThickness = 0.55;
  const cx = villa.position[0];
  const cz = villa.position[2];
  const ry = villa.rotationY;
  const baseY = villa.baseElevation;

  const pushSide = (
    sideName: VillaPlacement['gateSide'],
    spanLength: number,
    isHorizontalLocal: boolean, // true = along local X (front/back), false = along local Z (left/right)
    offsetCoord: number
  ) => {
    const hasGate = villa.gateSide === sideName;
    const segRot = isHorizontalLocal ? ry : ry + Math.PI / 2;

    if (!hasGate) {
      const lx = isHorizontalLocal ? 0 : offsetCoord;
      const lz = isHorizontalLocal ? offsetCoord : 0;
      const [wx, wz] = localToWorldXZ(cx, cz, ry, lx, lz);
      segments.push({
        id: `${villa.id}_wall_${sideName}`,
        centerX: wx,
        centerZ: wz,
        length: spanLength,
        thickness: wallThickness,
        rotationY: segRot,
        baseY
      });
    } else {
      const halfSpan = spanLength * 0.5;
      const halfGate = Math.min(villa.gateWidth * 0.5, halfSpan - 1.2);
      const wingLen = halfSpan - halfGate;
      const wingCenter = halfGate + wingLen * 0.5;

      for (const sign of [-1, 1] as const) {
        const along = sign * wingCenter;
        const lx = isHorizontalLocal ? along : offsetCoord;
        const lz = isHorizontalLocal ? offsetCoord : along;
        const [wx, wz] = localToWorldXZ(cx, cz, ry, lx, lz);
        segments.push({
          id: `${villa.id}_wall_${sideName}_${sign < 0 ? 'a' : 'b'}`,
          centerX: wx,
          centerZ: wz,
          length: wingLen,
          thickness: wallThickness,
          rotationY: segRot,
          baseY
        });
      }
    }
  };

  pushSide('front', villa.courtyardWidth, true, halfD);
  pushSide('back', villa.courtyardWidth, true, -halfD);
  pushSide('left', villa.courtyardDepth, false, -halfW);
  pushSide('right', villa.courtyardDepth, false, halfW);

  return segments;
}

function buildColliders(): WorldCollisionData {
  const boxes: ColliderBox[] = [];
  const circles: ColliderCircle[] = [];

  for (const villa of VILLAS) {
    // 1. Main villa building footprint collider
    boxes.push({
      id: `${villa.id}_building`,
      kind: 'box',
      centerX: villa.position[0],
      centerZ: villa.position[2],
      halfWidth: villa.footprintWidth * 0.5,
      halfDepth: villa.footprintDepth * 0.5,
      rotationY: villa.rotationY,
      minY: villa.baseElevation,
      maxY: villa.baseElevation + 18,
      category: 'building'
    });

    // 2. Courtyard walls (leaving open pedestrian gate!)
    const walls = getVillaWallSegments(villa);
    for (const seg of walls) {
      boxes.push({
        id: seg.id,
        kind: 'box',
        centerX: seg.centerX,
        centerZ: seg.centerZ,
        halfWidth: seg.length * 0.5,
        halfDepth: seg.thickness * 0.5,
        rotationY: seg.rotationY,
        minY: seg.baseY,
        maxY: seg.baseY + 2.2,
        category: 'wall'
      });
    }
  }

  // 3. Coastal cliff guard boulders around Huashi Cape sheer seaward drop
  const cliffGuards: [string, number, number, number][] = [
    ['cliff_huashi_s1', 42, 57.5, 2.4],
    ['cliff_huashi_s2', 52, 58.0, 2.6],
    ['cliff_huashi_e1', 63.5, 48.0, 2.6],
    ['cliff_huashi_e2', 64.0, 38.5, 2.4]
  ];
  for (const [id, x, z, radius] of cliffGuards) {
    circles.push({ id, kind: 'circle', x, z, radius, category: 'cliff' });
  }

  return {
    boxes,
    circles,
    worldBounds: WORLD_BOUNDS
  };
}

export const COLLIDERS: WorldCollisionData = buildColliders();

function pointInColliderBox(
  x: number,
  z: number,
  box: ColliderBox,
  padding: number
): boolean {
  const dx = x - box.centerX;
  const dz = z - box.centerZ;
  const c = Math.cos(box.rotationY);
  const s = Math.sin(box.rotationY);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return (
    Math.abs(lx) < box.halfWidth + padding &&
    Math.abs(lz) < box.halfDepth + padding
  );
}

/**
 * Checks whether a pedestrian at (x, z) with given collision radius can stand there.
 * Allows walking on roads, sidewalks, courtyards (via open gates), beach sand,
 * shallow shoreline foam, and the Stone Jetty; blocks buildings, walls, sheer cliffs,
 * and deep ocean water.
 */
export function isWalkablePosition(x: number, z: number, playerRadius = 0.55): boolean {
  const b = COLLIDERS.worldBounds;
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) {
    return false;
  }

  // Check building & courtyard wall colliders
  for (let i = 0; i < COLLIDERS.boxes.length; i++) {
    if (pointInColliderBox(x, z, COLLIDERS.boxes[i], playerRadius)) {
      return false;
    }
  }

  // Check circular colliders (cliff guards, rocks, etc.)
  for (let i = 0; i < COLLIDERS.circles.length; i++) {
    const c = COLLIDERS.circles[i];
    const r = c.radius + playerRadius;
    const dx = x - c.x;
    const dz = z - c.z;
    if (dx * dx + dz * dz < r * r) {
      return false;
    }
  }

  // Stone Jetty is always walkable above the sea
  if (getJettyHeight(x, z) !== null) {
    return true;
  }

  // Prevent walking into deep Yellow Sea water (allow wading to shallow shoreline)
  const terrainY = getTerrainHeight(x, z);
  if (terrainY < -0.18) {
    return false;
  }

  // Guard against climbing/falling off sheer Huashi Cape rock cliffs
  const slope = getTerrainSlope(x, z);
  if (slope > 0.92) {
    const roadInfo = getRoadInfo(x, z);
    if (!roadInfo.onRoad && !roadInfo.onShoulder) {
      return false;
    }
  }

  return true;
}

/**
 * Smooth collision resolution with X/Z sliding so walking along courtyard walls,
 * villa facades, or shoreline feels natural and never snags.
 */
export function resolvePlayerMovement(
  currentX: number,
  currentZ: number,
  nextX: number,
  nextZ: number,
  playerRadius = 0.55
): { x: number; z: number; collided: boolean } {
  if (isWalkablePosition(nextX, nextZ, playerRadius)) {
    return { x: nextX, z: nextZ, collided: false };
  }
  if (isWalkablePosition(nextX, currentZ, playerRadius)) {
    return { x: nextX, z: currentZ, collided: true };
  }
  if (isWalkablePosition(currentX, nextZ, playerRadius)) {
    return { x: currentX, z: nextZ, collided: true };
  }
  return { x: currentX, z: currentZ, collided: true };
}

// ============================================================================
// 7. CINEMATIC VIEWPOINTS & SPAWN POINT
// ============================================================================

export const SPAWN_POINT = {
  position: [-8.0, getWalkableHeight(-8.0, -34.0) + 1.75, -34.0] as [number, number, number],
  target: [4.0, 5.2, 8.0] as [number, number, number]
};

/** 6 curated viewpoints framing the iconic vistas of Qingdao Badaguan. */
export const VIEWPOINTS: ViewpointDef[] = [
  {
    id: 'ginkgo_avenue',
    nameZh: '居庸關銀杏',
    subtitleZh: '深秋金色銀杏大道，遠眺公主樓與碧海',
    position: [...SPAWN_POINT.position],
    target: [...SPAWN_POINT.target],
    fov: 54,
    suggestedMood: 'autumn'
  },
  {
    id: 'princess_house',
    nameZh: '公主樓庭院',
    subtitleZh: '丹麥童話藍牆紅瓦，松影花窗掩映',
    position: [-7.95, getWalkableHeight(-7.95, -1.9) + 1.75, -1.9],
    target: [12.0, 11.9, -2.2],
    fov: 58,
    suggestedMood: 'autumn'
  },
  {
    id: 'huashi_cape',
    nameZh: '花石樓海岬',
    subtitleZh: '臨海哥特花崗岩古堡，濤聲拍岸',
    position: [24.8, getWalkableHeight(24.8, 27.1) + 1.85, 27.1],
    target: [48.0, 14.8, 44.0],
    fov: 55,
    suggestedMood: 'sunset'
  },
  {
    id: 'second_beach_jetty',
    nameZh: '第二浴場石堤',
    subtitleZh: '沿花崗岩長堤入海，回望紅瓦山岬',
    position: [-20.6, JETTY.deckY + 1.85, 81.0],
    target: [20.0, 6.8, 35.0],
    fov: 56,
    suggestedMood: 'morning'
  },
  {
    id: 'maple_butterfly',
    nameZh: '嘉峪關楓林',
    subtitleZh: '五角楓紅映蝴蝶樓，金秋交錯十字口',
    position: [-14.0, getWalkableHeight(-14.0, -15.5) + 1.75, -15.5],
    target: [-32.0, 6.4, 6.0],
    fov: 54,
    suggestedMood: 'autumn'
  },
  {
    id: 'coastal_overview',
    nameZh: '紅瓦碧海俯瞰',
    subtitleZh: '全景鳥瞰八大關萬國建築與黃海灣岸',
    position: [-54.0, 34.0, -48.0],
    target: [10.0, 4.5, 22.0],
    fov: 50,
    suggestedMood: 'autumn'
  }
];

// ============================================================================
// 8. CULTURAL & POETIC LANDMARKS METADATA
// ============================================================================

export const LANDMARKS: LandmarkDef[] = [
  {
    id: 'huashi',
    nameZh: '花石樓',
    nameEn: 'Huashi Villa · Granite Sea Castle',
    roadZh: '黃海路 18 號 · 海岬之巔',
    year: '1930–1932',
    descriptionZh:
      '矗立於八大關南端海岬礁石之上，融哥特式尖塔、羅馬式圓堡與希臘柱廊於一體。外牆嵌滿嶗山花崗岩與海濱滑石卵石，推窗即是第二海水浴場的碧波與石堤。',
    position: [48, 6.4, 44],
    radius: 30,
    category: 'villa'
  },
  {
    id: 'princess',
    nameZh: '公主樓',
    nameEn: 'Princess House · Danish Fairy-Tale Villa',
    roadZh: '居庸關路 10 號',
    year: '1930s',
    descriptionZh:
      '八大關最具童話氣息的北歐丹麥式建築。淺藍綠色粉牆配以陡峭紅陶尖頂與白色木窗櫺，隱藏於居庸關銀杏與嘉峪關楓影交織的靜謐庭院之中。',
    position: [12, 5.5, -2],
    radius: 20,
    category: 'villa'
  },
  {
    id: 'butterfly',
    nameZh: '蝴蝶樓',
    nameEn: 'Butterfly Villa · Classic European Residence',
    roadZh: '山海關路 21 號',
    year: '1934',
    descriptionZh:
      '暖黃粉牆、墨綠百葉窗與對稱石雕露台相映成趣，因電影《劫後桃花》取景而名留青史。南面山海關路法桐掩映，舉步可聞黃海潮汐。',
    position: [-32, 4.7, 11],
    radius: 20,
    category: 'villa'
  },
  {
    id: 'juyongguan_rd',
    nameZh: '居庸關路 · 銀杏大道',
    nameEn: 'Juyongguan Road · Golden Ginkgo Avenue',
    roadZh: '居庸關路',
    year: '一關一樹',
    descriptionZh:
      '「一關一樹，十關十景」的深秋代表。每至十月末至十一月，道路兩側高大銀杏化作綿延金廊，落葉鋪滿花崗岩人行道與老城牆角。',
    position: [-8, getTerrainHeight(-8, -32), -32],
    radius: 22,
    category: 'road'
  },
  {
    id: 'jiayuguan_rd',
    nameZh: '嘉峪關路 · 五角楓徑',
    nameEn: 'Jiayuguan Road · Crimson Maple Lane',
    roadZh: '嘉峪關路',
    year: '一關一樹',
    descriptionZh:
      '貫穿萬國洋房群落的五角楓林蔭道，深秋霜染楓葉如火，與嶗山蘑菇石圍牆、紅瓦坡頂交織出青島最詩意的秋色長卷。',
    position: [-26, getTerrainHeight(-26, -15.8), -15.8],
    radius: 20,
    category: 'road'
  },
  {
    id: 'shanhaiguan_rd',
    nameZh: '山海關路 · 法桐海濱',
    nameEn: 'Shanhaiguan Road · Coastal Sycamore Promenade',
    roadZh: '山海關路',
    year: '紅瓦綠樹，碧海藍天',
    descriptionZh:
      '緊鄰第二海水浴場的濱海大道。斑駁古樸的法國梧桐樹幹與海風共舞，一側是掩映松濤的老別墅，一側是開闊無垠的黃海碧波。',
    position: [-10, getTerrainHeight(-10, 29.2), 29.2],
    radius: 22,
    category: 'road'
  },
  {
    id: 'second_beach',
    nameZh: '第二海水浴場 · 濱海石堤',
    nameEn: 'Second Bathing Beach & Stone Jetty',
    roadZh: '山海關路南側海灣',
    year: '百年海濱勝景',
    descriptionZh:
      '坡緩沙細的月牙形天然海灣，一道花崗岩海濱石堤探入碧藍黃海之中。立於堤端回望，花石樓古堡、紅瓦洋房與秋林山色盡收眼底。',
    position: [-19, JETTY.deckY, 66],
    radius: 28,
    category: 'coast'
  }
];

// ============================================================================
// 9. ATMOSPHERE PRESETS (4 AUTHENTIC QINGDAO MOODS)
// ============================================================================

export const ATMOSPHERE_PRESETS: Record<TimeOfDayId, AtmosphereConfig> = {
  morning: {
    id: 'morning',
    nameZh: '晨霧海風',
    nameEn: 'Morning Sea Mist',
    subtitleZh: '微熹薄霧籠罩海岬，清涼潮汐輕拍石堤',
    sunDirection: normalize3(0.74, 0.31, 0.59),
    sunColor: '#fff1d9',
    sunIntensity: 1.95,
    hemiSkyColor: '#bfd9e6',
    hemiGroundColor: '#5c665d',
    hemiIntensity: 0.92,
    fogColor: '#cedce0',
    fogDensity: 0.0044,
    skyTopColor: '#5686a6',
    skyHorizonColor: '#d9e5e7',
    skySunGlowColor: '#fff3d6',
    waterDeepColor: '#1a5a6e',
    waterShallowColor: '#489ba1',
    waterSunColor: '#fff4dc',
    exposure: 1.04,
    bloomStrength: 0.24,
    bloomThreshold: 0.86,
    nightFactor: 0.0,
    windStrength: 0.75
  },
  autumn: {
    id: 'autumn',
    nameZh: '深秋暖陽',
    nameEn: 'Golden Autumn',
    subtitleZh: '午後暖陽斜照銀杏紅瓦，黃海碧波流金',
    sunDirection: normalize3(-0.52, 0.44, 0.73),
    sunColor: '#ffe1ad',
    sunIntensity: 2.65,
    hemiSkyColor: '#8ebee3',
    hemiGroundColor: '#6f5c43',
    hemiIntensity: 0.82,
    fogColor: '#d5cdc0',
    fogDensity: 0.0021,
    skyTopColor: '#2a6aa6',
    skyHorizonColor: '#dbd1c0',
    skySunGlowColor: '#ffdfa0',
    waterDeepColor: '#12556b',
    waterShallowColor: '#2c99a0',
    waterSunColor: '#ffe7b3',
    exposure: 1.08,
    bloomStrength: 0.28,
    bloomThreshold: 0.84,
    nightFactor: 0.0,
    windStrength: 1.0
  },
  sunset: {
    id: 'sunset',
    nameZh: '黃昏夕照',
    nameEn: 'Sunset Glow',
    subtitleZh: '落日熔金染紅花石樓與海岬，晚風拂葉',
    sunDirection: normalize3(-0.84, 0.16, 0.52),
    sunColor: '#ff944d',
    sunIntensity: 2.85,
    hemiSkyColor: '#d98f7c',
    hemiGroundColor: '#4d3632',
    hemiIntensity: 0.68,
    fogColor: '#cfa088',
    fogDensity: 0.0028,
    skyTopColor: '#2c3f6e',
    skyHorizonColor: '#f29566',
    skySunGlowColor: '#ffbc75',
    waterDeepColor: '#1c3a54',
    waterShallowColor: '#48767d',
    waterSunColor: '#ff9e52',
    exposure: 1.06,
    bloomStrength: 0.44,
    bloomThreshold: 0.74,
    nightFactor: 0.28,
    windStrength: 1.15
  },
  twilight: {
    id: 'twilight',
    nameZh: '藍調燈火',
    nameEn: 'Blue-Hour Twilight',
    subtitleZh: '暮色深藍漫過老街，路燈與洋房花窗次第亮起',
    sunDirection: normalize3(-0.72, 0.24, 0.65),
    sunColor: '#7ea4d9',
    sunIntensity: 0.75,
    hemiSkyColor: '#2d4775',
    hemiGroundColor: '#1b202b',
    hemiIntensity: 0.58,
    fogColor: '#1b2942',
    fogDensity: 0.0033,
    skyTopColor: '#0c162e',
    skyHorizonColor: '#2e446b',
    skySunGlowColor: '#695770',
    waterDeepColor: '#0b1e36',
    waterShallowColor: '#1a425c',
    waterSunColor: '#9ebce8',
    exposure: 1.02,
    bloomStrength: 0.62,
    bloomThreshold: 0.62,
    nightFactor: 1.0,
    windStrength: 0.65
  }
};

export const DEFAULT_MOOD: TimeOfDayId = 'autumn';
