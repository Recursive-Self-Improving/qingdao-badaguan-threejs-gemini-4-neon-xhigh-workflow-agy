import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  VILLAS,
  clamp,
  getTerrainHeight,
  getVillaWallSegments
} from './layout';
import { TEXTURES, getWarmStuccoTextures } from './textures';
import type {
  AtmosphereConfig,
  ColliderBox,
  PBRTextureMaps,
  VillaPlacement,
  VillaWallSegment,
  WorldUpdateContext
} from './types';

// ============================================================================
// 1. PUBLIC TYPES
// ============================================================================

export type TextureLibrary = {
  readonly mushroomGranite?: PBRTextureMaps;
  readonly huashiPebbleStone?: PBRTextureMaps;
  readonly redRoofTiles?: PBRTextureMaps;
  readonly slateTurretRoof?: PBRTextureMaps;
  readonly warmStucco?: PBRTextureMaps;
  readonly nordicBlueWall?: PBRTextureMaps;
  readonly graniteCobble?: PBRTextureMaps;
  readonly woodPlank?: PBRTextureMaps;
  readonly windowDay?: THREE.CanvasTexture;
  readonly windowNightEmissive?: THREE.CanvasTexture;
  readonly createRoadSignTexture?: typeof TEXTURES.createRoadSignTexture;
};

export interface ArchitectureModule {
  group: THREE.Group;
  update(ctx: WorldUpdateContext): void;
  applyAtmosphere(cfg: AtmosphereConfig): void;
  extraColliders?: ColliderBox[];
}

// ============================================================================
// 2. INTERNAL LIGHTING TRACKERS & MATERIAL CONTEXT
// ============================================================================

interface TrackedWindowMaterial {
  material: THREE.MeshStandardMaterial;
  litWeight: number;
  phase: number;
}

interface TrackedPointLight {
  light: THREE.PointLight;
  maxIntensity: number;
}

interface ArchMaterials {
  mushroomGranite: THREE.MeshStandardMaterial;
  mushroomGraniteWarm: THREE.MeshStandardMaterial;
  huashiStone: THREE.MeshStandardMaterial;
  graniteTrim: THREE.MeshStandardMaterial;
  graniteDark: THREE.MeshStandardMaterial;
  graniteSteps: THREE.MeshStandardMaterial;
  redRoof: THREE.MeshStandardMaterial;
  slateTurret: THREE.MeshStandardMaterial;
  nordicBlue: THREE.MeshStandardMaterial;
  butterflyStucco: THREE.MeshStandardMaterial;
  ochreStucco: THREE.MeshStandardMaterial;
  ivoryStucco: THREE.MeshStandardMaterial;
  apricotStucco: THREE.MeshStandardMaterial;
  brickWall: THREE.MeshStandardMaterial;
  redBrickChimney: THREE.MeshStandardMaterial;
  whiteTrim: THREE.MeshStandardMaterial;
  creamStone: THREE.MeshStandardMaterial;
  darkTimber: THREE.MeshStandardMaterial;
  warmTimber: THREE.MeshStandardMaterial;
  shutterGreen: THREE.MeshStandardMaterial;
  wroughtIron: THREE.MeshStandardMaterial;
  agedCopper: THREE.MeshStandardMaterial;
  doorWood: THREE.MeshStandardMaterial;
  lanternGlass: THREE.MeshStandardMaterial;
  windowDayTex: THREE.CanvasTexture;
  windowNightTex: THREE.CanvasTexture;
  windowMaterials: TrackedWindowMaterial[];
  lanternLights: TrackedPointLight[];
}

function makePBRMaterial(
  maps: PBRTextureMaps,
  opts: {
    color?: number;
    roughness?: number;
    metalness?: number;
    bumpScale?: number;
  } = {}
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: maps.map,
    bumpMap: maps.bumpMap,
    bumpScale: opts.bumpScale ?? 0.045,
    roughness: opts.roughness ?? 0.86,
    metalness: opts.metalness ?? 0.04,
    color: opts.color ?? 0xffffff
  });
  if (maps.roughnessMap) {
    mat.roughnessMap = maps.roughnessMap;
  }
  return mat;
}

function createWindowVariant(
  mats: ArchMaterials,
  tintHex: number,
  litWeight: number,
  phase: number
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: mats.windowDayTex,
    emissive: new THREE.Color(tintHex),
    emissiveMap: mats.windowNightTex,
    emissiveIntensity: 0.05,
    roughness: 0.16,
    metalness: 0.14
  });
  mats.windowMaterials.push({ material: mat, litWeight, phase });
  return mat;
}

function createArchMaterials(textures: TextureLibrary): ArchMaterials {
  const mushroom = textures.mushroomGranite ?? TEXTURES.mushroomGranite;
  const huashiPebble = textures.huashiPebbleStone ?? TEXTURES.huashiPebbleStone;
  const redRoof = textures.redRoofTiles ?? TEXTURES.redRoofTiles;
  const slateTurret = textures.slateTurretRoof ?? TEXTURES.slateTurretRoof;
  const warmStucco = textures.warmStucco ?? TEXTURES.warmStucco;
  const nordicBlue = textures.nordicBlueWall ?? TEXTURES.nordicBlueWall;
  const graniteCobble = textures.graniteCobble ?? TEXTURES.graniteCobble;
  const woodPlank = textures.woodPlank ?? TEXTURES.woodPlank;
  const windowDayTex = textures.windowDay ?? TEXTURES.windowDay;
  const windowNightTex = textures.windowNightEmissive ?? TEXTURES.windowNightEmissive;

  const ochreMaps = getWarmStuccoTextures('#e7c894');
  const ivoryMaps = getWarmStuccoTextures('#efe6d5');
  const apricotMaps = getWarmStuccoTextures('#dfa884');
  const brickMaps = getWarmStuccoTextures('#b96249');

  return {
    mushroomGranite: makePBRMaterial(mushroom, {
      roughness: 0.9,
      bumpScale: 0.065
    }),
    mushroomGraniteWarm: makePBRMaterial(mushroom, {
      color: 0xc28a78,
      roughness: 0.88,
      bumpScale: 0.06
    }),
    huashiStone: makePBRMaterial(huashiPebble, {
      roughness: 0.88,
      bumpScale: 0.07
    }),
    graniteTrim: makePBRMaterial(graniteCobble, {
      color: 0xddd6c9,
      roughness: 0.82,
      bumpScale: 0.03
    }),
    graniteDark: makePBRMaterial(graniteCobble, {
      color: 0x8f887d,
      roughness: 0.9,
      bumpScale: 0.04
    }),
    graniteSteps: makePBRMaterial(graniteCobble, {
      color: 0xd0c8ba,
      roughness: 0.84,
      bumpScale: 0.035
    }),
    redRoof: makePBRMaterial(redRoof, {
      roughness: 0.78,
      metalness: 0.04,
      bumpScale: 0.055
    }),
    slateTurret: makePBRMaterial(slateTurret, {
      color: 0xd8c6be,
      roughness: 0.72,
      metalness: 0.1,
      bumpScale: 0.05
    }),
    nordicBlue: makePBRMaterial(nordicBlue, {
      roughness: 0.84,
      bumpScale: 0.025
    }),
    butterflyStucco: makePBRMaterial(warmStucco, {
      color: 0xf7e7c8,
      roughness: 0.86,
      bumpScale: 0.025
    }),
    ochreStucco: makePBRMaterial(ochreMaps, {
      roughness: 0.86,
      bumpScale: 0.028
    }),
    ivoryStucco: makePBRMaterial(ivoryMaps, {
      roughness: 0.86,
      bumpScale: 0.024
    }),
    apricotStucco: makePBRMaterial(apricotMaps, {
      roughness: 0.86,
      bumpScale: 0.026
    }),
    brickWall: makePBRMaterial(brickMaps, {
      roughness: 0.88,
      bumpScale: 0.04
    }),
    redBrickChimney: new THREE.MeshStandardMaterial({
      color: 0x9b4634,
      roughness: 0.9,
      metalness: 0.03
    }),
    whiteTrim: new THREE.MeshStandardMaterial({
      color: 0xf4eee2,
      roughness: 0.76,
      metalness: 0.02
    }),
    creamStone: new THREE.MeshStandardMaterial({
      color: 0xe6dcc8,
      roughness: 0.82,
      metalness: 0.02
    }),
    darkTimber: makePBRMaterial(woodPlank, {
      color: 0x4d3423,
      roughness: 0.86,
      bumpScale: 0.035
    }),
    warmTimber: makePBRMaterial(woodPlank, {
      color: 0x9c6e44,
      roughness: 0.82,
      bumpScale: 0.03
    }),
    shutterGreen: new THREE.MeshStandardMaterial({
      color: 0x264c37,
      roughness: 0.74,
      metalness: 0.04
    }),
    wroughtIron: new THREE.MeshStandardMaterial({
      color: 0x23272b,
      roughness: 0.48,
      metalness: 0.68
    }),
    agedCopper: new THREE.MeshStandardMaterial({
      color: 0x486e63,
      roughness: 0.52,
      metalness: 0.45
    }),
    doorWood: makePBRMaterial(woodPlank, {
      color: 0x5c3822,
      roughness: 0.72,
      bumpScale: 0.03
    }),
    lanternGlass: new THREE.MeshStandardMaterial({
      color: 0xfff0cc,
      emissive: new THREE.Color(0xffb85c),
      emissiveIntensity: 0.18,
      roughness: 0.25,
      metalness: 0.05
    }),
    windowDayTex,
    windowNightTex,
    windowMaterials: [],
    lanternLights: []
  };
}

// ============================================================================
// 3. PROCEDURAL GEOMETRY & WORLD-SCALE UV PRIMITIVES
// ============================================================================

function setShadow(mesh: THREE.Object3D, cast = true, receive = true): void {
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
}

/**
 * BoxGeometry whose 6 faces receive true physical-scale UVs so shared seamless
 * textures tile cleanly without stretching or mutating global CanvasTexture repeats.
 */
function createTiledBox(
  w: number,
  h: number,
  d: number,
  tileU = 2.4,
  tileV = 2.4
): THREE.BoxGeometry {
  const geom = new THREE.BoxGeometry(w, h, d);
  const uv = geom.attributes.uv;
  // Face order in BoxGeometry: +X, -X, +Y, -Y, +Z, -Z (4 verts per face)
  const faceDims: [number, number][] = [
    [d, h], // +X
    [d, h], // -X
    [w, d], // +Y
    [w, d], // -Y
    [w, h], // +Z
    [w, h]  // -Z
  ];
  for (let f = 0; f < 6; f++) {
    const [fw, fh] = faceDims[f];
    const su = fw / tileU;
    const sv = fh / tileV;
    const base = f * 4;
    for (let i = 0; i < 4; i++) {
      uv.setXY(base + i, uv.getX(base + i) * su, uv.getY(base + i) * sv);
    }
  }
  uv.needsUpdate = true;
  return geom;
}

function createTiledCylinder(
  rTop: number,
  rBot: number,
  h: number,
  radialSegs: number,
  tileU = 2.4,
  tileV = 2.4,
  openEnded = false
): THREE.CylinderGeometry {
  const geom = new THREE.CylinderGeometry(rTop, rBot, h, radialSegs, 1, openEnded);
  const uv = geom.attributes.uv;
  const circ = Math.PI * (rTop + rBot);
  const su = Math.max(1, circ / tileU);
  const sv = Math.max(0.5, h / tileV);
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
  return geom;
}

function createTiledCone(
  radius: number,
  height: number,
  radialSegs: number,
  tileU = 1.6,
  tileV = 1.6,
  openEnded = false
): THREE.ConeGeometry {
  const geom = new THREE.ConeGeometry(radius, height, radialSegs, 1, openEnded);
  const uv = geom.attributes.uv;
  const circ = 2 * Math.PI * radius;
  const slant = Math.hypot(radius, height);
  const su = Math.max(2, circ / tileU);
  const sv = Math.max(1.5, slant / tileV);
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
  return geom;
}

/**
 * Triangular gable prism centered on X and Z, resting at y=0 and rising to y=height.
 * World-scale UVs ensure stucco/masonry matches the rectangular facade below seamlessly.
 */
function createGablePrism(
  width: number,
  height: number,
  depth: number,
  tileU = 2.6,
  tileV = 2.6
): THREE.ExtrudeGeometry {
  const hw = width * 0.5;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, 0);
  shape.lineTo(hw, 0);
  shape.lineTo(0, height);
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    steps: 1
  });
  geom.translate(0, 0, -depth * 0.5);

  const uv = geom.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) / tileU, uv.getY(i) / tileV);
  }
  uv.needsUpdate = true;
  return geom;
}

/**
 * True 4-slope hipped / pyramidal / mansard frustum roof geometry with crisp
 * per-slope flat shading normals and eave-to-ridge barrel-tile UV flow.
 */
function createHippedRoofGeometry(
  baseW: number,
  baseD: number,
  topW: number,
  topD: number,
  height: number,
  tileU = 1.9,
  tileV = 1.9
): THREE.BufferGeometry {
  const hw = baseW * 0.5;
  const hd = baseD * 0.5;
  const tw = Math.max(0, topW * 0.5);
  const td = Math.max(0, topD * 0.5);

  const FL: [number, number, number] = [-hw, 0, hd];
  const FR: [number, number, number] = [hw, 0, hd];
  const BR: [number, number, number] = [hw, 0, -hd];
  const BL: [number, number, number] = [-hw, 0, -hd];

  const TFL: [number, number, number] = [-tw, height, td];
  const TFR: [number, number, number] = [tw, height, td];
  const TBR: [number, number, number] = [tw, height, -td];
  const TBL: [number, number, number] = [-tw, height, -td];

  const positions: number[] = [];
  const uvs: number[] = [];

  const pushTri = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    ua: [number, number],
    ub: [number, number],
    uc: [number, number]
  ) => {
    positions.push(...a, ...b, ...c);
    uvs.push(...ua, ...ub, ...uc);
  };

  const addSlope = (
    v0: [number, number, number],
    v1: [number, number, number],
    v2: [number, number, number],
    v3: [number, number, number],
    eaveLen: number,
    ridgeLen: number,
    runDist: number
  ) => {
    const slant = Math.hypot(runDist, height);
    const inset = (eaveLen - ridgeLen) * 0.5;
    const uv0: [number, number] = [0, 0];
    const uv1: [number, number] = [eaveLen / tileU, 0];
    const uv2: [number, number] = [(eaveLen - inset) / tileU, slant / tileV];
    const uv3: [number, number] = [inset / tileU, slant / tileV];

    pushTri(v0, v1, v2, uv0, uv1, uv2);
    if (ridgeLen > 0.002) {
      pushTri(v0, v2, v3, uv0, uv2, uv3);
    }
  };

  // Front (+Z), Right (+X), Back (-Z), Left (-X)
  addSlope(FL, FR, TFR, TFL, baseW, topW, hd - td);
  addSlope(FR, BR, TBR, TFR, baseD, topD, hw - tw);
  addSlope(BR, BL, TBL, TBR, baseW, topW, hd - td);
  addSlope(BL, FL, TFL, TBL, baseD, topD, hw - tw);

  // Top flat cap if mansard frustum
  if (topW > 0.01 && topD > 0.01) {
    const u0: [number, number] = [0, 0];
    const u1: [number, number] = [topW / tileU, 0];
    const u2: [number, number] = [topW / tileU, topD / tileV];
    const u3: [number, number] = [0, topD / tileV];
    pushTri(TFL, TFR, TBR, u0, u1, u2);
    pushTri(TFL, TBR, TBL, u0, u2, u3);
  }

  // Bottom soffit cap facing -Y so looking up under eaves is always closed
  const b0: [number, number] = [0, 0];
  const b1: [number, number] = [1, 0];
  const b2: [number, number] = [1, 1];
  const b3: [number, number] = [0, 1];
  pushTri(BL, BR, FR, b0, b1, b2);
  pushTri(BL, FR, FL, b0, b2, b3);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.computeVertexNormals();
  return geom;
}

/**
 * Adds a full 4-slope hipped roof with terracotta ridge & hip rolls and eaves trim.
 */
function addHippedRoof(
  parent: THREE.Group,
  opts: {
    x: number;
    y: number;
    z: number;
    baseW: number;
    baseD: number;
    topW: number;
    topD: number;
    height: number;
    roofMat: THREE.Material;
    trimMat: THREE.Material;
    ridgeMat?: THREE.Material;
    tileSize?: number;
  }
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(opts.x, opts.y, opts.z);

  const tile = opts.tileSize ?? 1.85;
  const roofMesh = new THREE.Mesh(
    createHippedRoofGeometry(
      opts.baseW,
      opts.baseD,
      opts.topW,
      opts.topD,
      opts.height,
      tile,
      tile
    ),
    opts.roofMat
  );
  setShadow(roofMesh, true, true);
  g.add(roofMesh);

  // Crisp boxed cornice fascia under eaves
  const fascia = new THREE.Mesh(
    new THREE.BoxGeometry(opts.baseW - 0.08, 0.16, opts.baseD - 0.08),
    opts.trimMat
  );
  fascia.position.y = -0.07;
  setShadow(fascia, true, true);
  g.add(fascia);

  const ridgeMaterial = opts.ridgeMat ?? opts.roofMat;
  const hw = opts.baseW * 0.5;
  const hd = opts.baseD * 0.5;
  const tw = opts.topW * 0.5;
  const td = opts.topD * 0.5;

  // Central horizontal ridge roll
  if (opts.topW > 0.05 && opts.topD <= 0.05) {
    const ridge = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, opts.topW + 0.16, 8),
      ridgeMaterial
    );
    ridge.rotation.z = Math.PI / 2;
    ridge.position.y = opts.height + 0.03;
    setShadow(ridge, true, false);
    g.add(ridge);
  } else if (opts.topD > 0.05 && opts.topW <= 0.05) {
    const ridge = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, opts.topD + 0.16, 8),
      ridgeMaterial
    );
    ridge.rotation.x = Math.PI / 2;
    ridge.position.y = opts.height + 0.03;
    setShadow(ridge, true, false);
    g.add(ridge);
  }

  // Four diagonal terracotta hip rolls
  const hipPairs: [THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(-hw, 0, hd), new THREE.Vector3(-tw, opts.height, td)],
    [new THREE.Vector3(hw, 0, hd), new THREE.Vector3(tw, opts.height, td)],
    [new THREE.Vector3(hw, 0, -hd), new THREE.Vector3(tw, opts.height, -td)],
    [new THREE.Vector3(-hw, 0, -hd), new THREE.Vector3(-tw, opts.height, -td)]
  ];
  const up = new THREE.Vector3(0, 1, 0);
  for (const [p0, p1] of hipPairs) {
    const dir = new THREE.Vector3().subVectors(p1, p0);
    const len = dir.length();
    if (len < 0.05) continue;
    const roll = new THREE.Mesh(
      new THREE.CylinderGeometry(0.085, 0.095, len, 7),
      ridgeMaterial
    );
    roll.position.copy(p0).add(p1).multiplyScalar(0.5);
    roll.position.y += 0.04;
    roll.quaternion.setFromUnitVectors(up, dir.normalize());
    setShadow(roll, false, true);
    g.add(roll);
  }

  parent.add(g);
  return g;
}

/**
 * Adds a steep 2-slope European gabled roof (with ridge cap, bargeboards, and
 * exposed wooden rafter tails). Ridge runs along local X when rotateY=0, or
 * along local Z when rotateY=Math.PI/2.
 */
function addGabledRoof(
  parent: THREE.Group,
  opts: {
    x: number;
    y: number;
    z: number;
    ridgeLength: number;
    span: number;
    ridgeHeight: number;
    eaveOverhang?: number;
    gableOverhang?: number;
    rotateY?: number;
    roofMat: THREE.Material;
    trimMat: THREE.Material;
    rafterMat?: THREE.Material;
    tileSize?: number;
    withRafters?: boolean;
  }
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(opts.x, opts.y, opts.z);
  g.rotation.y = opts.rotateY ?? 0;

  const eaveOver = opts.eaveOverhang ?? 0.55;
  const gableOver = opts.gableOverhang ?? 0.42;
  const halfSpan = opts.span * 0.5;
  const totalHalfRun = halfSpan + eaveOver;
  const slopeAngle = Math.atan2(opts.ridgeHeight, halfSpan);
  const cosA = Math.cos(slopeAngle);
  const sinA = Math.sin(slopeAngle);
  const slantLen = totalHalfRun / cosA + 0.14;
  const totalLen = opts.ridgeLength + gableOver * 2;
  const thickness = 0.16;
  const tile = opts.tileSize ?? 1.8;

  // Build both roof slopes with downward-flowing barrel tiles
  const slopeGeom = createTiledBox(totalLen, thickness, slantLen, tile, tile);

  for (const side of [-1, 1] as const) {
    const pivot = new THREE.Group();
    pivot.position.set(0, opts.ridgeHeight, 0);
    // Rotate +PI around Y for the -Z slope so tiles always shed down toward eaves
    if (side < 0) {
      pivot.rotation.y = Math.PI;
    }
    const slab = new THREE.Mesh(slopeGeom, opts.roofMat);
    slab.rotation.x = slopeAngle;
    slab.position.set(
      0,
      -slantLen * 0.5 * sinA + thickness * 0.35 * cosA,
      slantLen * 0.5 * cosA + thickness * 0.35 * sinA
    );
    setShadow(slab, true, true);
    pivot.add(slab);

    // Crisp bargeboard trims at both gable ends
    for (const endSign of [-1, 1] as const) {
      const barge = new THREE.Mesh(
        new THREE.BoxGeometry(0.11, 0.22, slantLen + 0.04),
        opts.trimMat
      );
      barge.rotation.x = slopeAngle;
      barge.position.set(
        endSign * (totalLen * 0.5 - 0.04),
        -slantLen * 0.5 * sinA - 0.02,
        slantLen * 0.5 * cosA
      );
      setShadow(barge, true, true);
      pivot.add(barge);
    }

    // Exposed wooden rafter tails along the eave underside
    if (opts.withRafters !== false) {
      const rMat = opts.rafterMat ?? opts.trimMat;
      const rafterCount = Math.max(4, Math.floor(totalLen / 0.85));
      const eaveY = opts.ridgeHeight - (totalHalfRun - 0.1) * Math.tan(slopeAngle) - 0.08;
      const eaveZ = (totalHalfRun - 0.25) * side;
      const rafterGeom = new THREE.BoxGeometry(0.08, 0.11, 0.62);
      for (let i = 0; i <= rafterCount; i++) {
        const rx = -totalLen * 0.5 + 0.2 + (i / rafterCount) * (totalLen - 0.4);
        const rafter = new THREE.Mesh(rafterGeom, rMat);
        rafter.position.set(rx, eaveY, eaveZ);
        rafter.rotation.x = side * slopeAngle;
        setShadow(rafter, false, true);
        g.add(rafter);
      }
    }

    g.add(pivot);
  }

  // Half-round terracotta ridge cap
  const ridge = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, totalLen + 0.12, 8),
    opts.roofMat
  );
  ridge.rotation.z = Math.PI / 2;
  ridge.position.set(0, opts.ridgeHeight + 0.1, 0);
  setShadow(ridge, true, false);
  g.add(ridge);

  parent.add(g);
  return g;
}

// ============================================================================
// 4. ARCHITECTURAL DETAIL BUILDERS (WINDOWS, ARCHES, BALUSTRADES, LANTERNS)
// ============================================================================

/** Rectangular European multi-pane window with recessed frame, sill, lintel & optional green shutters. */
function addRectWindow(
  parent: THREE.Group,
  opts: {
    x: number;
    y: number;
    z: number;
    w: number;
    h: number;
    rotY?: number;
    glassMat: THREE.Material;
    frameMat: THREE.Material;
    sillMat?: THREE.Material;
    shutterMat?: THREE.Material;
    withPediment?: boolean;
  }
): void {
  const g = new THREE.Group();
  g.position.set(opts.x, opts.y, opts.z);
  g.rotation.y = opts.rotY ?? 0;

  const { w, h } = opts;
  const frameT = 0.09;
  const frameD = 0.14;

  // Recessed glowing glass pane
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.06, h - 0.06), opts.glassMat);
  pane.position.z = 0.025;
  g.add(pane);

  // Outer surround (top, bottom, left, right)
  const topBar = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, frameT, frameD), opts.frameMat);
  topBar.position.set(0, h * 0.5 + frameT * 0.35, frameD * 0.3);
  setShadow(topBar, false, true);
  g.add(topBar);

  const sideGeom = new THREE.BoxGeometry(frameT, h + 0.04, frameD);
  for (const s of [-1, 1] as const) {
    const jamb = new THREE.Mesh(sideGeom, opts.frameMat);
    jamb.position.set(s * (w * 0.5 + frameT * 0.3), 0, frameD * 0.3);
    setShadow(jamb, false, true);
    g.add(jamb);
  }

  // Projecting stone/painted sill
  const sill = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.28, 0.12, 0.24),
    opts.sillMat ?? opts.frameMat
  );
  sill.position.set(0, -h * 0.5 - 0.05, 0.09);
  setShadow(sill, true, true);
  g.add(sill);

  // Optional classical header hood / pediment
  if (opts.withPediment) {
    const hood = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.32, 0.12, 0.22),
      opts.sillMat ?? opts.frameMat
    );
    hood.position.set(0, h * 0.5 + 0.14, 0.08);
    setShadow(hood, true, true);
    g.add(hood);
  }

  // Optional hinged forest-green louvered shutters (iconic Butterfly Villa detail!)
  if (opts.shutterMat) {
    const shutW = w * 0.44;
    const shutH = h + 0.04;
    const shutterBaseGeom = new THREE.BoxGeometry(shutW, shutH, 0.05);
    const slatGeom = new THREE.BoxGeometry(shutW - 0.08, 0.025, 0.032);
    const slatCount = Math.max(5, Math.floor(shutH / 0.19));

    for (const s of [-1, 1] as const) {
      const sg = new THREE.Group();
      sg.position.set(s * (w * 0.5 + frameT * 0.8 + shutW * 0.5), 0, 0.075);
      // Slight open outward angle so shutters catch sunlight organically
      sg.rotation.y = -s * 0.12;
      const body = new THREE.Mesh(shutterBaseGeom, opts.shutterMat);
      setShadow(body, true, true);
      sg.add(body);

      for (let i = 0; i < slatCount; i++) {
        const sy = -shutH * 0.42 + (i / (slatCount - 1)) * (shutH * 0.84);
        const slat = new THREE.Mesh(slatGeom, opts.shutterMat);
        slat.position.set(0, sy, 0.022);
        slat.rotation.x = 0.32;
        sg.add(slat);
      }
      g.add(sg);
    }
  }

  parent.add(g);
}

/**
 * True Gothic pointed-arch or Romanesque round-arch window with carved stone hood,
 * recessed glass mapped cleanly to [0,1]x[0,1], slender mullions, and stone sill.
 */
function addArchedWindow(
  parent: THREE.Group,
  opts: {
    x: number;
    y: number;
    z: number;
    w: number;
    h: number;
    rotY?: number;
    pointed: boolean;
    glassMat: THREE.Material;
    stoneMat: THREE.Material;
    mullionMat: THREE.Material;
  }
): void {
  const g = new THREE.Group();
  g.position.set(opts.x, opts.y, opts.z);
  g.rotation.y = opts.rotY ?? 0;

  const { w, h, pointed } = opts;
  const hw = w * 0.5;
  const springY = pointed ? h * 0.58 - h * 0.5 : h * 0.5 - hw;
  const botY = -h * 0.5;
  const topY = h * 0.5;

  const makeArchShape = (pad: number): THREE.Shape => {
    const sh = new THREE.Shape();
    const ahw = hw + pad;
    const abot = botY - pad * 0.4;
    const atop = topY + pad;
    sh.moveTo(-ahw, abot);
    sh.lineTo(ahw, abot);
    sh.lineTo(ahw, springY);
    if (pointed) {
      sh.quadraticCurveTo(ahw * 0.96, springY + (atop - springY) * 0.58, 0, atop);
      sh.quadraticCurveTo(-ahw * 0.96, springY + (atop - springY) * 0.58, -ahw, springY);
    } else {
      sh.absarc(0, springY, ahw, 0, Math.PI, false);
    }
    sh.closePath();
    return sh;
  };

  // Carved stone surround with hollowed window opening
  const outerShape = makeArchShape(0.14);
  const holePath = makeArchShape(0);
  outerShape.holes.push(holePath);
  const surroundGeom = new THREE.ExtrudeGeometry(outerShape, {
    depth: 0.18,
    bevelEnabled: true,
    bevelThickness: 0.025,
    bevelSize: 0.025,
    bevelSegments: 2,
    curveSegments: 10
  });
  const surround = new THREE.Mesh(surroundGeom, opts.stoneMat);
  surround.position.z = -0.02;
  setShadow(surround, true, true);
  g.add(surround);

  // Recessed arched glass pane with normalized [0..1] UVs
  const glassShape = makeArchShape(0.01);
  const glassGeom = new THREE.ShapeGeometry(glassShape, 12);
  const gPos = glassGeom.attributes.position;
  const gUv = glassGeom.attributes.uv;
  for (let i = 0; i < gPos.count; i++) {
    const px = gPos.getX(i);
    const py = gPos.getY(i);
    gUv.setXY(i, clamp((px + hw) / w, 0, 1), clamp((py - botY) / h, 0, 1));
  }
  gUv.needsUpdate = true;
  const glass = new THREE.Mesh(glassGeom, opts.glassMat);
  glass.position.z = 0.03;
  g.add(glass);

  // Stone mullion & transom tracery bars
  const vBar = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, h * 0.88, 0.07),
    opts.mullionMat
  );
  vBar.position.set(0, -h * 0.04, 0.06);
  g.add(vBar);

  const hBar = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.98, 0.06, 0.07),
    opts.mullionMat
  );
  hBar.position.set(0, springY, 0.06);
  g.add(hBar);

  // Projecting carved stone sill
  const sill = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.36, 0.14, 0.28),
    opts.stoneMat
  );
  sill.position.set(0, botY - 0.06, 0.11);
  setShadow(sill, true, true);
  g.add(sill);

  // Keystone at crown
  const keystone = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.22, 0.23),
    opts.stoneMat
  );
  keystone.position.set(0, topY + 0.1, 0.09);
  setShadow(keystone, true, true);
  g.add(keystone);

  parent.add(g);
}

/**
 * True perforated semicircular masonry arch bay (for Huashi loggia & red-brick arcade).
 */
function addMasonryArchBay(
  parent: THREE.Group,
  opts: {
    x: number;
    y: number;
    z: number;
    bayWidth: number;
    bayHeight: number;
    archRadius: number;
    depth: number;
    rotY?: number;
    wallMat: THREE.Material;
    trimMat: THREE.Material;
    tileSize?: number;
  }
): void {
  const g = new THREE.Group();
  g.position.set(opts.x, opts.y, opts.z);
  g.rotation.y = opts.rotY ?? 0;

  const hw = opts.bayWidth * 0.5;
  const r = Math.min(opts.archRadius, hw - 0.14);
  const springY = opts.bayHeight - r - 0.36;

  // Spandrel wall with semicircular arch cutout
  const shape = new THREE.Shape();
  shape.moveTo(-hw, springY);
  shape.lineTo(-r, springY);
  shape.absarc(0, springY, r, Math.PI, 0, true);
  shape.lineTo(hw, springY);
  shape.lineTo(hw, opts.bayHeight);
  shape.lineTo(-hw, opts.bayHeight);
  shape.closePath();

  const tile = opts.tileSize ?? 2.2;
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: opts.depth,
    bevelEnabled: false,
    curveSegments: 14
  });
  geom.translate(0, 0, -opts.depth * 0.5);
  const uv = geom.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) / tile, uv.getY(i) / tile);
  }
  uv.needsUpdate = true;

  const spandrel = new THREE.Mesh(geom, opts.wallMat);
  setShadow(spandrel, true, true);
  g.add(spandrel);

  // Projecting curved stone archivolt ring + keystone
  const ringShape = new THREE.Shape();
  ringShape.absarc(0, springY, r + 0.14, 0, Math.PI, false);
  ringShape.absarc(0, springY, r - 0.01, Math.PI, 0, true);
  ringShape.closePath();
  const ringGeom = new THREE.ExtrudeGeometry(ringShape, {
    depth: opts.depth + 0.08,
    bevelEnabled: false,
    curveSegments: 14
  });
  ringGeom.translate(0, 0, -(opts.depth + 0.08) * 0.5);
  const ring = new THREE.Mesh(ringGeom, opts.trimMat);
  setShadow(ring, true, true);
  g.add(ring);

  const keystone = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.32, opts.depth + 0.14),
    opts.trimMat
  );
  keystone.position.set(0, springY + r + 0.08, 0);
  setShadow(keystone, true, true);
  g.add(keystone);

  parent.add(g);
}

/** Classical stone or timber balustrade along local X from -length/2 to +length/2. */
function addBalustrade(
  parent: THREE.Group,
  opts: {
    x: number;
    y: number;
    z: number;
    length: number;
    height?: number;
    rotY?: number;
    mat: THREE.Material;
    spacing?: number;
    withEndPiers?: boolean;
  }
): void {
  const g = new THREE.Group();
  g.position.set(opts.x, opts.y, opts.z);
  g.rotation.y = opts.rotY ?? 0;

  const h = opts.height ?? 0.95;
  const len = opts.length;

  const botRail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.14, 0.2), opts.mat);
  botRail.position.y = 0.07;
  setShadow(botRail, true, true);
  g.add(botRail);

  const topRail = new THREE.Mesh(new THREE.BoxGeometry(len + 0.06, 0.11, 0.24), opts.mat);
  topRail.position.y = h - 0.055;
  setShadow(topRail, true, true);
  g.add(topRail);

  const balH = h - 0.24;
  const spacing = opts.spacing ?? 0.34;
  const count = Math.max(2, Math.floor((len - 0.32) / spacing));
  const balGeom = new THREE.CylinderGeometry(0.045, 0.058, balH, 7);
  const bellyGeom = new THREE.SphereGeometry(0.068, 7, 5);

  for (let i = 0; i <= count; i++) {
    const bx = -len * 0.5 + 0.18 + (i / count) * (len - 0.36);
    const bal = new THREE.Mesh(balGeom, opts.mat);
    bal.position.set(bx, 0.14 + balH * 0.5, 0);
    setShadow(bal, true, true);
    g.add(bal);

    const belly = new THREE.Mesh(bellyGeom, opts.mat);
    belly.scale.set(1, 1.35, 1);
    belly.position.set(bx, 0.14 + balH * 0.38, 0);
    g.add(belly);
  }

  if (opts.withEndPiers) {
    const pierGeom = new THREE.BoxGeometry(0.28, h + 0.08, 0.28);
    const capGeom = new THREE.BoxGeometry(0.34, 0.08, 0.34);
    for (const s of [-1, 1] as const) {
      const px = s * (len * 0.5);
      const pier = new THREE.Mesh(pierGeom, opts.mat);
      pier.position.set(px, (h + 0.08) * 0.5, 0);
      setShadow(pier, true, true);
      g.add(pier);

      const cap = new THREE.Mesh(capGeom, opts.mat);
      cap.position.set(px, h + 0.11, 0);
      setShadow(cap, true, true);
      g.add(cap);
    }
  }

  parent.add(g);
}

/** Alternating long-short rusticated corner quoins climbing a vertical building corner. */
function addCornerQuoins(
  parent: THREE.Group,
  x: number,
  z: number,
  yStart: number,
  yEnd: number,
  mat: THREE.Material,
  sizeLong = 0.52,
  sizeShort = 0.3
): void {
  const courseH = 0.42;
  const count = Math.floor((yEnd - yStart) / courseH);
  const sx = x >= 0 ? 1 : -1;
  const sz = z >= 0 ? 1 : -1;

  for (let i = 0; i < count; i++) {
    const isEven = i % 2 === 0;
    const wx = isEven ? sizeLong : sizeShort;
    const wz = isEven ? sizeShort : sizeLong;
    const q = new THREE.Mesh(
      createTiledBox(wx, courseH - 0.05, wz, 1.6, 1.6),
      mat
    );
    q.position.set(
      x - sx * (wx * 0.5 - 0.06),
      yStart + (i + 0.5) * courseH,
      z - sz * (wz * 0.5 - 0.06)
    );
    setShadow(q, true, true);
    parent.add(q);
  }
}

/** Charming European gabled roof dormer with miniature red-tile roof & glowing casement window. */
function addRoofDormer(
  parent: THREE.Group,
  opts: {
    x: number;
    y: number;
    z: number;
    rotY?: number;
    w?: number;
    h?: number;
    d?: number;
    wallMat: THREE.Material;
    roofMat: THREE.Material;
    trimMat: THREE.Material;
    glassMat: THREE.Material;
  }
): void {
  const g = new THREE.Group();
  g.position.set(opts.x, opts.y, opts.z);
  g.rotation.y = opts.rotY ?? 0;

  const w = opts.w ?? 1.55;
  const h = opts.h ?? 1.35;
  const d = opts.d ?? 1.8;

  const body = new THREE.Mesh(createTiledBox(w, h, d, 2.0, 2.0), opts.wallMat);
  body.position.set(0, h * 0.5, -d * 0.25);
  setShadow(body, true, true);
  g.add(body);

  const gable = new THREE.Mesh(createGablePrism(w, 0.72, d, 2.0, 2.0), opts.wallMat);
  gable.position.set(0, h, -d * 0.25);
  setShadow(gable, true, true);
  g.add(gable);

  addGabledRoof(g, {
    x: 0,
    y: h,
    z: -d * 0.25,
    ridgeLength: d + 0.2,
    span: w,
    ridgeHeight: 0.72,
    eaveOverhang: 0.22,
    gableOverhang: 0.26,
    rotateY: Math.PI / 2,
    roofMat: opts.roofMat,
    trimMat: opts.trimMat,
    tileSize: 1.2,
    withRafters: false
  });

  addRectWindow(g, {
    x: 0,
    y: h * 0.52,
    z: d * 0.25 + 0.01,
    w: w * 0.62,
    h: h * 0.68,
    glassMat: opts.glassMat,
    frameMat: opts.trimMat
  });

  parent.add(g);
}

/** Heritage European chimney stack with corbeled cap & clay chimney pots. */
function addChimney(
  parent: THREE.Group,
  x: number,
  yBottom: number,
  yTop: number,
  z: number,
  w: number,
  d: number,
  bodyMat: THREE.Material,
  capMat: THREE.Material,
  pots = 2
): void {
  const h = Math.max(0.8, yTop - yBottom);
  const stack = new THREE.Mesh(createTiledBox(w, h, d, 1.8, 1.8), bodyMat);
  stack.position.set(x, yBottom + h * 0.5, z);
  setShadow(stack, true, true);
  parent.add(stack);

  const neck = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, 0.12, d + 0.16), capMat);
  neck.position.set(x, yTop - 0.14, z);
  setShadow(neck, true, true);
  parent.add(neck);

  const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.28, 0.14, d + 0.28), capMat);
  cap.position.set(x, yTop + 0.04, z);
  setShadow(cap, true, true);
  parent.add(cap);

  const potGeom = new THREE.CylinderGeometry(0.085, 0.105, 0.34, 8);
  for (let i = 0; i < pots; i++) {
    const offset = pots === 1 ? 0 : -w * 0.24 + (i / (pots - 1)) * w * 0.48;
    const pot = new THREE.Mesh(potGeom, bodyMat);
    pot.position.set(x + offset, yTop + 0.26, z);
    setShadow(pot, true, false);
    parent.add(pot);
  }
}

/** German Fachwerk (half-timbering) decorative timber grid on a triangular gable face. */
function addFachwerkGable(
  parent: THREE.Group,
  opts: {
    x: number;
    y: number;
    z: number;
    width: number;
    height: number;
    rotY?: number;
    timberMat: THREE.Material;
  }
): void {
  const g = new THREE.Group();
  g.position.set(opts.x, opts.y, opts.z);
  g.rotation.y = opts.rotY ?? 0;

  const { width, height, timberMat } = opts;
  const hw = width * 0.5;
  const t = 0.11;
  const d = 0.08;

  // Base sill beam & mid horizontal collar beam
  const sill = new THREE.Mesh(new THREE.BoxGeometry(width + 0.06, t * 1.2, d), timberMat);
  sill.position.set(0, 0.05, 0);
  g.add(sill);

  const collarY = height * 0.52;
  const collarW = width * (1 - 0.52);
  const collar = new THREE.Mesh(new THREE.BoxGeometry(collarW, t, d), timberMat);
  collar.position.set(0, collarY, 0);
  g.add(collar);

  // Center king post + flanking queen posts
  const king = new THREE.Mesh(new THREE.BoxGeometry(t, height - 0.12, d), timberMat);
  king.position.set(0, height * 0.5, 0);
  g.add(king);

  for (const s of [-1, 1] as const) {
    const qx = s * hw * 0.46;
    const qh = height * (1 - 0.46);
    const queen = new THREE.Mesh(new THREE.BoxGeometry(t * 0.9, qh, d), timberMat);
    queen.position.set(qx, qh * 0.5, 0);
    g.add(queen);

    // Diagonal Fachwerk strut bracing from sill to collar/rafter
    const p0 = new THREE.Vector3(s * hw * 0.46, 0.1, 0);
    const p1 = new THREE.Vector3(s * hw * 0.82, height * 0.18 + 0.05, 0);
    const dir = new THREE.Vector3().subVectors(p1, p0);
    const brace = new THREE.Mesh(new THREE.BoxGeometry(t * 0.8, dir.length(), d), timberMat);
    brace.position.copy(p0).add(p1).multiplyScalar(0.5);
    brace.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    g.add(brace);

    // Upper chevron brace
    const u0 = new THREE.Vector3(0, collarY, 0);
    const u1 = new THREE.Vector3(s * collarW * 0.44, height * 0.72, 0);
    const uDir = new THREE.Vector3().subVectors(u1, u0);
    const uBrace = new THREE.Mesh(new THREE.BoxGeometry(t * 0.78, uDir.length(), d), timberMat);
    uBrace.position.copy(u0).add(u1).multiplyScalar(0.5);
    uBrace.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), uDir.normalize());
    g.add(uBrace);
  }

  parent.add(g);
}

/** Sculpted vintage wrought-iron & frosted-amber glass porch or gatepost lantern. */
function addVintageLantern(
  parent: THREE.Group,
  mats: ArchMaterials,
  opts: {
    x: number;
    y: number;
    z: number;
    style: 'pedestal' | 'wall' | 'hanging';
    rotY?: number;
    scale?: number;
    addPointLight?: boolean;
    lightIntensity?: number;
  }
): void {
  const g = new THREE.Group();
  g.position.set(opts.x, opts.y, opts.z);
  g.rotation.y = opts.rotY ?? 0;
  const sc = opts.scale ?? 1.0;
  g.scale.setScalar(sc);

  if (opts.style === 'pedestal') {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.16, 0.14, 8), mats.wroughtIron);
    base.position.y = 0.07;
    g.add(base);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.055, 0.22, 8), mats.wroughtIron);
    stem.position.y = 0.24;
    g.add(stem);
  } else if (opts.style === 'wall') {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.28, 0.04), mats.wroughtIron);
    plate.position.set(0, 0.36, -0.22);
    g.add(plate);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.24), mats.wroughtIron);
    arm.position.set(0, 0.44, -0.1);
    g.add(arm);
  } else {
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.32, 6), mats.wroughtIron);
    chain.position.y = 0.86;
    g.add(chain);
  }

  // Lantern cage + glowing amber glass globe
  const glass = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.095, 0.28, 6),
    mats.lanternGlass
  );
  glass.position.y = 0.48;
  g.add(glass);

  // Corner iron ribs
  const ribGeom = new THREE.BoxGeometry(0.018, 0.3, 0.018);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    const rib = new THREE.Mesh(ribGeom, mats.wroughtIron);
    rib.position.set(Math.cos(a) * 0.125, 0.48, Math.sin(a) * 0.125);
    g.add(rib);
  }

  // Stepped pagoda-European iron hood + finial
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.16, 6), mats.wroughtIron);
  cap.position.y = 0.69;
  g.add(cap);

  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 6), mats.wroughtIron);
  finial.position.y = 0.78;
  g.add(finial);

  if (opts.addPointLight) {
    const light = new THREE.PointLight(0xffb45c, 0, 14, 2);
    light.position.set(0, 0.48, 0.06);
    light.castShadow = false;
    g.add(light);
    mats.lanternLights.push({
      light,
      maxIntensity: opts.lightIntensity ?? 3.2
    });
  }

  parent.add(g);
}

/** Grounded stepped stone staircase along local Z descending from topY to bottomY. */
function addStoneStairs(
  parent: THREE.Group,
  opts: {
    x: number;
    zStart: number;
    topY: number;
    bottomY: number;
    width: number;
    runDepth: number;
    steps: number;
    rotY?: number;
    stepMat: THREE.Material;
    cheekMat: THREE.Material;
    ironMat?: THREE.Material;
  }
): void {
  const g = new THREE.Group();
  g.position.set(opts.x, 0, opts.zStart);
  g.rotation.y = opts.rotY ?? 0;

  const totalRise = Math.max(0.2, opts.topY - opts.bottomY);
  const stepRise = totalRise / opts.steps;
  const treadD = opts.runDepth / opts.steps;

  for (let i = 0; i < opts.steps; i++) {
    const stepTop = opts.topY - i * stepRise;
    const stepBase = opts.bottomY - 0.9; // Sink cleanly into ground
    const stepH = stepTop - stepBase;
    const step = new THREE.Mesh(
      createTiledBox(opts.width, stepH, treadD + 0.04, 1.6, 1.6),
      opts.stepMat
    );
    step.position.set(0, stepBase + stepH * 0.5, (i + 0.5) * treadD);
    setShadow(step, true, true);
    g.add(step);
  }

  // Stepped masonry cheek walls & optional wrought-iron handrails
  const cheekW = 0.28;
  for (const s of [-1, 1] as const) {
    const cx = s * (opts.width * 0.5 + cheekW * 0.5);
    const cheekH = totalRise + 0.9 + 0.42;
    const cheek = new THREE.Mesh(
      createTiledBox(cheekW, cheekH, opts.runDepth + 0.16, 1.8, 1.8),
      opts.cheekMat
    );
    cheek.position.set(cx, opts.bottomY - 0.9 + cheekH * 0.5 - 0.2, opts.runDepth * 0.5);
    // Slope top via subtle lower end newel
    setShadow(cheek, true, true);
    g.add(cheek);

    const newel = new THREE.Mesh(
      createTiledBox(0.36, 0.85, 0.36, 1.4, 1.4),
      opts.cheekMat
    );
    newel.position.set(cx, opts.bottomY + 0.32, opts.runDepth + 0.12);
    setShadow(newel, true, true);
    g.add(newel);

    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 0.42), opts.stepMat);
    cap.position.set(cx, opts.bottomY + 0.78, opts.runDepth + 0.12);
    setShadow(cap, true, true);
    g.add(cap);

    if (opts.ironMat) {
      const p0 = new THREE.Vector3(cx, opts.topY + 0.78, 0.05);
      const p1 = new THREE.Vector3(cx, opts.bottomY + 0.82, opts.runDepth + 0.08);
      const dir = new THREE.Vector3().subVectors(p1, p0);
      const rail = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, dir.length(), 6),
        opts.ironMat
      );
      rail.position.copy(p0).add(p1).multiplyScalar(0.5);
      rail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      g.add(rail);
    }
  }

  parent.add(g);
}

/** Samples local minimum terrain height around a villa footprint to guarantee zero floating edges. */
function sampleFootprintMinY(villa: VillaPlacement): number {
  const [cx, baseY, cz] = villa.position;
  const hw = villa.footprintWidth * 0.52;
  const hd = villa.footprintDepth * 0.52;
  const c = Math.cos(villa.rotationY);
  const s = Math.sin(villa.rotationY);
  let minY = baseY;
  const offsets: [number, number][] = [
    [0, 0],
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
    [0, hd],
    [0, -hd],
    [hw, 0],
    [-hw, 0]
  ];
  for (const [lx, lz] of offsets) {
    const wx = cx + lx * c + lz * s;
    const wz = cz - lx * s + lz * c;
    minY = Math.min(minY, getTerrainHeight(wx, wz));
  }
  return minY;
}

// ============================================================================
// 5. COURTYARD WALLS & OPEN WROUGHT-IRON GATES
// ============================================================================

function sampleWallMinY(seg: VillaWallSegment): number {
  const c = Math.cos(seg.rotationY);
  const s = Math.sin(seg.rotationY);
  let minY = seg.baseY;
  for (let i = 0; i <= 4; i++) {
    const along = -seg.length * 0.5 + (i / 4) * seg.length;
    for (const perp of [-0.65, 0, 0.65]) {
      const wx = seg.centerX + along * c + perp * s;
      const wz = seg.centerZ - along * s + perp * c;
      minY = Math.min(minY, getTerrainHeight(wx, wz));
    }
  }
  return minY;
}

function addWroughtIronGateLeaf(
  parent: THREE.Group,
  mats: ArchMaterials,
  width: number,
  height: number,
  hingeSide: -1 | 1,
  isPrincess: boolean
): void {
  const leaf = new THREE.Group();
  const railMat = isPrincess ? mats.whiteTrim : mats.wroughtIron;
  const picketMat = mats.wroughtIron;

  // Frame rails spanning from hinge x=0 toward -hingeSide * width
  const spanDir = -hingeSide;
  const midX = spanDir * width * 0.5;

  const hBarGeom = new THREE.BoxGeometry(width, 0.055, 0.045);
  for (const ry of [0.16, height * 0.52, height - 0.14]) {
    const bar = new THREE.Mesh(hBarGeom, railMat);
    bar.position.set(midX, ry, 0);
    leaf.add(bar);
  }

  // Hinge stile & latch stile
  const stileGeom = new THREE.BoxGeometry(0.06, height, 0.055);
  const hingeStile = new THREE.Mesh(stileGeom, railMat);
  hingeStile.position.set(spanDir * 0.03, height * 0.5, 0);
  leaf.add(hingeStile);

  const latchStile = new THREE.Mesh(stileGeom, railMat);
  latchStile.position.set(spanDir * (width - 0.03), height * 0.5, 0);
  leaf.add(latchStile);

  // Vertical wrought-iron pickets with spearhead tips curving slightly upward toward latch
  const picketCount = Math.max(6, Math.floor(width / 0.17));
  const tipGeom = new THREE.ConeGeometry(0.024, 0.09, 4);
  for (let i = 1; i < picketCount; i++) {
    const t = i / picketCount;
    const px = spanDir * t * width;
    const extraH = Math.sin(t * Math.PI * 0.5) * 0.24;
    const ph = height + extraH;
    const picket = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, ph, 5),
      picketMat
    );
    picket.position.set(px, ph * 0.5, 0);
    leaf.add(picket);

    const tip = new THREE.Mesh(tipGeom, picketMat);
    tip.position.set(px, ph + 0.04, 0);
    leaf.add(tip);
  }

  parent.add(leaf);
}

function buildCourtyardForVilla(
  worldGroup: THREE.Group,
  villa: VillaPlacement,
  mats: ArchMaterials
): void {
  const segments = getVillaWallSegments(villa);
  const isHuashi = villa.style === 'huashi';
  const isPrincess = villa.style === 'princess';
  const courtyardGroup = new THREE.Group();
  courtyardGroup.name = `${villa.id}_courtyard`;

  const [cx, baseY, cz] = villa.position;
  const ry = villa.rotationY;

  for (const seg of segments) {
    const segGroup = new THREE.Group();
    segGroup.position.set(seg.centerX, 0, seg.centerZ);
    segGroup.rotation.y = seg.rotationY;

    const minY = sampleWallMinY(seg);
    const isHuashiSeaward =
      isHuashi &&
      (seg.id.includes('_front') || seg.id.includes('_right'));

    if (isHuashiSeaward) {
      // Multi-tier stepped stone sea-viewing terrace retaining wall plunging deep into headland!
      const bottomY = Math.min(minY, seg.baseY) - 4.6;
      const deckY = seg.baseY;
      const retainH = deckY - bottomY;

      // Deep rusticated cliff retaining lower wall
      const retain = new THREE.Mesh(
        createTiledBox(seg.length + 0.3, retainH, seg.thickness + 0.42, 2.6, 2.2),
        mats.mushroomGranite
      );
      retain.position.set(0, bottomY + retainH * 0.5, 0);
      setShadow(retain, true, true);
      segGroup.add(retain);

      // Stepped mid-tier stone shelf / terrace ledge
      const shelf = new THREE.Mesh(
        createTiledBox(seg.length + 0.5, 0.36, seg.thickness + 0.72, 2.2, 1.4),
        mats.graniteTrim
      );
      shelf.position.set(0, deckY - 1.35, 0);
      setShadow(shelf, true, true);
      segGroup.add(shelf);

      // Heavy buttresses stepping down the headland cliff
      const buttressCount = Math.max(2, Math.floor(seg.length / 5.2));
      for (let b = 0; b <= buttressCount; b++) {
        const bx = -seg.length * 0.5 + 0.9 + (b / buttressCount) * (seg.length - 1.8);
        const buttress = new THREE.Mesh(
          createTiledBox(0.85, retainH - 0.3, seg.thickness + 0.95, 2.0, 2.0),
          mats.graniteDark
        );
        buttress.position.set(bx, bottomY + (retainH - 0.3) * 0.5, 0);
        setShadow(buttress, true, true);
        segGroup.add(buttress);
      }

      // Upper sea-viewing parapet wall (low enough to gaze over the Yellow Sea!) + stone coping
      const parapetH = 1.05;
      const parapet = new THREE.Mesh(
        createTiledBox(seg.length, parapetH, seg.thickness, 2.2, 1.8),
        mats.huashiStone
      );
      parapet.position.set(0, deckY + parapetH * 0.5, 0);
      setShadow(parapet, true, true);
      segGroup.add(parapet);

      const coping = new THREE.Mesh(
        createTiledBox(seg.length + 0.12, 0.14, seg.thickness + 0.16, 1.8, 1.0),
        mats.graniteTrim
      );
      coping.position.set(0, deckY + parapetH + 0.07, 0);
      setShadow(coping, true, true);
      segGroup.add(coping);

      // Crenellated castle merlon piers along the terrace overlooking Second Bathing Beach
      const pierCount = Math.max(3, Math.floor(seg.length / 4.2));
      for (let p = 0; p <= pierCount; p++) {
        const px = -seg.length * 0.5 + (p / pierCount) * seg.length;
        const pier = new THREE.Mesh(
          createTiledBox(0.76, parapetH + 0.42, seg.thickness + 0.24, 1.6, 1.6),
          mats.graniteTrim
        );
        pier.position.set(px, deckY + (parapetH + 0.42) * 0.5, 0);
        setShadow(pier, true, true);
        segGroup.add(pier);

        const cap = new THREE.Mesh(
          new THREE.BoxGeometry(0.88, 0.12, seg.thickness + 0.36),
          mats.graniteSteps
        );
        cap.position.set(px, deckY + parapetH + 0.48, 0);
        setShadow(cap, true, true);
        segGroup.add(cap);
      }
    } else if (isPrincess) {
      // Princess House: Charming low granite-and-white Nordic courtyard fence with iron railings!
      const bottomY = Math.min(minY, seg.baseY) - 1.8;
      const wallTopY = seg.baseY + 0.78;
      const baseH = wallTopY - bottomY;

      const baseWall = new THREE.Mesh(
        createTiledBox(seg.length, baseH, seg.thickness, 2.2, 1.8),
        mats.mushroomGranite
      );
      baseWall.position.set(0, bottomY + baseH * 0.5, 0);
      setShadow(baseWall, true, true);
      segGroup.add(baseWall);

      const whiteCap = new THREE.Mesh(
        new THREE.BoxGeometry(seg.length + 0.08, 0.11, seg.thickness + 0.14),
        mats.whiteTrim
      );
      whiteCap.position.set(0, wallTopY + 0.055, 0);
      setShadow(whiteCap, true, true);
      segGroup.add(whiteCap);

      // Airy upper wrought-iron fence & white masonry piers
      const fenceH = 0.72;
      const railTop = new THREE.Mesh(
        new THREE.BoxGeometry(seg.length, 0.04, 0.04),
        mats.wroughtIron
      );
      railTop.position.set(0, wallTopY + fenceH, 0);
      segGroup.add(railTop);

      const railBot = new THREE.Mesh(
        new THREE.BoxGeometry(seg.length, 0.035, 0.035),
        mats.wroughtIron
      );
      railBot.position.set(0, wallTopY + 0.2, 0);
      segGroup.add(railBot);

      const pickets = Math.max(8, Math.floor(seg.length / 0.26));
      const pGeom = new THREE.CylinderGeometry(0.011, 0.011, fenceH, 4);
      for (let i = 1; i < pickets; i++) {
        const px = -seg.length * 0.5 + (i / pickets) * seg.length;
        const p = new THREE.Mesh(pGeom, mats.wroughtIron);
        p.position.set(px, wallTopY + fenceH * 0.5 + 0.06, 0);
        segGroup.add(p);
      }

      const pierCount = Math.max(1, Math.floor(seg.length / 3.4));
      for (let p = 1; p < pierCount; p++) {
        const px = -seg.length * 0.5 + (p / pierCount) * seg.length;
        const pier = new THREE.Mesh(
          new THREE.BoxGeometry(0.42, 1.62, seg.thickness + 0.12),
          mats.whiteTrim
        );
        pier.position.set(px, seg.baseY + 0.81, 0);
        setShadow(pier, true, true);
        segGroup.add(pier);

        const pyr = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.2, 4), mats.whiteTrim);
        pyr.rotation.y = Math.PI * 0.25;
        pyr.position.set(px, seg.baseY + 1.72, 0);
        setShadow(pyr, true, true);
        segGroup.add(pyr);
      }
    } else {
      // Classic Qingdao Badaguan mushroom-stone (蘑菇石) granite courtyard wall!
      const bottomY = Math.min(minY, seg.baseY) - 1.85;
      const wallH = isHuashi ? 1.75 : 1.58;
      const totalH = seg.baseY + wallH - bottomY;

      const wallMesh = new THREE.Mesh(
        createTiledBox(seg.length, totalH, seg.thickness, 2.4, 2.0),
        isHuashi ? mats.huashiStone : mats.mushroomGranite
      );
      wallMesh.position.set(0, bottomY + totalH * 0.5, 0);
      setShadow(wallMesh, true, true);
      segGroup.add(wallMesh);

      // Beveled granite coping cap
      const cap = new THREE.Mesh(
        createTiledBox(seg.length + 0.1, 0.13, seg.thickness + 0.18, 2.0, 1.0),
        mats.graniteTrim
      );
      cap.position.set(0, seg.baseY + wallH + 0.065, 0);
      setShadow(cap, true, true);
      segGroup.add(cap);

      const capCrown = new THREE.Mesh(
        new THREE.BoxGeometry(seg.length + 0.04, 0.07, seg.thickness + 0.02),
        mats.graniteSteps
      );
      capCrown.position.set(0, seg.baseY + wallH + 0.15, 0);
      setShadow(capCrown, false, true);
      segGroup.add(capCrown);

      // Periodic masonry piers breaking up long wall runs
      const pierSpan = Math.floor(seg.length / 5.5);
      for (let p = 1; p < pierSpan; p++) {
        const px = -seg.length * 0.5 + (p / pierSpan) * seg.length;
        const pier = new THREE.Mesh(
          createTiledBox(0.68, wallH + 0.34, seg.thickness + 0.18, 1.8, 1.8),
          mats.mushroomGranite
        );
        pier.position.set(px, seg.baseY + (wallH + 0.34) * 0.5, 0);
        setShadow(pier, true, true);
        segGroup.add(pier);

        const pCap = new THREE.Mesh(
          new THREE.BoxGeometry(0.8, 0.12, seg.thickness + 0.3),
          mats.graniteTrim
        );
        pCap.position.set(px, seg.baseY + wallH + 0.38, 0);
        setShadow(pCap, true, true);
        segGroup.add(pCap);
      }
    }

    courtyardGroup.add(segGroup);
  }

  // Place 4 corner stone piers + 2 monumental gate pillars + open wrought-iron gates in villa local space
  const localFrame = new THREE.Group();
  localFrame.position.set(cx, 0, cz);
  localFrame.rotation.y = ry;

  const halfW = villa.courtyardWidth * 0.5;
  const halfD = villa.courtyardDepth * 0.5;
  const cornerH = isPrincess ? 1.72 : isHuashi ? 2.15 : 1.95;

  const corners: [number, number][] = [
    [-halfW, halfD],
    [halfW, halfD],
    [halfW, -halfD],
    [-halfW, -halfD]
  ];
  for (const [lx, lz] of corners) {
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    const wx = cx + lx * c + lz * s;
    const wz = cz - lx * s + lz * c;
    const minY = Math.min(getTerrainHeight(wx, wz), baseY) - (isHuashi ? 4.4 : 1.8);
    const totalH = baseY + cornerH - minY;
    const pier = new THREE.Mesh(
      createTiledBox(0.84, totalH, 0.84, 1.8, 1.8),
      isPrincess ? mats.whiteTrim : isHuashi ? mats.graniteTrim : mats.mushroomGranite
    );
    pier.position.set(lx, minY + totalH * 0.5, lz);
    setShadow(pier, true, true);
    localFrame.add(pier);

    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(0.98, 0.14, 0.98),
      isPrincess ? mats.whiteTrim : mats.graniteSteps
    );
    cap.position.set(lx, baseY + cornerH + 0.07, lz);
    setShadow(cap, true, true);
    localFrame.add(cap);
  }

  // Grand Gate Pillars, Open Wrought-Iron Gate Leaves, & Warm Pedestal Lanterns
  const gateIsHoriz = villa.gateSide === 'front' || villa.gateSide === 'back';
  const sideSpan = gateIsHoriz ? villa.courtyardWidth : villa.courtyardDepth;
  const halfGate = Math.min(villa.gateWidth * 0.5, sideSpan * 0.5 - 1.2);
  const gateGroup = new THREE.Group();

  if (villa.gateSide === 'front') {
    gateGroup.position.set(0, baseY, halfD);
    gateGroup.rotation.y = 0;
  } else if (villa.gateSide === 'back') {
    gateGroup.position.set(0, baseY, -halfD);
    gateGroup.rotation.y = Math.PI;
  } else if (villa.gateSide === 'left') {
    gateGroup.position.set(-halfW, baseY, 0);
    gateGroup.rotation.y = -Math.PI / 2;
  } else {
    gateGroup.position.set(halfW, baseY, 0);
    gateGroup.rotation.y = Math.PI / 2;
  }

  const gatePillarH = isHuashi ? 2.85 : isPrincess ? 2.25 : 2.35;
  const gatePillarW = isHuashi ? 0.96 : 0.82;
  const leafW = Math.max(1.1, halfGate - 0.18);
  const leafH = isPrincess ? 1.55 : isHuashi ? 2.15 : 1.75;

  for (const s of [-1, 1] as const) {
    const px = s * (halfGate + gatePillarW * 0.42);
    const pillar = new THREE.Mesh(
      createTiledBox(gatePillarW, gatePillarH + 1.4, gatePillarW, 1.8, 1.8),
      isPrincess ? mats.whiteTrim : isHuashi ? mats.huashiStone : mats.mushroomGranite
    );
    pillar.position.set(px, (gatePillarH - 1.4) * 0.5, 0);
    setShadow(pillar, true, true);
    gateGroup.add(pillar);

    // Molded granite collar + cap
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(gatePillarW + 0.18, 0.16, gatePillarW + 0.18),
      isPrincess ? mats.whiteTrim : mats.graniteTrim
    );
    cap.position.set(px, gatePillarH + 0.08, 0);
    setShadow(cap, true, true);
    gateGroup.add(cap);

    // Warm bronze heritage gatepost lantern perched atop every courtyard entrance!
    addVintageLantern(gateGroup, mats, {
      x: px,
      y: gatePillarH + 0.16,
      z: 0,
      style: 'pedestal',
      scale: isHuashi ? 1.15 : 0.95
    });

    // Open wrought-iron gate leaf swung ~82° INWARD into the courtyard (never obstructing walkthrough!)
    const hinge = new THREE.Group();
    hinge.position.set(s * (halfGate - 0.02), 0.08, -0.05);
    hinge.rotation.y = s * -1.42;
    addWroughtIronGateLeaf(hinge, mats, leafW, leafH, s, isPrincess);
    gateGroup.add(hinge);
  }

  localFrame.add(gateGroup);
  courtyardGroup.add(localFrame);
  worldGroup.add(courtyardGroup);
}

// ============================================================================
// 6. HERO LANDMARK 1 — 花石樓 (HUASHI VILLA · GOTHIC-ROMANESQUE SEA CASTLE)
// ============================================================================

function buildHuashiVilla(
  villa: VillaPlacement,
  mats: ArchMaterials
): THREE.Group {
  const root = new THREE.Group();
  root.name = 'villa_huashi';
  root.position.set(villa.position[0], villa.baseElevation, villa.position[2]);
  root.rotation.y = villa.rotationY;

  const minTerrainLocal = sampleFootprintMinY(villa) - villa.baseElevation;
  const plinthBottom = Math.min(-2.8, minTerrainLocal - 2.6);
  const plinthTop = 1.45;
  const plinthH = plinthTop - plinthBottom;

  const winWarmA = createWindowVariant(mats, 0xffba63, 1.15, 0.4);
  const winWarmB = createWindowVariant(mats, 0xffa84c, 0.85, 1.9);
  const winTower = createWindowVariant(mats, 0xffc878, 1.25, 3.1);

  // 1. Heavy stepped rustic granite plinth sinking deep into Huashi Cape headland!
  const lowerPlinth = new THREE.Mesh(
    createTiledBox(14.6, plinthH - 0.4, 11.6, 2.6, 2.2),
    mats.mushroomGranite
  );
  lowerPlinth.position.set(0.2, plinthBottom + (plinthH - 0.4) * 0.5, -0.1);
  setShadow(lowerPlinth, true, true);
  root.add(lowerPlinth);

  const upperPlinth = new THREE.Mesh(
    createTiledBox(13.8, 0.6, 10.8, 2.4, 1.6),
    mats.graniteDark
  );
  upperPlinth.position.set(0.2, plinthTop - 0.3, -0.1);
  setShadow(upperPlinth, true, true);
  root.add(upperPlinth);

  const waterTable = new THREE.Mesh(
    createTiledBox(14.0, 0.16, 11.0, 2.2, 1.0),
    mats.graniteTrim
  );
  waterTable.position.set(0.2, plinthTop + 0.05, -0.1);
  setShadow(waterTable, true, true);
  root.add(waterTable);

  // 2. Main asymmetric Gothic-Romanesque stone keep volume (pebble & granite masonry)
  const mainW = 10.6;
  const mainD = 7.8;
  const mainX = 1.0;
  const mainZ = -0.9;
  const wallTopY = 10.6;
  const mainH = wallTopY - plinthTop;

  const mainBody = new THREE.Mesh(
    createTiledBox(mainW, mainH, mainD, 2.8, 2.8),
    mats.huashiStone
  );
  mainBody.position.set(mainX, plinthTop + mainH * 0.5, mainZ);
  setShadow(mainBody, true, true);
  root.add(mainBody);

  // Corner rusticated granite quoins on all 4 corners of main keep
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      addCornerQuoins(
        root,
        mainX + sx * (mainW * 0.5),
        mainZ + sz * (mainD * 0.5),
        plinthTop + 0.12,
        wallTopY - 0.1,
        mats.graniteTrim,
        0.58,
        0.34
      );
    }
  }

  // Horizontal stone stringcourses & corbeled roof cornice
  for (const sy of [4.65, 7.7, 10.45]) {
    const band = new THREE.Mesh(
      createTiledBox(mainW + 0.32, 0.24, mainD + 0.32, 2.2, 1.0),
      mats.graniteTrim
    );
    band.position.set(mainX, sy, mainZ);
    setShadow(band, true, true);
    root.add(band);
  }

  // 3. Crenellated stone battlements (雉堞 / 女兒牆) crowning the castle roof!
  const parapetBaseY = wallTopY;
  const parapetWall = new THREE.Mesh(
    createTiledBox(mainW + 0.22, 0.62, mainD + 0.22, 2.4, 1.6),
    mats.huashiStone
  );
  parapetWall.position.set(mainX, parapetBaseY + 0.31, mainZ);
  setShadow(parapetWall, true, true);
  root.add(parapetWall);

  // Dark weathered slate flat roof deck inside battlements
  const roofDeck = new THREE.Mesh(
    createTiledBox(mainW - 0.3, 0.2, mainD - 0.3, 2.4, 2.4),
    mats.slateTurret
  );
  roofDeck.position.set(mainX, parapetBaseY + 0.45, mainZ);
  setShadow(roofDeck, false, true);
  root.add(roofDeck);

  // Rhythmic merlons along front, back, left, right parapet edges
  const merlonH = 0.62;
  const merlonY = parapetBaseY + 0.62 + merlonH * 0.5;
  const placeMerlonRow = (
    count: number,
    span: number,
    fixedCoord: number,
    alongX: boolean
  ) => {
    for (let i = 0; i < count; i++) {
      const along = -span * 0.5 + 0.55 + (i / (count - 1)) * (span - 1.1);
      const mw = alongX ? 0.78 : 0.44;
      const md = alongX ? 0.44 : 0.78;
      const m = new THREE.Mesh(createTiledBox(mw, merlonH, md, 1.4, 1.4), mats.graniteTrim);
      m.position.set(
        mainX + (alongX ? along : fixedCoord),
        merlonY,
        mainZ + (alongX ? fixedCoord : along)
      );
      setShadow(m, true, true);
      root.add(m);

      const mCap = new THREE.Mesh(
        new THREE.BoxGeometry(mw + 0.08, 0.09, md + 0.08),
        mats.graniteSteps
      );
      mCap.position.set(m.position.x, merlonY + merlonH * 0.5 + 0.04, m.position.z);
      setShadow(mCap, true, true);
      root.add(mCap);
    }
  };
  placeMerlonRow(7, mainW, mainD * 0.5 - 0.08, true);
  placeMerlonRow(7, mainW, -(mainD * 0.5 - 0.08), true);
  placeMerlonRow(5, mainD - 1.0, mainW * 0.5 - 0.08, false);
  placeMerlonRow(5, mainD - 1.0, -(mainW * 0.5 - 0.08), false);

  // Recessed upper stone roof pavilion + sloped slate roof + tall granite castle chimney
  const attic = new THREE.Mesh(
    createTiledBox(5.6, 1.9, 4.2, 2.4, 2.4),
    mats.huashiStone
  );
  attic.position.set(mainX + 0.5, parapetBaseY + 1.4, mainZ - 0.2);
  setShadow(attic, true, true);
  root.add(attic);

  addHippedRoof(root, {
    x: mainX + 0.5,
    y: parapetBaseY + 2.35,
    z: mainZ - 0.2,
    baseW: 6.3,
    baseD: 4.9,
    topW: 2.2,
    topD: 0.0,
    height: 2.0,
    roofMat: mats.slateTurret,
    trimMat: mats.graniteTrim,
    tileSize: 1.5
  });

  addChimney(
    root,
    mainX + 3.6,
    parapetBaseY + 0.2,
    parapetBaseY + 3.9,
    mainZ - 2.3,
    1.1,
    0.95,
    mats.huashiStone,
    mats.graniteTrim,
    2
  );

  // 4. Seaward East Polygonal Bay Projection (+X side overlooking Yellow Sea cliffs)
  const bayX = mainX + mainW * 0.5 - 0.15;
  const bayZ = mainZ + 0.4;
  const bayR = 1.52;
  const bayH = 8.4;
  const bayPlinth = new THREE.Mesh(
    createTiledCylinder(bayR + 0.16, bayR + 0.24, plinthH, 6, 2.2, 2.0),
    mats.mushroomGranite
  );
  bayPlinth.position.set(bayX, plinthBottom + plinthH * 0.5, bayZ);
  setShadow(bayPlinth, true, true);
  root.add(bayPlinth);

  const bay = new THREE.Mesh(
    createTiledCylinder(bayR - 0.04, bayR, bayH, 6, 2.2, 2.4),
    mats.huashiStone
  );
  bay.position.set(bayX, plinthTop + bayH * 0.5, bayZ);
  setShadow(bay, true, true);
  root.add(bay);

  const bayCap = new THREE.Mesh(
    createTiledCone(bayR + 0.28, 1.85, 6, 1.4, 1.4),
    mats.slateTurret
  );
  bayCap.position.set(bayX, plinthTop + bayH + 0.92, bayZ);
  setShadow(bayCap, true, true);
  root.add(bayCap);

  // Narrow Gothic lancet windows on seaward polygonal bay
  for (const wy of [3.2, 6.2, 8.6]) {
    for (const ang of [-0.55, 0, 0.55]) {
      const a = Math.PI * 0.5 + ang;
      addArchedWindow(root, {
        x: bayX + Math.sin(a) * (bayR - 0.12),
        y: wy,
        z: bayZ + Math.cos(a) * (bayR - 0.12),
        w: 0.58,
        h: 1.4,
        rotY: a,
        pointed: true,
        glassMat: winWarmB,
        stoneMat: mats.graniteTrim,
        mullionMat: mats.graniteDark
      });
    }
  }

  // 5. ICONIC TALL CIRCULAR CORNER WATCHTOWER TURRET with conical slate spire!
  const turretX = -4.65;
  const turretZ = 2.95;
  const turretR = 2.38;
  const turretShaftTop = 13.4;

  // Grounded circular rustic granite base drum
  const drumH = plinthTop + 0.5 - plinthBottom;
  const turretBase = new THREE.Mesh(
    createTiledCylinder(turretR + 0.22, turretR + 0.36, drumH, 20, 2.4, 2.2),
    mats.mushroomGranite
  );
  turretBase.position.set(turretX, plinthBottom + drumH * 0.5, turretZ);
  setShadow(turretBase, true, true);
  root.add(turretBase);

  // Tall circular pebble-stone watchtower shaft
  const shaftH = turretShaftTop - (plinthTop + 0.4);
  const turretShaft = new THREE.Mesh(
    createTiledCylinder(turretR - 0.08, turretR, shaftH, 24, 2.4, 2.6),
    mats.huashiStone
  );
  turretShaft.position.set(turretX, plinthTop + 0.4 + shaftH * 0.5, turretZ);
  setShadow(turretShaft, true, true);
  root.add(turretShaft);

  // Carved stone belt rings & machicolation corbel crown under turret eaves
  for (const ry of [4.65, 7.9, 11.0, 12.95]) {
    const ring = new THREE.Mesh(
      createTiledCylinder(turretR + 0.14, turretR + 0.12, 0.24, 24, 2.0, 1.0),
      mats.graniteTrim
    );
    ring.position.set(turretX, ry, turretZ);
    setShadow(ring, true, true);
    root.add(ring);
  }

  // Corbeled brackets & turret battlement collar right below the conical spire
  const corbelCount = 16;
  const corbelGeom = new THREE.BoxGeometry(0.24, 0.44, 0.36);
  for (let i = 0; i < corbelCount; i++) {
    const a = (i / corbelCount) * Math.PI * 2;
    const cMesh = new THREE.Mesh(corbelGeom, mats.graniteTrim);
    cMesh.position.set(
      turretX + Math.sin(a) * (turretR + 0.06),
      turretShaftTop - 0.26,
      turretZ + Math.cos(a) * (turretR + 0.06)
    );
    cMesh.rotation.y = a;
    setShadow(cMesh, true, true);
    root.add(cMesh);
  }

  // Narrow glowing Gothic turret windows spiralling up the circular tower
  const turretWindows: [number, number][] = [
    [3.3, 0.15],
    [3.3, -1.35],
    [6.3, 0.65],
    [6.3, -0.85],
    [6.3, -2.2],
    [9.4, 0.1],
    [9.4, -1.25],
    [9.4, 1.45],
    [12.0, -0.35],
    [12.0, 0.85],
    [12.0, -1.65],
    [12.0, 2.2]
  ];
  for (const [wy, ang] of turretWindows) {
    const frac = clamp((wy - (plinthTop + 0.4)) / shaftH, 0, 1);
    const localR = turretR - frac * 0.08 - 0.06;
    addArchedWindow(root, {
      x: turretX + Math.sin(ang) * localR,
      y: wy,
      z: turretZ + Math.cos(ang) * localR,
      w: 0.62,
      h: 1.46,
      rotY: ang,
      pointed: true,
      glassMat: winTower,
      stoneMat: mats.graniteTrim,
      mullionMat: mats.graniteDark
    });
  }

  // Iconic Conical Turret Spire Roof (slateTurretRoof) + copper collar + wrought-iron finial!
  const spireH = 5.1;
  const spire = new THREE.Mesh(
    createTiledCone(turretR + 0.42, spireH, 24, 1.45, 1.45),
    mats.slateTurret
  );
  spire.position.set(turretX, turretShaftTop + spireH * 0.5 - 0.08, turretZ);
  setShadow(spire, true, true);
  root.add(spire);

  // Decorative spire gablet dormer window peeking out toward the bay
  const spireCap = new THREE.Mesh(
    new THREE.ConeGeometry(0.32, 0.72, 10),
    mats.agedCopper
  );
  spireCap.position.set(turretX, turretShaftTop + spireH + 0.2, turretZ);
  root.add(spireCap);

  const finialPole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.045, 1.85, 8),
    mats.wroughtIron
  );
  finialPole.position.set(turretX, turretShaftTop + spireH + 1.12, turretZ);
  root.add(finialPole);

  const finialOrb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), mats.agedCopper);
  finialOrb.position.set(turretX, turretShaftTop + spireH + 1.05, turretZ);
  root.add(finialOrb);

  const crossBar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.05), mats.wroughtIron);
  crossBar.position.set(turretX, turretShaftTop + spireH + 1.65, turretZ);
  root.add(crossBar);

  // Secondary rear-right round stair turret for rich 360-degree castle silhouette
  const rearTurretX = mainX + mainW * 0.5 - 0.35;
  const rearTurretZ = mainZ - mainD * 0.5 + 0.25;
  const rearBase = new THREE.Mesh(
    createTiledCylinder(1.52, 1.62, plinthH + 0.2, 16, 2.2, 2.0),
    mats.mushroomGranite
  );
  rearBase.position.set(rearTurretX, plinthBottom + (plinthH + 0.2) * 0.5, rearTurretZ);
  setShadow(rearBase, true, true);
  root.add(rearBase);

  const rearTurret = new THREE.Mesh(
    createTiledCylinder(1.38, 1.46, 11.4, 16, 2.2, 2.4),
    mats.huashiStone
  );
  rearTurret.position.set(rearTurretX, plinthTop + 5.7, rearTurretZ);
  setShadow(rearTurret, true, true);
  root.add(rearTurret);

  const rearTurretCap = new THREE.Mesh(
    createTiledCylinder(1.52, 1.46, 0.72, 16, 1.8, 1.2),
    mats.graniteTrim
  );
  rearTurretCap.position.set(rearTurretX, plinthTop + 11.6, rearTurretZ);
  setShadow(rearTurretCap, true, true);
  root.add(rearTurretCap);

  // 6. Ground-Floor Arched Stone Loggia / Porch Veranda & 2nd-Floor Sea-Viewing Terrace
  const loggiaX = 1.6;
  const loggiaZ = 3.95; // projects in front of mainZ + mainD/2 = 3.0 up to z = 4.9
  const loggiaW = 7.4;
  const loggiaD = 2.05;
  const loggiaDeckY = plinthTop;
  const loggiaTopY = 4.65;

  // Grounded rustic stone sub-veranda base
  const loggiaSub = new THREE.Mesh(
    createTiledBox(loggiaW + 0.4, plinthH, loggiaD + 0.3, 2.4, 2.0),
    mats.mushroomGranite
  );
  loggiaSub.position.set(loggiaX, plinthBottom + plinthH * 0.5, loggiaZ);
  setShadow(loggiaSub, true, true);
  root.add(loggiaSub);

  // Three perforated Romanesque stone arches along front of loggia + side arch
  const bayW = loggiaW / 3;
  const archH = loggiaTopY - loggiaDeckY;
  for (let i = 0; i < 3; i++) {
    const bx = loggiaX - loggiaW * 0.5 + (i + 0.5) * bayW;
    addMasonryArchBay(root, {
      x: bx,
      y: loggiaDeckY,
      z: loggiaZ + loggiaD * 0.5 - 0.22,
      bayWidth: bayW,
      bayHeight: archH,
      archRadius: bayW * 0.38,
      depth: 0.44,
      wallMat: mats.huashiStone,
      trimMat: mats.graniteTrim
    });
  }

  // Granite columns supporting the loggia arches
  const colH = archH - bayW * 0.38 - 0.36;
  for (let i = 0; i <= 3; i++) {
    const cx = loggiaX - loggiaW * 0.5 + i * bayW;
    const colBase = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.32, 0.46), mats.graniteTrim);
    colBase.position.set(cx, loggiaDeckY + 0.16, loggiaZ + loggiaD * 0.5 - 0.22);
    setShadow(colBase, true, true);
    root.add(colBase);

    const shaft = new THREE.Mesh(
      createTiledCylinder(0.18, 0.21, colH, 12, 1.4, 1.8),
      mats.graniteSteps
    );
    shaft.position.set(cx, loggiaDeckY + 0.32 + colH * 0.5 - 0.1, loggiaZ + loggiaD * 0.5 - 0.22);
    setShadow(shaft, true, true);
    root.add(shaft);

    const capital = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.22, 0.48), mats.graniteTrim);
    capital.position.set(cx, loggiaDeckY + colH + 0.08, loggiaZ + loggiaD * 0.5 - 0.22);
    setShadow(capital, true, true);
    root.add(capital);
  }

  // Side masonry arch on the +X end of loggia
  addMasonryArchBay(root, {
    x: loggiaX + loggiaW * 0.5 - 0.22,
    y: loggiaDeckY,
    z: loggiaZ,
    bayWidth: loggiaD,
    bayHeight: archH,
    archRadius: loggiaD * 0.36,
    depth: 0.44,
    rotY: Math.PI / 2,
    wallMat: mats.huashiStone,
    trimMat: mats.graniteTrim
  });

  // Balcony slab & classical granite balustrade atop the loggia (2nd floor sea terrace!)
  const balcSlab = new THREE.Mesh(
    createTiledBox(loggiaW + 0.36, 0.24, loggiaD + 0.36, 2.2, 1.0),
    mats.graniteTrim
  );
  balcSlab.position.set(loggiaX, loggiaTopY + 0.1, loggiaZ);
  setShadow(balcSlab, true, true);
  root.add(balcSlab);

  addBalustrade(root, {
    x: loggiaX,
    y: loggiaTopY + 0.22,
    z: loggiaZ + loggiaD * 0.5 - 0.05,
    length: loggiaW,
    height: 1.0,
    mat: mats.graniteTrim,
    spacing: 0.36,
    withEndPiers: true
  });
  addBalustrade(root, {
    x: loggiaX + loggiaW * 0.5 - 0.05,
    y: loggiaTopY + 0.22,
    z: loggiaZ,
    length: loggiaD,
    height: 1.0,
    rotY: Math.PI / 2,
    mat: mats.graniteTrim,
    spacing: 0.34,
    withEndPiers: false
  });
  addBalustrade(root, {
    x: loggiaX - loggiaW * 0.5 + 0.05,
    y: loggiaTopY + 0.22,
    z: loggiaZ,
    length: loggiaD,
    height: 1.0,
    rotY: Math.PI / 2,
    mat: mats.graniteTrim,
    spacing: 0.34,
    withEndPiers: false
  });

  // Ground-floor balustrade flanking the central grand staircase opening
  for (const s of [-1, 1] as const) {
    addBalustrade(root, {
      x: loggiaX + s * (loggiaW * 0.33),
      y: loggiaDeckY,
      z: loggiaZ + loggiaD * 0.5 - 0.18,
      length: bayW - 0.35,
      height: 0.88,
      mat: mats.graniteTrim,
      spacing: 0.32
    });
  }

  // Grand stepped granite entrance staircase descending from the central loggia arch!
  addStoneStairs(root, {
    x: loggiaX,
    zStart: loggiaZ + loggiaD * 0.5,
    topY: loggiaDeckY,
    bottomY: 0,
    width: 2.35,
    runDepth: 1.22,
    steps: 6,
    stepMat: mats.graniteSteps,
    cheekMat: mats.mushroomGranite,
    ironMat: mats.wroughtIron
  });

  // Castle arched oak entrance door inside loggia + warm glowing hanging lantern (with hero point light!)
  const doorFrame = new THREE.Mesh(
    new THREE.BoxGeometry(1.72, 2.75, 0.22),
    mats.graniteTrim
  );
  doorFrame.position.set(loggiaX, loggiaDeckY + 1.38, mainZ + mainD * 0.5 + 0.04);
  root.add(doorFrame);

  const doorPanel = new THREE.Mesh(
    createTiledBox(1.42, 2.55, 0.14, 1.4, 2.2),
    mats.doorWood
  );
  doorPanel.position.set(loggiaX, loggiaDeckY + 1.3, mainZ + mainD * 0.5 + 0.12);
  root.add(doorPanel);

  addVintageLantern(root, mats, {
    x: loggiaX,
    y: loggiaTopY - 0.96,
    z: loggiaZ + 0.25,
    style: 'hanging',
    scale: 1.15,
    addPointLight: true,
    lightIntensity: 3.6
  });

  // Secondary granite entry landing on the -X approach side (facing Huashi Cape Path gate!)
  addStoneStairs(root, {
    x: mainX - mainW * 0.5 - 0.05,
    zStart: mainZ - 1.75,
    topY: plinthTop,
    bottomY: 0,
    width: 2.2,
    runDepth: 1.5,
    steps: 6,
    rotY: -Math.PI / 2,
    stepMat: mats.graniteSteps,
    cheekMat: mats.mushroomGranite,
    ironMat: mats.wroughtIron
  });

  // 7. Gothic Pointed-Arch & Romanesque Arched Windows on all 4 facades
  // Front (+Z) facade (centered over the 3 loggia arches & completely clear of turret!)
  for (const wx of [mainX - 1.85, mainX + 0.8, mainX + 3.45]) {
    addArchedWindow(root, {
      x: wx,
      y: 6.25,
      z: mainZ + mainD * 0.5 + 0.02,
      w: 1.36,
      h: 2.25,
      pointed: true,
      glassMat: winWarmA,
      stoneMat: mats.graniteTrim,
      mullionMat: mats.graniteDark
    });
    addArchedWindow(root, {
      x: wx,
      y: 9.15,
      z: mainZ + mainD * 0.5 + 0.02,
      w: 1.16,
      h: 1.85,
      pointed: true,
      glassMat: winWarmB,
      stoneMat: mats.graniteTrim,
      mullionMat: mats.graniteDark
    });
  }
  for (const wx of [mainX - 1.85, mainX + 3.45]) {
    addArchedWindow(root, {
      x: wx,
      y: 3.1,
      z: mainZ + mainD * 0.5 + 0.02,
      w: 1.25,
      h: 1.85,
      pointed: false,
      glassMat: winWarmA,
      stoneMat: mats.graniteTrim,
      mullionMat: mats.graniteDark
    });
  }

  // Left (-X) approach facade (prominent from Huashi Cape viewpoint!)
  for (const wz of [mainZ - 1.9, mainZ + 0.5]) {
    addArchedWindow(root, {
      x: mainX - mainW * 0.5 - 0.02,
      y: 6.25,
      z: wz,
      w: 1.35,
      h: 2.2,
      rotY: -Math.PI / 2,
      pointed: true,
      glassMat: winWarmA,
      stoneMat: mats.graniteTrim,
      mullionMat: mats.graniteDark
    });
    addArchedWindow(root, {
      x: mainX - mainW * 0.5 - 0.02,
      y: 9.15,
      z: wz,
      w: 1.15,
      h: 1.8,
      rotY: -Math.PI / 2,
      pointed: true,
      glassMat: winWarmB,
      stoneMat: mats.graniteTrim,
      mullionMat: mats.graniteDark
    });
  }
  // Approach side castle entrance portal with granite surround & heavy oak door!
  const sidePortalFrame = new THREE.Mesh(
    createTiledBox(0.24, 2.7, 1.75, 1.4, 1.4),
    mats.graniteTrim
  );
  sidePortalFrame.position.set(mainX - mainW * 0.5 - 0.05, plinthTop + 1.35, mainZ - 1.75);
  setShadow(sidePortalFrame, true, true);
  root.add(sidePortalFrame);

  const sidePortalDoor = new THREE.Mesh(
    createTiledBox(0.14, 2.45, 1.42, 1.4, 2.2),
    mats.doorWood
  );
  sidePortalDoor.position.set(mainX - mainW * 0.5 - 0.13, plinthTop + 1.24, mainZ - 1.75);
  root.add(sidePortalDoor);

  addVintageLantern(root, mats, {
    x: mainX - mainW * 0.5 - 0.25,
    y: 3.45,
    z: mainZ - 0.68,
    style: 'wall',
    rotY: -Math.PI / 2
  });

  // Back (-Z) inland facade
  for (const wx of [mainX - 3.2, mainX - 0.2, mainX + 2.6]) {
    for (const [wy, pointed, gm] of [
      [3.15, false, winWarmB],
      [6.25, true, winWarmA],
      [9.15, true, winWarmB]
    ] as const) {
      addArchedWindow(root, {
        x: wx,
        y: wy,
        z: mainZ - mainD * 0.5 - 0.02,
        w: 1.2,
        h: 1.85,
        rotY: Math.PI,
        pointed,
        glassMat: gm,
        stoneMat: mats.graniteTrim,
        mullionMat: mats.graniteDark
      });
    }
  }

  return root;
}

// ============================================================================
// 7. HERO LANDMARK 2 — 公主樓 (PRINCESS HOUSE · DANISH FAIRY-TALE VILLA)
// ============================================================================

function buildPrincessHouse(
  villa: VillaPlacement,
  mats: ArchMaterials
): THREE.Group {
  const root = new THREE.Group();
  root.name = 'villa_princess';
  root.position.set(villa.position[0], villa.baseElevation, villa.position[2]);
  root.rotation.y = villa.rotationY;

  const minTerrainLocal = sampleFootprintMinY(villa) - villa.baseElevation;
  const plinthBottom = Math.min(-1.9, minTerrainLocal - 1.7);
  const plinthTop = 1.25;
  const plinthH = plinthTop - plinthBottom;

  const winA = createWindowVariant(mats, 0xffbe68, 1.2, 0.9);
  const winB = createWindowVariant(mats, 0xffd082, 0.95, 2.5);
  const winTurret = createWindowVariant(mats, 0xffb355, 1.3, 4.0);

  // 1. Heavy Laoshan granite plinth base (mushroomGranite, zero floating!)
  const mainW = 10.6;
  const mainD = 7.4;
  const mainX = 0.2;
  const mainZ = -0.95;
  const eaveY = 6.35;
  const bodyH = eaveY - plinthTop;

  const plinth = new THREE.Mesh(
    createTiledBox(mainW + 0.45, plinthH, mainD + 0.45, 2.4, 2.0),
    mats.mushroomGranite
  );
  plinth.position.set(mainX, plinthBottom + plinthH * 0.5, mainZ);
  setShadow(plinth, true, true);
  root.add(plinth);

  const plinthCap = new THREE.Mesh(
    new THREE.BoxGeometry(mainW + 0.58, 0.14, mainD + 0.58),
    mats.whiteTrim
  );
  plinthCap.position.set(mainX, plinthTop + 0.04, mainZ);
  setShadow(plinthCap, true, true);
  root.add(plinthCap);

  // 2. Iconic Nordic Pale Blue-Green main facade with crisp ivory-white trim
  const mainBody = new THREE.Mesh(
    createTiledBox(mainW, bodyH, mainD, 2.8, 2.8),
    mats.nordicBlue
  );
  mainBody.position.set(mainX, plinthTop + bodyH * 0.5, mainZ);
  setShadow(mainBody, true, true);
  root.add(mainBody);

  // Crisp white Nordic corner pilasters & belt molding
  const pilGeom = new THREE.BoxGeometry(0.28, bodyH, 0.28);
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const pil = new THREE.Mesh(pilGeom, mats.whiteTrim);
      pil.position.set(
        mainX + sx * (mainW * 0.5 - 0.04),
        plinthTop + bodyH * 0.5,
        mainZ + sz * (mainD * 0.5 - 0.04)
      );
      setShadow(pil, true, true);
      root.add(pil);
    }
  }
  const belt = new THREE.Mesh(
    new THREE.BoxGeometry(mainW + 0.24, 0.16, mainD + 0.24),
    mats.whiteTrim
  );
  belt.position.set(mainX, 4.0, mainZ);
  setShadow(belt, true, true);
  root.add(belt);

  // End gable walls (along -X and +X ends of main volume) + white Nordic timber gable trim
  const ridgeH = 4.65;
  const mainGables = new THREE.Mesh(
    createGablePrism(mainD, ridgeH, mainW, 2.8, 2.8),
    mats.nordicBlue
  );
  mainGables.rotation.y = Math.PI / 2;
  mainGables.position.set(mainX, eaveY, mainZ);
  setShadow(mainGables, true, true);
  root.add(mainGables);

  for (const sx of [-1, 1] as const) {
    addFachwerkGable(root, {
      x: mainX + sx * (mainW * 0.5 + 0.03),
      y: eaveY,
      z: mainZ,
      width: mainD - 0.15,
      height: ridgeH - 0.15,
      rotY: sx > 0 ? Math.PI / 2 : -Math.PI / 2,
      timberMat: mats.whiteTrim
    });
  }

  // Steep terracotta red tiled main gabled roof with exposed white rafters!
  addGabledRoof(root, {
    x: mainX,
    y: eaveY,
    z: mainZ,
    ridgeLength: mainW,
    span: mainD,
    ridgeHeight: ridgeH,
    eaveOverhang: 0.65,
    gableOverhang: 0.55,
    roofMat: mats.redRoof,
    trimMat: mats.whiteTrim,
    rafterMat: mats.whiteTrim,
    tileSize: 1.75
  });

  // 3. Projecting Front-Right Storybook Cross-Gable Wing (+X, +Z side)
  const wingW = 4.4;
  const wingD = 2.05;
  const wingX = mainX + 2.65;
  const wingZ = mainZ + mainD * 0.5 + wingD * 0.5 - 0.15;

  const wingPlinth = new THREE.Mesh(
    createTiledBox(wingW + 0.35, plinthH, wingD + 0.35, 2.2, 2.0),
    mats.mushroomGranite
  );
  wingPlinth.position.set(wingX, plinthBottom + plinthH * 0.5, wingZ);
  setShadow(wingPlinth, true, true);
  root.add(wingPlinth);

  const wingBody = new THREE.Mesh(
    createTiledBox(wingW, bodyH, wingD, 2.8, 2.8),
    mats.nordicBlue
  );
  wingBody.position.set(wingX, plinthTop + bodyH * 0.5, wingZ);
  setShadow(wingBody, true, true);
  root.add(wingBody);

  const wingRidgeH = 3.55;
  const wingGable = new THREE.Mesh(
    createGablePrism(wingW, wingRidgeH, wingD + 2.4, 2.8, 2.8),
    mats.nordicBlue
  );
  wingGable.position.set(wingX, eaveY, wingZ - 1.2);
  setShadow(wingGable, true, true);
  root.add(wingGable);

  // Decorative white fairy-tale timber gable framing on front cross-gable
  addFachwerkGable(root, {
    x: wingX,
    y: eaveY,
    z: wingZ + wingD * 0.5 + 0.03,
    width: wingW - 0.12,
    height: wingRidgeH - 0.12,
    timberMat: mats.whiteTrim
  });

  // Steep cross-gable red tiled roof intersecting main roof cleanly
  addGabledRoof(root, {
    x: wingX,
    y: eaveY,
    z: wingZ - 1.15,
    ridgeLength: wingD + 2.3,
    span: wingW,
    ridgeHeight: wingRidgeH,
    eaveOverhang: 0.45,
    gableOverhang: 0.48,
    rotateY: Math.PI / 2,
    roofMat: mats.redRoof,
    trimMat: mats.whiteTrim,
    rafterMat: mats.whiteTrim,
    tileSize: 1.65
  });

  // Gable peak attic window on front cross-gable
  addArchedWindow(root, {
    x: wingX,
    y: eaveY + 1.35,
    z: wingZ + wingD * 0.5 + 0.02,
    w: 0.92,
    h: 1.38,
    pointed: true,
    glassMat: winB,
    stoneMat: mats.whiteTrim,
    mullionMat: mats.whiteTrim
  });

  // 4. SIGNATURE SLENDER POINTED CONICAL SPIRE TURRET (Front-Left / NW Corner!)
  // Visible from Juyongguan Spawn, Jiayuguan Rd, AND Princess House viewpoint!
  const turX = mainX - mainW * 0.5 + 0.25;
  const turZ = mainZ + mainD * 0.5 + 0.25;
  const turR = 1.48;
  const turTopY = 8.75;

  const turPlinth = new THREE.Mesh(
    createTiledCylinder(turR + 0.18, turR + 0.28, plinthH + 0.2, 18, 2.0, 2.0),
    mats.mushroomGranite
  );
  turPlinth.position.set(turX, plinthBottom + (plinthH + 0.2) * 0.5, turZ);
  setShadow(turPlinth, true, true);
  root.add(turPlinth);

  const turShaftH = turTopY - plinthTop;
  const turShaft = new THREE.Mesh(
    createTiledCylinder(turR, turR, turShaftH, 20, 2.4, 2.6),
    mats.nordicBlue
  );
  turShaft.position.set(turX, plinthTop + turShaftH * 0.5, turZ);
  setShadow(turShaft, true, true);
  root.add(turShaft);

  // Crisp white turret cornice rings & eaves corbel brackets
  for (const ry of [plinthTop + 0.08, 4.0, 6.4, turTopY - 0.12]) {
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(turR + 0.1, turR + 0.1, 0.16, 20),
      mats.whiteTrim
    );
    ring.position.set(turX, ry, turZ);
    setShadow(ring, true, true);
    root.add(ring);
  }

  // Storybook turret windows
  for (const [wy, ang] of [
    [2.75, -0.35],
    [2.75, -1.4],
    [5.3, 0.15],
    [5.3, -0.95],
    [7.55, -0.45],
    [7.55, 0.7],
    [7.55, -1.7]
  ] as const) {
    addRectWindow(root, {
      x: turX + Math.sin(ang) * (turR + 0.01),
      y: wy,
      z: turZ + Math.cos(ang) * (turR + 0.01),
      w: 0.68,
      h: 1.18,
      rotY: ang,
      glassMat: winTurret,
      frameMat: mats.whiteTrim
    });
  }

  // Slender fairy-tale conical terracotta-red tiled spire + copper orb finial!
  const turSpireH = 5.35;
  const turSpire = new THREE.Mesh(
    createTiledCone(turR + 0.36, turSpireH, 22, 1.3, 1.3),
    mats.redRoof
  );
  turSpire.position.set(turX, turTopY + turSpireH * 0.5 - 0.1, turZ);
  setShadow(turSpire, true, true);
  root.add(turSpire);

  const turFinialCap = new THREE.Mesh(
    new THREE.ConeGeometry(0.24, 0.55, 10),
    mats.agedCopper
  );
  turFinialCap.position.set(turX, turTopY + turSpireH + 0.12, turZ);
  root.add(turFinialCap);

  const turFinialRod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.035, 1.35, 8),
    mats.agedCopper
  );
  turFinialRod.position.set(turX, turTopY + turSpireH + 0.82, turZ);
  root.add(turFinialRod);

  const turOrb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 8), mats.agedCopper);
  turOrb.position.set(turX, turTopY + turSpireH + 0.75, turZ);
  root.add(turOrb);

  // 5. Charming Roof Dormers & Tall Brick Chimney
  addRoofDormer(root, {
    x: mainX - 1.35,
    y: eaveY + 0.85,
    z: mainZ + mainD * 0.5 - 1.05,
    w: 1.5,
    h: 1.3,
    d: 1.8,
    wallMat: mats.nordicBlue,
    roofMat: mats.redRoof,
    trimMat: mats.whiteTrim,
    glassMat: winB
  });
  for (const dx of [mainX - 2.3, mainX + 2.3]) {
    addRoofDormer(root, {
      x: dx,
      y: eaveY + 0.85,
      z: mainZ - mainD * 0.5 + 1.05,
      rotY: Math.PI,
      w: 1.5,
      h: 1.3,
      d: 1.8,
      wallMat: mats.nordicBlue,
      roofMat: mats.redRoof,
      trimMat: mats.whiteTrim,
      glassMat: winA
    });
  }

  addChimney(
    root,
    mainX + 0.6,
    eaveY + 1.2,
    eaveY + ridgeH + 1.35,
    mainZ - 1.65,
    0.95,
    0.88,
    mats.redBrickChimney,
    mats.whiteTrim,
    2
  );

  // 6. Cozy Stone-Stepped Timber Porch Entrance (between turret and cross-gable wing!)
  const porchX = mainX - 1.35;
  const porchZ = mainZ + mainD * 0.5 + 0.95;
  const porchW = 3.1;
  const porchD = 1.9;

  const porchBase = new THREE.Mesh(
    createTiledBox(porchW + 0.2, plinthH, porchD + 0.2, 2.0, 2.0),
    mats.mushroomGranite
  );
  porchBase.position.set(porchX, plinthBottom + plinthH * 0.5, porchZ);
  setShadow(porchBase, true, true);
  root.add(porchBase);

  const porchDeck = new THREE.Mesh(
    createTiledBox(porchW + 0.28, 0.14, porchD + 0.28, 1.6, 1.6),
    mats.warmTimber
  );
  porchDeck.position.set(porchX, plinthTop + 0.04, porchZ);
  setShadow(porchDeck, true, true);
  root.add(porchDeck);

  // White timber porch posts & diagonal knee-braces supporting a red-tile porch canopy
  const porchRoofY = plinthTop + 2.52;
  for (const sx of [-1, 1] as const) {
    const px = porchX + sx * (porchW * 0.5 - 0.16);
    const pz = porchZ + porchD * 0.5 - 0.16;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.52, 0.16), mats.whiteTrim);
    post.position.set(px, plinthTop + 1.26, pz);
    setShadow(post, true, true);
    root.add(post);

    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.56, 0.1), mats.whiteTrim);
    brace.position.set(px - sx * 0.18, porchRoofY - 0.22, pz);
    brace.rotation.z = sx * 0.72;
    root.add(brace);
  }

  addGabledRoof(root, {
    x: porchX,
    y: porchRoofY,
    z: porchZ - 0.1,
    ridgeLength: porchD + 0.4,
    span: porchW + 0.3,
    ridgeHeight: 0.72,
    eaveOverhang: 0.24,
    gableOverhang: 0.26,
    rotateY: Math.PI / 2,
    roofMat: mats.redRoof,
    trimMat: mats.whiteTrim,
    tileSize: 1.35,
    withRafters: false
  });

  // Front granite steps descending into courtyard (strictly inside footprintDepth/2 = 5.4!)
  addStoneStairs(root, {
    x: porchX,
    zStart: porchZ + porchD * 0.5,
    topY: plinthTop + 0.05,
    bottomY: 0,
    width: 1.9,
    runDepth: 0.9,
    steps: 5,
    stepMat: mats.graniteSteps,
    cheekMat: mats.mushroomGranite,
    ironMat: mats.whiteTrim
  });

  // Charming Nordic paneled front door + warm hanging porch lantern + hero point light
  const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(1.48, 2.38, 0.18), mats.whiteTrim);
  doorFrame.position.set(porchX, plinthTop + 1.19, mainZ + mainD * 0.5 + 0.04);
  root.add(doorFrame);

  const door = new THREE.Mesh(createTiledBox(1.22, 2.18, 0.12, 1.2, 2.0), mats.doorWood);
  door.position.set(porchX, plinthTop + 1.11, mainZ + mainD * 0.5 + 0.09);
  root.add(door);

  addVintageLantern(root, mats, {
    x: porchX,
    y: porchRoofY - 0.88,
    z: porchZ + 0.25,
    style: 'hanging',
    scale: 0.95,
    addPointLight: true,
    lightIntensity: 3.1
  });

  // 7. Crisp White-Framed Multi-Pane Windows on all 4 facades
  // Front (+Z) wing windows (2 stories)
  for (const wy of [2.75, 5.25]) {
    addRectWindow(root, {
      x: wingX - 0.9,
      y: wy,
      z: wingZ + wingD * 0.5 + 0.02,
      w: 1.15,
      h: 1.55,
      glassMat: winA,
      frameMat: mats.whiteTrim,
      withPediment: true
    });
    addRectWindow(root, {
      x: wingX + 0.9,
      y: wy,
      z: wingZ + wingD * 0.5 + 0.02,
      w: 1.15,
      h: 1.55,
      glassMat: winB,
      frameMat: mats.whiteTrim,
      withPediment: true
    });
  }
  // Upper window cleanly perched above the porch gable ridge
  addRectWindow(root, {
    x: porchX,
    y: 5.42,
    z: mainZ + mainD * 0.5 + 0.02,
    w: 1.32,
    h: 1.32,
    glassMat: winA,
    frameMat: mats.whiteTrim
  });

  // Side (-X North toward spawn & +X South) windows
  for (const sx of [-1, 1] as const) {
    const wx = mainX + sx * (mainW * 0.5 + 0.02);
    const ry = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    for (const wz of [mainZ - 1.85, mainZ + 0.85]) {
      for (const wy of [2.75, 5.25]) {
        addRectWindow(root, {
          x: wx,
          y: wy,
          z: wz,
          w: 1.2,
          h: 1.55,
          rotY: ry,
          glassMat: wy > 4 ? winB : winA,
          frameMat: mats.whiteTrim
        });
      }
    }
    // Gable peak window
    addRectWindow(root, {
      x: wx,
      y: eaveY + 1.55,
      z: mainZ,
      w: 1.1,
      h: 1.42,
      rotY: ry,
      glassMat: winB,
      frameMat: mats.whiteTrim
    });
  }

  // Rear (-Z) garden facade windows
  for (const wx of [mainX - 3.2, mainX, mainX + 3.2]) {
    for (const wy of [2.75, 5.25]) {
      addRectWindow(root, {
        x: wx,
        y: wy,
        z: mainZ - mainD * 0.5 - 0.02,
        w: 1.25,
        h: 1.55,
        rotY: Math.PI,
        glassMat: wx === mainX ? winA : winB,
        frameMat: mats.whiteTrim
      });
    }
  }

  return root;
}

// ============================================================================
// 8. HERO LANDMARK 3 — 蝴蝶樓 (BUTTERFLY VILLA · 1934 EUROPEAN RESIDENCE)
// ============================================================================

function buildButterflyVilla(
  villa: VillaPlacement,
  mats: ArchMaterials
): THREE.Group {
  const root = new THREE.Group();
  root.name = 'villa_butterfly';
  root.position.set(villa.position[0], villa.baseElevation, villa.position[2]);
  root.rotation.y = villa.rotationY;

  const minTerrainLocal = sampleFootprintMinY(villa) - villa.baseElevation;
  const plinthBottom = Math.min(-2.0, minTerrainLocal - 1.8);
  const plinthTop = 1.32;
  const plinthH = plinthTop - plinthBottom;

  const winA = createWindowVariant(mats, 0xffbd66, 1.15, 1.3);
  const winB = createWindowVariant(mats, 0xffcc7e, 0.88, 2.8);

  const mainW = 13.4;
  const mainD = 8.0;
  const mainZ = -1.0;
  const eaveY = 7.95;
  const bodyH = eaveY - plinthTop;

  // 1. Distinctive reddish-brown granite/brick foundation base
  const plinth = new THREE.Mesh(
    createTiledBox(mainW + 0.48, plinthH, mainD + 0.48, 2.4, 2.0),
    mats.mushroomGraniteWarm
  );
  plinth.position.set(0, plinthBottom + plinthH * 0.5, mainZ);
  setShadow(plinth, true, true);
  root.add(plinth);

  const plinthLedge = new THREE.Mesh(
    new THREE.BoxGeometry(mainW + 0.62, 0.16, mainD + 0.62),
    mats.creamStone
  );
  plinthLedge.position.set(0, plinthTop + 0.05, mainZ);
  setShadow(plinthLedge, true, true);
  root.add(plinthLedge);

  // 2. Symmetrical warm cream-ochre European stucco main body
  const mainBody = new THREE.Mesh(
    createTiledBox(mainW, bodyH, mainD, 3.0, 3.0),
    mats.butterflyStucco
  );
  mainBody.position.set(0, plinthTop + bodyH * 0.5, mainZ);
  setShadow(mainBody, true, true);
  root.add(mainBody);

  // Classical stone belt course, corner pilasters, & dentil cornice under deep eaves
  const belt = new THREE.Mesh(
    new THREE.BoxGeometry(mainW + 0.28, 0.22, mainD + 0.28),
    mats.creamStone
  );
  belt.position.set(0, 4.62, mainZ);
  setShadow(belt, true, true);
  root.add(belt);

  const cornice = new THREE.Mesh(
    new THREE.BoxGeometry(mainW + 0.46, 0.26, mainD + 0.46),
    mats.whiteTrim
  );
  cornice.position.set(0, eaveY - 0.12, mainZ);
  setShadow(cornice, true, true);
  root.add(cornice);

  // Rusticated cream corner pilasters
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      addCornerQuoins(
        root,
        sx * (mainW * 0.5),
        mainZ + sz * (mainD * 0.5),
        plinthTop + 0.14,
        eaveY - 0.25,
        mats.creamStone,
        0.52,
        0.32
      );
    }
  }

  // 3. Central Projecting Second-Floor Classical Balcony & Columned Entrance Portico
  const portW = 4.1;
  const portD = 1.55;
  const portZ = mainZ + mainD * 0.5 + portD * 0.5;
  const balcY = 4.68;

  // Grounded porch base under portico
  const portBase = new THREE.Mesh(
    createTiledBox(portW + 0.3, plinthH, portD + 0.3, 2.2, 2.0),
    mats.mushroomGraniteWarm
  );
  portBase.position.set(0, plinthBottom + plinthH * 0.5, portZ);
  setShadow(portBase, true, true);
  root.add(portBase);

  const portFloor = new THREE.Mesh(
    createTiledBox(portW + 0.36, 0.14, portD + 0.36, 1.8, 1.8),
    mats.graniteSteps
  );
  portFloor.position.set(0, plinthTop + 0.05, portZ);
  setShadow(portFloor, true, true);
  root.add(portFloor);

  // Four classical white Tuscan columns supporting the symmetrical 2nd-floor balcony
  const colPositions = [-portW * 0.44, -portW * 0.18, portW * 0.18, portW * 0.44];
  const colH = balcY - plinthTop - 0.1;
  for (const cx of colPositions) {
    const cPlinth = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.24, 0.42), mats.whiteTrim);
    cPlinth.position.set(cx, plinthTop + 0.2, portZ + portD * 0.5 - 0.24);
    setShadow(cPlinth, true, true);
    root.add(cPlinth);

    const col = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.18, colH - 0.36, 14),
      mats.whiteTrim
    );
    col.position.set(cx, plinthTop + 0.22 + (colH - 0.36) * 0.5, portZ + portD * 0.5 - 0.24);
    setShadow(col, true, true);
    root.add(col);

    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.18, 0.44), mats.whiteTrim);
    cap.position.set(cx, balcY - 0.09, portZ + portD * 0.5 - 0.24);
    setShadow(cap, true, true);
    root.add(cap);
  }

  // Balcony stone deck & classical white stone balustrade!
  const balcDeck = new THREE.Mesh(
    new THREE.BoxGeometry(portW + 0.48, 0.24, portD + 0.4),
    mats.whiteTrim
  );
  balcDeck.position.set(0, balcY + 0.1, portZ + 0.05);
  setShadow(balcDeck, true, true);
  root.add(balcDeck);

  addBalustrade(root, {
    x: 0,
    y: balcY + 0.22,
    z: portZ + portD * 0.5 + 0.08,
    length: portW + 0.18,
    height: 0.98,
    mat: mats.whiteTrim,
    spacing: 0.3,
    withEndPiers: true
  });
  for (const sx of [-1, 1] as const) {
    addBalustrade(root, {
      x: sx * (portW * 0.5 + 0.08),
      y: balcY + 0.22,
      z: portZ + 0.05,
      length: portD + 0.12,
      height: 0.98,
      rotY: Math.PI / 2,
      mat: mats.whiteTrim,
      spacing: 0.3
    });
  }

  // Front symmetrical stone entrance steps (strictly inside footprintDepth/2 = 5.5!)
  addStoneStairs(root, {
    x: 0,
    zStart: portZ + portD * 0.5,
    topY: plinthTop + 0.08,
    bottomY: 0,
    width: 2.3,
    runDepth: 0.9,
    steps: 5,
    stepMat: mats.graniteSteps,
    cheekMat: mats.creamStone,
    ironMat: mats.wroughtIron
  });

  // Grand double entrance door + twin warm brass entrance sconces & hero point light
  const doorSurround = new THREE.Mesh(new THREE.BoxGeometry(1.95, 2.68, 0.18), mats.whiteTrim);
  doorSurround.position.set(0, plinthTop + 1.34, mainZ + mainD * 0.5 + 0.04);
  root.add(doorSurround);

  const doorPanel = new THREE.Mesh(createTiledBox(1.66, 2.48, 0.12, 1.4, 2.2), mats.doorWood);
  doorPanel.position.set(0, plinthTop + 1.24, mainZ + mainD * 0.5 + 0.09);
  root.add(doorPanel);

  for (const sx of [-1, 1] as const) {
    addVintageLantern(root, mats, {
      x: sx * 1.28,
      y: plinthTop + 1.8,
      z: mainZ + mainD * 0.5 + 0.24,
      style: 'wall',
      scale: 0.9,
      addPointLight: sx === 1,
      lightIntensity: 3.0
    });
  }

  // 4. Classic Multi-Pane Windows with Forest-Green Louvered Shutters on ALL 4 FACADES!
  // Front (+Z) symmetrical 5-bay rhythm with crisp shutter clearance around balcony & quoins
  for (const wx of [-5.2, -3.25, 3.25, 5.2]) {
    addRectWindow(root, {
      x: wx,
      y: 2.92,
      z: mainZ + mainD * 0.5 + 0.02,
      w: 0.98,
      h: 1.7,
      glassMat: winA,
      frameMat: mats.whiteTrim,
      sillMat: mats.creamStone,
      shutterMat: mats.shutterGreen,
      withPediment: true
    });
    addRectWindow(root, {
      x: wx,
      y: 6.18,
      z: mainZ + mainD * 0.5 + 0.02,
      w: 0.98,
      h: 1.7,
      glassMat: winB,
      frameMat: mats.whiteTrim,
      sillMat: mats.creamStone,
      shutterMat: mats.shutterGreen,
      withPediment: true
    });
  }
  // Tall central French balcony doors on 2nd floor behind white balustrade
  addRectWindow(root, {
    x: 0,
    y: 6.1,
    z: mainZ + mainD * 0.5 + 0.02,
    w: 1.62,
    h: 2.35,
    glassMat: winA,
    frameMat: mats.whiteTrim,
    sillMat: mats.creamStone,
    shutterMat: mats.shutterGreen,
    withPediment: true
  });

  // Back (-Z, prominently seen from maple_butterfly viewpoint!) symmetrical 5-bay windows with green shutters
  for (const wx of [-4.8, -2.4, 0, 2.4, 4.8]) {
    for (const [wy, gm] of [
      [2.92, winB],
      [6.18, winA]
    ] as const) {
      addRectWindow(root, {
        x: wx,
        y: wy,
        z: mainZ - mainD * 0.5 - 0.02,
        w: 1.04,
        h: 1.7,
        rotY: Math.PI,
        glassMat: gm,
        frameMat: mats.whiteTrim,
        sillMat: mats.creamStone,
        shutterMat: mats.shutterGreen,
        withPediment: true
      });
    }
  }

  // East (+X) and West (-X) symmetrical 3-bay windows with green shutters
  for (const sx of [-1, 1] as const) {
    const wx = sx * (mainW * 0.5 + 0.02);
    const rotY = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    for (const wz of [mainZ - 2.35, mainZ, mainZ + 2.35]) {
      for (const [wy, gm] of [
        [2.92, winA],
        [6.18, winB]
      ] as const) {
        addRectWindow(root, {
          x: wx,
          y: wy,
          z: wz,
          w: 0.98,
          h: 1.65,
          rotY,
          glassMat: gm,
          frameMat: mats.whiteTrim,
          sillMat: mats.creamStone,
          shutterMat: mats.shutterGreen
        });
      }
    }
  }

  // 5. Sweeping Red Clay Hipped Roof with Deep Eaves, Dormers, & Twin Brick Chimneys
  addHippedRoof(root, {
    x: 0,
    y: eaveY,
    z: mainZ,
    baseW: mainW + 1.5,
    baseD: mainD + 1.5,
    topW: 5.8,
    topD: 0.0,
    height: 3.55,
    roofMat: mats.redRoof,
    trimMat: mats.whiteTrim,
    tileSize: 1.85
  });

  // Front & back central classic roof dormers
  addRoofDormer(root, {
    x: 0,
    y: eaveY + 0.65,
    z: mainZ + mainD * 0.5 - 0.85,
    w: 1.65,
    h: 1.3,
    d: 1.85,
    wallMat: mats.butterflyStucco,
    roofMat: mats.redRoof,
    trimMat: mats.whiteTrim,
    glassMat: winB
  });
  addRoofDormer(root, {
    x: 0,
    y: eaveY + 0.65,
    z: mainZ - mainD * 0.5 + 0.85,
    rotY: Math.PI,
    w: 1.65,
    h: 1.3,
    d: 1.85,
    wallMat: mats.butterflyStucco,
    roofMat: mats.redRoof,
    trimMat: mats.whiteTrim,
    glassMat: winA
  });

  // Symmetrical twin red-brick chimneys
  for (const sx of [-1, 1] as const) {
    addChimney(
      root,
      sx * 3.3,
      eaveY + 1.0,
      eaveY + 4.45,
      mainZ - 0.9,
      0.95,
      0.85,
      mats.redBrickChimney,
      mats.creamStone,
      2
    );
  }

  return root;
}

// ============================================================================
// 9. SUPPORTING BADAGUAN EUROPEAN RED-TILE VILLAS (4 DISTINCT ARCHETYPES)
// ============================================================================

/** Style 4: German Jugendstil Ochre & Fachwerk Gable Villa with Oriel Bay (`german_ginkgo`). */
function buildGermanGinkgoVilla(
  villa: VillaPlacement,
  mats: ArchMaterials
): THREE.Group {
  const root = new THREE.Group();
  root.name = `villa_${villa.id}`;
  root.position.set(villa.position[0], villa.baseElevation, villa.position[2]);
  root.rotation.y = villa.rotationY;

  const minTerrainLocal = sampleFootprintMinY(villa) - villa.baseElevation;
  const plinthBottom = Math.min(-2.0, minTerrainLocal - 1.8);
  const plinthTop = 1.4;
  const plinthH = plinthTop - plinthBottom;

  const winA = createWindowVariant(mats, 0xffb75d, 1.1, 0.5);
  const winB = createWindowVariant(mats, 0xffca7a, 0.72, 2.2);

  const mainW = 10.6;
  const mainD = 7.4;
  const mainZ = -1.0;
  const eaveY = 6.75;
  const bodyH = eaveY - plinthTop;

  // Heavy Qingdao mushroom-stone ground plinth
  const plinth = new THREE.Mesh(
    createTiledBox(mainW + 0.45, plinthH, mainD + 0.45, 2.4, 2.0),
    mats.mushroomGranite
  );
  plinth.position.set(0, plinthBottom + plinthH * 0.5, mainZ);
  setShadow(plinth, true, true);
  root.add(plinth);

  const ledge = new THREE.Mesh(
    new THREE.BoxGeometry(mainW + 0.6, 0.16, mainD + 0.6),
    mats.graniteTrim
  );
  ledge.position.set(0, plinthTop + 0.04, mainZ);
  setShadow(ledge, true, true);
  root.add(ledge);

  // Warm sunlit ochre stucco body
  const body = new THREE.Mesh(
    createTiledBox(mainW, bodyH, mainD, 2.8, 2.8),
    mats.ochreStucco
  );
  body.position.set(0, plinthTop + bodyH * 0.5, mainZ);
  setShadow(body, true, true);
  root.add(body);

  // Main end gables + German dark-walnut Fachwerk half-timbering
  const ridgeH = 4.15;
  const gables = new THREE.Mesh(
    createGablePrism(mainD, ridgeH, mainW, 2.8, 2.8),
    mats.ochreStucco
  );
  gables.rotation.y = Math.PI / 2;
  gables.position.set(0, eaveY, mainZ);
  setShadow(gables, true, true);
  root.add(gables);

  for (const sx of [-1, 1] as const) {
    addFachwerkGable(root, {
      x: sx * (mainW * 0.5 + 0.03),
      y: eaveY,
      z: mainZ,
      width: mainD - 0.1,
      height: ridgeH - 0.1,
      rotY: sx > 0 ? Math.PI / 2 : -Math.PI / 2,
      timberMat: mats.darkTimber
    });
  }

  addGabledRoof(root, {
    x: 0,
    y: eaveY,
    z: mainZ,
    ridgeLength: mainW,
    span: mainD,
    ridgeHeight: ridgeH,
    eaveOverhang: 0.6,
    gableOverhang: 0.48,
    roofMat: mats.redRoof,
    trimMat: mats.darkTimber,
    rafterMat: mats.darkTimber,
    tileSize: 1.8
  });

  // Projecting front-left half-timbered cross-gable wing
  const wingW = 4.6;
  const wingD = 1.75;
  const wingX = -2.7;
  const wingZ = mainZ + mainD * 0.5 + wingD * 0.5 - 0.15;

  const wPlinth = new THREE.Mesh(
    createTiledBox(wingW + 0.3, plinthH, wingD + 0.3, 2.2, 2.0),
    mats.mushroomGranite
  );
  wPlinth.position.set(wingX, plinthBottom + plinthH * 0.5, wingZ);
  setShadow(wPlinth, true, true);
  root.add(wPlinth);

  const wBody = new THREE.Mesh(
    createTiledBox(wingW, bodyH, wingD, 2.8, 2.8),
    mats.ochreStucco
  );
  wBody.position.set(wingX, plinthTop + bodyH * 0.5, wingZ);
  setShadow(wBody, true, true);
  root.add(wBody);

  const wRidgeH = 3.2;
  const wGable = new THREE.Mesh(
    createGablePrism(wingW, wRidgeH, wingD + 2.2, 2.8, 2.8),
    mats.ochreStucco
  );
  wGable.position.set(wingX, eaveY, wingZ - 1.1);
  setShadow(wGable, true, true);
  root.add(wGable);

  addFachwerkGable(root, {
    x: wingX,
    y: eaveY,
    z: wingZ + wingD * 0.5 + 0.04,
    width: wingW - 0.1,
    height: wRidgeH - 0.1,
    timberMat: mats.darkTimber
  });

  addGabledRoof(root, {
    x: wingX,
    y: eaveY,
    z: wingZ - 1.0,
    ridgeLength: wingD + 2.2,
    span: wingW,
    ridgeHeight: wRidgeH,
    eaveOverhang: 0.42,
    gableOverhang: 0.45,
    rotateY: Math.PI / 2,
    roofMat: mats.redRoof,
    trimMat: mats.darkTimber,
    rafterMat: mats.darkTimber,
    tileSize: 1.7
  });

  // Projecting polygonal corner oriel bay window on front-right corner!
  const bayX = mainW * 0.5 - 0.25;
  const bayZ = mainZ + mainD * 0.5 - 0.15;
  const bayBase = new THREE.Mesh(
    createTiledCylinder(1.32, 1.4, plinthH + 2.7, 6, 2.0, 2.0),
    mats.mushroomGranite
  );
  bayBase.position.set(bayX, plinthBottom + (plinthH + 2.7) * 0.5, bayZ);
  setShadow(bayBase, true, true);
  root.add(bayBase);

  const bayUpper = new THREE.Mesh(
    createTiledCylinder(1.36, 1.36, 2.95, 6, 2.2, 2.2),
    mats.ochreStucco
  );
  bayUpper.position.set(bayX, plinthTop + 2.7 + 1.48, bayZ);
  setShadow(bayUpper, true, true);
  root.add(bayUpper);

  const bayRoof = new THREE.Mesh(
    createTiledCone(1.62, 2.45, 6, 1.4, 1.4),
    mats.redRoof
  );
  bayRoof.position.set(bayX, eaveY + 1.48, bayZ);
  setShadow(bayRoof, true, true);
  root.add(bayRoof);

  for (const ang of [-0.35, 0.55, 1.45]) {
    addRectWindow(root, {
      x: bayX + Math.sin(ang) * 1.24,
      y: 5.45,
      z: bayZ + Math.cos(ang) * 1.24,
      w: 0.72,
      h: 1.32,
      rotY: ang,
      glassMat: winA,
      frameMat: mats.whiteTrim
    });
  }

  // Arched granite entrance porch & steps
  const porchX = 1.45;
  const porchZ = mainZ + mainD * 0.5 + 0.85;
  const porchBase = new THREE.Mesh(
    createTiledBox(2.8, plinthH, 1.7, 2.0, 2.0),
    mats.mushroomGranite
  );
  porchBase.position.set(porchX, plinthBottom + plinthH * 0.5, porchZ);
  setShadow(porchBase, true, true);
  root.add(porchBase);

  addMasonryArchBay(root, {
    x: porchX,
    y: plinthTop,
    z: porchZ + 0.65,
    bayWidth: 2.7,
    bayHeight: 2.75,
    archRadius: 1.0,
    depth: 0.4,
    wallMat: mats.ochreStucco,
    trimMat: mats.graniteTrim
  });
  for (const s of [-1, 1] as const) {
    const pier = new THREE.Mesh(
      createTiledBox(0.36, 2.75, 1.65, 1.6, 1.6),
      mats.mushroomGranite
    );
    pier.position.set(porchX + s * 1.18, plinthTop + 1.38, porchZ);
    setShadow(pier, true, true);
    root.add(pier);
  }
  const porchCap = new THREE.Mesh(
    createTiledBox(3.1, 0.24, 1.95, 1.8, 1.0),
    mats.graniteTrim
  );
  porchCap.position.set(porchX, plinthTop + 2.86, porchZ);
  setShadow(porchCap, true, true);
  root.add(porchCap);

  addBalustrade(root, {
    x: porchX,
    y: plinthTop + 2.98,
    z: porchZ + 0.82,
    length: 2.8,
    height: 0.88,
    mat: mats.creamStone,
    spacing: 0.32
  });

  addStoneStairs(root, {
    x: porchX,
    zStart: porchZ + 0.85,
    topY: plinthTop,
    bottomY: 0,
    width: 1.85,
    runDepth: 0.9,
    steps: 5,
    stepMat: mats.graniteSteps,
    cheekMat: mats.mushroomGranite
  });

  const porchDoorFrame = new THREE.Mesh(new THREE.BoxGeometry(1.42, 2.38, 0.16), mats.graniteTrim);
  porchDoorFrame.position.set(porchX, plinthTop + 1.19, mainZ + mainD * 0.5 + 0.04);
  root.add(porchDoorFrame);
  const porchDoor = new THREE.Mesh(createTiledBox(1.18, 2.2, 0.12, 1.2, 2.0), mats.doorWood);
  porchDoor.position.set(porchX, plinthTop + 1.1, mainZ + mainD * 0.5 + 0.09);
  root.add(porchDoor);

  addVintageLantern(root, mats, {
    x: porchX,
    y: plinthTop + 1.9,
    z: porchZ + 0.2,
    style: 'hanging',
    scale: 0.9
  });

  // Dormer + brick chimney
  addRoofDormer(root, {
    x: 1.5,
    y: eaveY + 0.65,
    z: mainZ + mainD * 0.5 - 0.9,
    wallMat: mats.ochreStucco,
    roofMat: mats.redRoof,
    trimMat: mats.whiteTrim,
    glassMat: winB
  });
  addChimney(
    root,
    -0.5,
    eaveY + 0.8,
    eaveY + ridgeH + 1.1,
    mainZ - 1.4,
    0.92,
    0.85,
    mats.redBrickChimney,
    mats.graniteTrim,
    2
  );

  // Windows across all 4 facades
  for (const wy of [2.95, 5.45]) {
    for (const wx of [wingX - 1.0, wingX + 1.0]) {
      addRectWindow(root, {
        x: wx,
        y: wy,
        z: wingZ + wingD * 0.5 + 0.02,
        w: 1.1,
        h: 1.52,
        glassMat: winA,
        frameMat: mats.whiteTrim,
        sillMat: mats.graniteTrim
      });
    }
  }
  addRectWindow(root, {
    x: porchX,
    y: 5.55,
    z: mainZ + mainD * 0.5 + 0.02,
    w: 1.35,
    h: 1.65,
    glassMat: winB,
    frameMat: mats.whiteTrim
  });
  for (const wx of [-3.4, 0, 3.4]) {
    for (const wy of [2.95, 5.45]) {
      addRectWindow(root, {
        x: wx,
        y: wy,
        z: mainZ - mainD * 0.5 - 0.02,
        w: 1.18,
        h: 1.55,
        rotY: Math.PI,
        glassMat: wx === 0 ? winA : winB,
        frameMat: mats.whiteTrim
      });
    }
  }
  for (const sx of [-1, 1] as const) {
    const rotY = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    for (const wz of [mainZ - 1.8, mainZ + 0.9]) {
      for (const wy of [2.95, 5.45]) {
        addRectWindow(root, {
          x: sx * (mainW * 0.5 + 0.02),
          y: wy,
          z: wz,
          w: 1.1,
          h: 1.48,
          rotY,
          glassMat: winB,
          frameMat: mats.whiteTrim
        });
      }
    }
  }

  return root;
}

/** Style 5: Rugged Granite Ground Floor + Ivory Fachwerk Timber Chalet (`stone_timber`). */
function buildStoneTimberVilla(
  villa: VillaPlacement,
  mats: ArchMaterials
): THREE.Group {
  const root = new THREE.Group();
  root.name = `villa_${villa.id}`;
  root.position.set(villa.position[0], villa.baseElevation, villa.position[2]);
  root.rotation.y = villa.rotationY;

  const minTerrainLocal = sampleFootprintMinY(villa) - villa.baseElevation;
  const plinthBottom = Math.min(-2.1, minTerrainLocal - 1.8);
  const floor2Y = 4.35;
  const eaveY = 7.35;

  const winA = createWindowVariant(mats, 0xffbe6a, 1.05, 1.1);
  const winB = createWindowVariant(mats, 0xffa84e, 0.68, 3.3);

  const mainW = 11.8;
  const mainD = 7.8;
  const mainZ = -0.95;

  // 1. Full ground floor clad in rugged Laoshan mushroomGranite!
  const groundH = floor2Y - plinthBottom;
  const groundFloor = new THREE.Mesh(
    createTiledBox(mainW + 0.24, groundH, mainD + 0.24, 2.4, 2.1),
    mats.mushroomGranite
  );
  groundFloor.position.set(0, plinthBottom + groundH * 0.5, mainZ);
  setShadow(groundFloor, true, true);
  root.add(groundFloor);

  // Heavy dark timber belt beam separating granite base from ivory upper story
  const timberBelt = new THREE.Mesh(
    new THREE.BoxGeometry(mainW + 0.44, 0.24, mainD + 0.44),
    mats.darkTimber
  );
  timberBelt.position.set(0, floor2Y, mainZ);
  setShadow(timberBelt, true, true);
  root.add(timberBelt);

  // 2. Second floor in antique ivory stucco framed with dark German Fachwerk posts
  const upperH = eaveY - floor2Y;
  const upperBody = new THREE.Mesh(
    createTiledBox(mainW, upperH, mainD, 2.8, 2.8),
    mats.ivoryStucco
  );
  upperBody.position.set(0, floor2Y + upperH * 0.5, mainZ);
  setShadow(upperBody, true, true);
  root.add(upperBody);

  // Vertical Fachwerk timber framing around upper story
  const postGeom = new THREE.BoxGeometry(0.14, upperH, 0.1);
  for (const px of [-mainW * 0.5, -mainW * 0.25, 0, mainW * 0.25, mainW * 0.5]) {
    for (const sz of [-1, 1] as const) {
      const p = new THREE.Mesh(postGeom, mats.darkTimber);
      p.position.set(px, floor2Y + upperH * 0.5, mainZ + sz * (mainD * 0.5 + 0.02));
      root.add(p);
    }
  }
  const eaveTimber = new THREE.Mesh(
    new THREE.BoxGeometry(mainW + 0.22, 0.16, mainD + 0.22),
    mats.darkTimber
  );
  eaveTimber.position.set(0, eaveY - 0.08, mainZ);
  root.add(eaveTimber);

  // 3. Steep overhanging Bavarian gabled roof + rich Fachwerk gable trusses
  const ridgeH = 4.3;
  const gables = new THREE.Mesh(
    createGablePrism(mainD, ridgeH, mainW, 2.8, 2.8),
    mats.ivoryStucco
  );
  gables.rotation.y = Math.PI / 2;
  gables.position.set(0, eaveY, mainZ);
  setShadow(gables, true, true);
  root.add(gables);

  for (const sx of [-1, 1] as const) {
    addFachwerkGable(root, {
      x: sx * (mainW * 0.5 + 0.04),
      y: eaveY,
      z: mainZ,
      width: mainD - 0.1,
      height: ridgeH - 0.1,
      rotY: sx > 0 ? Math.PI / 2 : -Math.PI / 2,
      timberMat: mats.darkTimber
    });
  }

  addGabledRoof(root, {
    x: 0,
    y: eaveY,
    z: mainZ,
    ridgeLength: mainW,
    span: mainD,
    ridgeHeight: ridgeH,
    eaveOverhang: 0.78,
    gableOverhang: 0.65,
    roofMat: mats.redRoof,
    trimMat: mats.darkTimber,
    rafterMat: mats.darkTimber,
    tileSize: 1.85
  });

  // Two cozy roof dormers on front slope + prominent granite chimney
  for (const dx of [-3.1, 3.1]) {
    addRoofDormer(root, {
      x: dx,
      y: eaveY + 0.75,
      z: mainZ + mainD * 0.5 - 1.0,
      w: 1.45,
      h: 1.25,
      d: 1.8,
      wallMat: mats.ivoryStucco,
      roofMat: mats.redRoof,
      trimMat: mats.darkTimber,
      glassMat: winB
    });
  }
  addChimney(
    root,
    3.9,
    floor2Y,
    eaveY + ridgeH + 1.25,
    mainZ - 1.5,
    1.05,
    0.95,
    mats.mushroomGranite,
    mats.graniteTrim,
    2
  );

  // 4. Stone Entrance Porch & Carved Dark-Timber 2nd-Floor Balcony
  const porchW = 4.6;
  const porchD = 1.65;
  const porchZ = mainZ + mainD * 0.5 + porchD * 0.5;
  const porchDeckY = 1.15;

  const porchSub = new THREE.Mesh(
    createTiledBox(porchW + 0.25, porchDeckY - plinthBottom, porchD + 0.25, 2.2, 2.0),
    mats.mushroomGranite
  );
  porchSub.position.set(0, plinthBottom + (porchDeckY - plinthBottom) * 0.5, porchZ);
  setShadow(porchSub, true, true);
  root.add(porchSub);

  // Timber posts supporting 2nd-floor timber veranda balcony
  for (const px of [-porchW * 0.46, -porchW * 0.16, porchW * 0.16, porchW * 0.46]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, floor2Y - porchDeckY, 0.2), mats.darkTimber);
    post.position.set(px, porchDeckY + (floor2Y - porchDeckY) * 0.5, porchZ + porchD * 0.5 - 0.18);
    setShadow(post, true, true);
    root.add(post);
  }

  const balcFloor = new THREE.Mesh(
    createTiledBox(porchW + 0.4, 0.22, porchD + 0.35, 1.8, 1.8),
    mats.darkTimber
  );
  balcFloor.position.set(0, floor2Y + 0.06, porchZ + 0.05);
  setShadow(balcFloor, true, true);
  root.add(balcFloor);

  // Timber balustrade on 2nd-floor balcony
  addBalustrade(root, {
    x: 0,
    y: floor2Y + 0.17,
    z: porchZ + porchD * 0.5 + 0.08,
    length: porchW + 0.15,
    height: 0.96,
    mat: mats.warmTimber,
    spacing: 0.32,
    withEndPiers: true
  });
  for (const sx of [-1, 1] as const) {
    addBalustrade(root, {
      x: sx * (porchW * 0.5 + 0.08),
      y: floor2Y + 0.17,
      z: porchZ + 0.05,
      length: porchD + 0.1,
      height: 0.96,
      rotY: Math.PI / 2,
      mat: mats.warmTimber,
      spacing: 0.32
    });
  }

  addStoneStairs(root, {
    x: 0,
    zStart: porchZ + porchD * 0.5,
    topY: porchDeckY,
    bottomY: 0,
    width: 2.1,
    runDepth: 0.82,
    steps: 4,
    stepMat: mats.graniteSteps,
    cheekMat: mats.mushroomGranite
  });

  const stDoorFrame = new THREE.Mesh(new THREE.BoxGeometry(1.52, 2.42, 0.22), mats.graniteTrim);
  stDoorFrame.position.set(0, porchDeckY + 1.21, mainZ + mainD * 0.5 + 0.14);
  root.add(stDoorFrame);
  const stDoor = new THREE.Mesh(createTiledBox(1.24, 2.24, 0.12, 1.2, 2.0), mats.doorWood);
  stDoor.position.set(0, porchDeckY + 1.12, mainZ + mainD * 0.5 + 0.2);
  root.add(stDoor);

  addVintageLantern(root, mats, {
    x: 0,
    y: floor2Y - 0.95,
    z: porchZ + 0.2,
    style: 'hanging',
    scale: 0.95
  });

  // 5. Arched granite ground-floor windows + warm timber-framed upper windows
  for (const wx of [-4.0, 4.0]) {
    addArchedWindow(root, {
      x: wx,
      y: 2.65,
      z: mainZ + mainD * 0.5 + 0.14,
      w: 1.25,
      h: 1.72,
      pointed: false,
      glassMat: winA,
      stoneMat: mats.graniteTrim,
      mullionMat: mats.darkTimber
    });
  }
  for (const wx of [-4.0, 0, 4.0]) {
    addRectWindow(root, {
      x: wx,
      y: 5.8,
      z: mainZ + mainD * 0.5 + 0.02,
      w: wx === 0 ? 1.65 : 1.25,
      h: wx === 0 ? 2.05 : 1.55,
      glassMat: wx === 0 ? winA : winB,
      frameMat: mats.darkTimber,
      sillMat: mats.warmTimber
    });
  }

  // Rear & side facades
  for (const wx of [-3.9, 0, 3.9]) {
    addArchedWindow(root, {
      x: wx,
      y: 2.65,
      z: mainZ - mainD * 0.5 - 0.14,
      w: 1.2,
      h: 1.65,
      rotY: Math.PI,
      pointed: false,
      glassMat: winB,
      stoneMat: mats.graniteTrim,
      mullionMat: mats.darkTimber
    });
    addRectWindow(root, {
      x: wx,
      y: 5.8,
      z: mainZ - mainD * 0.5 - 0.02,
      w: 1.22,
      h: 1.55,
      rotY: Math.PI,
      glassMat: winA,
      frameMat: mats.darkTimber
    });
  }
  for (const sx of [-1, 1] as const) {
    const rotY = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    for (const wz of [mainZ - 1.9, mainZ + 1.4]) {
      addArchedWindow(root, {
        x: sx * (mainW * 0.5 + 0.14),
        y: 2.65,
        z: wz,
        w: 1.12,
        h: 1.62,
        rotY,
        pointed: false,
        glassMat: winA,
        stoneMat: mats.graniteTrim,
        mullionMat: mats.darkTimber
      });
      addRectWindow(root, {
        x: sx * (mainW * 0.5 + 0.02),
        y: 5.8,
        z: wz,
        w: 1.15,
        h: 1.5,
        rotY,
        glassMat: winB,
        frameMat: mats.darkTimber
      });
    }
  }

  return root;
}

/** Style 6: Apricot-Terracotta French/German Mansard Villa with Semicircular Portico (`east_hill`). */
function buildEastHillMansardVilla(
  villa: VillaPlacement,
  mats: ArchMaterials
): THREE.Group {
  const root = new THREE.Group();
  root.name = `villa_${villa.id}`;
  root.position.set(villa.position[0], villa.baseElevation, villa.position[2]);
  root.rotation.y = villa.rotationY;

  const minTerrainLocal = sampleFootprintMinY(villa) - villa.baseElevation;
  const plinthBottom = Math.min(-2.0, minTerrainLocal - 1.8);
  const plinthTop = 1.25;
  const plinthH = plinthTop - plinthBottom;

  const winA = createWindowVariant(mats, 0xffc06d, 1.12, 0.7);
  const winB = createWindowVariant(mats, 0xffad52, 0.78, 2.9);

  const mainW = 11.4;
  const mainD = 7.4;
  const mainZ = -1.05;
  const eaveY = 6.75;
  const bodyH = eaveY - plinthTop;

  // Grounded mushroomGranite plinth
  const plinth = new THREE.Mesh(
    createTiledBox(mainW + 0.45, plinthH, mainD + 0.45, 2.4, 2.0),
    mats.mushroomGranite
  );
  plinth.position.set(0, plinthBottom + plinthH * 0.5, mainZ);
  setShadow(plinth, true, true);
  root.add(plinth);

  // Warm apricot-terracotta stucco body with pale cream limestone quoins & cornice
  const body = new THREE.Mesh(
    createTiledBox(mainW, bodyH, mainD, 2.8, 2.8),
    mats.apricotStucco
  );
  body.position.set(0, plinthTop + bodyH * 0.5, mainZ);
  setShadow(body, true, true);
  root.add(body);

  const belt = new THREE.Mesh(
    new THREE.BoxGeometry(mainW + 0.28, 0.2, mainD + 0.28),
    mats.creamStone
  );
  belt.position.set(0, 4.15, mainZ);
  setShadow(belt, true, true);
  root.add(belt);

  const cornice = new THREE.Mesh(
    new THREE.BoxGeometry(mainW + 0.52, 0.28, mainD + 0.52),
    mats.creamStone
  );
  cornice.position.set(0, eaveY - 0.1, mainZ);
  setShadow(cornice, true, true);
  root.add(cornice);

  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      addCornerQuoins(
        root,
        sx * (mainW * 0.5),
        mainZ + sz * (mainD * 0.5),
        plinthTop + 0.1,
        eaveY - 0.25,
        mats.creamStone,
        0.5,
        0.3
      );
    }
  }

  // Two-tier French/German Mansard Red-Tile Roof!
  const lowerMansardH = 2.65;
  addHippedRoof(root, {
    x: 0,
    y: eaveY,
    z: mainZ,
    baseW: mainW + 1.0,
    baseD: mainD + 1.0,
    topW: mainW - 1.7,
    topD: mainD - 1.7,
    height: lowerMansardH,
    roofMat: mats.redRoof,
    trimMat: mats.creamStone,
    tileSize: 1.75
  });

  // Upper gentle hipped cap atop the mansard deck
  addHippedRoof(root, {
    x: 0,
    y: eaveY + lowerMansardH,
    z: mainZ,
    baseW: mainW - 1.55,
    baseD: mainD - 1.55,
    topW: 4.4,
    topD: 0.0,
    height: 1.55,
    roofMat: mats.redRoof,
    trimMat: mats.creamStone,
    tileSize: 1.85
  });

  // Five charming mansard roof dormers (3 front, 2 back) glowing at twilight!
  for (const dx of [-3.4, 0, 3.4]) {
    addRoofDormer(root, {
      x: dx,
      y: eaveY + 0.35,
      z: mainZ + mainD * 0.5 - 0.3,
      w: 1.48,
      h: 1.42,
      d: 1.7,
      wallMat: mats.creamStone,
      roofMat: mats.redRoof,
      trimMat: mats.whiteTrim,
      glassMat: dx === 0 ? winA : winB
    });
  }
  for (const dx of [-2.8, 2.8]) {
    addRoofDormer(root, {
      x: dx,
      y: eaveY + 0.35,
      z: mainZ - mainD * 0.5 + 0.3,
      rotY: Math.PI,
      w: 1.48,
      h: 1.42,
      d: 1.7,
      wallMat: mats.creamStone,
      roofMat: mats.redRoof,
      trimMat: mats.whiteTrim,
      glassMat: winA
    });
  }

  for (const sx of [-1, 1] as const) {
    addChimney(
      root,
      sx * 2.9,
      eaveY + 2.2,
      eaveY + lowerMansardH + 2.45,
      mainZ - 0.85,
      0.88,
      0.82,
      mats.creamStone,
      mats.graniteTrim,
      2
    );
  }

  // Graceful semicircular front entrance portico with 4 columns & domed copper cap!
  const portZ = mainZ + mainD * 0.5;
  const portR = 1.72;

  const portBase = new THREE.Mesh(
    createTiledCylinder(portR, portR + 0.14, plinthH, 18, 2.2, 2.0),
    mats.mushroomGranite
  );
  portBase.position.set(0, plinthBottom + plinthH * 0.5, portZ);
  setShadow(portBase, true, true);
  root.add(portBase);

  const portFloor = new THREE.Mesh(
    new THREE.CylinderGeometry(portR + 0.08, portR + 0.08, 0.14, 18),
    mats.creamStone
  );
  portFloor.position.set(0, plinthTop + 0.05, portZ);
  setShadow(portFloor, true, true);
  root.add(portFloor);

  // 4 slender classical columns arranged on the front semicircular arc
  const portRoofY = 4.2;
  for (const ang of [-1.05, -0.38, 0.38, 1.05]) {
    const col = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.15, portRoofY - plinthTop - 0.1, 10),
      mats.creamStone
    );
    col.position.set(
      Math.sin(ang) * (portR - 0.24),
      plinthTop + (portRoofY - plinthTop) * 0.5,
      portZ + Math.cos(ang) * (portR - 0.24)
    );
    setShadow(col, true, true);
    root.add(col);
  }

  const portCornice = new THREE.Mesh(
    new THREE.CylinderGeometry(portR + 0.18, portR + 0.1, 0.26, 18),
    mats.creamStone
  );
  portCornice.position.set(0, portRoofY + 0.1, portZ);
  setShadow(portCornice, true, true);
  root.add(portCornice);

  // Curved copper-patina dome roof atop portico
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(portR + 0.08, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
    mats.agedCopper
  );
  dome.scale.set(1, 0.52, 1);
  dome.position.set(0, portRoofY + 0.2, portZ);
  setShadow(dome, true, true);
  root.add(dome);

  // Semicircular stepped granite entrance stairs (strictly inside footprintDepth/2 = 5.25!)
  for (let i = 0; i < 4; i++) {
    const rStep = portR + 0.22 + i * 0.21;
    const hStep = plinthTop * (1 - (i + 1) / 4.5);
    const step = new THREE.Mesh(
      new THREE.CylinderGeometry(rStep, rStep, hStep + 0.8, 16, 1, false, -Math.PI * 0.42, Math.PI * 0.84),
      mats.graniteSteps
    );
    step.position.set(0, (hStep - 0.8) * 0.5, portZ);
    setShadow(step, true, true);
    root.add(step);
  }

  const ehDoorFrame = new THREE.Mesh(new THREE.BoxGeometry(1.52, 2.52, 0.16), mats.creamStone);
  ehDoorFrame.position.set(0, plinthTop + 1.26, portZ + 0.04);
  root.add(ehDoorFrame);
  const ehDoor = new THREE.Mesh(createTiledBox(1.24, 2.34, 0.12, 1.2, 2.0), mats.doorWood);
  ehDoor.position.set(0, plinthTop + 1.18, portZ + 0.09);
  root.add(ehDoor);

  addVintageLantern(root, mats, {
    x: 0,
    y: portRoofY - 0.9,
    z: portZ + 0.9,
    style: 'hanging',
    scale: 0.92
  });

  // Tall arched French windows across all 4 facades
  for (const wx of [-3.6, 3.6]) {
    addArchedWindow(root, {
      x: wx,
      y: 2.75,
      z: mainZ + mainD * 0.5 + 0.02,
      w: 1.25,
      h: 1.88,
      pointed: false,
      glassMat: winA,
      stoneMat: mats.creamStone,
      mullionMat: mats.whiteTrim
    });
  }
  for (const wx of [-3.6, 0, 3.6]) {
    addRectWindow(root, {
      x: wx,
      y: 5.45,
      z: mainZ + mainD * 0.5 + 0.02,
      w: 1.25,
      h: 1.68,
      glassMat: wx === 0 ? winA : winB,
      frameMat: mats.whiteTrim,
      sillMat: mats.creamStone,
      withPediment: true
    });
  }
  for (const wx of [-3.6, 0, 3.6]) {
    for (const wy of [2.75, 5.45]) {
      addRectWindow(root, {
        x: wx,
        y: wy,
        z: mainZ - mainD * 0.5 - 0.02,
        w: 1.2,
        h: 1.62,
        rotY: Math.PI,
        glassMat: winB,
        frameMat: mats.whiteTrim,
        sillMat: mats.creamStone
      });
    }
  }
  for (const sx of [-1, 1] as const) {
    const rotY = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    for (const wz of [mainZ - 1.75, mainZ + 1.45]) {
      for (const wy of [2.75, 5.45]) {
        addRectWindow(root, {
          x: sx * (mainW * 0.5 + 0.02),
          y: wy,
          z: wz,
          w: 1.15,
          h: 1.6,
          rotY,
          glassMat: winA,
          frameMat: mats.whiteTrim,
          sillMat: mats.creamStone
        });
      }
    }
  }

  return root;
}

/** Style 7: Red-Brick & Limestone 3-Bay Arched Arcade Villa with Square Belvedere Tower (`red_brick_arcade`). */
function buildRedBrickArcadeVilla(
  villa: VillaPlacement,
  mats: ArchMaterials
): THREE.Group {
  const root = new THREE.Group();
  root.name = `villa_${villa.id}`;
  root.position.set(villa.position[0], villa.baseElevation, villa.position[2]);
  root.rotation.y = villa.rotationY;

  const minTerrainLocal = sampleFootprintMinY(villa) - villa.baseElevation;
  const plinthBottom = Math.min(-2.0, minTerrainLocal - 1.8);
  const plinthTop = 1.3;
  const plinthH = plinthTop - plinthBottom;

  const winA = createWindowVariant(mats, 0xffb860, 1.12, 1.7);
  const winB = createWindowVariant(mats, 0xffcc7e, 0.8, 3.8);

  const mainW = 11.4;
  const mainD = 7.2;
  const mainZ = -1.05;
  const floor2Y = 4.6;
  const eaveY = 7.75;

  // Grounded Laoshan granite plinth extending beneath both main block and front arcade!
  const fullD = mainD + 2.0;
  const fullCenterZ = mainZ + 1.0;
  const plinth = new THREE.Mesh(
    createTiledBox(mainW + 0.44, plinthH, fullD + 0.32, 2.4, 2.0),
    mats.mushroomGranite
  );
  plinth.position.set(0, plinthBottom + plinthH * 0.5, fullCenterZ);
  setShadow(plinth, true, true);
  root.add(plinth);

  const waterTable = new THREE.Mesh(
    new THREE.BoxGeometry(mainW + 0.56, 0.16, fullD + 0.44),
    mats.creamStone
  );
  waterTable.position.set(0, plinthTop + 0.04, fullCenterZ);
  setShadow(waterTable, true, true);
  root.add(waterTable);

  // Main weathered terracotta-brick volume
  const bodyH = eaveY - plinthTop;
  const mainBody = new THREE.Mesh(
    createTiledBox(mainW, bodyH, mainD, 2.6, 2.6),
    mats.brickWall
  );
  mainBody.position.set(0, plinthTop + bodyH * 0.5, mainZ);
  setShadow(mainBody, true, true);
  root.add(mainBody);

  // Cream limestone corner quoins & horizontal stringcourse
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      addCornerQuoins(
        root,
        sx * (mainW * 0.5),
        mainZ + sz * (mainD * 0.5),
        plinthTop + 0.12,
        eaveY - 0.15,
        mats.creamStone,
        0.52,
        0.3
      );
    }
  }
  const belt = new THREE.Mesh(
    new THREE.BoxGeometry(mainW + 0.3, 0.22, mainD + 0.3),
    mats.creamStone
  );
  belt.position.set(0, floor2Y, mainZ);
  setShadow(belt, true, true);
  root.add(belt);

  // Signature Three-Bay Arched Ground-Floor Front Arcade Loggia!
  const arcadeW = 7.8;
  const arcadeD = 1.85;
  const arcadeX = 1.65; // bonds flush with square corner Belvedere Tower on -X!
  const arcadeZ = mainZ + mainD * 0.5 + arcadeD * 0.5;
  const bayW = arcadeW / 3;
  const arcadeH = floor2Y - plinthTop;

  for (let i = 0; i < 3; i++) {
    const bx = arcadeX - arcadeW * 0.5 + (i + 0.5) * bayW;
    addMasonryArchBay(root, {
      x: bx,
      y: plinthTop,
      z: arcadeZ + arcadeD * 0.5 - 0.22,
      bayWidth: bayW,
      bayHeight: arcadeH,
      archRadius: bayW * 0.37,
      depth: 0.44,
      wallMat: mats.brickWall,
      trimMat: mats.creamStone
    });
  }
  const colH = arcadeH - bayW * 0.37 - 0.36;
  for (let i = 0; i <= 3; i++) {
    const cx = arcadeX - arcadeW * 0.5 + i * bayW;
    const pier = new THREE.Mesh(
      createTiledBox(0.38, colH + 0.2, 0.44, 1.4, 1.4),
      mats.creamStone
    );
    pier.position.set(cx, plinthTop + (colH + 0.2) * 0.5, arcadeZ + arcadeD * 0.5 - 0.22);
    setShadow(pier, true, true);
    root.add(pier);
  }
  // End arch on +X side of arcade
  addMasonryArchBay(root, {
    x: arcadeX + arcadeW * 0.5 - 0.22,
    y: plinthTop,
    z: arcadeZ,
    bayWidth: arcadeD,
    bayHeight: arcadeH,
    archRadius: arcadeD * 0.35,
    depth: 0.44,
    rotY: Math.PI / 2,
    wallMat: mats.brickWall,
    trimMat: mats.creamStone
  });

  // Upper terrace balcony slab & balustrade atop the 3-bay arcade!
  const terraceSlab = new THREE.Mesh(
    new THREE.BoxGeometry(arcadeW + 0.35, 0.22, arcadeD + 0.35),
    mats.creamStone
  );
  terraceSlab.position.set(arcadeX, floor2Y + 0.08, arcadeZ);
  setShadow(terraceSlab, true, true);
  root.add(terraceSlab);

  addBalustrade(root, {
    x: arcadeX,
    y: floor2Y + 0.19,
    z: arcadeZ + arcadeD * 0.5 - 0.04,
    length: arcadeW,
    height: 0.94,
    mat: mats.creamStone,
    spacing: 0.34,
    withEndPiers: true
  });
  addBalustrade(root, {
    x: arcadeX + arcadeW * 0.5 - 0.04,
    y: floor2Y + 0.19,
    z: arcadeZ,
    length: arcadeD,
    height: 0.94,
    rotY: Math.PI / 2,
    mat: mats.creamStone,
    spacing: 0.34
  });

  // Entrance steps descending from central arcade bay (strictly inside footprintDepth/2 = 5.2!)
  addStoneStairs(root, {
    x: arcadeX,
    zStart: arcadeZ + arcadeD * 0.5,
    topY: plinthTop + 0.04,
    bottomY: 0,
    width: 2.1,
    runDepth: 0.78,
    steps: 5,
    stepMat: mats.graniteSteps,
    cheekMat: mats.mushroomGranite
  });

  const arcDoorFrame = new THREE.Mesh(new THREE.BoxGeometry(1.56, 2.52, 0.16), mats.creamStone);
  arcDoorFrame.position.set(arcadeX, plinthTop + 1.26, mainZ + mainD * 0.5 + 0.04);
  root.add(arcDoorFrame);
  const arcDoor = new THREE.Mesh(createTiledBox(1.28, 2.34, 0.12, 1.2, 2.0), mats.doorWood);
  arcDoor.position.set(arcadeX, plinthTop + 1.18, mainZ + mainD * 0.5 + 0.09);
  root.add(arcDoor);

  addVintageLantern(root, mats, {
    x: arcadeX,
    y: floor2Y - 0.95,
    z: arcadeZ + 0.15,
    style: 'hanging',
    scale: 0.95
  });

  // Square Corner Belvedere Lookout Tower on Front-Left (-X, +Z) Corner!
  const tw = 3.5;
  const towX = -mainW * 0.5 + tw * 0.5 - 0.1;
  const towZ = mainZ + mainD * 0.5 + 0.4;
  const towTopY = 10.6;
  const towH = towTopY - plinthTop;

  const tower = new THREE.Mesh(
    createTiledBox(tw, towH, tw, 2.4, 2.4),
    mats.brickWall
  );
  tower.position.set(towX, plinthTop + towH * 0.5, towZ);
  setShadow(tower, true, true);
  root.add(tower);

  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      addCornerQuoins(
        root,
        towX + sx * (tw * 0.5),
        towZ + sz * (tw * 0.5),
        plinthTop + 0.1,
        towTopY - 0.2,
        mats.creamStone,
        0.44,
        0.26
      );
    }
  }

  // Steep pyramidal red-tile belvedere spire roof + iron finial!
  addHippedRoof(root, {
    x: towX,
    y: towTopY,
    z: towZ,
    baseW: tw + 0.95,
    baseD: tw + 0.95,
    topW: 0,
    topD: 0,
    height: 3.35,
    roofMat: mats.redRoof,
    trimMat: mats.creamStone,
    tileSize: 1.5
  });

  const towFinial = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.035, 1.15, 6),
    mats.wroughtIron
  );
  towFinial.position.set(towX, towTopY + 3.85, towZ);
  root.add(towFinial);

  // Paired arched lookout windows on the upper belvedere story
  for (const [rotY, ox, oz] of [
    [0, 0, tw * 0.5 + 0.02],
    [-Math.PI / 2, -tw * 0.5 - 0.02, 0],
    [Math.PI / 2, tw * 0.5 + 0.02, 0],
    [Math.PI, 0, -tw * 0.5 - 0.02]
  ] as const) {
    addArchedWindow(root, {
      x: towX + ox,
      y: 9.1,
      z: towZ + oz,
      w: 1.15,
      h: 1.65,
      rotY,
      pointed: false,
      glassMat: winA,
      stoneMat: mats.creamStone,
      mullionMat: mats.whiteTrim
    });
  }
  for (const wy of [2.95, 6.1]) {
    addArchedWindow(root, {
      x: towX,
      y: wy,
      z: towZ + tw * 0.5 + 0.02,
      w: 1.18,
      h: 1.68,
      pointed: false,
      glassMat: winB,
      stoneMat: mats.creamStone,
      mullionMat: mats.whiteTrim
    });
  }

  // Main Hipped Red-Tile Roof & Twin Brick Chimneys
  addHippedRoof(root, {
    x: 0,
    y: eaveY,
    z: mainZ,
    baseW: mainW + 1.35,
    baseD: mainD + 1.35,
    topW: 4.8,
    topD: 0.0,
    height: 3.4,
    roofMat: mats.redRoof,
    trimMat: mats.creamStone,
    tileSize: 1.85
  });

  for (const sx of [-1, 1] as const) {
    addChimney(
      root,
      sx * 2.6 + 0.8,
      eaveY + 0.9,
      eaveY + 4.35,
      mainZ - 1.0,
      0.92,
      0.85,
      mats.redBrickChimney,
      mats.creamStone,
      2
    );
  }

  // Main facade windows
  for (const wx of [arcadeX - 2.3, arcadeX, arcadeX + 2.3]) {
    addArchedWindow(root, {
      x: wx,
      y: 6.1,
      z: mainZ + mainD * 0.5 + 0.02,
      w: 1.2,
      h: 1.72,
      pointed: false,
      glassMat: wx === arcadeX ? winA : winB,
      stoneMat: mats.creamStone,
      mullionMat: mats.whiteTrim
    });
  }
  for (const wx of [-3.6, 0, 3.6]) {
    for (const wy of [2.95, 6.1]) {
      addArchedWindow(root, {
        x: wx,
        y: wy,
        z: mainZ - mainD * 0.5 - 0.02,
        w: 1.18,
        h: 1.68,
        rotY: Math.PI,
        pointed: false,
        glassMat: winB,
        stoneMat: mats.creamStone,
        mullionMat: mats.whiteTrim
      });
    }
  }
  for (const sx of [-1, 1] as const) {
    const rotY = sx > 0 ? Math.PI / 2 : -Math.PI / 2;
    for (const wz of [mainZ - 1.6, mainZ + 1.2]) {
      for (const wy of [2.95, 6.1]) {
        addArchedWindow(root, {
          x: sx * (mainW * 0.5 + 0.02),
          y: wy,
          z: wz,
          w: 1.1,
          h: 1.6,
          rotY,
          pointed: false,
          glassMat: winA,
          stoneMat: mats.creamStone,
          mullionMat: mats.whiteTrim
        });
      }
    }
  }

  return root;
}

// ============================================================================
// 10. STATIC GEOMETRY MERGING & MAIN MODULE FACTORY
// ============================================================================

interface MergeBucket {
  material: THREE.Material;
  castShadow: boolean;
  receiveShadow: boolean;
  geometries: THREE.BufferGeometry[];
  hasIndexed: boolean;
  hasNonIndexed: boolean;
}

/**
 * Clones a source mesh geometry, strips extra attributes so every geometry in
 * a bucket exposes identical (position, normal, uv) Float32 attributes, and
 * bakes the mesh's world matrix (including normals under non-uniform scale).
 */
function prepareGeometryForMerge(
  source: THREE.BufferGeometry,
  matrixWorld: THREE.Matrix4
): THREE.BufferGeometry | null {
  const posAttr = source.getAttribute('position');
  if (!posAttr || posAttr.count === 0) return null;

  const geom = source.clone();
  geom.clearGroups();
  geom.morphAttributes = {};

  if (!geom.getAttribute('normal')) {
    geom.computeVertexNormals();
  }
  if (!geom.getAttribute('uv')) {
    geom.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute(new Float32Array(posAttr.count * 2), 2)
    );
  }

  for (const attrName of Object.keys(geom.attributes)) {
    if (attrName !== 'position' && attrName !== 'normal' && attrName !== 'uv') {
      geom.deleteAttribute(attrName);
    }
  }

  // Ensure matching non-interleaved Float32BufferAttribute storage across all primitives
  for (const attrName of ['position', 'normal', 'uv'] as const) {
    const attr = geom.getAttribute(attrName);
    const expectedSize = attrName === 'uv' ? 2 : 3;
    if (!attr || attr.itemSize !== expectedSize) {
      geom.dispose();
      return null;
    }
    if (!(attr instanceof THREE.BufferAttribute) || !(attr.array instanceof Float32Array) || attr.normalized) {
      const copy = new Float32Array(attr.count * expectedSize);
      for (let i = 0; i < attr.count; i++) {
        copy[i * expectedSize] = attr.getX(i);
        copy[i * expectedSize + 1] = attr.getY(i);
        if (expectedSize === 3) {
          copy[i * expectedSize + 2] = attr.getZ(i);
        }
      }
      geom.setAttribute(attrName, new THREE.Float32BufferAttribute(copy, expectedSize));
    }
  }

  geom.applyMatrix4(matrixWorld);

  // Preserve outward face winding if a mirrored (negative-determinant) transform ever occurs
  if (matrixWorld.determinant() < 0) {
    const idx = geom.getIndex();
    if (idx) {
      const arr = idx.array as Uint16Array | Uint32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const tmp = arr[i + 1];
        arr[i + 1] = arr[i + 2];
        arr[i + 2] = tmp;
      }
      idx.needsUpdate = true;
    } else {
      const p = geom.getAttribute('position');
      const n = geom.getAttribute('normal');
      const u = geom.getAttribute('uv');
      for (let i = 0; i < p.count; i += 3) {
        const b = i + 1;
        const c = i + 2;
        const px = p.getX(b), py = p.getY(b), pz = p.getZ(b);
        p.setXYZ(b, p.getX(c), p.getY(c), p.getZ(c));
        p.setXYZ(c, px, py, pz);
        const nx = n.getX(b), ny = n.getY(b), nz = n.getZ(b);
        n.setXYZ(b, n.getX(c), n.getY(c), n.getZ(c));
        n.setXYZ(c, nx, ny, nz);
        const ux = u.getX(b), uy = u.getY(b);
        u.setXY(b, u.getX(c), u.getY(c));
        u.setXY(c, ux, uy);
      }
      p.needsUpdate = true;
      n.needsUpdate = true;
      u.needsUpdate = true;
    }
  }

  return geom;
}

/**
 * Collapses thousands of static architectural sub-meshes inside `buildGroup`
 * into merged meshes grouped by (material reference, castShadow, receiveShadow),
 * preserving all shared animated/emissive materials and world-space PointLights.
 */
function mergeStaticArchitecture(
  buildGroup: THREE.Group,
  targetGroup: THREE.Group
): void {
  buildGroup.updateMatrixWorld(true);

  const buckets = new Map<string, MergeBucket>();
  const sourceGeometries = new Set<THREE.BufferGeometry>();
  const preservedObjects: THREE.Object3D[] = [];

  buildGroup.traverse((obj) => {
    if (obj instanceof THREE.Light) {
      preservedObjects.push(obj);
      return;
    }
    if (!(obj instanceof THREE.Mesh) || !obj.visible) {
      return;
    }
    if (Array.isArray(obj.material) || !obj.geometry) {
      preservedObjects.push(obj);
      return;
    }

    const baked = prepareGeometryForMerge(obj.geometry, obj.matrixWorld);
    if (!baked) {
      preservedObjects.push(obj);
      return;
    }

    sourceGeometries.add(obj.geometry);

    const key = `${obj.material.uuid}|${obj.castShadow ? 1 : 0}|${obj.receiveShadow ? 1 : 0}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        material: obj.material,
        castShadow: obj.castShadow,
        receiveShadow: obj.receiveShadow,
        geometries: [],
        hasIndexed: false,
        hasNonIndexed: false
      };
      buckets.set(key, bucket);
    }

    if (baked.index !== null) {
      bucket.hasIndexed = true;
    } else {
      bucket.hasNonIndexed = true;
    }
    bucket.geometries.push(baked);
  });

  let mergedIndex = 0;
  for (const bucket of buckets.values()) {
    const geoms = bucket.geometries;
    if (geoms.length === 0) continue;

    // Ensure indexed/non-indexed consistency within the bucket before merging
    if (bucket.hasIndexed && bucket.hasNonIndexed) {
      for (let i = 0; i < geoms.length; i++) {
        const g = geoms[i];
        if (g.index !== null) {
          const nonIndexed = g.toNonIndexed();
          g.dispose();
          geoms[i] = nonIndexed;
        }
      }
    }

    if (geoms.length === 1) {
      const single = geoms[0];
      single.computeBoundingBox();
      single.computeBoundingSphere();
      const mesh = new THREE.Mesh(single, bucket.material);
      mesh.name = `arch_merged_${mergedIndex++}`;
      mesh.castShadow = bucket.castShadow;
      mesh.receiveShadow = bucket.receiveShadow;
      targetGroup.add(mesh);
      continue;
    }

    const merged = mergeGeometries(geoms, false);
    if (merged) {
      for (let i = 0; i < geoms.length; i++) {
        geoms[i].dispose();
      }
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, bucket.material);
      mesh.name = `arch_merged_${mergedIndex++}`;
      mesh.castShadow = bucket.castShadow;
      mesh.receiveShadow = bucket.receiveShadow;
      targetGroup.add(mesh);
    } else {
      // Defensive fallback if merge ever fails: preserve baked geometries cleanly
      for (let i = 0; i < geoms.length; i++) {
        geoms[i].computeBoundingBox();
        geoms[i].computeBoundingSphere();
        const mesh = new THREE.Mesh(geoms[i], bucket.material);
        mesh.castShadow = bucket.castShadow;
        mesh.receiveShadow = bucket.receiveShadow;
        targetGroup.add(mesh);
      }
    }
  }

  // Reparent preserved lights (and any fallback objects) at their exact world transforms
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  for (const obj of preservedObjects) {
    obj.matrixWorld.decompose(pos, quat, scale);
    obj.position.copy(pos);
    obj.quaternion.copy(quat);
    obj.scale.copy(scale);
    targetGroup.add(obj);
  }

  // Dispose temporary source geometries & release intermediate build hierarchy
  for (const srcGeom of sourceGeometries) {
    srcGeom.dispose();
  }
  buildGroup.clear();
}

export function createArchitecture(
  textures: TextureLibrary = TEXTURES
): ArchitectureModule {
  const group = new THREE.Group();
  group.name = 'badaguan_architecture';

  const buildGroup = new THREE.Group();
  const mats = createArchMaterials(textures);

  for (const villa of VILLAS) {
    let villaMesh: THREE.Group;
    switch (villa.style) {
      case 'huashi':
        villaMesh = buildHuashiVilla(villa, mats);
        break;
      case 'princess':
        villaMesh = buildPrincessHouse(villa, mats);
        break;
      case 'butterfly':
        villaMesh = buildButterflyVilla(villa, mats);
        break;
      case 'german_ginkgo':
        villaMesh = buildGermanGinkgoVilla(villa, mats);
        break;
      case 'stone_timber':
        villaMesh = buildStoneTimberVilla(villa, mats);
        break;
      case 'east_hill':
        villaMesh = buildEastHillMansardVilla(villa, mats);
        break;
      case 'red_brick_arcade':
        villaMesh = buildRedBrickArcadeVilla(villa, mats);
        break;
    }
    buildGroup.add(villaMesh);
    buildCourtyardForVilla(buildGroup, villa, mats);
  }

  mergeStaticArchitecture(buildGroup, group);

  let currentNightFactor = 0;

  const updateEmissives = (nightFactor: number, time: number): void => {
    const nf = clamp(nightFactor, 0, 1);
    // Smooth warm architectural ramp: subtle depth in daylight -> cozy amber at sunset -> radiant at twilight
    const windowBase = 0.04 + Math.pow(nf, 1.15) * 1.82;
    const shimmerAmp = nf > 0.12 ? 0.028 * nf : 0;

    for (let i = 0; i < mats.windowMaterials.length; i++) {
      const entry = mats.windowMaterials[i];
      const breathe = shimmerAmp > 0 ? 1 + Math.sin(time * 0.9 + entry.phase) * shimmerAmp : 1;
      entry.material.emissiveIntensity = windowBase * entry.litWeight * breathe;
    }

    // Porch & courtyard gatepost lanterns light up slightly ahead of full twilight
    const lanternCurve = Math.pow(nf, 0.85);
    mats.lanternGlass.emissiveIntensity = 0.16 + lanternCurve * 3.15;

    // Hero entrance warm point lights active only during sunset / twilight
    const pointFactor = nf <= 0.05 ? 0 : Math.pow((nf - 0.05) / 0.95, 1.1);
    for (let i = 0; i < mats.lanternLights.length; i++) {
      const entry = mats.lanternLights[i];
      entry.light.intensity = entry.maxIntensity * pointFactor;
    }
  };

  const applyAtmosphere = (cfg: AtmosphereConfig): void => {
    currentNightFactor = cfg.nightFactor;
    updateEmissives(currentNightFactor, 0);
  };

  const update = (ctx: WorldUpdateContext): void => {
    currentNightFactor = ctx.nightFactor;
    updateEmissives(currentNightFactor, ctx.time);
  };

  return {
    group,
    update,
    applyAtmosphere,
    extraColliders: []
  };
}
