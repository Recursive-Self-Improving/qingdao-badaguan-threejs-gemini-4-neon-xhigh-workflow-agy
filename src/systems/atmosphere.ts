import * as THREE from 'three';
import type { AtmosphereConfig, TimeOfDayId } from '../world/types';

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/**
 * Convert meteorological azimuth (degrees clockwise from North = -Z, East = +X)
 * and elevation (degrees above horizon) to a unit sun direction vector.
 */
function sunDirFromAngles(azimuthDeg: number, elevationDeg: number): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const cosEl = Math.cos(el);
  return normalize3(Math.sin(az) * cosEl, Math.sin(el), -Math.cos(az) * cosEl);
}

/**
 * Four exquisitely art-directed Qingdao Badaguan atmospheric lighting moods.
 * Default mood is 'autumn' (深秋暖陽).
 */
export const ATMOSPHERE_PRESETS: Record<TimeOfDayId, AtmosphereConfig> = {
  morning: {
    id: 'morning',
    nameZh: '晨霧海風',
    nameEn: 'Morning Sea Mist',
    subtitleZh: '微熹海霧籠罩紅瓦海岬，清涼潮汐輕拍石堤',
    sunDirection: sunDirFromAngles(118, 18),
    sunColor: '#fff0d6',
    sunIntensity: 1.92,
    hemiSkyColor: '#c6dde8',
    hemiGroundColor: '#616b63',
    hemiIntensity: 0.96,
    fogColor: '#d4dfe2',
    fogDensity: 0.0048,
    skyTopColor: '#5687a8',
    skyHorizonColor: '#dde7e9',
    skySunGlowColor: '#fff2d4',
    waterDeepColor: '#1b5a6e',
    waterShallowColor: '#4c9ea6',
    waterSunColor: '#fff3db',
    exposure: 1.05,
    bloomStrength: 0.24,
    bloomThreshold: 0.86,
    nightFactor: 0.05,
    windStrength: 0.78
  },
  autumn: {
    id: 'autumn',
    nameZh: '深秋暖陽',
    nameEn: 'Golden Autumn',
    subtitleZh: '午後暖陽斜照銀杏與紅瓦，黃海碧波流金',
    sunDirection: sunDirFromAngles(232, 24),
    sunColor: '#ffe3b8',
    sunIntensity: 2.68,
    hemiSkyColor: '#8ec2e8',
    hemiGroundColor: '#725d43',
    hemiIntensity: 0.84,
    fogColor: '#dfd3bf',
    fogDensity: 0.0019,
    skyTopColor: '#2468a8',
    skyHorizonColor: '#ebd4b4',
    skySunGlowColor: '#ffda98',
    waterDeepColor: '#10546d',
    waterShallowColor: '#2a9ea6',
    waterSunColor: '#ffe6b0',
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
    subtitleZh: '落日熔金染紅花石樓與海灣，街燈初上',
    sunDirection: sunDirFromAngles(246, 9),
    sunColor: '#ff8e4a',
    sunIntensity: 2.82,
    hemiSkyColor: '#d8887b',
    hemiGroundColor: '#4f3532',
    hemiIntensity: 0.7,
    fogColor: '#d49a80',
    fogDensity: 0.0027,
    skyTopColor: '#2d3466',
    skyHorizonColor: '#f58f62',
    skySunGlowColor: '#ffba6e',
    waterDeepColor: '#1a3754',
    waterShallowColor: '#4c767d',
    waterSunColor: '#ff9d4e',
    exposure: 1.06,
    bloomStrength: 0.46,
    bloomThreshold: 0.72,
    nightFactor: 0.55,
    windStrength: 1.12
  },
  twilight: {
    id: 'twilight',
    nameZh: '藍調燈火',
    nameEn: 'Blue-Hour Twilight',
    subtitleZh: '深藍暮色漫過八大關老街，暖黃花窗與路燈漸亮',
    sunDirection: sunDirFromAngles(220, 22),
    sunColor: '#86ace0',
    sunIntensity: 0.74,
    hemiSkyColor: '#2a4576',
    hemiGroundColor: '#1a202c',
    hemiIntensity: 0.58,
    fogColor: '#1a2842',
    fogDensity: 0.0032,
    skyTopColor: '#0a142e',
    skyHorizonColor: '#273e69',
    skySunGlowColor: '#8c5870',
    waterDeepColor: '#0a1d36',
    waterShallowColor: '#1a425e',
    waterSunColor: '#a2c1ec',
    exposure: 1.03,
    bloomStrength: 0.62,
    bloomThreshold: 0.6,
    nightFactor: 1.0,
    windStrength: 0.65
  }
};

export interface AtmosphereSystem {
  setPreset(id: TimeOfDayId, instant?: boolean): void;
  getCurrentId(): TimeOfDayId;
  getCurrentConfig(): AtmosphereConfig;
  getSunDirection(target?: THREE.Vector3): THREE.Vector3;
  getNightFactor(): number;
  getWindStrength(): number;
  readonly sunLight: THREE.DirectionalLight;
  readonly hemiLight: THREE.HemisphereLight;
  readonly seaBounceLight: THREE.DirectionalLight;
  readonly skyMesh: THREE.Mesh;
  update(time: number, dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

const SKY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldDir;
  uniform float uForceFarPlane;

  void main() {
    vWorldDir = normalize(position);
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vec4 clipPos = projectionMatrix * mvPos;
    if (uForceFarPlane > 0.5) {
      clipPos.z = clipPos.w * 0.99992;
    }
    gl_Position = clipPos;
  }
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uTopColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uSunGlowColor;
  uniform vec3 uSunColor;
  uniform vec3 uFogColor;
  uniform vec3 uGroundColor;
  uniform vec3 uSunDir;
  uniform float uTime;
  uniform float uNightFactor;
  uniform float uCloudOpacity;
  uniform float uShowStars;

  varying vec3 vWorldDir;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float valueNoise(vec2 p) {
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
    float amp = 0.52;
    mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
    for (int i = 0; i < 4; i++) {
      v += amp * valueNoise(p);
      p = rot * p * 2.04 + vec2(11.3, 7.1);
      amp *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vWorldDir);
    vec3 sunDir = normalize(uSunDir);
    float y = dir.y;
    float up = max(y, 0.0);

    // 1. Physically-inspired Rayleigh zenith-to-horizon scattering gradient
    float horizonPow = pow(1.0 - up, 2.35);
    vec3 sky = mix(uTopColor, uHorizonColor, horizonPow);

    // Subtle mid-sky atmospheric depth & coastal luminance
    float midBand = exp(-pow((up - 0.24) * 3.4, 2.0));
    sky += (uHorizonColor - uTopColor) * midBand * 0.08 * (1.0 - uNightFactor * 0.6);

    // 2. Solar Mie scattering halo & crisp glowing sun disk
    float sunDot = max(dot(dir, sunDir), 0.0);
    float dayWeight = 1.0 - smoothstep(0.65, 0.98, uNightFactor);

    // Broad warm forward scatter concentrated near horizon
    float broadHalo = pow(sunDot, 3.8) * mix(0.42, 0.18, up);
    float tightHalo = pow(sunDot, 36.0) * 0.65;
    float innerCorona = pow(sunDot, 220.0) * 1.15;
    float sunDisk = smoothstep(0.99915, 0.99972, sunDot) * 2.4;

    sky += uSunGlowColor * (broadHalo + tightHalo) * dayWeight;
    sky += uSunColor * (innerCorona + sunDisk) * dayWeight;

    // Soft rose-violet western horizon dusk afterglow during blue-hour twilight
    vec3 westHorizonDir = normalize(vec3(-0.88, 0.04, 0.46));
    float duskAzimuth = pow(max(dot(dir, westHorizonDir), 0.0), 2.6);
    float duskBand = exp(-abs(y - 0.025) * 9.0) * duskAzimuth;
    sky += uSunGlowColor * duskBand * smoothstep(0.25, 1.0, uNightFactor) * 0.58;

    // Gentle cool moonlight glow at twilight
    float moonWeight = smoothstep(0.55, 1.0, uNightFactor);
    float moonHalo = pow(sunDot, 28.0) * 0.24 + pow(sunDot, 360.0) * 0.65;
    float moonDisk = smoothstep(0.9993, 0.99975, sunDot) * 1.1;
    sky += uSunColor * (moonHalo + moonDisk) * moonWeight;

    // 3. Layered drifting coastal cumulus & high wispy cirrus clouds
    if (y > 0.008 && uCloudOpacity > 0.001) {
      float cloudFade = smoothstep(0.015, 0.19, y) * (1.0 - smoothstep(0.84, 1.0, y) * 0.25);
      vec2 proj = dir.xz / (y + 0.165);

      // Lower coastal cumulus ribbons
      vec2 uv1 = proj * 0.42 + vec2(uTime * 0.0075, -uTime * 0.0038);
      float n1 = fbm(uv1);
      float n1Detail = fbm(uv1 * 2.15 + vec2(3.4, -uTime * 0.005));
      float cumulus = smoothstep(0.49, 0.78, n1 * 0.72 + n1Detail * 0.28);

      // High translucent cirrus wisps
      vec2 uv2 = proj * 0.85 + vec2(-uTime * 0.0042, uTime * 0.0065);
      float cirrus = smoothstep(0.58, 0.86, fbm(uv2 * vec2(1.4, 0.65))) * 0.42;

      float cloudMask = clamp((cumulus * 0.82 + cirrus) * cloudFade * uCloudOpacity, 0.0, 0.92);

      // Cloud shading: warm sunlit silver-lining edges + ambient sky underside
      float sunForward = pow(sunDot, 3.0) * 0.65 + pow(sunDot, 14.0) * 0.6;
      vec3 cloudShadow = mix(uTopColor * 0.72, uHorizonColor * 0.78, 0.58);
      vec3 cloudLit = mix(uHorizonColor * 1.08, uSunGlowColor * 1.18, clamp(0.32 + sunForward * 0.68, 0.0, 1.0));
      cloudLit = mix(cloudLit, uSunColor * 1.15, pow(sunDot, 6.0) * 0.42 * dayWeight);

      // Darken clouds subtly at blue-hour twilight while keeping delicate rose/cool rims
      vec3 twilightCloud = mix(uTopColor * 0.85, uHorizonColor * 0.95, 0.45) + uSunGlowColor * duskAzimuth * 0.18;
      vec3 cloudColor = mix(mix(cloudShadow, cloudLit, clamp(0.45 + n1Detail * 0.55, 0.0, 1.0)), twilightCloud, uNightFactor * 0.82);

      sky = mix(sky, cloudColor, cloudMask);
    }

    // 4. Faint twinkling stars appearing during blue-hour twilight
    if (uShowStars > 0.5 && uNightFactor > 0.35 && y > 0.06) {
      float starFade = smoothstep(0.38, 0.92, uNightFactor) * smoothstep(0.08, 0.42, y);
      vec3 starGrid = dir * 240.0;
      vec3 cell = floor(starGrid);
      vec3 frac = fract(starGrid) - 0.5;
      float rnd = hash31(cell);
      if (rnd > 0.986) {
        vec3 jitter = vec3(
          hash31(cell + 17.1),
          hash31(cell + 43.7),
          hash31(cell + 91.3)
        ) - 0.5;
        float dist = length(frac - jitter * 0.48);
        float pointStar = smoothstep(0.16, 0.02, dist);
        float twinkle = 0.72 + 0.28 * sin(uTime * (1.8 + rnd * 4.0) + rnd * 62.8);
        vec3 starTint = mix(vec3(0.84, 0.91, 1.0), vec3(1.0, 0.93, 0.82), fract(rnd * 73.1));
        sky += starTint * pointStar * twinkle * starFade * 0.85;
      }
    }

    // 5. Seamless coastal horizon fog merge + lower hemisphere sea/ground bounce
    float horizonFog = exp(-abs(y) * 16.0);
    sky = mix(sky, uFogColor, horizonFog * 0.72);

    if (y < 0.0) {
      float downBlend = smoothstep(0.0, -0.35, y);
      sky = mix(uFogColor, uGroundColor, downBlend);
    }

    gl_FragColor = vec4(sky, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

interface MutableColorSet {
  sunColor: THREE.Color;
  hemiSkyColor: THREE.Color;
  hemiGroundColor: THREE.Color;
  fogColor: THREE.Color;
  skyTopColor: THREE.Color;
  skyHorizonColor: THREE.Color;
  skySunGlowColor: THREE.Color;
  waterDeepColor: THREE.Color;
  waterShallowColor: THREE.Color;
  waterSunColor: THREE.Color;
}

function createColorSet(cfg: AtmosphereConfig): MutableColorSet {
  return {
    sunColor: new THREE.Color(cfg.sunColor),
    hemiSkyColor: new THREE.Color(cfg.hemiSkyColor),
    hemiGroundColor: new THREE.Color(cfg.hemiGroundColor),
    fogColor: new THREE.Color(cfg.fogColor),
    skyTopColor: new THREE.Color(cfg.skyTopColor),
    skyHorizonColor: new THREE.Color(cfg.skyHorizonColor),
    skySunGlowColor: new THREE.Color(cfg.skySunGlowColor),
    waterDeepColor: new THREE.Color(cfg.waterDeepColor),
    waterShallowColor: new THREE.Color(cfg.waterShallowColor),
    waterSunColor: new THREE.Color(cfg.waterSunColor)
  };
}

function copyColorSet(dst: MutableColorSet, src: MutableColorSet): void {
  dst.sunColor.copy(src.sunColor);
  dst.hemiSkyColor.copy(src.hemiSkyColor);
  dst.hemiGroundColor.copy(src.hemiGroundColor);
  dst.fogColor.copy(src.fogColor);
  dst.skyTopColor.copy(src.skyTopColor);
  dst.skyHorizonColor.copy(src.skyHorizonColor);
  dst.skySunGlowColor.copy(src.skySunGlowColor);
  dst.waterDeepColor.copy(src.waterDeepColor);
  dst.waterShallowColor.copy(src.waterShallowColor);
  dst.waterSunColor.copy(src.waterSunColor);
}

function lerpColorSet(out: MutableColorSet, a: MutableColorSet, b: MutableColorSet, t: number): void {
  out.sunColor.copy(a.sunColor).lerp(b.sunColor, t);
  out.hemiSkyColor.copy(a.hemiSkyColor).lerp(b.hemiSkyColor, t);
  out.hemiGroundColor.copy(a.hemiGroundColor).lerp(b.hemiGroundColor, t);
  out.fogColor.copy(a.fogColor).lerp(b.fogColor, t);
  out.skyTopColor.copy(a.skyTopColor).lerp(b.skyTopColor, t);
  out.skyHorizonColor.copy(a.skyHorizonColor).lerp(b.skyHorizonColor, t);
  out.skySunGlowColor.copy(a.skySunGlowColor).lerp(b.skySunGlowColor, t);
  out.waterDeepColor.copy(a.waterDeepColor).lerp(b.waterDeepColor, t);
  out.waterShallowColor.copy(a.waterShallowColor).lerp(b.waterShallowColor, t);
  out.waterSunColor.copy(a.waterSunColor).lerp(b.waterSunColor, t);
}

function getPresetCloudOpacity(id: TimeOfDayId): number {
  switch (id) {
    case 'morning':
      return 0.52;
    case 'autumn':
      return 0.58;
    case 'sunset':
      return 0.72;
    case 'twilight':
      return 0.42;
  }
}

function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createAtmosphereSystem(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  initialMood: TimeOfDayId = 'autumn'
): AtmosphereSystem {
  const TRANSITION_DURATION = 1.4;
  const SUN_DISTANCE = 148;

  // Ensure crisp soft shadows on the renderer
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const presetColors: Record<TimeOfDayId, MutableColorSet> = {
    morning: createColorSet(ATMOSPHERE_PRESETS.morning),
    autumn: createColorSet(ATMOSPHERE_PRESETS.autumn),
    sunset: createColorSet(ATMOSPHERE_PRESETS.sunset),
    twilight: createColorSet(ATMOSPHERE_PRESETS.twilight)
  };

  let currentId: TimeOfDayId = initialMood;
  const initialPreset = ATMOSPHERE_PRESETS[initialMood];

  // Live interpolated scalar & color state
  const liveColors = createColorSet(initialPreset);
  const fromColors = createColorSet(initialPreset);
  const toColors = createColorSet(initialPreset);

  const liveSunDir = new THREE.Vector3(...initialPreset.sunDirection).normalize();
  const fromSunDir = liveSunDir.clone();
  const toSunDir = liveSunDir.clone();

  interface ScalarState {
    sunIntensity: number;
    hemiIntensity: number;
    fogDensity: number;
    exposure: number;
    bloomStrength: number;
    bloomThreshold: number;
    nightFactor: number;
    windStrength: number;
    cloudOpacity: number;
  }

  function extractScalars(cfg: AtmosphereConfig): ScalarState {
    return {
      sunIntensity: cfg.sunIntensity,
      hemiIntensity: cfg.hemiIntensity,
      fogDensity: cfg.fogDensity,
      exposure: cfg.exposure,
      bloomStrength: cfg.bloomStrength,
      bloomThreshold: cfg.bloomThreshold,
      nightFactor: cfg.nightFactor,
      windStrength: cfg.windStrength,
      cloudOpacity: getPresetCloudOpacity(cfg.id)
    };
  }

  const liveScalars = extractScalars(initialPreset);
  let fromScalars = extractScalars(initialPreset);
  let toScalars = extractScalars(initialPreset);

  let transitionProgress = 1.0;
  let pendingEnvRefresh = false;

  // Reusable live AtmosphereConfig returned by getCurrentConfig()
  const liveConfig: AtmosphereConfig = {
    ...initialPreset,
    sunDirection: [liveSunDir.x, liveSunDir.y, liveSunDir.z]
  };

  // --------------------------------------------------------------------------
  // 1. Atmospheric Sky Dome (Main Scene + Miniature PMREM Scene)
  // --------------------------------------------------------------------------
  const sharedGroundColor = new THREE.Color();

  const skyUniforms = {
    uTopColor: { value: liveColors.skyTopColor.clone() },
    uHorizonColor: { value: liveColors.skyHorizonColor.clone() },
    uSunGlowColor: { value: liveColors.skySunGlowColor.clone() },
    uSunColor: { value: liveColors.sunColor.clone() },
    uFogColor: { value: liveColors.fogColor.clone() },
    uGroundColor: { value: sharedGroundColor.clone() },
    uSunDir: { value: liveSunDir.clone() },
    uTime: { value: 0 },
    uNightFactor: { value: liveScalars.nightFactor },
    uCloudOpacity: { value: liveScalars.cloudOpacity },
    uShowStars: { value: 1.0 },
    uForceFarPlane: { value: 1.0 }
  };

  const skyGeometry = new THREE.SphereGeometry(220, 48, 32);
  const skyMaterial = new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: true
  });

  const skyMesh = new THREE.Mesh(skyGeometry, skyMaterial);
  skyMesh.name = 'BadaguanSkyDome';
  skyMesh.renderOrder = -1000;
  skyMesh.frustumCulled = false;
  scene.add(skyMesh);

  // Lightweight miniature sky scene for procedural PMREM environment reflections
  const envScene = new THREE.Scene();
  const envUniforms = {
    uTopColor: { value: liveColors.skyTopColor.clone() },
    uHorizonColor: { value: liveColors.skyHorizonColor.clone() },
    uSunGlowColor: { value: liveColors.skySunGlowColor.clone() },
    uSunColor: { value: liveColors.sunColor.clone() },
    uFogColor: { value: liveColors.fogColor.clone() },
    uGroundColor: { value: sharedGroundColor.clone() },
    uSunDir: { value: liveSunDir.clone() },
    uTime: { value: 0 },
    uNightFactor: { value: liveScalars.nightFactor },
    uCloudOpacity: { value: liveScalars.cloudOpacity * 0.45 },
    uShowStars: { value: 0.0 },
    uForceFarPlane: { value: 0.0 }
  };
  const envSkyGeometry = new THREE.SphereGeometry(18, 24, 16);
  const envSkyMaterial = new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
    uniforms: envUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false
  });
  const envSkyMesh = new THREE.Mesh(envSkyGeometry, envSkyMaterial);
  envScene.add(envSkyMesh);

  let pmremGenerator: THREE.PMREMGenerator | null = null;
  let envRenderTarget: THREE.WebGLRenderTarget | null = null;
  try {
    pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();
  } catch {
    pmremGenerator = null;
  }

  // --------------------------------------------------------------------------
  // 2. Scene Lighting Rig (Sun + Hemisphere + Yellow Sea Bounce Fill)
  // --------------------------------------------------------------------------
  const sunLight = new THREE.DirectionalLight(initialPreset.sunColor, initialPreset.sunIntensity);
  sunLight.name = 'BadaguanSunLight';
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -95;
  sunLight.shadow.camera.right = 95;
  sunLight.shadow.camera.top = 95;
  sunLight.shadow.camera.bottom = -95;
  sunLight.shadow.camera.near = 15;
  sunLight.shadow.camera.far = 320;
  sunLight.shadow.camera.updateProjectionMatrix();
  sunLight.shadow.bias = -0.00042;
  sunLight.shadow.normalBias = 0.045;
  sunLight.shadow.radius = 2.5;
  sunLight.target.position.set(0, 4, 0);
  scene.add(sunLight);
  scene.add(sunLight.target);

  const hemiLight = new THREE.HemisphereLight(
    initialPreset.hemiSkyColor,
    initialPreset.hemiGroundColor,
    initialPreset.hemiIntensity
  );
  hemiLight.name = 'BadaguanHemiLight';
  scene.add(hemiLight);

  // Subtle reflected bounce light rising from the glittering Yellow Sea (South +Z)
  const seaBounceLight = new THREE.DirectionalLight(initialPreset.waterShallowColor, 0.34);
  seaBounceLight.name = 'BadaguanSeaBounceLight';
  seaBounceLight.castShadow = false;
  seaBounceLight.position.set(16, 28, 118);
  seaBounceLight.target.position.set(0, 6, 0);
  scene.add(seaBounceLight);
  scene.add(seaBounceLight.target);

  // Exponential coastal atmospheric haze
  const fog = new THREE.FogExp2(initialPreset.fogColor, initialPreset.fogDensity);
  scene.fog = fog;

  const tmpSeaBounceColor = new THREE.Color();

  function syncSceneFromLiveState(): void {
    // 1. Lights
    sunLight.color.copy(liveColors.sunColor);
    sunLight.intensity = liveScalars.sunIntensity;
    sunLight.position.set(
      liveSunDir.x * SUN_DISTANCE,
      4 + liveSunDir.y * SUN_DISTANCE,
      liveSunDir.z * SUN_DISTANCE
    );

    hemiLight.color.copy(liveColors.hemiSkyColor);
    hemiLight.groundColor.copy(liveColors.hemiGroundColor);
    hemiLight.intensity = liveScalars.hemiIntensity;

    // Coastal sea bounce blends shallow turquoise water with warm solar reflection
    tmpSeaBounceColor
      .copy(liveColors.waterShallowColor)
      .lerp(liveColors.waterSunColor, 0.38);
    seaBounceLight.color.copy(tmpSeaBounceColor);
    seaBounceLight.intensity = lerpNum(0.36, 0.16, liveScalars.nightFactor);

    // 2. Fog & Renderer exposure
    fog.color.copy(liveColors.fogColor);
    fog.density = liveScalars.fogDensity;
    renderer.toneMappingExposure = liveScalars.exposure;

    // 3. Sky Dome & PMREM Sky Uniforms
    sharedGroundColor
      .copy(liveColors.waterDeepColor)
      .lerp(liveColors.hemiGroundColor, 0.45);

    skyUniforms.uTopColor.value.copy(liveColors.skyTopColor);
    skyUniforms.uHorizonColor.value.copy(liveColors.skyHorizonColor);
    skyUniforms.uSunGlowColor.value.copy(liveColors.skySunGlowColor);
    skyUniforms.uSunColor.value.copy(liveColors.sunColor);
    skyUniforms.uFogColor.value.copy(liveColors.fogColor);
    skyUniforms.uGroundColor.value.copy(sharedGroundColor);
    skyUniforms.uSunDir.value.copy(liveSunDir);
    skyUniforms.uNightFactor.value = liveScalars.nightFactor;
    skyUniforms.uCloudOpacity.value = liveScalars.cloudOpacity;

    // 4. Sync liveConfig snapshot for external subsystems (ocean, bloom, lamps)
    const targetMeta = ATMOSPHERE_PRESETS[currentId];
    liveConfig.id = targetMeta.id;
    liveConfig.nameZh = targetMeta.nameZh;
    liveConfig.nameEn = targetMeta.nameEn;
    liveConfig.subtitleZh = targetMeta.subtitleZh;
    liveConfig.sunDirection[0] = liveSunDir.x;
    liveConfig.sunDirection[1] = liveSunDir.y;
    liveConfig.sunDirection[2] = liveSunDir.z;
    liveConfig.sunColor = `#${liveColors.sunColor.getHexString()}`;
    liveConfig.sunIntensity = liveScalars.sunIntensity;
    liveConfig.hemiSkyColor = `#${liveColors.hemiSkyColor.getHexString()}`;
    liveConfig.hemiGroundColor = `#${liveColors.hemiGroundColor.getHexString()}`;
    liveConfig.hemiIntensity = liveScalars.hemiIntensity;
    liveConfig.fogColor = `#${liveColors.fogColor.getHexString()}`;
    liveConfig.fogDensity = liveScalars.fogDensity;
    liveConfig.skyTopColor = `#${liveColors.skyTopColor.getHexString()}`;
    liveConfig.skyHorizonColor = `#${liveColors.skyHorizonColor.getHexString()}`;
    liveConfig.skySunGlowColor = `#${liveColors.skySunGlowColor.getHexString()}`;
    liveConfig.waterDeepColor = `#${liveColors.waterDeepColor.getHexString()}`;
    liveConfig.waterShallowColor = `#${liveColors.waterShallowColor.getHexString()}`;
    liveConfig.waterSunColor = `#${liveColors.waterSunColor.getHexString()}`;
    liveConfig.exposure = liveScalars.exposure;
    liveConfig.bloomStrength = liveScalars.bloomStrength;
    liveConfig.bloomThreshold = liveScalars.bloomThreshold;
    liveConfig.nightFactor = liveScalars.nightFactor;
    liveConfig.windStrength = liveScalars.windStrength;
  }

  function rebuildEnvironmentMap(): void {
    if (!pmremGenerator) return;

    envUniforms.uTopColor.value.copy(liveColors.skyTopColor);
    envUniforms.uHorizonColor.value.copy(liveColors.skyHorizonColor);
    envUniforms.uSunGlowColor.value.copy(liveColors.skySunGlowColor);
    envUniforms.uSunColor.value.copy(liveColors.sunColor);
    envUniforms.uFogColor.value.copy(liveColors.fogColor);
    envUniforms.uGroundColor.value.copy(sharedGroundColor);
    envUniforms.uSunDir.value.copy(liveSunDir);
    envUniforms.uNightFactor.value = liveScalars.nightFactor;
    envUniforms.uCloudOpacity.value = liveScalars.cloudOpacity * 0.45;

    try {
      const nextRT = pmremGenerator.fromScene(envScene, 0.04);
      scene.environment = nextRT.texture;
      if (envRenderTarget) {
        envRenderTarget.dispose();
      }
      envRenderTarget = nextRT;
    } catch {
      // Gracefully skip PMREM refresh if context is unavailable
    }
  }

  function setPreset(id: TimeOfDayId, instant = false): void {
    const preset = ATMOSPHERE_PRESETS[id];
    if (!preset) return;

    currentId = id;

    if (instant) {
      copyColorSet(liveColors, presetColors[id]);
      copyColorSet(fromColors, presetColors[id]);
      copyColorSet(toColors, presetColors[id]);

      liveSunDir.set(...preset.sunDirection).normalize();
      fromSunDir.copy(liveSunDir);
      toSunDir.copy(liveSunDir);

      const s = extractScalars(preset);
      Object.assign(liveScalars, s);
      fromScalars = { ...s };
      toScalars = { ...s };

      transitionProgress = 1.0;
      pendingEnvRefresh = false;

      syncSceneFromLiveState();
      rebuildEnvironmentMap();
      return;
    }

    // Begin smooth transition from current live state to target preset
    copyColorSet(fromColors, liveColors);
    copyColorSet(toColors, presetColors[id]);

    fromSunDir.copy(liveSunDir);
    toSunDir.set(...preset.sunDirection).normalize();

    fromScalars = { ...liveScalars };
    toScalars = extractScalars(preset);

    transitionProgress = 0.0;
    pendingEnvRefresh = true;
  }

  function update(time: number, dt: number, camera: THREE.Camera): void {
    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    skyUniforms.uTime.value = time;

    // Keep sky dome centered on camera so horizon is infinite
    skyMesh.position.copy(camera.position);

    if (transitionProgress < 1.0) {
      transitionProgress = Math.min(1.0, transitionProgress + safeDt / TRANSITION_DURATION);
      const t = easeInOutCubic(transitionProgress);

      lerpColorSet(liveColors, fromColors, toColors, t);

      // Arc sun gracefully across the sky without dipping below horizon
      liveSunDir.copy(fromSunDir).lerp(toSunDir, t);
      const minElev = Math.min(fromSunDir.y, toSunDir.y);
      const arcLift = Math.sin(t * Math.PI) * 0.14;
      liveSunDir.y = Math.max(minElev, liveSunDir.y + arcLift);
      liveSunDir.normalize();

      liveScalars.sunIntensity = lerpNum(fromScalars.sunIntensity, toScalars.sunIntensity, t);
      liveScalars.hemiIntensity = lerpNum(fromScalars.hemiIntensity, toScalars.hemiIntensity, t);
      liveScalars.fogDensity = lerpNum(fromScalars.fogDensity, toScalars.fogDensity, t);
      liveScalars.exposure = lerpNum(fromScalars.exposure, toScalars.exposure, t);
      liveScalars.bloomStrength = lerpNum(fromScalars.bloomStrength, toScalars.bloomStrength, t);
      liveScalars.bloomThreshold = lerpNum(fromScalars.bloomThreshold, toScalars.bloomThreshold, t);
      liveScalars.nightFactor = lerpNum(fromScalars.nightFactor, toScalars.nightFactor, t);
      liveScalars.windStrength = lerpNum(fromScalars.windStrength, toScalars.windStrength, t);
      liveScalars.cloudOpacity = lerpNum(fromScalars.cloudOpacity, toScalars.cloudOpacity, t);

      syncSceneFromLiveState();

      if (transitionProgress >= 1.0 && pendingEnvRefresh) {
        pendingEnvRefresh = false;
        rebuildEnvironmentMap();
      }
    }
  }

  // Apply initial preset immediately
  syncSceneFromLiveState();
  rebuildEnvironmentMap();

  return {
    setPreset,
    getCurrentId: () => currentId,
    getCurrentConfig: () => liveConfig,
    getSunDirection: (target = new THREE.Vector3()) => target.copy(liveSunDir),
    getNightFactor: () => liveScalars.nightFactor,
    getWindStrength: () => liveScalars.windStrength,
    sunLight,
    hemiLight,
    seaBounceLight,
    skyMesh,
    update,
    dispose() {
      scene.remove(skyMesh);
      scene.remove(sunLight);
      scene.remove(sunLight.target);
      scene.remove(hemiLight);
      scene.remove(seaBounceLight);
      scene.remove(seaBounceLight.target);
      skyGeometry.dispose();
      skyMaterial.dispose();
      envSkyGeometry.dispose();
      envSkyMaterial.dispose();
      if (envRenderTarget) {
        envRenderTarget.dispose();
        envRenderTarget = null;
      }
      if (pmremGenerator) {
        pmremGenerator.dispose();
        pmremGenerator = null;
      }
    }
  };
}
