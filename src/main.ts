import './style.css';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import {
  DEFAULT_MOOD,
  VIEWPOINTS,
  getWalkableHeight,
  isWalkablePosition
} from './world/layout';
import {
  TEXTURES,
  disposeAllTextures,
  setTextureAnisotropy
} from './world/textures';
import { createTerrainAndSea } from './world/terrainAndSea';
import { createArchitecture } from './world/architecture';
import { createVegetationAndProps } from './world/vegetationAndProps';
import type {
  LandmarkDef,
  TimeOfDayId,
  ViewpointDef,
  WorldUpdateContext
} from './world/types';

import {
  ATMOSPHERE_PRESETS,
  createAtmosphereSystem
} from './systems/atmosphere';
import {
  createPlayerControls,
  type ControlMode
} from './systems/controls';
import { createAmbientAudio } from './systems/audio';
import {
  createHud,
  pickNearbyLandmark,
  resolveLocationLabel
} from './ui/hud';

// ============================================================================
// DEBUG / VERIFICATION API CONTRACT (window.__BADAGUAN__)
// ============================================================================

export interface BadaguanDebugState {
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
  mode: ControlMode;
  atmosphere: TimeOfDayId;
  roadName: string;
  activeLandmark: string | null;
  fps: number;
  drawCalls: number;
  triangles: number;
}

export interface BadaguanDebugAPI {
  setViewpoint(idOrIndex: string | number, instant?: boolean): boolean;
  setAtmosphere(id: TimeOfDayId, instant?: boolean): boolean;
  dismissIntro(): void;
  setHudVisible(visible: boolean): void;
  setCamera(pos: [number, number, number], target: [number, number, number]): void;
  getState(): BadaguanDebugState;
  getViewpoints(): string[];
}

declare global {
  interface Window {
    __BADAGUAN__?: BadaguanDebugAPI;
  }
}

const MOOD_CYCLE_ORDER: readonly TimeOfDayId[] = [
  'morning',
  'autumn',
  'sunset',
  'twilight'
];

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

function yieldPaintFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function prewarmProceduralTextures(): void {
  // Touch all lazy getters during the loading screen so frame 0 has zero texture-build hitch
  void TEXTURES.mushroomGranite;
  void TEXTURES.huashiPebbleStone;
  void TEXTURES.redRoofTiles;
  void TEXTURES.slateTurretRoof;
  void TEXTURES.warmStucco;
  void TEXTURES.nordicBlueWall;
  void TEXTURES.asphaltRoad;
  void TEXTURES.graniteCobble;
  void TEXTURES.beachSand;
  void TEXTURES.woodPlank;
  void TEXTURES.treeBark;
  void TEXTURES.sycamoreBark;
  void TEXTURES.windowDay;
  void TEXTURES.windowNightEmissive;
  void TEXTURES.foliageClusterTextures;
}

// ============================================================================
// MAIN APPLICATION BOOTSTRAP
// ============================================================================

async function bootstrap(): Promise<void> {
  const canvas = document.getElementById('scene-canvas') as HTMLCanvasElement | null;
  const hudRoot = document.getElementById('hud-root') ?? undefined;
  const loadingVeil = document.getElementById('loading-veil');
  const loadingBarFill = document.getElementById('loading-bar-fill');
  const loadingStatus = document.getElementById('loading-status');

  const setLoadingProgress = (percent: number, message: string): void => {
    if (loadingBarFill) {
      loadingBarFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }
    if (loadingStatus) {
      loadingStatus.textContent = message;
    }
  };

  if (!canvas) {
    setLoadingProgress(0, '無法找到畫布元素 (#scene-canvas)');
    return;
  }

  setLoadingProgress(12, '初始化三維渲染與天光大氣…');
  await yieldPaintFrame();

  // --------------------------------------------------------------------------
  // 1. WebGLRenderer, Scene, Camera, & Post-Processing Pipeline
  // --------------------------------------------------------------------------
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
  } catch (err) {
    console.error('[Badaguan] Failed to initialize WebGLRenderer:', err);
    setLoadingProgress(0, '您的瀏覽器不支援 WebGL，請嘗試更新或啟用硬體加速。');
    return;
  }

  const initialWidth = Math.max(1, window.innerWidth);
  const initialHeight = Math.max(1, window.innerHeight);
  const initialPixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  renderer.setPixelRatio(initialPixelRatio);
  renderer.setSize(initialWidth, initialHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = ATMOSPHERE_PRESETS[DEFAULT_MOOD].exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Reset info manually right before composer.render so drawCalls & triangles include the full frame
  renderer.info.autoReset = false;

  setTextureAnisotropy(renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  scene.name = 'QingdaoBadaguanScene';

  const camera = new THREE.PerspectiveCamera(
    VIEWPOINTS[0]?.fov ?? 54,
    initialWidth / initialHeight,
    0.25,
    1400
  );

  // Multisampled HDR render target preserves crisp antialiasing through UnrealBloomPass & OutputPass
  const composerTarget = new THREE.WebGLRenderTarget(initialWidth, initialHeight, {
    type: THREE.HalfFloatType,
    samples: renderer.capabilities.isWebGL2 ? 4 : 0
  });
  const composer = new EffectComposer(renderer, composerTarget);
  composer.setPixelRatio(initialPixelRatio);
  composer.setSize(initialWidth, initialHeight);

  const renderPass = new RenderPass(scene, camera);
  const defaultAtmosphereCfg = ATMOSPHERE_PRESETS[DEFAULT_MOOD];
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(
      Math.max(1, Math.floor(initialWidth * initialPixelRatio)),
      Math.max(1, Math.floor(initialHeight * initialPixelRatio))
    ),
    defaultAtmosphereCfg.bloomStrength,
    0.52,
    defaultAtmosphereCfg.bloomThreshold
  );
  const outputPass = new OutputPass();

  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);

  // --------------------------------------------------------------------------
  // 2. Atmosphere System & Procedural PBR Textures
  // --------------------------------------------------------------------------
  const atmosphere = createAtmosphereSystem(scene, renderer, DEFAULT_MOOD);

  setLoadingProgress(32, '繪製嶗山花崗岩、紅瓦與秋葉紋理…');
  await yieldPaintFrame();
  prewarmProceduralTextures();

  // --------------------------------------------------------------------------
  // 3. World Geometry Modules (Terrain/Sea, Villas/Courtyards, Foliage/Props)
  // --------------------------------------------------------------------------
  setLoadingProgress(54, '構築八大關海岸地形、道路與黃海碧波…');
  await yieldPaintFrame();
  const terrainAndSea = createTerrainAndSea(TEXTURES);
  scene.add(terrainAndSea.group);

  setLoadingProgress(74, '雕琢花石樓、公主樓、蝴蝶樓與萬國洋房…');
  await yieldPaintFrame();
  const architecture = createArchitecture(TEXTURES);
  scene.add(architecture.group);

  setLoadingProgress(90, '栽植銀杏、五角楓、法桐林蔭與海鷗…');
  await yieldPaintFrame();
  const vegetationAndProps = createVegetationAndProps(TEXTURES);
  scene.add(vegetationAndProps.group);

  // Sync all world modules to the authoritative AtmosphereSystem preset
  const syncWorldAtmosphere = (): void => {
    const cfg = atmosphere.getCurrentConfig();
    terrainAndSea.applyAtmosphere(cfg);
    architecture.applyAtmosphere(cfg);
    vegetationAndProps.applyAtmosphere(cfg);
    bloomPass.strength = cfg.bloomStrength;
    bloomPass.threshold = cfg.bloomThreshold;
  };
  syncWorldAtmosphere();

  // --------------------------------------------------------------------------
  // 4. Controls, Ambient Coastal Audio, & Poetic Glassmorphic HUD
  // --------------------------------------------------------------------------
  const controls = createPlayerControls(camera, canvas, {
    initialMode: 'walk'
  });
  // Keep camera tranquil behind the frosted welcome card until user enters
  controls.setEnabled(false);

  const audio = createAmbientAudio();

  const applyAtmosphereMood = (id: TimeOfDayId, instant = false): boolean => {
    if (!ATMOSPHERE_PRESETS[id]) return false;
    atmosphere.setPreset(id, instant);
    hud.setActiveMood(id);
    if (instant) {
      syncWorldAtmosphere();
    }
    return true;
  };

  const resolveViewpoint = (idOrIndex: string | number): { vp: ViewpointDef; index: number } | null => {
    if (typeof idOrIndex === 'number') {
      const vp = VIEWPOINTS[idOrIndex];
      return vp ? { vp, index: idOrIndex } : null;
    }
    const index = VIEWPOINTS.findIndex((item) => item.id === idOrIndex);
    if (index === -1) return null;
    return { vp: VIEWPOINTS[index], index };
  };

  const selectViewpoint = (idOrIndex: string | number, instant = false): boolean => {
    const resolved = resolveViewpoint(idOrIndex);
    if (!resolved) return false;
    controls.teleportTo(resolved.vp, instant);
    hud.setActiveViewpoint(resolved.vp.id);
    if (instant) {
      camera.updateMatrixWorld(true);
      syncHudSnapshot();
    }
    return true;
  };

  const hud = createHud(
    {
      onSelectMood(mood) {
        applyAtmosphereMood(mood, false);
      },
      onSelectViewpoint(vp) {
        controls.teleportTo(vp, false);
        hud.setActiveViewpoint(vp.id);
      },
      onToggleMode() {
        controls.toggleMode();
      },
      onRequestPointerLock() {
        controls.togglePointerLock();
      },
      onToggleAudio() {
        const enabled = audio.toggle();
        hud.setAudioEnabled(enabled);
      },
      onEnterExperience(enableAudio) {
        controls.setEnabled(true);
        if (enableAudio) {
          audio.setEnabled(true);
          hud.setAudioEnabled(audio.isEnabled());
        }
      }
    },
    hudRoot
  );

  const unsubMode = controls.onModeChange((mode) => {
    hud.setMode(mode);
  });
  const unsubLock = controls.onPointerLockChange((locked) => {
    hud.setPointerLocked(locked);
  });

  // Sync initial HUD badges immediately
  function syncHudSnapshot(): void {
    const pState = controls.getState();
    hud.update({
      position: pState.position,
      yaw: pState.yaw,
      mode: pState.mode,
      mood: atmosphere.getCurrentId(),
      isPointerLocked: pState.isPointerLocked,
      isAudioEnabled: audio.isEnabled()
    });
  }
  syncHudSnapshot();

  // --------------------------------------------------------------------------
  // 5. Global Atmosphere Cycle Shortcut (T) & Responsive Window Resize
  //    (1–6, H, M, ?, Enter handled in hud.ts; V, F, WASD handled in controls.ts)
  // --------------------------------------------------------------------------
  const onGlobalKeyDown = (e: KeyboardEvent): void => {
    if (isEditableElement(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (hud.isIntroVisible()) return;

    if (e.code === 'KeyT' && !e.repeat) {
      const currentIdx = MOOD_CYCLE_ORDER.indexOf(atmosphere.getCurrentId());
      const nextMood = MOOD_CYCLE_ORDER[(currentIdx + 1) % MOOD_CYCLE_ORDER.length];
      applyAtmosphereMood(nextMood, false);
    }
  };
  window.addEventListener('keydown', onGlobalKeyDown);

  const onResize = (): void => {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height);

    composer.setPixelRatio(pixelRatio);
    composer.setSize(width, height);
    bloomPass.resolution.set(
      Math.max(1, Math.floor(width * pixelRatio)),
      Math.max(1, Math.floor(height * pixelRatio))
    );
  };
  window.addEventListener('resize', onResize);

  // --------------------------------------------------------------------------
  // 6. Frame Loop, Stats Tracking, & Reusable Update Payload
  // --------------------------------------------------------------------------
  const sunDirectionScratch = new THREE.Vector3();
  const forwardScratch = new THREE.Vector3();
  const worldCtx: WorldUpdateContext = {
    time: 0,
    dt: 0.016,
    camera,
    nightFactor: atmosphere.getNightFactor(),
    sunDirection: atmosphere.getSunDirection(sunDirectionScratch),
    windStrength: atmosphere.getWindStrength(),
    atmosphere: atmosphere.getCurrentConfig()
  };

  let elapsedTime = 0;
  let lastFrameMs = performance.now();
  let smoothedFps = 60;
  let lastDrawCalls = 0;
  let lastTriangles = 0;
  let cachedDebugLandmark: LandmarkDef | null = null;
  let rafId = 0;
  let disposed = false;

  const renderSingleFrame = (dt: number): void => {
    elapsedTime += dt;

    controls.update(dt);
    atmosphere.update(elapsedTime, dt, camera);

    const cfg = atmosphere.getCurrentConfig();
    bloomPass.strength = cfg.bloomStrength;
    bloomPass.threshold = cfg.bloomThreshold;

    worldCtx.time = elapsedTime;
    worldCtx.dt = dt;
    worldCtx.nightFactor = atmosphere.getNightFactor();
    worldCtx.sunDirection = atmosphere.getSunDirection(sunDirectionScratch);
    worldCtx.windStrength = atmosphere.getWindStrength();
    worldCtx.atmosphere = cfg;

    terrainAndSea.update(worldCtx);
    architecture.update(worldCtx);
    vegetationAndProps.update(worldCtx);

    const pState = controls.getState();
    audio.update(pState.position.z, worldCtx.windStrength);

    hud.update({
      position: pState.position,
      yaw: pState.yaw,
      mode: pState.mode,
      mood: atmosphere.getCurrentId(),
      isPointerLocked: pState.isPointerLocked,
      isAudioEnabled: audio.isEnabled()
    });

    renderer.info.reset();
    composer.render(dt);
    lastDrawCalls = renderer.info.render.calls;
    lastTriangles = renderer.info.render.triangles;
  };

  // Render initial frame 0 before revealing the canvas so there is zero blank flash
  setLoadingProgress(100, '步入青島八大關…');
  renderSingleFrame(0.016);

  // --------------------------------------------------------------------------
  // 7. Expose Verification & Control Debug Handle (window.__BADAGUAN__)
  // --------------------------------------------------------------------------
  const debugApi: BadaguanDebugAPI = {
    setViewpoint(idOrIndex: string | number, instant = false): boolean {
      return selectViewpoint(idOrIndex, instant);
    },
    setAtmosphere(id: TimeOfDayId, instant = false): boolean {
      return applyAtmosphereMood(id, instant);
    },
    dismissIntro(): void {
      hud.dismissIntro();
      controls.setEnabled(true);
    },
    setHudVisible(visible: boolean): void {
      hud.setHudVisible(visible);
    },
    setCamera(
      pos: [number, number, number],
      target: [number, number, number]
    ): void {
      // Switch to free-fly when placing camera above eye height or over water/non-walkable terrain
      const groundY = getWalkableHeight(pos[0], pos[2]);
      const needsFly =
        Math.abs(pos[1] - (groundY + 1.68)) > 0.65 ||
        !isWalkablePosition(pos[0], pos[2], 0.45);
      if (needsFly && controls.getMode() !== 'fly') {
        controls.setMode('fly');
      }
      controls.setPose(pos, target);
      camera.updateMatrixWorld(true);
      syncHudSnapshot();
    },
    getState(): BadaguanDebugState {
      camera.updateMatrixWorld(true);
      const px = camera.position.x;
      const py = camera.position.y;
      const pz = camera.position.z;
      camera.getWorldDirection(forwardScratch);

      const mode = controls.getMode();
      const roadName = resolveLocationLabel(px, py, pz, mode);
      cachedDebugLandmark = pickNearbyLandmark(
        px,
        py,
        pz,
        mode,
        cachedDebugLandmark
      );

      return {
        cameraPosition: [px, py, pz],
        cameraTarget: [
          px + forwardScratch.x * 15,
          py + forwardScratch.y * 15,
          pz + forwardScratch.z * 15
        ],
        mode,
        atmosphere: atmosphere.getCurrentId(),
        roadName,
        activeLandmark: cachedDebugLandmark ? cachedDebugLandmark.nameZh : null,
        fps: Math.round(smoothedFps),
        drawCalls: lastDrawCalls,
        triangles: lastTriangles
      };
    },
    getViewpoints(): string[] {
      return VIEWPOINTS.map((vp) => vp.id);
    }
  };

  window.__BADAGUAN__ = debugApi;

  // Reveal the live 3D scene immediately once frame 0 has painted
  if (loadingVeil) {
    requestAnimationFrame(() => {
      loadingVeil.classList.add('hidden');
    });
  }

  // Prevent giant delta jumps when returning from a background browser tab
  const onVisibilityChange = (): void => {
    if (!document.hidden) {
      lastFrameMs = performance.now();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  const animate = (nowMs: number): void => {
    if (disposed) return;
    rafId = requestAnimationFrame(animate);

    const rawDt = Math.max(0.0001, (nowMs - lastFrameMs) / 1000);
    lastFrameMs = nowMs;

    if (rawDt < 0.5) {
      const instFps = Math.min(240, 1 / rawDt);
      smoothedFps = smoothedFps * 0.9 + instFps * 0.1;
    }

    const dt = Math.min(rawDt, 0.1);
    renderSingleFrame(dt);
  };

  lastFrameMs = performance.now();
  rafId = requestAnimationFrame(animate);

  // Clean disposal on page teardown
  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener('keydown', onGlobalKeyDown);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    unsubMode();
    unsubLock();
    controls.dispose();
    hud.dispose();
    audio.dispose();
    atmosphere.dispose();
    vegetationAndProps.dispose();
    bloomPass.dispose();
    outputPass.dispose();
    composer.dispose();
    composerTarget.dispose();
    disposeAllTextures();
    renderer.dispose();
    delete window.__BADAGUAN__;
  };

  window.addEventListener('beforeunload', cleanup, { once: true });
}

void bootstrap();
