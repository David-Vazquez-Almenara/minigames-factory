import type * as ThreeModule from 'three';
import { MiiMood, MiiRig } from '../../../../shared/components/mii-stage/mii-rig';
import type { CountKind } from '../../../../core/services/socket.service';

type Three = typeof ThreeModule;

// Calle vista desde el callejon (la camara mira hacia -z). Profundidad (z) de cada franja:
const ALLEY_HALF_WIDTH = 3.3;
const STREET_EDGE_NEAR = 4.6;
const SIDEWALK_NEAR = [4.05, 3.45, 2.85];
const ROAD_NEAR_LANE = 1.3;
const ROAD_FAR_LANE = -1.3;
const SIDEWALK_FAR = [-2.95, -3.55, -4.15];
const FAR_WALL_Z = -4.75;
const ROAD_HALF = 2.5;
const CAMERA_FINAL = { x: 0, y: 1.65, z: 10.4 };
const CAMERA_START = { x: 0, y: 5.5, z: 22 };
const FOV = 50;
const SHIRTS = ['#e53935', '#1e63ff', '#22a845', '#ffc400', '#ff7f00', '#8e24aa', '#ff4fa3', '#00b8d4', '#6d4c41', '#37474f', '#c0ca33', '#5c6bc0'];
const VEHICLE_COLORS = ['#e8262b', '#1d5bff', '#ffd60a', '#1fae45', '#ffffff', '#ff8a00', '#222831', '#8a2be2'];
const FACE_VARIANTS = 6;

export interface CountSceneEntry {
  id: number;
  at: number;
  kind: CountKind;
  lane: number | 'road-near' | 'road-far';
  dir: 1 | -1;
  speed: number;
  look: number;
}

export interface CountSceneState {
  schedule: CountSceneEntry[];
  travel: number;
  /** Momento (reloj performance.now) en que empieza a pasar gente. */
  watchStartsAt: number;
  /** Momento (reloj performance.now) en que acaba el travelling inicial de la camara. */
  cameraArrivesAt: number;
}

interface Walker {
  entry: CountSceneEntry;
  holder: ThreeModule.Group;
  rig: MiiRig;
  vehicle: ThreeModule.Group | null;
  z: number;
}

/**
 * Escena 3D de "¿Cuantos hay?": calle con dos aceras, carretera de doble sentido y un edificio al fondo, vista
 * desde un callejon. Reproduce el guion del servidor con el reloj local: cada transeunte aparece en su momento y se
 * retira de la escena en cuanto sale de la calle. Los Miis se reciclan (pool) para no crear y destruir mallas.
 */
export class CountScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly resizeObserver: ResizeObserver;
  private readonly active = new Map<number, Walker>();
  private readonly finished = new Set<number>();
  private readonly pool: MiiRig[] = [];
  private readonly allRigs: MiiRig[] = [];
  private readonly faces: ThreeModule.CanvasTexture[] = [];
  private readonly materialCache = new Map<string, ThreeModule.MeshStandardMaterial>();
  private readonly geometries: Record<string, ThreeModule.BufferGeometry> = {};
  private state: CountSceneState;
  private frameHandle = 0;
  private lastFrame = performance.now();

  /** Aviso cuando un vehiculo entra en la calle (para el sonido del motor o el timbre). */
  onVehicle?: (kind: CountKind) => void;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    state: CountSceneState,
  ) {
    const T = THREE;
    this.state = state;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#9fd8ff');
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 120);

    this.scene.add(new T.HemisphereLight(0xffffff, 0x8a7f74, 1.5));
    const sun = new T.DirectionalLight(0xfff2d6, 1.5);
    sun.position.set(6, 12, 8);
    this.scene.add(sun);

    this.buildGeometries();
    this.buildStreet();
    this.buildFaces();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.loop();
  }

  sync(state: CountSceneState): void {
    this.state = state;
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();

    for (const rig of this.allRigs) {
      rig.dispose();
    }

    for (const item of [...this.faces, ...this.materialCache.values(), ...Object.values(this.geometries)]) {
      item.dispose();
    }

    this.active.clear();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private material(color: string, roughness = 0.6): ThreeModule.MeshStandardMaterial {
    let material = this.materialCache.get(`${color}:${roughness}`);

    if (!material) {
      material = new this.THREE.MeshStandardMaterial({ color, roughness });
      this.materialCache.set(`${color}:${roughness}`, material);
    }

    return material;
  }

  private box(width: number, height: number, depth: number, color: string, x: number, y: number, z: number): ThreeModule.Mesh {
    const mesh = new this.THREE.Mesh(this.geometries['box'], this.material(color));
    mesh.scale.set(width, height, depth);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    return mesh;
  }

  private buildGeometries(): void {
    const T = this.THREE;
    this.geometries['box'] = new T.BoxGeometry(1, 1, 1);
    this.geometries['wheel'] = new T.CylinderGeometry(0.34, 0.34, 0.22, 18);
    this.geometries['bikeWheel'] = new T.TorusGeometry(0.33, 0.035, 8, 24);
    this.geometries['bar'] = new T.CylinderGeometry(0.035, 0.035, 1, 8);
  }

  private buildStreet(): void {
    // Carretera, lineas, aceras con bordillo y el edificio del fondo (que cierra la vista).
    this.box(80, 0.05, ROAD_HALF * 2, '#3e4249', 0, 0, 0);

    for (let x = -30; x <= 30; x += 3) {
      this.box(1.5, 0.06, 0.14, '#f4f1e8', x, 0.01, 0);
    }

    this.box(80, 0.18, STREET_EDGE_NEAR - ROAD_HALF, '#c9c3b8', 0, 0.09, (STREET_EDGE_NEAR + ROAD_HALF) / 2);
    this.box(80, 0.18, Math.abs(FAR_WALL_Z) - ROAD_HALF, '#c9c3b8', 0, 0.09, (FAR_WALL_Z - ROAD_HALF) / 2);
    this.box(80, 0.2, 0.18, '#9e978b', 0, 0.1, ROAD_HALF + 0.09);
    this.box(80, 0.2, 0.18, '#9e978b', 0, 0.1, -ROAD_HALF - 0.09);

    // Edificio del fondo: fachada con puertas, escaparate con toldo y ventanas.
    this.box(80, 9, 0.6, '#e8b57a', 0, 4.5, FAR_WALL_Z - 0.3);
    this.box(80, 0.5, 0.7, '#b9814d', 0, 3.1, FAR_WALL_Z - 0.2);

    for (const x of [-9, -3.4, 2.6, 8.2]) {
      this.box(1.3, 2.3, 0.12, '#7a4a24', x, 1.33, FAR_WALL_Z);
      this.box(0.12, 0.12, 0.08, '#ffd54a', x + 0.42, 1.3, FAR_WALL_Z + 0.08);
    }

    this.box(3.2, 1.6, 0.1, '#9ad7ff', -0.4, 1.5, FAR_WALL_Z);
    const awning = this.box(3.6, 0.12, 0.9, '#e8262b', -0.4, 2.55, FAR_WALL_Z + 0.4);
    awning.rotation.x = 0.35;

    for (let x = -12; x <= 12; x += 2.8) {
      for (const y of [4.6, 6.6]) {
        this.box(1.2, 1.2, 0.1, '#bfe6ff', x, y, FAR_WALL_Z);
      }
    }

    // Edificios del callejon (a ambos lados de la camara) y su acera del lado cercano.
    for (const side of [-1, 1]) {
      this.box(30, 10, 14, side < 0 ? '#c46f55' : '#8fa6b8', side * (ALLEY_HALF_WIDTH + 15), 5, STREET_EDGE_NEAR + 7);

      for (const z of [6.5, 9.5]) {
        this.box(0.1, 1.1, 1, '#bfe6ff', side * ALLEY_HALF_WIDTH, 3.2, z);
      }
    }

    this.box(ALLEY_HALF_WIDTH * 2, 0.04, 14, '#8d877d', 0, 0.02, STREET_EDGE_NEAR + 7);
    this.box(1.2, 1, 0.8, '#2f6d3a', -ALLEY_HALF_WIDTH + 0.7, 0.5, 8.5);
  }

  /** Caras sencillas para los transeuntes (ojos, boca y flequillo), compartidas por todos. */
  private buildFaces(): void {
    const T = this.THREE;
    const hair = ['#3b2a1e', '#111111', '#e0b25b', '#8b3a1e', '#7a7a7a', '#5a3825'];

    for (let index = 0; index < FACE_VARIANTS; index += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#f3cfa8';
      context.fillRect(0, 0, 128, 128);
      context.fillStyle = hair[index];
      context.fillRect(0, 0, 128, 30 + (index % 3) * 4);
      context.fillStyle = '#1b1b1b';
      context.beginPath();
      context.ellipse(46, 62, 5, 8, 0, 0, Math.PI * 2);
      context.ellipse(82, 62, 5, 8, 0, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = '#8a3b2a';
      context.lineWidth = 4;
      context.beginPath();
      context.arc(64, 82, 12, 0.15 * Math.PI, 0.85 * Math.PI);
      context.stroke();
      const texture = new T.CanvasTexture(canvas);
      texture.colorSpace = T.SRGBColorSpace;
      this.faces.push(texture);
    }
  }

  /* ------------------------------- Transeuntes ------------------------------- */

  private laneZ(entry: CountSceneEntry): number {
    if (entry.lane === 'road-near') {
      return ROAD_NEAR_LANE;
    }

    if (entry.lane === 'road-far') {
      return ROAD_FAR_LANE;
    }

    return entry.lane < 3 ? SIDEWALK_NEAR[entry.lane] : SIDEWALK_FAR[entry.lane - 3];
  }

  private takeRig(entry: CountSceneEntry): MiiRig {
    const shirt = SHIRTS[entry.look % SHIRTS.length];
    let rig = this.pool.pop();

    if (!rig) {
      rig = new MiiRig(this.THREE, shirt);
      // Ya en escena (sin la animacion de entrada que cae desde arriba).
      rig.enter(0);
      rig.setFaceTexture(this.faces[this.allRigs.length % FACE_VARIANTS]);
      this.allRigs.push(rig);
    }

    rig.setShirtColor(shirt);
    return rig;
  }

  private spawn(entry: CountSceneEntry): void {
    const T = this.THREE;
    const holder = new T.Group();
    const rig = this.takeRig(entry);
    const z = this.laneZ(entry);
    holder.rotation.y = entry.dir * (Math.PI / 2);
    let vehicle: ThreeModule.Group | null = null;

    if (entry.kind === 'walk' || entry.kind === 'run') {
      rig.pose = 'stand';
      holder.position.y = 0.18;
      holder.add(rig.root);
    } else {
      vehicle = this.buildVehicle(entry);
      holder.add(vehicle);
      // Un solo conductor por vehiculo, sentado.
      rig.pose = 'sit';
      rig.root.position.set(0, 0, 0);
      const seat = new T.Group();
      seat.position.set(0, entry.kind === 'car' ? 0.12 : entry.kind === 'moto' ? 0.42 : 0.5, entry.kind === 'car' ? -0.35 : -0.1);
      seat.add(rig.root);
      holder.add(seat);
    }

    this.scene.add(holder);
    this.active.set(entry.id, { entry, holder, rig, vehicle, z });

    if (vehicle) {
      this.onVehicle?.(entry.kind);
    }
  }

  private buildVehicle(entry: CountSceneEntry): ThreeModule.Group {
    const T = this.THREE;
    const group = new T.Group();
    const color = VEHICLE_COLORS[entry.look % VEHICLE_COLORS.length];
    const dark = this.material('#1c1f24', 0.8);
    const add = (geometry: ThreeModule.BufferGeometry, material: ThreeModule.Material, x: number, y: number, z: number, scale?: [number, number, number]) => {
      const mesh = new T.Mesh(geometry, material);
      mesh.position.set(x, y, z);

      if (scale) {
        mesh.scale.set(...scale);
      }

      group.add(mesh);
      return mesh;
    };

    // El vehiculo se construye mirando a +z (igual que el Mii); el holder lo gira hacia su sentido de marcha.
    if (entry.kind === 'car') {
      // Descapotable: carroceria, morro, maletero y parabrisas, con el conductor a la vista.
      add(this.geometries['box'], this.material(color, 0.35), 0, 0.5, 0, [1.7, 0.5, 3.6]);
      add(this.geometries['box'], this.material(color, 0.35), 0, 0.82, 1.05, [1.6, 0.16, 1.3]);
      add(this.geometries['box'], this.material(color, 0.35), 0, 0.82, -1.4, [1.6, 0.16, 0.7]);
      add(this.geometries['box'], this.material('#bfe6ff', 0.1), 0, 1.05, 0.38, [1.5, 0.42, 0.06]);

      for (const [x, z] of [
        [-0.82, 1.15],
        [0.82, 1.15],
        [-0.82, -1.15],
        [0.82, -1.15],
      ]) {
        add(this.geometries['wheel'], dark, x, 0.34, z).rotation.z = Math.PI / 2;
      }
    } else if (entry.kind === 'moto') {
      add(this.geometries['box'], this.material(color, 0.35), 0, 0.62, 0, [0.4, 0.36, 1.3]);
      add(this.geometries['bar'], dark, 0, 0.98, 0.55, [1, 0.62, 1]).rotation.z = Math.PI / 2;

      for (const z of [0.72, -0.72]) {
        add(this.geometries['wheel'], dark, 0, 0.34, z).rotation.z = Math.PI / 2;
      }
    } else {
      // Bici: dos ruedas finas, cuadro y manillar.
      for (const z of [0.55, -0.55]) {
        add(this.geometries['bikeWheel'], dark, 0, 0.34, z).rotation.y = Math.PI / 2;
      }

      add(this.geometries['bar'], this.material(color, 0.4), 0, 0.6, 0, [1, 1.15, 1]).rotation.x = Math.PI / 2;
      add(this.geometries['bar'], this.material(color, 0.4), 0, 0.85, 0.5, [1, 0.5, 1]).rotation.z = Math.PI / 2;
    }

    return group;
  }

  private despawn(walker: Walker): void {
    walker.holder.remove(walker.rig.root);
    walker.rig.root.parent?.remove(walker.rig.root);
    walker.rig.root.position.set(0, 0, 0);
    walker.rig.root.rotation.set(0, 0, 0);
    this.scene.remove(walker.holder);
    this.pool.push(walker.rig);
    this.active.delete(walker.entry.id);
    this.finished.add(walker.entry.id);
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const time = now / 1000;
    const elapsed = now - this.state.watchStartsAt;
    const half = this.state.travel / 2;

    for (const entry of this.state.schedule) {
      const travelMs = (this.state.travel / entry.speed) * 1000;

      if (elapsed >= entry.at && elapsed < entry.at + travelMs && !this.active.has(entry.id) && !this.finished.has(entry.id)) {
        this.spawn(entry);
      }
    }

    for (const walker of [...this.active.values()]) {
      const { entry } = walker;
      const progress = (elapsed - entry.at) / 1000;
      const travelMs = (this.state.travel / entry.speed) * 1000;

      // Sale de la calle: se retira de la escena al momento (y su Mii vuelve al pool).
      if (elapsed >= entry.at + travelMs) {
        this.despawn(walker);
        continue;
      }

      walker.holder.position.x = -entry.dir * half + entry.dir * entry.speed * progress;
      walker.holder.position.z = walker.z;
      const mood: MiiMood = walker.vehicle ? 'ride' : entry.kind === 'run' ? 'run' : 'walk';
      walker.rig.mood = mood;
      walker.rig.update(time, delta, 'game');
    }

    this.updateCamera(now);
    this.renderer.render(this.scene, this.camera);
  }

  /** Travelling inicial: desde lo alto del callejon hasta la altura de los ojos, mirando a la calle. */
  private updateCamera(now: number): void {
    const remaining = this.state.cameraArrivesAt - now;
    const progress = remaining <= 0 ? 1 : Math.max(0, 1 - remaining / 3000);
    const ease = 1 - Math.pow(1 - progress, 3);
    this.camera.position.set(
      CAMERA_START.x + (CAMERA_FINAL.x - CAMERA_START.x) * ease,
      CAMERA_START.y + (CAMERA_FINAL.y - CAMERA_START.y) * ease,
      CAMERA_START.z + (CAMERA_FINAL.z - CAMERA_START.z) * ease,
    );
    this.camera.lookAt(0, 1.05 + (1 - ease) * 0.8, -1.5);
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    // En pantallas estrechas (movil) se abre el angulo para que quepa el hueco del callejon.
    this.camera.fov = width / height < 1 ? 66 : FOV;
    this.camera.updateProjectionMatrix();
  }
}
