import type * as ThreeModule from 'three';
import { BALL_RADIUS, BowlingSimulation, HEAD_PIN_Z, LANE_HALF, PIN_SPOTS } from './bowling-sim';

type Three = typeof ThreeModule;

// Pistas a lo largo de +z (la linea de falta en z = 0). La del jugador local siempre en el centro.
export const BOWLING_MAX_LANES = 5;
const LANE_PITCH = 1.75;
const LANE_LENGTH = 20.5;
const PIN_HEIGHT = 0.38;
const FALL_MS = 420;
// Tirada "normal" de los demas: recta hasta los bolos y derriba los que diga el servidor.
const OTHER_ROLL_MS = 2300;
const FOV = 50;

export interface BowlingLaneView {
  playerId: string;
  name: string;
  color: string;
  isLocal: boolean;
}

interface Lane {
  view: BowlingLaneView;
  x: number;
  ball: ThreeModule.Mesh;
  pins: ThreeModule.Group[];
  /** Tirada propia simulada. */
  simulation: BowlingSimulation | null;
  /** Tirada de otro jugador: cuantos bolos tira. */
  otherPins: number | null;
  startedAt: number;
  fallen: Array<{ at: number; dirX: number; dirZ: number } | null>;
}

/**
 * Escena 3D de Bolos: bolera con hasta cinco pistas. La pista propia reproduce la simulacion fotograma a fotograma
 * (bola con efecto y bolos chocando); las demas hacen una tirada recta y derriban el numero de bolos indicado.
 */
export class BowlingScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly lanes = new Map<string, Lane>();
  private readonly scratch: ThreeModule.Vector3;
  private readonly cameraTarget: ThreeModule.Vector3;
  private readonly cameraPosition: ThreeModule.Vector3;
  private frameHandle = 0;
  private lastFrame = performance.now();

  /** Aviso cuando la bola de una pista llega a los bolos (para el sonido). */
  onStrikeSound?: (playerId: string, pins: number) => void;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    views: BowlingLaneView[],
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#1b1530');
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.05, 120);
    this.scratch = new T.Vector3();
    this.cameraTarget = new T.Vector3(0, 0.4, 12);
    this.cameraPosition = new T.Vector3(0, 1.7, -3.2);

    this.scene.add(new T.HemisphereLight(0xffffff, 0x2a2040, 1.4));
    const key = new T.DirectionalLight(0xfff2e0, 1.2);
    key.position.set(2, 8, -4);
    this.scene.add(key);
    const pinLight = new T.PointLight(0xffffff, 12, 10, 1.5);
    pinLight.position.set(0, 3, HEAD_PIN_Z);
    this.scene.add(pinLight);

    const count = Math.min(BOWLING_MAX_LANES, views.length);
    this.buildAlley(count);
    views.slice(0, BOWLING_MAX_LANES).forEach((view, index) => this.createLane(view, (index - (count - 1) / 2) * LANE_PITCH));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.loop();
  }

  /** Tirada propia: la bola sale ya, siguiendo la simulacion. */
  rollLocal(playerId: string, simulation: BowlingSimulation): void {
    const lane = this.lanes.get(playerId);

    if (lane && !lane.simulation) {
      lane.simulation = simulation;
      lane.startedAt = performance.now();
    }
  }

  /** Tirada de otro jugador (cuando el servidor reparte los resultados). */
  rollOther(playerId: string, pins: number, startedAt: number): void {
    const lane = this.lanes.get(playerId);

    if (lane && !lane.view.isLocal && lane.otherPins === null) {
      lane.otherPins = pins;
      lane.startedAt = startedAt;
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();

    for (const item of this.disposables) {
      item.dispose();
    }

    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private material(color: string, roughness = 0.6, extra: Partial<ThreeModule.MeshStandardMaterialParameters> = {}): ThreeModule.MeshStandardMaterial {
    return this.track(new this.THREE.MeshStandardMaterial({ color, roughness, ...extra }));
  }

  private buildAlley(count: number): void {
    const T = this.THREE;
    const width = Math.max(count, 3) * LANE_PITCH + 4;

    // Suelo de la zona de lanzamiento, paredes y un fondo con luces de neon.
    const floor = new T.Mesh(this.track(new T.PlaneGeometry(width + 10, 14)), this.material('#2b2340', 0.8));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.01, -5);
    this.scene.add(floor);
    const back = new T.Mesh(this.track(new T.PlaneGeometry(width + 10, 6)), this.material('#120d22', 0.9));
    back.position.set(0, 2.2, LANE_LENGTH + 0.4);
    this.scene.add(back);

    ['#ff4fd8', '#4fc3ff', '#ffd23f'].forEach((color, index) => {
      const neon = new T.Mesh(this.track(new T.BoxGeometry(width, 0.06, 0.06)), this.material(color, 0.3, { emissive: color, emissiveIntensity: 1.4 }));
      neon.position.set(0, 2.2 + index * 0.35, LANE_LENGTH + 0.3);
      this.scene.add(neon);
    });

    // Tablero de madera de cada pista: textura de listones.
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 32;
    const context = canvas.getContext('2d')!;

    for (let x = 0; x < 128; x += 8) {
      context.fillStyle = (x / 8) % 2 ? '#e2b77d' : '#d9ab6c';
      context.fillRect(x, 0, 8, 32);
    }

    const texture = this.track(new T.CanvasTexture(canvas));
    texture.colorSpace = T.SRGBColorSpace;
    texture.wrapT = T.RepeatWrapping;
    texture.repeat.set(1, 20);
    const wood = this.track(new T.MeshStandardMaterial({ map: texture, roughness: 0.25, metalness: 0.05 }));
    const gutter = this.material('#3d3a45', 0.5, { metalness: 0.4 });
    const divider = this.material('#5a4a7a', 0.6);
    const arrows = this.material('#7a4a2a', 0.5);

    for (let index = 0; index < count; index += 1) {
      const x = (index - (count - 1) / 2) * LANE_PITCH;
      const lane = new T.Mesh(this.track(new T.BoxGeometry(LANE_HALF * 2, 0.04, LANE_LENGTH)), wood);
      lane.position.set(x, -0.02, LANE_LENGTH / 2);
      this.scene.add(lane);

      for (const side of [-1, 1]) {
        const channel = new T.Mesh(this.track(new T.BoxGeometry(0.24, 0.02, LANE_LENGTH)), gutter);
        channel.position.set(x + side * (LANE_HALF + 0.12), -0.07, LANE_LENGTH / 2);
        this.scene.add(channel);
      }

      // Flechas guia a unos metros de la linea de falta.
      for (let arrow = -3; arrow <= 3; arrow += 1) {
        const mark = new T.Mesh(this.track(new T.ConeGeometry(0.035, 0.18, 3)), arrows);
        mark.rotation.x = Math.PI / 2;
        mark.position.set(x + arrow * 0.13, 0.005, 4.6 + Math.abs(arrow) * 0.25);
        this.scene.add(mark);
      }

      const foul = new T.Mesh(this.track(new T.BoxGeometry(LANE_HALF * 2, 0.005, 0.04)), this.material('#e8262b', 0.4));
      foul.position.set(x, 0.002, 0);
      this.scene.add(foul);
    }

    for (let index = 0; index <= count; index += 1) {
      const x = (index - count / 2) * LANE_PITCH;
      const wall = new T.Mesh(this.track(new T.BoxGeometry(0.22, 0.25, LANE_LENGTH)), divider);
      wall.position.set(x, 0.08, LANE_LENGTH / 2);
      this.scene.add(wall);
    }
  }

  private createPin(): ThreeModule.Group {
    const T = this.THREE;
    const profile = [
      [0.0, 0],
      [0.032, 0],
      [0.055, 0.08],
      [0.06, 0.14],
      [0.04, 0.24],
      [0.026, 0.28],
      [0.034, 0.33],
      [0.028, 0.37],
      [0, PIN_HEIGHT],
    ].map(([radius, y]) => new T.Vector2(radius, y));
    const group = new T.Group();
    const body = new T.Mesh(this.track(new T.LatheGeometry(profile, 16)), this.material('#fbfbf7', 0.35));
    const stripe = new T.Mesh(this.track(new T.CylinderGeometry(0.029, 0.031, 0.02, 16)), this.material('#d71f2e', 0.4));
    stripe.position.y = 0.27;
    group.add(body, stripe);
    return group;
  }

  private createLane(view: BowlingLaneView, x: number): void {
    const T = this.THREE;
    const pins = PIN_SPOTS.map((spot) => {
      const pin = this.createPin();
      pin.position.set(x + spot.x, 0, spot.z);
      this.scene.add(pin);
      return pin;
    });
    const ball = new T.Mesh(this.track(new T.SphereGeometry(BALL_RADIUS, 24, 16)), this.material(view.color, 0.2, { metalness: 0.2 }));
    ball.position.set(x, BALL_RADIUS, -0.6);
    this.scene.add(ball);
    this.lanes.set(view.playerId, { view, x, ball, pins, simulation: null, otherPins: null, startedAt: 0, fallen: PIN_SPOTS.map(() => null) });
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private updateLocal(lane: Lane, now: number): void {
    const simulation = lane.simulation!;
    const index = Math.min(simulation.frames.length - 1, Math.floor((now - lane.startedAt) / simulation.frameMs));
    const frame = simulation.frames[Math.max(0, index)];
    const sinking = frame.ball.inGutter ? 0.06 : 0;
    lane.ball.position.set(lane.x + frame.ball.x, BALL_RADIUS - sinking, frame.ball.z);
    lane.ball.rotation.x = frame.ball.z / BALL_RADIUS;

    frame.pins.forEach((pin, pinIndex) => {
      if (pin.down && !lane.fallen[pinIndex]) {
        lane.fallen[pinIndex] = { at: now, dirX: pin.dirX, dirZ: pin.dirZ };

        if (lane.fallen.filter(Boolean).length === 1) {
          this.onStrikeSound?.(lane.view.playerId, simulation.pins);
        }
      }

      lane.pins[pinIndex].position.set(lane.x + pin.x, 0, pin.z);
    });
  }

  private updateOther(lane: Lane, now: number): void {
    const elapsed = now - lane.startedAt;

    if (elapsed < 0) {
      return;
    }

    // Bola recta por el centro y, al llegar, caen tantos bolos como haya dicho el servidor (los de delante primero).
    const progress = Math.min(1.25, elapsed / OTHER_ROLL_MS);
    const z = progress * (HEAD_PIN_Z + 1.2);
    lane.ball.position.set(lane.x, BALL_RADIUS, Math.min(LANE_LENGTH, z));
    lane.ball.rotation.x = z / BALL_RADIUS;

    if (z >= HEAD_PIN_Z - 0.1) {
      for (let pinIndex = 0; pinIndex < (lane.otherPins ?? 0); pinIndex += 1) {
        if (!lane.fallen[pinIndex]) {
          const spot = PIN_SPOTS[pinIndex];
          const angle = Math.atan2(spot.x, 1) + (Math.random() - 0.5) * 0.8;
          lane.fallen[pinIndex] = { at: now + pinIndex * 35, dirX: Math.sin(angle), dirZ: Math.cos(angle) };

          if (pinIndex === 0) {
            this.onStrikeSound?.(lane.view.playerId, lane.otherPins ?? 0);
          }
        }
      }
    }
  }

  /** Los bolos derribados se tumban hacia donde salen despedidos. */
  private updatePins(lane: Lane, now: number): void {
    lane.fallen.forEach((fall, index) => {
      if (!fall) {
        return;
      }

      const progress = Math.max(0, Math.min(1, (now - fall.at) / FALL_MS));
      const pin = lane.pins[index];
      const tilt = progress * (Math.PI / 2) * 0.95;
      pin.rotation.set(fall.dirZ * tilt, 0, -fall.dirX * tilt);

      if (!lane.view.isLocal) {
        pin.position.x = lane.x + PIN_SPOTS[index].x + fall.dirX * progress * 0.35;
        pin.position.z = PIN_SPOTS[index].z + fall.dirZ * progress * 0.35;
      }
    });
  }

  /** Camara detras de la pista central: sigue a la bola propia y termina mirando los bolos. */
  private updateCamera(delta: number): void {
    const local = [...this.lanes.values()].find((lane) => lane.view.isLocal);
    const z = local?.simulation ? local.ball.position.z : 0;
    const following = Boolean(local?.simulation);
    const targetPosition = following ? this.scratch.set(0, 1.3, Math.min(HEAD_PIN_Z - 4.2, z - 2.6)) : this.scratch.set(0, 1.7, -3.2);
    this.cameraPosition.lerp(targetPosition, Math.min(1, delta * (following ? 4 : 2)));
    this.cameraTarget.lerp(this.scratch.set(0, following ? 0.25 : 0.4, following ? Math.min(HEAD_PIN_Z + 0.4, z + 6) : 12), Math.min(1, delta * 4));
    this.camera.position.copy(this.cameraPosition);
    this.camera.lookAt(this.cameraTarget);
  }

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    for (const lane of this.lanes.values()) {
      if (lane.simulation) {
        this.updateLocal(lane, now);
      } else if (lane.otherPins !== null) {
        this.updateOther(lane, now);
      }

      this.updatePins(lane, now);
    }

    this.updateCamera(delta);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  /** Nombre (y bolos) sobre cada pista, a la altura de los bolos. */
  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-bw-label]'))) {
      const lane = this.lanes.get(label.dataset['bwLabel'] || '');

      if (!lane) {
        label.style.opacity = '0';
        continue;
      }

      const vector = this.scratch.set(lane.x, 0.9, HEAD_PIN_Z + 0.4).project(this.camera);
      const visible = vector.z < 1 && Math.abs(vector.x) < 1.05 && Math.abs(vector.y) < 1.05;
      label.style.opacity = visible ? '1' : '0';
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, -100%)`;
    }
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.fov = width / height < 1 ? 72 : FOV;
    this.camera.updateProjectionMatrix();
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }
}
