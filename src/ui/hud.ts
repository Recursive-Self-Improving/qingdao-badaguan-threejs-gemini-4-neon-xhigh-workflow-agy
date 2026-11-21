import type * as THREE from 'three';
import {
  LANDMARKS,
  VIEWPOINTS,
  getCoastZone,
  getJettyHeight,
  getRoadInfo
} from '../world/layout';
import type { LandmarkDef, TimeOfDayId, ViewpointDef } from '../world/types';
import type { ControlMode } from '../systems/controls';

export interface HudCallbacks {
  onSelectMood: (mood: TimeOfDayId) => void;
  onSelectViewpoint: (viewpoint: ViewpointDef, index: number) => void;
  onToggleMode: () => void;
  onRequestPointerLock: () => void;
  onToggleAudio: () => void;
  onEnterExperience?: (enableAudio: boolean) => void;
}

export interface HudUpdateState {
  position: THREE.Vector3 | [number, number, number];
  yaw: number;
  mode: ControlMode;
  mood: TimeOfDayId;
  isPointerLocked: boolean;
  isAudioEnabled: boolean;
  activeViewpointId?: string | null;
}

export interface HudController {
  update(state: HudUpdateState): void;
  setActiveMood(mood: TimeOfDayId): void;
  setActiveViewpoint(idOrIndex: string | number | null): void;
  setMode(mode: ControlMode): void;
  setPointerLocked(locked: boolean): void;
  setAudioEnabled(enabled: boolean): void;
  dismissIntro(): void;
  isIntroVisible(): boolean;
  setHudVisible(visible: boolean): void;
  isHudVisible(): boolean;
  toggleHelp(force?: boolean): void;
  dispose(): void;
}

const MOOD_ITEMS: { id: TimeOfDayId; label: string; dotColor: string; title: string }[] = [
  { id: 'morning', label: '晨霧', dotColor: '#cfe0e6', title: '晨霧海風 · Morning Sea Mist' },
  { id: 'autumn', label: '暖秋', dotColor: '#e8b954', title: '深秋暖陽 · Golden Autumn' },
  { id: 'sunset', label: '夕照', dotColor: '#f08b57', title: '黃昏夕照 · Sunset Glow' },
  { id: 'twilight', label: '夜燈', dotColor: '#6f94d6', title: '藍調燈火 · Blue-Hour Twilight' }
];

const VIEWPOINT_SHORT_LABELS: Record<string, string> = {
  ginkgo_avenue: '銀杏大道',
  princess_house: '公主樓',
  huashi_cape: '花石樓',
  second_beach_jetty: '第二浴場石堤',
  maple_butterfly: '楓林與蝴蝶樓',
  coastal_overview: '紅瓦碧海俯瞰'
};

const EXTRA_STYLE_ID = 'badaguan-hud-extra-styles';

function ensureExtraHudStyles(): void {
  if (document.getElementById(EXTRA_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = EXTRA_STYLE_ID;
  style.textContent = `
    /* Scoped Gallery-Grade Additions for Qingdao Badaguan HUD */
    .hud-top-left {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
    }

    .hud-loc-compass {
      padding: 9px 16px;
      gap: 13px;
    }

    .compass-strip {
      position: relative;
      width: 112px;
      height: 22px;
      overflow: hidden;
      border-left: 1px solid var(--border-subtle);
      padding-left: 12px;
      display: flex;
      align-items: center;
      mask-image: linear-gradient(90deg, transparent 0%, #000 18%, #000 82%, transparent 100%);
      -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 18%, #000 82%, transparent 100%);
    }

    .compass-track {
      display: flex;
      align-items: center;
      white-space: nowrap;
      will-change: transform;
      font-size: 11px;
      letter-spacing: 0.04em;
      color: var(--ivory-muted);
    }

    .compass-tick {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      flex-shrink: 0;
      text-align: center;
    }

    .compass-tick.cardinal {
      color: var(--ivory);
      font-family: var(--font-serif);
      font-weight: 600;
      font-size: 11.5px;
    }

    .compass-tick.north {
      color: var(--ginkgo-gold);
    }

    .compass-needle {
      position: absolute;
      left: calc(50% + 6px);
      top: 0;
      width: 0;
      height: 0;
      transform: translateX(-50%);
      border-left: 3.5px solid transparent;
      border-right: 3.5px solid transparent;
      border-top: 4.5px solid var(--ginkgo-gold);
      pointer-events: none;
    }

    .mood-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      opacity: 0.88;
    }

    .icon-pill.icon-square {
      padding: 7px 11px;
      font-weight: 600;
    }

    /* Lower-left contextual landmark story card */
    .landmark-card.hud-story-left {
      left: 24px;
      right: auto;
      bottom: 88px;
      width: min(358px, calc(100vw - 48px));
      border-left: 3px solid var(--ginkgo-gold);
    }

    /* Minimal Cinema-Mode Restore Pill */
    .hud-restore-pill {
      position: fixed;
      top: 20px;
      right: 24px;
      z-index: 25;
      padding: 8px 15px;
      border-radius: var(--radius-pill);
      font-size: 12px;
      letter-spacing: 0.08em;
      color: var(--ivory-soft);
      cursor: pointer;
      opacity: 0;
      transform: translateY(-6px);
      pointer-events: none;
      transition: opacity 280ms var(--ease-out), transform 280ms var(--ease-out);
    }

    #hud-root.hud-minimal .toolbar-row {
      opacity: 0;
      pointer-events: none;
    }

    #hud-root.hud-minimal .hud-restore-pill {
      opacity: 0.82;
      transform: translateY(0);
      pointer-events: auto;
    }

    #hud-root.hud-minimal .hud-restore-pill:hover {
      opacity: 1;
      color: var(--ivory);
      border-color: var(--border-warm);
    }

    /* Translucent Frosted Welcome / Intro Overlay over Live 3D Badaguan */
    .intro-overlay {
      position: fixed;
      inset: 0;
      z-index: 40;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: radial-gradient(circle at 50% 44%, rgba(16, 22, 28, 0.34) 0%, rgba(12, 17, 23, 0.64) 100%);
      backdrop-filter: blur(7px) saturate(118%);
      -webkit-backdrop-filter: blur(7px) saturate(118%);
      pointer-events: auto;
      opacity: 1;
      visibility: visible;
      transition: opacity 640ms var(--ease-out), visibility 640ms var(--ease-out);
    }

    .intro-overlay.dismissed {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }

    .intro-card {
      width: min(560px, 100%);
      padding: 36px 38px 32px;
      text-align: center;
      background: rgba(16, 21, 28, 0.66);
      border: 1px solid rgba(246, 240, 228, 0.22);
      border-radius: var(--radius-lg);
      box-shadow: 0 24px 64px rgba(6, 10, 16, 0.48);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .intro-seal {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 5px 14px;
      border-radius: 6px;
      background: linear-gradient(145deg, var(--terracotta), #973926);
      border: 1px solid rgba(255, 228, 202, 0.36);
      font-family: var(--font-serif);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.26em;
      text-indent: 0.26em;
      color: var(--ivory);
      box-shadow: 0 6px 18px rgba(151, 57, 38, 0.36);
      margin-bottom: 18px;
    }

    .intro-title {
      font-family: var(--font-serif);
      font-size: clamp(30px, 4.4vw, 44px);
      font-weight: 600;
      letter-spacing: 0.22em;
      text-indent: 0.22em;
      color: var(--ivory);
      line-height: 1.2;
    }

    .intro-subtitle {
      margin-top: 12px;
      font-family: var(--font-serif);
      font-size: 14.5px;
      letter-spacing: 0.16em;
      color: var(--ginkgo-gold);
    }

    .intro-divider {
      width: 64px;
      height: 1px;
      margin: 22px 0 18px;
      background: linear-gradient(90deg, transparent, rgba(229, 178, 84, 0.65), transparent);
    }

    .intro-hints {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px 14px;
      font-size: 12px;
      line-height: 1.7;
      color: var(--ivory-soft);
      max-width: 470px;
    }

    .intro-hints span {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .intro-hints kbd {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 5px;
      background: rgba(246, 240, 228, 0.13);
      border: 1px solid rgba(246, 240, 228, 0.22);
      color: var(--ivory);
      font-family: var(--font-sans);
      font-size: 10.5px;
    }

    .intro-cta {
      margin-top: 26px;
      appearance: none;
      border: 1px solid rgba(255, 228, 180, 0.45);
      background: linear-gradient(135deg, #c45238 0%, #d4893d 100%);
      color: #fffaf0;
      font-family: var(--font-serif);
      font-size: 16px;
      font-weight: 600;
      letter-spacing: 0.24em;
      text-indent: 0.24em;
      padding: 13px 38px;
      border-radius: var(--radius-pill);
      cursor: pointer;
      box-shadow: 0 10px 28px rgba(196, 82, 56, 0.36);
      transition: transform 220ms var(--ease-out), box-shadow 220ms var(--ease-out), filter 220ms var(--ease-out);
    }

    .intro-cta:hover {
      transform: translateY(-2px);
      box-shadow: 0 14px 34px rgba(212, 137, 61, 0.44);
      filter: brightness(1.06);
    }

    .intro-cta:active {
      transform: translateY(0);
    }

    .intro-audio-opt {
      margin-top: 14px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      color: var(--ivory-muted);
      cursor: pointer;
    }

    .intro-audio-opt input {
      accent-color: var(--ginkgo-gold);
      cursor: pointer;
    }

    /* Help Modal */
    .hud-help-backdrop {
      position: fixed;
      inset: 0;
      z-index: 35;
      background: rgba(12, 16, 22, 0.52);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 240ms var(--ease-out), visibility 240ms var(--ease-out);
    }

    .hud-help-backdrop.open {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }

    .hud-help-panel {
      width: min(460px, 100%);
      padding: 24px 26px;
      background: var(--ink-glass-strong);
    }

    .hud-help-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .hud-help-header h2 {
      font-family: var(--font-serif);
      font-size: 18px;
      font-weight: 600;
      letter-spacing: 0.12em;
      color: var(--ivory);
    }

    .hud-help-close {
      appearance: none;
      border: 1px solid var(--border-subtle);
      background: rgba(246, 240, 228, 0.08);
      color: var(--ivory-soft);
      width: 28px;
      height: 28px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
    }

    .hud-help-close:hover {
      background: rgba(246, 240, 228, 0.16);
      color: var(--ivory);
    }

    .hud-help-list {
      display: grid;
      gap: 10px;
      font-size: 13px;
      color: var(--ivory-soft);
    }

    .hud-help-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(246, 240, 228, 0.08);
    }

    .hud-help-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }

    .hud-help-row kbd {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 5px;
      background: rgba(246, 240, 228, 0.12);
      border: 1px solid rgba(246, 240, 228, 0.22);
      color: var(--ginkgo-gold);
      font-family: var(--font-sans);
      font-size: 11px;
    }

    @media (max-width: 900px) {
      .intro-card {
        padding: 26px 22px 24px;
      }
      .landmark-card.hud-story-left {
        left: 14px;
        bottom: 74px;
      }
      .compass-strip {
        width: 84px;
      }
    }
  `;
  document.head.appendChild(style);
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Resolves an authentic Traditional Chinese road or coastal zone name from world coordinates.
 */
export function resolveLocationLabel(x: number, y: number, z: number, mode: ControlMode): string {
  if (mode === 'fly' && y > 17.5) {
    return '紅瓦碧海 · 空中俯瞰';
  }

  if (getJettyHeight(x, z) !== null) {
    return '第二海水浴場 · 濱海石堤';
  }

  const roadInfo = getRoadInfo(x, z);
  if (roadInfo.onRoad || roadInfo.onShoulder || roadInfo.edgeDistance < 2.4) {
    switch (roadInfo.roadId) {
      case 'juyongguan':
        return '居庸關路 · 銀杏大道';
      case 'jiayuguan':
        return '嘉峪關路 · 五角楓林';
      case 'shanhaiguan':
        return '山海關路 · 法桐海濱';
      case 'huashi_cape':
        return '黃海路 · 海岬小徑';
      case 'beach_boardwalk':
        return '第二海水浴場 · 濱海棧道';
      default:
        break;
    }
  }

  // Hero landmark courtyards & coastal headland
  if (Math.hypot(x - 48, z - 44) < 23 || (x > 26 && z > 25 && z < 66)) {
    return '花石樓海岬';
  }
  if (Math.hypot(x - 12, z + 2) < 16) {
    return '公主樓庭院';
  }
  if (Math.hypot(x + 32, z - 11) < 16) {
    return '蝴蝶樓庭院';
  }

  const coastZone = getCoastZone(x, z);
  switch (coastZone) {
    case 'beach':
      return '第二海水浴場 · 金沙灣';
    case 'seawall':
      return '山海關路 · 濱海觀瀾';
    case 'reef':
      return '花石樓海岬 · 礁石海岸';
    case 'sea':
      return '黃海灣岸 · 碧波遠眺';
    default:
      return '八大關 · 萬國洋房林蔭';
  }
}

/**
 * Selects the most relevant nearby landmark card with subtle hysteresis to prevent flicker.
 */
export function pickNearbyLandmark(
  x: number,
  y: number,
  z: number,
  mode: ControlMode,
  currentLandmark: LandmarkDef | null
): LandmarkDef | null {
  // Hide ground-level proximity cards while soaring high in aerial overview
  if (mode === 'fly' && y > 20) {
    return null;
  }

  let best: LandmarkDef | null = null;
  let bestScore = Infinity;

  for (let i = 0; i < LANDMARKS.length; i++) {
    const lm = LANDMARKS[i];
    const dist = Math.hypot(x - lm.position[0], z - lm.position[2]);
    const effectiveRadius = currentLandmark?.id === lm.id ? lm.radius + 3.0 : lm.radius;

    if (dist <= effectiveRadius) {
      // Prioritize signature villas & coastal landmarks slightly over broad road zones
      const priorityBias = lm.category === 'villa' ? 0.62 : lm.category === 'coast' ? 0.78 : 1.0;
      const score = (dist / lm.radius) * priorityBias;
      if (score < bestScore) {
        bestScore = score;
        best = lm;
      }
    }
  }

  return best;
}

export function createHud(
  callbacks: HudCallbacks,
  container?: HTMLElement
): HudController {
  ensureExtraHudStyles();

  const root = container ?? document.getElementById('hud-root') ?? document.body;
  root.innerHTML = '';

  let introVisible = true;
  let hudVisible = true;
  let helpOpen = false;
  let activeMood: TimeOfDayId = 'autumn';
  let activeViewpointId: string | null = VIEWPOINTS[0]?.id ?? null;
  let activeLandmark: LandmarkDef | null = null;
  let lastLocationText = '';
  let lastMode: ControlMode | null = null;
  let lastLocked: boolean | null = null;
  let lastAudio: boolean | null = null;
  let lastHeadingRounded = Number.NaN;

  // ==========================================================================
  // 1. TOP BAR: Location + Sliding Compass Pill (Left) & Toolbar (Right)
  // ==========================================================================
  const topBar = document.createElement('div');
  topBar.className = 'hud-top';

  const topLeft = document.createElement('div');
  topLeft.className = 'hud-top-left';

  const locationPill = document.createElement('div');
  locationPill.className = 'glass-panel location-pill hud-loc-compass';

  const locationDot = document.createElement('span');
  locationDot.className = 'location-dot';

  const locationNameEl = document.createElement('span');
  locationNameEl.className = 'location-name';
  locationNameEl.textContent = '居庸關路 · 銀杏大道';

  // Minimal horizontal compass tape (16 ticks * 24px = 384px per 360° cycle, repeated 3x for seamless wrap)
  const compassStrip = document.createElement('div');
  compassStrip.className = 'compass-strip';
  compassStrip.setAttribute('aria-label', '方位羅盤');

  const compassNeedle = document.createElement('span');
  compassNeedle.className = 'compass-needle';

  const compassTrack = document.createElement('div');
  compassTrack.className = 'compass-track';

  const TICK_LABELS = [
    { text: '北', cls: 'cardinal north' },
    { text: '·', cls: '' },
    { text: '東北', cls: '' },
    { text: '·', cls: '' },
    { text: '東', cls: 'cardinal' },
    { text: '·', cls: '' },
    { text: '東南', cls: '' },
    { text: '·', cls: '' },
    { text: '南', cls: 'cardinal' },
    { text: '·', cls: '' },
    { text: '西南', cls: '' },
    { text: '·', cls: '' },
    { text: '西', cls: 'cardinal' },
    { text: '·', cls: '' },
    { text: '西北', cls: '' },
    { text: '·', cls: '' }
  ];
  const TICK_WIDTH = 24;
  const CYCLE_PX = TICK_LABELS.length * TICK_WIDTH; // 384px = 360deg

  for (let rep = 0; rep < 3; rep++) {
    for (const tick of TICK_LABELS) {
      const span = document.createElement('span');
      span.className = tick.cls ? `compass-tick ${tick.cls}` : 'compass-tick';
      span.textContent = tick.text;
      compassTrack.appendChild(span);
    }
  }

  compassStrip.appendChild(compassTrack);
  compassStrip.appendChild(compassNeedle);

  locationPill.appendChild(locationDot);
  locationPill.appendChild(locationNameEl);
  locationPill.appendChild(compassStrip);
  topLeft.appendChild(locationPill);

  // Top-right toolbar cluster
  const topRight = document.createElement('div');
  topRight.className = 'hud-top-right';

  const moodBar = document.createElement('div');
  moodBar.className = 'glass-panel mood-bar';
  moodBar.setAttribute('role', 'group');
  moodBar.setAttribute('aria-label', '天光氛圍切換');

  const moodButtons = new Map<TimeOfDayId, HTMLButtonElement>();
  for (const item of MOOD_ITEMS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = item.id === activeMood ? 'mood-btn active' : 'mood-btn';
    btn.title = item.title;
    btn.dataset.mood = item.id;

    const dot = document.createElement('span');
    dot.className = 'mood-dot';
    dot.style.background = item.dotColor;

    const label = document.createElement('span');
    label.textContent = item.label;

    btn.appendChild(dot);
    btn.appendChild(label);
    btn.addEventListener('click', () => {
      setActiveMood(item.id);
      callbacks.onSelectMood(item.id);
    });

    moodBar.appendChild(btn);
    moodButtons.set(item.id, btn);
  }

  const toolbarRow = document.createElement('div');
  toolbarRow.className = 'toolbar-row';

  const modeBtn = document.createElement('button');
  modeBtn.type = 'button';
  modeBtn.className = 'glass-panel icon-pill';
  modeBtn.title = '切換漫步 / 自由飛行模式 (V)';
  modeBtn.textContent = '漫步 (V)';
  modeBtn.addEventListener('click', () => callbacks.onToggleMode());

  const lockBtn = document.createElement('button');
  lockBtn.type = 'button';
  lockBtn.className = 'glass-panel icon-pill';
  lockBtn.title = '鎖定滑鼠視角，按 ESC 釋放 (F)';
  lockBtn.textContent = '鎖定視角 (F)';
  lockBtn.addEventListener('click', () => callbacks.onRequestPointerLock());

  const audioBtn = document.createElement('button');
  audioBtn.type = 'button';
  audioBtn.className = 'glass-panel icon-pill';
  audioBtn.title = '開啟或靜音黃海浪聲與秋風聲景 (M)';
  audioBtn.textContent = '海風聲景';
  audioBtn.addEventListener('click', () => callbacks.onToggleAudio());

  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  helpBtn.className = 'glass-panel icon-pill icon-square';
  helpBtn.title = '操作說明 (?)';
  helpBtn.textContent = '?';
  helpBtn.addEventListener('click', () => toggleHelp());

  const hideBtn = document.createElement('button');
  hideBtn.type = 'button';
  hideBtn.className = 'glass-panel icon-pill icon-square';
  hideBtn.title = '隱藏介面進入純淨觀景模式 (H)';
  hideBtn.textContent = 'H';
  hideBtn.addEventListener('click', () => setHudVisible(!hudVisible));

  toolbarRow.appendChild(modeBtn);
  toolbarRow.appendChild(lockBtn);
  toolbarRow.appendChild(audioBtn);
  toolbarRow.appendChild(helpBtn);
  toolbarRow.appendChild(hideBtn);

  topRight.appendChild(moodBar);
  topRight.appendChild(toolbarRow);

  topBar.appendChild(topLeft);
  topBar.appendChild(topRight);

  // ==========================================================================
  // 2. CONTEXTUAL LANDMARK STORY CARD (Lower-Left)
  // ==========================================================================
  const landmarkCard = document.createElement('aside');
  landmarkCard.className = 'glass-panel landmark-card hud-story-left';
  landmarkCard.setAttribute('aria-live', 'polite');

  const lmMeta = document.createElement('div');
  lmMeta.className = 'landmark-meta';
  const lmRoadEl = document.createElement('span');
  const lmYearEl = document.createElement('span');
  lmMeta.appendChild(lmRoadEl);
  lmMeta.appendChild(lmYearEl);

  const lmTitleEl = document.createElement('h3');
  lmTitleEl.className = 'landmark-title';

  const lmEnEl = document.createElement('div');
  lmEnEl.className = 'landmark-en';

  const lmDescEl = document.createElement('p');
  lmDescEl.className = 'landmark-desc';

  landmarkCard.appendChild(lmMeta);
  landmarkCard.appendChild(lmTitleEl);
  landmarkCard.appendChild(lmEnEl);
  landmarkCard.appendChild(lmDescEl);

  // ==========================================================================
  // 3. BOTTOM SCENIC VIEWPOINT DOCK & COMPACT CONTROLS HINT
  // ==========================================================================
  const bottomBar = document.createElement('div');
  bottomBar.className = 'hud-bottom';

  const vpDock = document.createElement('nav');
  vpDock.className = 'glass-panel viewpoint-dock';
  vpDock.setAttribute('aria-label', '八大關經典視角');

  const vpButtons: { id: string; btn: HTMLButtonElement }[] = [];
  VIEWPOINTS.forEach((vp, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = vp.id === activeViewpointId ? 'viewpoint-btn active' : 'viewpoint-btn';
    btn.title = vp.subtitleZh;

    const badge = document.createElement('span');
    badge.className = 'vp-index';
    badge.textContent = String(idx + 1);

    const text = document.createElement('span');
    text.textContent = VIEWPOINT_SHORT_LABELS[vp.id] ?? vp.nameZh;

    btn.appendChild(badge);
    btn.appendChild(text);
    btn.addEventListener('click', () => {
      setActiveViewpoint(vp.id);
      callbacks.onSelectViewpoint(vp, idx);
    });

    vpDock.appendChild(btn);
    vpButtons.push({ id: vp.id, btn });
  });

  const controlsHint = document.createElement('div');
  controlsHint.className = 'glass-panel controls-hint';
  controlsHint.innerHTML =
    '<span><kbd>WASD</kbd> 移動</span>' +
    '<span><kbd>拖曳</kbd> / <kbd>F</kbd> 視角</span>' +
    '<span><kbd>V</kbd> 飛行</span>' +
    '<span><kbd>T</kbd> 天光</span>' +
    '<span><kbd>H</kbd> 隱藏</span>';

  bottomBar.appendChild(vpDock);
  bottomBar.appendChild(controlsHint);

  // ==========================================================================
  // 4. POINTER-LOCK RETICLE & CINEMA-MODE RESTORE HINT
  // ==========================================================================
  const reticle = document.createElement('div');
  reticle.className = 'walk-reticle';

  const restorePill = document.createElement('button');
  restorePill.type = 'button';
  restorePill.className = 'glass-panel hud-restore-pill';
  restorePill.textContent = '按 H 顯示介面';
  restorePill.addEventListener('click', () => setHudVisible(true));

  // ==========================================================================
  // 5. HELP MODAL (?)
  // ==========================================================================
  const helpBackdrop = document.createElement('div');
  helpBackdrop.className = 'hud-help-backdrop';
  helpBackdrop.setAttribute('role', 'dialog');
  helpBackdrop.setAttribute('aria-modal', 'true');
  helpBackdrop.setAttribute('aria-label', '八大關漫遊操作說明');

  const helpPanel = document.createElement('div');
  helpPanel.className = 'glass-panel hud-help-panel';
  helpPanel.innerHTML = `
    <div class="hud-help-header">
      <h2>漫遊操作指南</h2>
      <button type="button" class="hud-help-close" aria-label="關閉">×</button>
    </div>
    <div class="hud-help-list">
      <div class="hud-help-row"><span>前後左右移動</span><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 或 <kbd>方向鍵</kbd></span></div>
      <div class="hud-help-row"><span>加速慢跑 / 快速飛行</span><span><kbd>Shift</kbd></span></div>
      <div class="hud-help-row"><span>自由旋轉視角</span><span><kbd>滑鼠拖曳</kbd> 或 <kbd>F</kbd> 鎖定視角</span></div>
      <div class="hud-help-row"><span>漫步輕跳 / 飛行升降</span><span><kbd>Space</kbd><kbd>E</kbd> 上升 · <kbd>C</kbd><kbd>Q</kbd> 下降</span></div>
      <div class="hud-help-row"><span>切換漫步 / 自由飛行</span><span><kbd>V</kbd></span></div>
      <div class="hud-help-row"><span>快速前往六大經典景觀</span><span><kbd>1</kbd> – <kbd>6</kbd></span></div>
      <div class="hud-help-row"><span>循環切換天光氛圍</span><span><kbd>T</kbd></span></div>
      <div class="hud-help-row"><span>開關海風與海浪聲景</span><span><kbd>M</kbd></span></div>
      <div class="hud-help-row"><span>隱藏 / 恢復介面</span><span><kbd>H</kbd></span></div>
    </div>
  `;

  const helpCloseBtn = helpPanel.querySelector('.hud-help-close');
  helpCloseBtn?.addEventListener('click', () => toggleHelp(false));
  helpBackdrop.addEventListener('click', (e) => {
    if (e.target === helpBackdrop) toggleHelp(false);
  });
  helpBackdrop.appendChild(helpPanel);

  // ==========================================================================
  // 6. WELCOME / INTRO OVERLAY (Translucent over Live Animated 3D Badaguan)
  // ==========================================================================
  const introOverlay = document.createElement('div');
  introOverlay.className = 'intro-overlay';
  introOverlay.setAttribute('role', 'dialog');
  introOverlay.setAttribute('aria-modal', 'true');

  const introCard = document.createElement('div');
  introCard.className = 'intro-card';

  const introSeal = document.createElement('div');
  introSeal.className = 'intro-seal';
  introSeal.textContent = '萬國建築博覽館';

  const introTitle = document.createElement('h1');
  introTitle.className = 'intro-title';
  introTitle.textContent = '青島 · 八大關';

  const introSubtitle = document.createElement('p');
  introSubtitle.className = 'intro-subtitle';
  introSubtitle.textContent = '紅瓦綠樹 · 碧海藍天 · 沉浸式虛擬景觀漫遊';

  const introDivider = document.createElement('div');
  introDivider.className = 'intro-divider';

  const introHints = document.createElement('div');
  introHints.className = 'intro-hints';
  introHints.innerHTML =
    '<span><kbd>WASD</kbd> / <kbd>方向鍵</kbd> 移動</span>' +
    '<span><kbd>滑鼠拖曳</kbd> 或按 <kbd>F</kbd> 鎖定視角</span>' +
    '<span><kbd>V</kbd> 切換漫步 / 飛行</span>' +
    '<span><kbd>1–6</kbd> 景觀視角</span>' +
    '<span><kbd>H</kbd> 隱藏介面</span>';

  const introCta = document.createElement('button');
  introCta.type = 'button';
  introCta.className = 'intro-cta';
  introCta.textContent = '步入八大關';

  const audioOptLabel = document.createElement('label');
  audioOptLabel.className = 'intro-audio-opt';
  const audioOptCheckbox = document.createElement('input');
  audioOptCheckbox.type = 'checkbox';
  audioOptCheckbox.checked = true;
  const audioOptText = document.createElement('span');
  audioOptText.textContent = '同時開啟海風與黃海潮汐聲景';
  audioOptLabel.appendChild(audioOptCheckbox);
  audioOptLabel.appendChild(audioOptText);

  introCta.addEventListener('click', () => {
    const wantsAudio = audioOptCheckbox.checked;
    dismissIntro();
    if (callbacks.onEnterExperience) {
      callbacks.onEnterExperience(wantsAudio);
    } else if (wantsAudio) {
      callbacks.onToggleAudio();
    }
  });

  introCard.appendChild(introSeal);
  introCard.appendChild(introTitle);
  introCard.appendChild(introSubtitle);
  introCard.appendChild(introDivider);
  introCard.appendChild(introHints);
  introCard.appendChild(introCta);
  introCard.appendChild(audioOptLabel);
  introOverlay.appendChild(introCard);

  // Mount all elements into HUD root
  root.appendChild(topBar);
  root.appendChild(landmarkCard);
  root.appendChild(bottomBar);
  root.appendChild(reticle);
  root.appendChild(restorePill);
  root.appendChild(helpBackdrop);
  root.appendChild(introOverlay);

  // ==========================================================================
  // State Setters & Update Methods
  // ==========================================================================
  function setActiveMood(mood: TimeOfDayId): void {
    activeMood = mood;
    for (const [id, btn] of moodButtons) {
      btn.classList.toggle('active', id === mood);
    }
  }

  function setActiveViewpoint(idOrIndex: string | number | null): void {
    if (typeof idOrIndex === 'number') {
      activeViewpointId = VIEWPOINTS[idOrIndex]?.id ?? null;
    } else {
      activeViewpointId = idOrIndex;
    }
    for (const item of vpButtons) {
      item.btn.classList.toggle('active', item.id === activeViewpointId);
    }
  }

  function setMode(mode: ControlMode): void {
    if (lastMode === mode) return;
    lastMode = mode;
    modeBtn.textContent = mode === 'fly' ? '飛行 (V)' : '漫步 (V)';
    modeBtn.classList.toggle('active', mode === 'fly');
  }

  function setPointerLocked(locked: boolean): void {
    const showReticle = locked && !introVisible;
    if (lastLocked === locked && reticle.classList.contains('visible') === showReticle) return;
    lastLocked = locked;
    lockBtn.textContent = locked ? '已鎖定 (ESC)' : '鎖定視角 (F)';
    lockBtn.classList.toggle('active', locked);
    reticle.classList.toggle('visible', showReticle);
  }

  function setAudioEnabled(enabled: boolean): void {
    if (lastAudio === enabled) return;
    lastAudio = enabled;
    audioBtn.textContent = enabled ? '海風聲景 · 開' : '海風聲景';
    audioBtn.classList.toggle('active', enabled);
  }

  function dismissIntro(): void {
    if (!introVisible) return;
    introVisible = false;
    introOverlay.classList.add('dismissed');
    reticle.classList.toggle('visible', Boolean(lastLocked));
  }

  function setHudVisible(visible: boolean): void {
    hudVisible = visible;
    root.classList.toggle('hud-minimal', !visible);
    if (!visible && helpOpen) {
      toggleHelp(false);
    }
  }

  function toggleHelp(force?: boolean): void {
    helpOpen = force !== undefined ? force : !helpOpen;
    helpBackdrop.classList.toggle('open', helpOpen);
    helpBtn.classList.toggle('active', helpOpen);
  }

  function updateCompass(yaw: number): void {
    // Heading clockwise from North (-Z) in [0, 360)
    const rawDeg = ((-yaw * 180) / Math.PI) % 360;
    const headingDeg = rawDeg < 0 ? rawDeg + 360 : rawDeg;
    const rounded = Math.round(headingDeg * 10);
    if (rounded === lastHeadingRounded) return;
    lastHeadingRounded = rounded;

    // Position the middle cycle's heading pixel directly under the center needle
    const stripWidth = compassStrip.clientWidth || 112;
    const stripCenter = (stripWidth - 12) * 0.5;
    const headingOffsetPx = CYCLE_PX + (headingDeg / 360) * CYCLE_PX + TICK_WIDTH * 0.5;
    const translateX = stripCenter - headingOffsetPx;
    compassTrack.style.transform = `translate3d(${translateX.toFixed(1)}px, 0, 0)`;
  }

  function updateLandmarkCard(lm: LandmarkDef | null): void {
    if (lm?.id === activeLandmark?.id) return;
    activeLandmark = lm;

    if (!lm) {
      landmarkCard.classList.remove('visible');
      return;
    }

    lmRoadEl.textContent = lm.roadZh;
    lmYearEl.textContent = lm.year;
    lmTitleEl.textContent = lm.nameZh;
    lmEnEl.textContent = lm.nameEn;
    lmDescEl.textContent = lm.descriptionZh;
    landmarkCard.classList.add('visible');
  }

  function update(state: HudUpdateState): void {
    const x = Array.isArray(state.position) ? state.position[0] : state.position.x;
    const y = Array.isArray(state.position) ? state.position[1] : state.position.y;
    const z = Array.isArray(state.position) ? state.position[2] : state.position.z;

    updateCompass(state.yaw);

    const locText = resolveLocationLabel(x, y, z, state.mode);
    if (locText !== lastLocationText) {
      lastLocationText = locText;
      locationNameEl.textContent = locText;
    }

    setMode(state.mode);
    if (state.mood !== activeMood) {
      setActiveMood(state.mood);
    }
    setPointerLocked(state.isPointerLocked);
    setAudioEnabled(state.isAudioEnabled);

    if (state.activeViewpointId !== undefined && state.activeViewpointId !== activeViewpointId) {
      setActiveViewpoint(state.activeViewpointId);
    }

    if (!introVisible) {
      const nearby = pickNearbyLandmark(x, y, z, state.mode, activeLandmark);
      updateLandmarkCard(nearby);
    } else if (activeLandmark) {
      updateLandmarkCard(null);
    }
  }

  // ==========================================================================
  // HUD Keyboard Shortcuts (1–6 Viewpoints, H Hide HUD, ? Help, M Audio, Enter)
  // ==========================================================================
  const onKeyDown = (e: KeyboardEvent) => {
    if (isEditableElement(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (introVisible) {
      if (e.key === 'Enter') {
        e.preventDefault();
        introCta.click();
      }
      return;
    }

    if (e.key === 'Escape' && helpOpen) {
      toggleHelp(false);
      return;
    }

    if (e.code === 'KeyH' && !e.repeat) {
      setHudVisible(!hudVisible);
      return;
    }

    if (e.code === 'KeyM' && !e.repeat) {
      callbacks.onToggleAudio();
      return;
    }

    if ((e.key === '?' || (e.code === 'Slash' && e.shiftKey)) && !e.repeat) {
      toggleHelp();
      return;
    }

    if (!e.repeat && e.key >= '1' && e.key <= '6') {
      const idx = Number(e.key) - 1;
      const vp = VIEWPOINTS[idx];
      if (vp) {
        setActiveViewpoint(vp.id);
        callbacks.onSelectViewpoint(vp, idx);
      }
    }
  };

  window.addEventListener('keydown', onKeyDown);

  return {
    update,
    setActiveMood,
    setActiveViewpoint,
    setMode,
    setPointerLocked,
    setAudioEnabled,
    dismissIntro,
    isIntroVisible: () => introVisible,
    setHudVisible,
    isHudVisible: () => hudVisible,
    toggleHelp,
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      root.innerHTML = '';
    }
  };
}
