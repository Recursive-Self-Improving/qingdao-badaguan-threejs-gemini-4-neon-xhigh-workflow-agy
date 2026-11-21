import type * as THREE from 'three';

/** Four authentic Qingdao Badaguan atmospheric lighting moods. */
export type TimeOfDayId = 'morning' | 'autumn' | 'sunset' | 'twilight';

/** Complete lighting, sky, ocean, fog, and post-processing parameters for a mood. */
export interface AtmosphereConfig {
  id: TimeOfDayId;
  nameZh: string;
  nameEn: string;
  subtitleZh: string;
  /** Unit direction vector pointing FROM origin TOWARD the sun/moon light. */
  sunDirection: [number, number, number];
  /** CSS hex color string (compatible with THREE.Color and DOM styling). */
  sunColor: string;
  sunIntensity: number;
  hemiSkyColor: string;
  hemiGroundColor: string;
  hemiIntensity: number;
  fogColor: string;
  fogDensity: number;
  skyTopColor: string;
  skyHorizonColor: string;
  skySunGlowColor: string;
  waterDeepColor: string;
  waterShallowColor: string;
  waterSunColor: string;
  exposure: number;
  bloomStrength: number;
  bloomThreshold: number;
  /** 0 = full daylight, 1 = blue-hour twilight (controls lamps & glowing villa windows). */
  nightFactor: number;
  /** Relative breeze multiplier for foliage sway, sea waves, and drifting leaves. */
  windStrength: number;
}

export type ColliderCategory = 'building' | 'wall' | 'cliff' | 'tree' | 'rock' | 'prop';

/** Oriented 2D/2.5D bounding box collider in the XZ plane (rotationY matches Three.js Y-up). */
export interface ColliderBox {
  id: string;
  kind: 'box';
  centerX: number;
  centerZ: number;
  halfWidth: number;
  halfDepth: number;
  /** Rotation in radians around +Y axis (Three.js Object3D.rotation.y convention). */
  rotationY: number;
  minY?: number;
  maxY?: number;
  category: ColliderCategory;
}

/** Circular pillar/trunk/boulder collider in the XZ plane. */
export interface ColliderCircle {
  id: string;
  kind: 'circle';
  x: number;
  z: number;
  radius: number;
  category: ColliderCategory;
}

export interface WorldBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface WorldCollisionData {
  boxes: ColliderBox[];
  circles: ColliderCircle[];
  worldBounds: WorldBounds;
}

/** Cinematic preset camera viewpoint for HUD quick-travel and guided views. */
export interface ViewpointDef {
  id: string;
  nameZh: string;
  subtitleZh: string;
  position: [number, number, number];
  target: [number, number, number];
  fov?: number;
  suggestedMood?: TimeOfDayId;
}

/** Cultural & historical landmark metadata for proximity HUD discovery cards. */
export interface LandmarkDef {
  id: string;
  nameZh: string;
  nameEn: string;
  roadZh: string;
  year: string;
  descriptionZh: string;
  position: [number, number, number];
  radius: number;
  category?: 'villa' | 'road' | 'coast';
}

export type VillaStyleId =
  | 'huashi'
  | 'princess'
  | 'butterfly'
  | 'german_ginkgo'
  | 'stone_timber'
  | 'east_hill'
  | 'red_brick_arcade';

/** Local courtyard side where the open entrance gate sits (front = local +Z). */
export type VillaGateSide = 'front' | 'back' | 'left' | 'right';

/** Authoritative villa placement, footprint, courtyard, and elevation spec. */
export interface VillaPlacement {
  id: string;
  nameZh: string;
  style: VillaStyleId;
  /** [x, baseElevation, z] in world meters. */
  position: [number, number, number];
  /** Rotation around +Y in radians. rotationY = 0 means front facade faces +Z (South). */
  rotationY: number;
  /** Main structure width along local X (meters). */
  footprintWidth: number;
  /** Main structure depth along local Z (meters). */
  footprintDepth: number;
  /** Courtyard wall outer width along local X (meters). */
  courtyardWidth: number;
  /** Courtyard wall outer depth along local Z (meters). */
  courtyardDepth: number;
  /** Ground pad elevation Y (meters). */
  baseElevation: number;
  /** Local side of courtyard wall containing the open pedestrian gate. */
  gateSide: VillaGateSide;
  /** Clear opening width of the courtyard gate (meters). */
  gateWidth: number;
  /** Smooth terrain feather distance outside courtyard perimeter (meters). */
  padMargin: number;
}

/** World-space wall segment shared by both visual courtyard builders and collision boxes. */
export interface VillaWallSegment {
  id: string;
  centerX: number;
  centerZ: number;
  length: number;
  thickness: number;
  rotationY: number;
  baseY: number;
}

export type RoadId =
  | 'juyongguan'
  | 'jiayuguan'
  | 'shanhaiguan'
  | 'huashi_cape'
  | 'beach_boardwalk';

export type TreeSpecies = 'ginkgo' | 'maple' | 'sycamore' | 'cedar';

export type RoadSurfaceType = 'asphalt' | 'granite' | 'wood';

/** Pre-sampled linear segment of a smooth Catmull-Rom road spline. */
export interface RoadSegment {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  t0: number;
  t1: number;
  length: number;
  tangentX: number;
  tangentZ: number;
}

/** Complete geometric and thematic specification for an iconic Badaguan road. */
export interface RoadCurveSpec {
  id: RoadId;
  nameZh: string;
  nameEn: string;
  treeSpecies: TreeSpecies;
  treeLabelZh: string;
  width: number;
  shoulderWidth: number;
  surface: RoadSurfaceType;
  controlPoints: [number, number][];
  segments: RoadSegment[];
  totalLength: number;
}

/** Result of querying a world (x, z) point against all roads. */
export interface RoadInfo {
  onRoad: boolean;
  onShoulder: boolean;
  /** Distance in meters to the nearest road centerline. */
  distance: number;
  /** Signed distance to the nearest road edge (< 0 inside road, > 0 outside). */
  edgeDistance: number;
  roadId: RoadId | null;
  roadNameZh: string | null;
  /** Normalized parameter [0, 1] along the nearest road. */
  t: number;
  /** Unit tangent vector [tx, tz] of the nearest road at parameter t. */
  tangent: [number, number];
  /** World-space point [cx, cz] on the nearest road centerline. */
  closestPoint: [number, number];
}

/** Sampled point and orthonormal frame along a road curve. */
export interface RoadSample {
  x: number;
  z: number;
  tangentX: number;
  tangentZ: number;
  /** Right-hand perpendicular vector in XZ plane. */
  normalX: number;
  normalZ: number;
}

/** Iconic Second Bathing Beach stone breakwater / jetty geometry. */
export interface JettySpec {
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
  width: number;
  deckY: number;
  pierHeadRadius: number;
  length: number;
}

export type CoastZone = 'inland' | 'seawall' | 'beach' | 'reef' | 'sea';

/** Per-frame update payload passed to every world subsystem. */
export interface WorldUpdateContext {
  time: number;
  dt: number;
  camera: THREE.Camera;
  nightFactor: number;
  sunDirection: THREE.Vector3;
  windStrength: number;
  atmosphere: AtmosphereConfig;
}

/** Standard procedural PBR map set produced by src/world/textures.ts. */
export interface PBRTextureMaps {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap?: THREE.CanvasTexture;
}

/** Alpha-cutout foliage leaf-cluster textures for Badaguan's iconic trees. */
export interface FoliageClusterTextureSet {
  ginkgo: THREE.CanvasTexture;
  maple: THREE.CanvasTexture;
  sycamore: THREE.CanvasTexture;
  cedar: THREE.CanvasTexture;
  fallenLeaf: THREE.CanvasTexture;
}
