import * as THREE from 'three';
import {
  COLLIDERS,
  SEA_LEVEL,
  SPAWN_POINT,
  clamp,
  getWalkableHeight,
  isWalkablePosition,
  resolvePlayerMovement
} from '../world/layout';
import type { ViewpointDef } from '../world/types';

export type ControlMode = 'walk' | 'fly';

export interface PlayerControlState {
  position: THREE.Vector3;
  yaw: number;
  pitch: number;
  /** Compass heading in degrees [0, 360), where 0=North (-Z), 90=East (+X), 180=South (+Z), 270=West (-X). */
  headingDeg: number;
  mode: ControlMode;
  speed: number;
  isGrounded: boolean;
  isPointerLocked: boolean;
  isTransitioning: boolean;
}

export interface PlayerControlsOptions {
  initialMode?: ControlMode;
  eyeHeight?: number;
  walkSpeed?: number;
  jogSpeed?: number;
  flySpeed?: number;
  flyFastSpeed?: number;
}

export interface PlayerControls {
  getMode(): ControlMode;
  setMode(mode: ControlMode): void;
  toggleMode(): ControlMode;
  requestPointerLock(): void;
  exitPointerLock(): void;
  togglePointerLock(): void;
  isPointerLocked(): boolean;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  teleportTo(viewpoint: ViewpointDef, instant?: boolean): void;
  setPose(position: [number, number, number], target: [number, number, number]): void;
  getState(): PlayerControlState;
  onModeChange(listener: (mode: ControlMode) => void): () => void;
  onPointerLockChange(listener: (locked: boolean) => void): () => void;
  update(dt: number): void;
  dispose(): void;
}

interface CameraTransition {
  active: boolean;
  elapsed: number;
  duration: number;
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  startYaw: number;
  deltaYaw: number;
  startPitch: number;
  endPitch: number;
  startFov: number;
  endFov: number;
  targetMode: ControlMode;
}

const MIN_PITCH = -Math.PI * 0.465;
const MAX_PITCH = Math.PI * 0.465;
const PLAYER_RADIUS = 0.55;
const GRAVITY = 14.0;
const JUMP_VELOCITY = 4.6;
const FLY_BOUNDS = {
  minX: -124,
  maxX: 124,
  minZ: -116,
  maxZ: 128,
  maxY: 84
};

function wrapAngleDelta(delta: number): number {
  let d = (delta + Math.PI) % (Math.PI * 2);
  if (d < 0) d += Math.PI * 2;
  return d - Math.PI;
}

function yawPitchFromLook(
  px: number,
  py: number,
  pz: number,
  tx: number,
  ty: number,
  tz: number
): { yaw: number; pitch: number } {
  const dx = tx - px;
  const dy = ty - py;
  const dz = tz - pz;
  const horiz = Math.hypot(dx, dz) || 1e-6;
  const yaw = Math.atan2(-dx, -dz);
  const pitch = clamp(Math.atan2(dy, horiz), MIN_PITCH, MAX_PITCH);
  return { yaw, pitch };
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Finds the closest safe walkable point when returning from Free-Fly to Walk mode
 * over deep water or inside a building footprint.
 */
function findNearestWalkablePoint(x: number, z: number): [number, number] {
  const b = COLLIDERS.worldBounds;
  const cx = clamp(x, b.minX + 1, b.maxX - 1);
  const cz = clamp(z, b.minZ + 1, b.maxZ - 1);

  if (isWalkablePosition(cx, cz, PLAYER_RADIUS)) {
    return [cx, cz];
  }

  for (let radius = 1.5; radius <= 28; radius += 1.5) {
    const samples = 16;
    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2;
      const sx = clamp(cx + Math.cos(angle) * radius, b.minX + 1, b.maxX - 1);
      const sz = clamp(cz + Math.sin(angle) * radius, b.minZ + 1, b.maxZ - 1);
      if (isWalkablePosition(sx, sz, PLAYER_RADIUS)) {
        return [sx, sz];
      }
    }
  }

  return [SPAWN_POINT.position[0], SPAWN_POINT.position[2]];
}

/**
 * Enhanced sliding collision step using COLLIDERS & isWalkablePosition from layout.ts,
 * with sub-stepping and diagonal wall tangent fallback for angled villas like Huashi Villa.
 */
function moveWithSmartSliding(
  startX: number,
  startZ: number,
  dx: number,
  dz: number
): { x: number; z: number } {
  const totalDist = Math.hypot(dx, dz);
  if (totalDist < 1e-6) return { x: startX, z: startZ };

  const steps = Math.max(1, Math.ceil(totalDist / 0.34));
  const stepX = dx / steps;
  const stepZ = dz / steps;

  let curX = startX;
  let curZ = startZ;

  for (let i = 0; i < steps; i++) {
    const nextX = curX + stepX;
    const nextZ = curZ + stepZ;

    const resolved = resolvePlayerMovement(curX, curZ, nextX, nextZ, PLAYER_RADIUS);
    if (resolved.x !== curX || resolved.z !== curZ) {
      curX = resolved.x;
      curZ = resolved.z;
      continue;
    }

    // Diagonal wall tangent slide fallback (e.g. Huashi Villa's rotated courtyard walls)
    const stepLen = Math.hypot(stepX, stepZ);
    const baseAngle = Math.atan2(stepZ, stepX);
    let slid = false;
    for (const offsetDeg of [35, -35, 62, -62]) {
      const a = baseAngle + (offsetDeg * Math.PI) / 180;
      const slideLen = stepLen * Math.cos((offsetDeg * Math.PI) / 180);
      const tx = curX + Math.cos(a) * slideLen;
      const tz = curZ + Math.sin(a) * slideLen;
      if (isWalkablePosition(tx, tz, PLAYER_RADIUS)) {
        curX = tx;
        curZ = tz;
        slid = true;
        break;
      }
    }

    if (!slid) {
      break;
    }
  }

  return { x: curX, z: curZ };
}

export function createPlayerControls(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
  options: PlayerControlsOptions = {}
): PlayerControls {
  const eyeHeight = options.eyeHeight ?? 1.68;
  const walkSpeed = options.walkSpeed ?? 5.6;
  const jogSpeed = options.jogSpeed ?? 10.6;
  const flySpeed = options.flySpeed ?? 15.0;
  const flyFastSpeed = options.flyFastSpeed ?? 32.0;

  let mode: ControlMode = options.initialMode ?? 'walk';
  let enabled = true;
  let pointerLocked = document.pointerLockElement === domElement;

  // Spatial state
  const position = new THREE.Vector3(
    SPAWN_POINT.position[0],
    getWalkableHeight(SPAWN_POINT.position[0], SPAWN_POINT.position[2]) + eyeHeight,
    SPAWN_POINT.position[2]
  );

  const initialAngles = yawPitchFromLook(
    position.x,
    position.y,
    position.z,
    SPAWN_POINT.target[0],
    SPAWN_POINT.target[1],
    SPAWN_POINT.target[2]
  );

  let yaw = initialAngles.yaw;
  let pitch = initialAngles.pitch;
  let targetYaw = yaw;
  let targetPitch = pitch;

  // Smoothed velocity, jump, and walking head-bob
  const velocity = new THREE.Vector3();
  let verticalVel = 0;
  let isGrounded = true;
  let smoothGroundY = getWalkableHeight(position.x, position.z);
  let bobPhase = 0;
  let bobAmount = 0;
  let wheelImpulse = 0;

  // Input tracking
  const keys = new Set<string>();
  let activeDragPointerId: number | null = null;
  let lastPointerX = 0;
  let lastPointerY = 0;

  // Listeners
  const modeListeners = new Set<(m: ControlMode) => void>();
  const lockListeners = new Set<(locked: boolean) => void>();

  // Smooth scenic viewpoint transition state
  const transition: CameraTransition = {
    active: false,
    elapsed: 0,
    duration: 1.2,
    startPos: new THREE.Vector3(),
    endPos: new THREE.Vector3(),
    startYaw: yaw,
    deltaYaw: 0,
    startPitch: pitch,
    endPitch: pitch,
    startFov: camera.fov,
    endFov: camera.fov,
    targetMode: mode
  };

  // Prevent browser pinch/scroll hijacking on canvas touch
  domElement.style.touchAction = 'none';

  // Configure camera rotation order for clean yaw-pitch FPS look
  camera.rotation.order = 'YXZ';

  function syncCameraTransform(): void {
    const bobOffsetY =
      mode === 'walk' && !transition.active ? Math.sin(bobPhase) * 0.036 * bobAmount : 0;
    const bobOffsetSide =
      mode === 'walk' && !transition.active ? Math.cos(bobPhase * 0.5) * 0.013 * bobAmount : 0;

    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    camera.position.set(
      position.x + rightX * bobOffsetSide,
      position.y + bobOffsetY,
      position.z + rightZ * bobOffsetSide
    );
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  function cancelTransition(): void {
    if (!transition.active) return;
    transition.active = false;
    targetYaw = yaw;
    targetPitch = pitch;
    smoothGroundY = getWalkableHeight(position.x, position.z);
  }

  function notifyModeChange(): void {
    for (const cb of modeListeners) {
      cb(mode);
    }
  }

  function notifyLockChange(): void {
    for (const cb of lockListeners) {
      cb(pointerLocked);
    }
  }

  function setMode(nextMode: ControlMode): void {
    if (mode === nextMode) return;
    mode = nextMode;
    velocity.set(0, 0, 0);
    verticalVel = 0;
    wheelImpulse = 0;

    if (mode === 'walk') {
      const [safeX, safeZ] = findNearestWalkablePoint(position.x, position.z);
      position.x = safeX;
      position.z = safeZ;
      smoothGroundY = getWalkableHeight(safeX, safeZ);
      // Allow a brief smooth settle if dropping down from low flight, or snap neatly if high
      if (position.y > smoothGroundY + eyeHeight + 6.0) {
        position.y = smoothGroundY + eyeHeight;
      } else if (position.y < smoothGroundY + eyeHeight) {
        position.y = smoothGroundY + eyeHeight;
      }
      isGrounded = position.y <= smoothGroundY + eyeHeight + 0.05;
      syncCameraTransform();
    } else {
      isGrounded = false;
      bobAmount = 0;
    }

    notifyModeChange();
  }

  function toggleMode(): ControlMode {
    setMode(mode === 'walk' ? 'fly' : 'walk');
    return mode;
  }

  function requestPointerLock(): void {
    if (!enabled) return;
    try {
      const result = domElement.requestPointerLock?.() as unknown as Promise<void> | undefined;
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          // Ignore rejected pointer-lock requests (e.g. headless or rapid ESC)
        });
      }
    } catch {
      // Gracefully ignore in unsupported environments
    }
  }

  function exitPointerLock(): void {
    try {
      if (document.pointerLockElement) {
        document.exitPointerLock?.();
      }
    } catch {
      // Ignore
    }
  }

  function togglePointerLock(): void {
    if (pointerLocked) {
      exitPointerLock();
    } else {
      requestPointerLock();
    }
  }

  function setPose(
    pos: [number, number, number],
    target: [number, number, number]
  ): void {
    transition.active = false;
    position.set(pos[0], pos[1], pos[2]);
    const angles = yawPitchFromLook(pos[0], pos[1], pos[2], target[0], target[1], target[2]);
    yaw = angles.yaw;
    pitch = angles.pitch;
    targetYaw = yaw;
    targetPitch = pitch;
    velocity.set(0, 0, 0);
    verticalVel = 0;
    smoothGroundY = getWalkableHeight(pos[0], pos[2]);
    isGrounded = mode === 'walk';
    syncCameraTransform();
  }

  function teleportTo(viewpoint: ViewpointDef, instant = false): void {
    const [vx, vy, vz] = viewpoint.position;
    const [tx, ty, tz] = viewpoint.target;
    const groundY = getWalkableHeight(vx, vz);
    const shouldFly = vy - groundY > 4.0 || !isWalkablePosition(vx, vz, 0.45);
    const destMode: ControlMode = shouldFly ? 'fly' : 'walk';
    const destY = destMode === 'walk' ? groundY + eyeHeight : vy;
    const destFov = viewpoint.fov ?? 54;

    const angles = yawPitchFromLook(vx, destY, vz, tx, ty, tz);
    velocity.set(0, 0, 0);
    verticalVel = 0;
    wheelImpulse = 0;

    if (instant) {
      transition.active = false;
      position.set(vx, destY, vz);
      yaw = angles.yaw;
      pitch = angles.pitch;
      targetYaw = yaw;
      targetPitch = pitch;
      smoothGroundY = groundY;
      isGrounded = destMode === 'walk';
      if (Math.abs(camera.fov - destFov) > 0.01) {
        camera.fov = destFov;
        camera.updateProjectionMatrix();
      }
      if (mode !== destMode) {
        mode = destMode;
        notifyModeChange();
      }
      syncCameraTransform();
      return;
    }

    transition.active = true;
    transition.elapsed = 0;
    transition.duration = 1.2;
    transition.startPos.copy(position);
    transition.endPos.set(vx, destY, vz);
    transition.startYaw = yaw;
    transition.deltaYaw = wrapAngleDelta(angles.yaw - yaw);
    transition.startPitch = pitch;
    transition.endPitch = angles.pitch;
    transition.startFov = camera.fov;
    transition.endFov = destFov;
    transition.targetMode = destMode;

    if (mode !== destMode) {
      mode = destMode;
      notifyModeChange();
    }
  }

  // --------------------------------------------------------------------------
  // Event Handlers
  // --------------------------------------------------------------------------
  const onKeyDown = (e: KeyboardEvent) => {
    if (!enabled || isEditableTarget(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const code = e.code;

    if (
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'Space'
    ) {
      e.preventDefault();
    }

    if (code === 'KeyV' && !e.repeat) {
      cancelTransition();
      toggleMode();
      return;
    }

    if (code === 'KeyF' && !e.repeat) {
      togglePointerLock();
      return;
    }

    if (
      code === 'KeyW' ||
      code === 'KeyA' ||
      code === 'KeyS' ||
      code === 'KeyD' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'Space' ||
      code === 'KeyE' ||
      code === 'KeyC' ||
      code === 'KeyQ'
    ) {
      cancelTransition();
    }

    // Gentle hop in Walk mode on Space press
    if (code === 'Space' && !e.repeat && mode === 'walk' && isGrounded) {
      verticalVel = JUMP_VELOCITY;
      isGrounded = false;
    }

    keys.add(code);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    keys.delete(e.code);
  };

  const onWindowBlur = () => {
    keys.clear();
    activeDragPointerId = null;
  };

  const onVisibilityChange = () => {
    if (document.hidden) {
      keys.clear();
      activeDragPointerId = null;
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    if (pointerLocked) return;

    // Only track primary single pointer for smooth drag-look
    if (activeDragPointerId !== null) return;
    activeDragPointerId = e.pointerId;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    cancelTransition();

    try {
      domElement.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events without active pointer capture
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!enabled || pointerLocked) return;
    if (activeDragPointerId === null || e.pointerId !== activeDragPointerId) return;

    const dx = e.clientX - lastPointerX;
    const dy = e.clientY - lastPointerY;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;

    // Panoramic grab-to-look sensitivity (matches cursor: grab / grabbing)
    const sens = e.pointerType === 'touch' ? 0.0044 : 0.0034;
    targetYaw += dx * sens;
    targetPitch = clamp(targetPitch + dy * sens, MIN_PITCH, MAX_PITCH);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== activeDragPointerId) return;
    activeDragPointerId = null;
    try {
      if (domElement.hasPointerCapture(e.pointerId)) {
        domElement.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }
  };

  const onMouseMoveLocked = (e: MouseEvent) => {
    if (!enabled || !pointerLocked) return;
    cancelTransition();

    // Guard against Chromium pointer-lock occasional jump spikes
    const mx = clamp(e.movementX, -140, 140);
    const my = clamp(e.movementY, -140, 140);
    const sens = 0.0022;

    targetYaw -= mx * sens;
    targetPitch = clamp(targetPitch - my * sens, MIN_PITCH, MAX_PITCH);
  };

  const onWheel = (e: WheelEvent) => {
    if (!enabled) return;
    e.preventDefault();
    cancelTransition();

    // Normalize wheel delta cleanly across mice & trackpads
    const delta = clamp(-e.deltaY, -180, 180) / 100;
    wheelImpulse = clamp(wheelImpulse + delta * (mode === 'fly' ? 4.8 : 2.2), -14, 14);
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  const onPointerLockChange = () => {
    const nextLocked = document.pointerLockElement === domElement;
    if (nextLocked !== pointerLocked) {
      pointerLocked = nextLocked;
      activeDragPointerId = null;
      notifyLockChange();
    }
  };

  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onWindowBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('mousemove', onMouseMoveLocked);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  domElement.addEventListener('pointerdown', onPointerDown);
  domElement.addEventListener('pointermove', onPointerMove);
  domElement.addEventListener('pointerup', onPointerUp);
  domElement.addEventListener('pointercancel', onPointerUp);
  domElement.addEventListener('wheel', onWheel, { passive: false });
  domElement.addEventListener('contextmenu', onContextMenu);

  // Sync initial camera pose immediately
  syncCameraTransform();

  function update(dt: number): void {
    const safeDt = Math.min(Math.max(dt, 0), 0.1);

    // 1. Handle smooth scenic viewpoint teleport transition
    if (transition.active) {
      transition.elapsed += safeDt;
      const rawT = clamp(transition.elapsed / transition.duration, 0, 1);
      const t = easeInOutCubic(rawT);

      position.lerpVectors(transition.startPos, transition.endPos, t);
      yaw = transition.startYaw + transition.deltaYaw * t;
      pitch = transition.startPitch + (transition.endPitch - transition.startPitch) * t;
      targetYaw = yaw;
      targetPitch = pitch;

      const nextFov = transition.startFov + (transition.endFov - transition.startFov) * t;
      if (Math.abs(camera.fov - nextFov) > 0.005) {
        camera.fov = nextFov;
        camera.updateProjectionMatrix();
      }

      if (rawT >= 1) {
        transition.active = false;
        smoothGroundY = getWalkableHeight(position.x, position.z);
        isGrounded = mode === 'walk';
      }

      syncCameraTransform();
      return;
    }

    // 2. Smooth angular damping for silky mouse/drag camera look
    const rotBlend = 1 - Math.exp(-24 * safeDt);
    yaw += (targetYaw - yaw) * rotBlend;
    pitch += (targetPitch - pitch) * rotBlend;

    // 3. Gather directional movement input relative to camera yaw
    let inputForward = 0;
    let inputRight = 0;
    let inputUp = 0;

    if (enabled) {
      if (keys.has('KeyW') || keys.has('ArrowUp')) inputForward += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) inputForward -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) inputRight += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) inputRight -= 1;

      if (mode === 'fly') {
        if (keys.has('Space') || keys.has('KeyE')) inputUp += 1;
        if (keys.has('KeyC') || keys.has('KeyQ')) inputUp -= 1;
      }
    }

    const inputLen = Math.hypot(inputForward, inputRight);
    if (inputLen > 1) {
      inputForward /= inputLen;
      inputRight /= inputLen;
    }

    const isFast = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    // Decay gentle mouse wheel forward/backward impulse
    const wheelStep = wheelImpulse;
    wheelImpulse *= Math.exp(-9.5 * safeDt);
    if (Math.abs(wheelImpulse) < 0.01) wheelImpulse = 0;

    if (mode === 'walk') {
      const maxSpeed = isFast ? jogSpeed : walkSpeed;
      const desiredVx = (forwardX * inputForward + rightX * inputRight) * maxSpeed + forwardX * wheelStep;
      const desiredVz = (forwardZ * inputForward + rightZ * inputRight) * maxSpeed + forwardZ * wheelStep;

      const accel = inputLen > 0 || Math.abs(wheelStep) > 0.05 ? 11.5 : 13.5;
      const velBlend = 1 - Math.exp(-accel * safeDt);
      velocity.x += (desiredVx - velocity.x) * velBlend;
      velocity.z += (desiredVz - velocity.z) * velBlend;
      velocity.y = 0;

      const dx = velocity.x * safeDt;
      const dz = velocity.z * safeDt;
      const moved = moveWithSmartSliding(position.x, position.z, dx, dz);

      // Soft clamp within playable Badaguan bounds
      const bounds = COLLIDERS.worldBounds;
      position.x = clamp(moved.x, bounds.minX, bounds.maxX);
      position.z = clamp(moved.z, bounds.minZ, bounds.maxZ);

      // Smooth walkable ground height following (roads, curbs, beach, stone jetty)
      const targetGroundY = getWalkableHeight(position.x, position.z);
      const groundBlend = 1 - Math.exp(-16 * safeDt);
      smoothGroundY += (targetGroundY - smoothGroundY) * groundBlend;

      const targetEyeY = smoothGroundY + eyeHeight;
      if (!isGrounded || verticalVel > 0 || position.y > targetEyeY + 0.06) {
        verticalVel -= GRAVITY * safeDt;
        position.y += verticalVel * safeDt;
        if (position.y <= targetEyeY) {
          position.y = targetEyeY;
          verticalVel = 0;
          isGrounded = true;
        }
      } else {
        position.y = targetEyeY;
        isGrounded = true;
      }

      // Gentle walking head-bob only while grounded and moving
      const horizSpeed = Math.hypot(velocity.x, velocity.z);
      const speedRatio = clamp(horizSpeed / walkSpeed, 0, 1.35);
      const targetBob = isGrounded && horizSpeed > 0.3 ? Math.min(speedRatio, 1.15) : 0;
      bobAmount += (targetBob - bobAmount) * (1 - Math.exp(-10 * safeDt));
      if (bobAmount > 0.01) {
        bobPhase += safeDt * (isFast ? 11.2 : 8.4) * Math.max(0.55, Math.min(speedRatio, 1.25));
      }
    } else {
      // Free-Fly mode: smooth horizontal yaw-relative movement + clean Space/E & C/Q altitude
      const maxSpeed = isFast ? flyFastSpeed : flySpeed;
      const desiredVx =
        (forwardX * inputForward + rightX * inputRight) * maxSpeed +
        forwardX * Math.cos(pitch) * wheelStep;
      const desiredVz =
        (forwardZ * inputForward + rightZ * inputRight) * maxSpeed +
        forwardZ * Math.cos(pitch) * wheelStep;
      const desiredVy = inputUp * (maxSpeed * 0.62) + Math.sin(pitch) * wheelStep;

      const velBlend = 1 - Math.exp(-8.5 * safeDt);
      velocity.x += (desiredVx - velocity.x) * velBlend;
      velocity.y += (desiredVy - velocity.y) * velBlend;
      velocity.z += (desiredVz - velocity.z) * velBlend;

      position.x = clamp(position.x + velocity.x * safeDt, FLY_BOUNDS.minX, FLY_BOUNDS.maxX);
      position.z = clamp(position.z + velocity.z * safeDt, FLY_BOUNDS.minZ, FLY_BOUNDS.maxZ);

      const minFlyY = Math.max(getWalkableHeight(position.x, position.z) + 1.25, SEA_LEVEL + 1.25);
      position.y = clamp(position.y + velocity.y * safeDt, minFlyY, FLY_BOUNDS.maxY);
      bobAmount = 0;
    }

    syncCameraTransform();
  }

  const statePositionSnapshot = new THREE.Vector3();

  function getState(): PlayerControlState {
    // Heading clockwise from North (-Z): 0 = N, 90 = E, 180 = S, 270 = W
    const rawDeg = ((-yaw * 180) / Math.PI) % 360;
    const headingDeg = rawDeg < 0 ? rawDeg + 360 : rawDeg;
    statePositionSnapshot.copy(position);

    return {
      position: statePositionSnapshot,
      yaw,
      pitch,
      headingDeg,
      mode,
      speed: Math.hypot(velocity.x, velocity.y, velocity.z),
      isGrounded,
      isPointerLocked: pointerLocked,
      isTransitioning: transition.active
    };
  }

  return {
    getMode: () => mode,
    setMode,
    toggleMode,
    requestPointerLock,
    exitPointerLock,
    togglePointerLock,
    isPointerLocked: () => pointerLocked,
    setEnabled(nextEnabled: boolean) {
      enabled = nextEnabled;
      if (!enabled) {
        keys.clear();
        activeDragPointerId = null;
        if (pointerLocked) {
          exitPointerLock();
        }
      }
    },
    isEnabled: () => enabled,
    teleportTo,
    setPose,
    getState,
    onModeChange(listener) {
      modeListeners.add(listener);
      return () => modeListeners.delete(listener);
    },
    onPointerLockChange(listener) {
      lockListeners.add(listener);
      return () => lockListeners.delete(listener);
    },
    update,
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('mousemove', onMouseMoveLocked);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      domElement.removeEventListener('pointerdown', onPointerDown);
      domElement.removeEventListener('pointermove', onPointerMove);
      domElement.removeEventListener('pointerup', onPointerUp);
      domElement.removeEventListener('pointercancel', onPointerUp);
      domElement.removeEventListener('wheel', onWheel);
      domElement.removeEventListener('contextmenu', onContextMenu);
      modeListeners.clear();
      lockListeners.clear();
      keys.clear();
    }
  };
}
