import type * as ThreeModule from 'three';
import type { CrossyRow } from '../../../../core/services/socket.service';
import { CROSSY_HALF_COLS, TRAIN_LENGTH, carPositions, trainPhase, trainSpan } from './crossy-world';

type Three = typeof ThreeModule;

// Mundo: la columna c esta en x = c y la fila r en z = -r (avanzar es ir hacia -z). Camara ortografica en diagonal,
// como en el Crossy Road original, siguiendo a la gallina propia.
const FIELD_HALF = 13;
const HOP_MS = 130;
const REMOTE_HOP_MS = 200;
const CAMERA_OFFSET = { x: -2.6, y: 10, z: 6.6 };
const CAR_COLORS = ['#e8262b', '#2f7de1', '#ffd23f', '#38c172', '#ff7ab6', '#8a5cf6', '#ff9f1c', '#f2f2f2'];
const EXTRA_ROWS_BEHIND = 12;
const EXTRA_ROWS_AHEAD = 10;

export interface CrossyChickenView {
  playerId: string;
  name: string;
  color: string;
  isLocal: boolean;
}

interface Chicken {
  view: CrossyChickenView;
  group: ThreeModule.Group;
  body: ThreeModule.Group;
  from: { x: number; z: number };
  to: { x: number; z: number };
  hopStart: number;
  hopMs: number;
  dead: 'car' | 'train' | null;
  deadAt: number;
}

interface Feather {
  mesh: ThreeModule.Mesh;
  velocity: ThreeModule.Vector3;
  bornAt: number;
}

/** Hash determinista para decorar (arboles fuera del campo, alturas...). */
function hash(a: number, b: number): number {
  const value = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * Escena 3D de Cruza la carretera: filas de cesped, carretera y via de tren hechas con bloques (estilo voxel),
 * coches y trenes moviendose segun el reloj comun y una gallina por jugador.
 */
export class CrossyScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.OrthographicCamera;
  private readonly sun: ThreeModule.DirectionalLight;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly chickens = new Map<string, Chicken>();
  private readonly cars: Array<{ rowIndex: number; carIndex: number; group: ThreeModule.Group }> = [];
  private readonly trains: Array<{ rowIndex: number; group: ThreeModule.Group; lamps: ThreeModule.MeshStandardMaterial[]; lit: boolean }> = [];
  private readonly feathers: Feather[] = [];
  private readonly scratch: ThreeModule.Vector3;
  private readonly cameraTarget: ThreeModule.Vector3;
  private readonly materials = new Map<string, ThreeModule.MeshStandardMaterial>();
  private readonly boxes = new Map<string, ThreeModule.BoxGeometry>();
  private frameHandle = 0;
  private lastFrame = performance.now();

  /** Reloj comun en ms desde el inicio de la partida (lo da el componente). */
  clock: () => number = () => 0;
  /** Aviso cuando se enciende la luz de una via (para el sonido). */
  onWarning?: (rowIndex: number) => void;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    private readonly rows: CrossyRow[],
    private readonly wrap: number,
    private readonly finishRow: number,
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#9ed8f5');
    this.camera = new T.OrthographicCamera(-8, 8, 6, -6, 0.1, 80);
    this.scratch = new T.Vector3();
    this.cameraTarget = new T.Vector3(0, 0, -2.5);

    this.scene.add(new T.HemisphereLight(0xffffff, 0x6a8a5a, 1.6));
    this.sun = new T.DirectionalLight(0xfff4dd, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 40 });
    this.scene.add(this.sun, this.sun.target);

    this.buildWorld();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.loop();
  }

  /** Crea (o actualiza) las gallinas de la partida. */
  setChickens(views: CrossyChickenView[], start: Map<string, { row: number; col: number }>): void {
    for (const view of views) {
      if (this.chickens.has(view.playerId)) {
        continue;
      }

      const cell = start.get(view.playerId) || { row: 0, col: 0 };
      const { group, body } = this.buildChicken(view.color, view.isLocal);
      group.position.set(cell.col, 0, -cell.row);
      this.scene.add(group);
      this.chickens.set(view.playerId, {
        view,
        group,
        body,
        from: { x: cell.col, z: -cell.row },
        to: { x: cell.col, z: -cell.row },
        hopStart: 0,
        hopMs: HOP_MS,
        dead: null,
        deadAt: 0,
      });
    }
  }

  /** Salto a otra casilla (la propia al instante; las de los demas, cuando llega su posicion). */
  moveChicken(playerId: string, row: number, col: number): void {
    const chicken = this.chickens.get(playerId);

    if (!chicken || chicken.dead) {
      return;
    }

    const x = col;
    const z = -row;

    if (x === chicken.to.x && z === chicken.to.z) {
      return;
    }

    const now = performance.now();
    chicken.from = { x: chicken.group.position.x, z: chicken.group.position.z };
    chicken.to = { x, z };
    chicken.hopStart = now;
    chicken.hopMs = chicken.view.isLocal ? HOP_MS : REMOTE_HOP_MS;
    // Mira hacia donde salta.
    const dx = x - chicken.from.x;
    const dz = z - chicken.from.z;

    if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) {
      chicken.body.rotation.y = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? -Math.PI / 2 : Math.PI / 2) : dz < 0 ? 0 : Math.PI;
    }
  }

  /** Atropello: la gallina queda aplastada y salen plumas. */
  killChicken(playerId: string, cause: 'car' | 'train'): void {
    const chicken = this.chickens.get(playerId);

    if (!chicken || chicken.dead) {
      return;
    }

    chicken.dead = cause;
    chicken.deadAt = performance.now();
    chicken.group.position.set(chicken.to.x, 0, chicken.to.z);
    const T = this.THREE;
    const material = this.material(chicken.view.color);

    for (let index = 0; index < 10; index += 1) {
      const mesh = new T.Mesh(this.box(0.12, 0.04, 0.12), material);
      mesh.position.set(chicken.to.x, 0.4, chicken.to.z);
      const angle = (index / 10) * Math.PI * 2;
      this.scene.add(mesh);
      this.feathers.push({ mesh, velocity: new T.Vector3(Math.cos(angle) * 2.2, 3 + hash(index, 3) * 2, Math.sin(angle) * 2.2), bornAt: chicken.deadAt });
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

  private material(color: string, extra: Partial<ThreeModule.MeshStandardMaterialParameters> = {}): ThreeModule.MeshStandardMaterial {
    const key = `${color}:${JSON.stringify(extra)}`;
    let material = this.materials.get(key);

    if (!material) {
      material = this.track(new this.THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true, ...extra }));
      this.materials.set(key, material);
    }

    return material;
  }

  private box(width: number, height: number, depth: number): ThreeModule.BoxGeometry {
    const key = `${width}:${height}:${depth}`;
    let geometry = this.boxes.get(key);

    if (!geometry) {
      geometry = this.track(new this.THREE.BoxGeometry(width, height, depth));
      this.boxes.set(key, geometry);
    }

    return geometry;
  }

  /** Bloque con sombra: (ancho, alto, fondo) apoyado en `y` (base). */
  private block(parent: ThreeModule.Object3D, size: [number, number, number], position: [number, number, number], color: string, cast = true): ThreeModule.Mesh {
    const mesh = new this.THREE.Mesh(this.box(...size), this.material(color));
    mesh.position.set(position[0], position[1] + size[1] / 2, position[2]);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private buildWorld(): void {
    const first = -EXTRA_ROWS_BEHIND;
    const last = this.finishRow + EXTRA_ROWS_AHEAD;

    for (let rowIndex = first; rowIndex <= last; rowIndex += 1) {
      const row = rowIndex >= 0 && rowIndex < this.rows.length ? this.rows[rowIndex] : null;
      const z = -rowIndex;

      if (!row || row.type === 'grass') {
        // Detras de la salida no hay arboles en el campo: taparian a las gallinas (la camara mira desde atras).
        this.buildGrass(rowIndex, z, row?.type === 'grass' ? row.trees : []);
      } else if (row.type === 'road') {
        this.buildRoad(rowIndex, z, row);
      } else {
        this.buildRail(rowIndex, z, row);
      }
    }

    // Fuera del ancho jugable el suelo se oscurece (como en el original): ahi no se puede ir.
    const T = this.THREE;
    const shade = this.track(new T.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.28, depthWrite: false }));
    const depth = last - first + 1;

    for (const side of [-1, 1]) {
      const plane = new T.Mesh(this.track(new T.PlaneGeometry(FIELD_HALF - CROSSY_HALF_COLS - 0.5, depth)), shade);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(side * (CROSSY_HALF_COLS + 0.5 + (FIELD_HALF - CROSSY_HALF_COLS - 0.5) / 2), 0.012, -(first + last) / 2);
      plane.renderOrder = 2;
      this.scene.add(plane);
    }

    this.buildFinish();
  }

  private buildGrass(rowIndex: number, z: number, trees: number[]): void {
    this.block(this.scene, [FIELD_HALF * 2, 0.3, 1], [0, -0.3, z], rowIndex % 2 ? '#93d94f' : '#86cc45', false);

    for (const col of trees) {
      this.buildTree(col, z, rowIndex);
    }

    // Arboles de adorno fuera del campo.
    for (let col = CROSSY_HALF_COLS + 1; col <= FIELD_HALF - 1; col += 1) {
      for (const side of [-1, 1]) {
        if (hash(rowIndex, col * side) < 0.45) {
          this.buildTree(col * side, z, rowIndex);
        }
      }
    }
  }

  private buildTree(x: number, z: number, seed: number): void {
    const group = new this.THREE.Group();
    group.position.set(x, 0, z);
    this.block(group, [0.26, 0.32, 0.26], [0, 0, 0], '#8a5a32');
    const tall = hash(seed, x) > 0.5;
    this.block(group, [0.72, tall ? 0.9 : 0.6, 0.72], [0, 0.32, 0], tall ? '#3f9a3a' : '#4caf3e');

    if (tall) {
      this.block(group, [0.5, 0.35, 0.5], [0, 1.22, 0], '#4caf3e');
    }

    this.scene.add(group);
  }

  private buildRoad(rowIndex: number, z: number, row: Extract<CrossyRow, { type: 'road' }>): void {
    this.block(this.scene, [FIELD_HALF * 2, 0.2, 1], [0, -0.25, z], '#50555f', false);

    // Linea discontinua con la siguiente fila si tambien es carretera.
    if (this.rows[rowIndex + 1]?.type === 'road') {
      for (let x = -FIELD_HALF + 0.5; x < FIELD_HALF; x += 1.6) {
        this.block(this.scene, [0.7, 0.02, 0.08], [x, -0.05, z - 0.5], '#e9e9e9', false);
      }
    }

    row.cars.forEach((_start, carIndex) => {
      const group = this.buildCar(row.length, CAR_COLORS[(row.color + carIndex * 3) % CAR_COLORS.length], row.dir);
      group.position.set(0, -0.05, z);
      this.scene.add(group);
      this.cars.push({ rowIndex, carIndex, group });
    });
  }

  /** Coche (o camion si es largo) mirando hacia `dir` en el eje x. */
  private buildCar(length: number, color: string, dir: 1 | -1): ThreeModule.Group {
    const group = new this.THREE.Group();
    const inner = new this.THREE.Group();
    inner.rotation.y = dir > 0 ? 0 : Math.PI;
    group.add(inner);

    if (length >= 2) {
      // Camion: cabina delante y caja detras.
      this.block(inner, [0.6, 0.75, 0.78], [length / 2 - 0.3, 0.12, 0], color);
      this.block(inner, [0.08, 0.3, 0.6], [length / 2 + 0.01, 0.48, 0], '#bfe6ff');
      this.block(inner, [length - 0.72, 0.9, 0.84], [-0.33, 0.12, 0], '#f4f1e8');
    } else {
      this.block(inner, [length, 0.42, 0.8], [0, 0.12, 0], color);
      this.block(inner, [length * 0.55, 0.32, 0.68], [-length * 0.08, 0.54, 0], '#f4f4f4');
      this.block(inner, [length * 0.57, 0.18, 0.7], [-length * 0.08, 0.6, 0], '#7cc6f2');
    }

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this.block(inner, [0.3, 0.3, 0.14], [sx * (length / 2 - 0.32), -0.02, sz * 0.4], '#1d1d1d');
      }
    }

    return group;
  }

  private buildRail(rowIndex: number, z: number, row: Extract<CrossyRow, { type: 'rail' }>): void {
    this.block(this.scene, [FIELD_HALF * 2, 0.24, 1], [0, -0.24, z], '#9b8f84', false);

    for (let x = -FIELD_HALF + 0.3; x < FIELD_HALF; x += 0.62) {
      this.block(this.scene, [0.22, 0.05, 0.86], [x, 0, z], '#6b4a2b', false);
    }

    for (const side of [-1, 1]) {
      this.block(this.scene, [FIELD_HALF * 2, 0.07, 0.07], [0, 0.04, z + side * 0.25], '#c9ced6', false);
    }

    // Poste con la luz roja que avisa del tren (justo fuera del campo, a la izquierda).
    const post = new this.THREE.Group();
    post.position.set(-CROSSY_HALF_COLS - 0.85, 0, z - 0.38);
    this.block(post, [0.1, 1.25, 0.1], [0, 0, 0], '#3a3a3a');
    this.block(post, [0.5, 0.26, 0.16], [0, 1.2, 0], '#222222');
    const lamps = [-1, 1].map((side) => {
      const lamp = this.track(new this.THREE.MeshStandardMaterial({ color: '#5a1010', emissive: '#ff1a1a', emissiveIntensity: 0, roughness: 0.4 }));
      const mesh = new this.THREE.Mesh(this.box(0.16, 0.16, 0.06), lamp);
      mesh.position.set(side * 0.12, 1.33, 0.09);
      post.add(mesh);
      return lamp;
    });
    this.scene.add(post);

    // Tren: locomotora y vagones a lo largo de TRAIN_LENGTH, con el morro en x = 0 (hacia `dir`).
    const group = new this.THREE.Group();
    const inner = new this.THREE.Group();
    inner.rotation.y = row.dir > 0 ? 0 : Math.PI;
    group.add(inner);
    const segment = TRAIN_LENGTH / 4;

    for (let index = 0; index < 4; index += 1) {
      const center = -segment * index - segment / 2;
      const loco = index === 0;
      this.block(inner, [segment - 0.15, loco ? 1.05 : 0.95, 0.9], [center, 0.12, 0], loco ? '#d62f2f' : index % 2 ? '#2f6fd6' : '#f2c230');
      this.block(inner, [segment - 0.35, 0.12, 0.8], [center, loco ? 1.17 : 1.07, 0], '#3a3a3a');

      if (loco) {
        this.block(inner, [0.08, 0.32, 0.7], [-0.06, 0.62, 0], '#bfe6ff');
      }
    }

    group.position.set(1000, 0, z);
    group.visible = false;
    this.scene.add(group);
    this.trains.push({ rowIndex, group, lamps, lit: false });
  }

  private buildFinish(): void {
    const T = this.THREE;
    const canvas = document.createElement('canvas');
    canvas.width = 288;
    canvas.height = 32;
    const context = canvas.getContext('2d')!;

    for (let x = 0; x < 18; x += 1) {
      for (let y = 0; y < 2; y += 1) {
        context.fillStyle = (x + y) % 2 ? '#111111' : '#ffffff';
        context.fillRect(x * 16, y * 16, 16, 16);
      }
    }

    const texture = this.track(new T.CanvasTexture(canvas));
    texture.colorSpace = T.SRGBColorSpace;
    texture.magFilter = T.NearestFilter;
    const strip = new T.Mesh(this.track(new T.PlaneGeometry(CROSSY_HALF_COLS * 2 + 1, 0.9)), this.track(new T.MeshStandardMaterial({ map: texture })));
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(0, 0.01, -this.finishRow);
    strip.receiveShadow = true;
    this.scene.add(strip);

    // Arco de meta con cartel.
    for (const side of [-1, 1]) {
      this.block(this.scene, [0.2, 2.2, 0.2], [side * (CROSSY_HALF_COLS + 0.6), 0, -this.finishRow], '#f2f2f2');
    }

    const sign = document.createElement('canvas');
    sign.width = 512;
    sign.height = 96;
    const signContext = sign.getContext('2d')!;
    signContext.fillStyle = '#e8262b';
    signContext.fillRect(0, 0, 512, 96);
    signContext.fillStyle = '#ffffff';
    signContext.font = '900 64px sans-serif';
    signContext.textAlign = 'center';
    signContext.textBaseline = 'middle';
    signContext.fillText('META', 256, 52);
    const signTexture = this.track(new T.CanvasTexture(sign));
    signTexture.colorSpace = T.SRGBColorSpace;
    const banner = new T.Mesh(this.track(new T.BoxGeometry(CROSSY_HALF_COLS * 2 + 1.4, 0.55, 0.12)), [
      this.material('#b81d22'),
      this.material('#b81d22'),
      this.material('#b81d22'),
      this.material('#b81d22'),
      this.track(new T.MeshStandardMaterial({ map: signTexture })),
      this.track(new T.MeshStandardMaterial({ map: signTexture })),
    ]);
    banner.position.set(0, 2.1, -this.finishRow);
    banner.castShadow = true;
    this.scene.add(banner);
  }

  /** Gallina voxel: cuerpo del color del jugador, cresta roja, pico y patas naranjas. */
  private buildChicken(color: string, isLocal: boolean): { group: ThreeModule.Group; body: ThreeModule.Group } {
    const group = new this.THREE.Group();
    const body = new this.THREE.Group();
    group.add(body);
    this.block(body, [0.07, 0.16, 0.07], [-0.1, 0, 0], '#ff9a1f');
    this.block(body, [0.07, 0.16, 0.07], [0.1, 0, 0], '#ff9a1f');
    this.block(body, [0.5, 0.42, 0.52], [0, 0.14, 0.02], color);
    this.block(body, [0.4, 0.4, 0.36], [0, 0.5, -0.08], color);
    this.block(body, [0.1, 0.16, 0.22], [0, 0.9, -0.08], '#e8262b');
    this.block(body, [0.14, 0.09, 0.14], [0, 0.66, -0.31], '#ff9a1f');
    this.block(body, [0.08, 0.1, 0.06], [0, 0.55, -0.28], '#e8262b');
    this.block(body, [0.2, 0.18, 0.12], [0, 0.34, 0.32], color);

    for (const side of [-1, 1]) {
      this.block(body, [0.06, 0.08, 0.08], [side * 0.2, 0.72, -0.16], '#111111', false);
      this.block(body, [0.06, 0.24, 0.32], [side * 0.27, 0.2, 0.04], color);
    }

    // La propia lleva un aro blanco en el suelo para encontrarla rapido.
    if (isLocal) {
      const ring = new this.THREE.Mesh(
        this.track(new this.THREE.RingGeometry(0.36, 0.46, 24)),
        this.track(new this.THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false })),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      group.add(ring);
    }

    return { group, body };
  }

  /* ------------------------------ Animacion ------------------------------ */

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const ms = this.clock();

    for (const car of this.cars) {
      const row = this.rows[car.rowIndex];

      if (row?.type === 'road') {
        car.group.position.x = carPositions(row, ms, this.wrap)[car.carIndex];
      }
    }

    for (const train of this.trains) {
      const row = this.rows[train.rowIndex];

      if (row?.type !== 'rail') {
        continue;
      }

      const { warning } = trainPhase(row, ms);
      const span = trainSpan(row, ms);
      train.group.visible = Boolean(span);
      train.group.position.x = span ? span.head : 1000;
      // Las dos luces parpadean alternandose mientras avisan.
      const blink = Math.floor(ms / 160) % 2;
      train.lamps[0].emissiveIntensity = warning && blink ? 2.4 : 0;
      train.lamps[1].emissiveIntensity = warning && !blink ? 2.4 : 0;

      if (warning && !train.lit) {
        this.onWarning?.(train.rowIndex);
      }

      train.lit = warning;
    }

    for (const chicken of this.chickens.values()) {
      this.updateChicken(chicken, now);
    }

    for (let index = this.feathers.length - 1; index >= 0; index -= 1) {
      const feather = this.feathers[index];
      const age = (now - feather.bornAt) / 1000;

      if (age > 1.4) {
        this.scene.remove(feather.mesh);
        this.feathers.splice(index, 1);
        continue;
      }

      feather.velocity.y -= 9 * delta;
      feather.mesh.position.addScaledVector(feather.velocity, delta);
      feather.mesh.position.y = Math.max(0.03, feather.mesh.position.y);
      feather.mesh.rotation.x += delta * 6;
      feather.mesh.rotation.z += delta * 4;
    }

    this.updateCamera(delta);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  private updateChicken(chicken: Chicken, now: number): void {
    if (chicken.dead) {
      // Aplastada por el coche; el tren la deja aun mas plana.
      const progress = Math.min(1, (now - chicken.deadAt) / 120);
      const flat = chicken.dead === 'train' ? 0.08 : 0.14;
      chicken.body.scale.set(1 + 0.45 * progress, 1 - (1 - flat) * progress, 1 + 0.45 * progress);
      chicken.body.position.y = 0;
      return;
    }

    const progress = chicken.hopStart ? Math.min(1, (now - chicken.hopStart) / chicken.hopMs) : 1;
    const eased = 1 - (1 - progress) * (1 - progress);
    chicken.group.position.x = chicken.from.x + (chicken.to.x - chicken.from.x) * eased;
    chicken.group.position.z = chicken.from.z + (chicken.to.z - chicken.from.z) * eased;
    // Salto en arco y un poco de estiramiento al despegar.
    chicken.body.position.y = Math.sin(Math.PI * progress) * 0.42;
    const stretch = progress < 1 ? 1 + Math.sin(Math.PI * progress) * 0.15 : 1;
    chicken.body.scale.set(1 / Math.sqrt(stretch), stretch, 1 / Math.sqrt(stretch));
  }

  /** La camara sigue a la gallina propia (hacia delante con margen para ver lo que viene). */
  private updateCamera(delta: number): void {
    const local = [...this.chickens.values()].find((chicken) => chicken.view.isLocal);
    const x = local ? local.group.position.x * 0.45 : 0;
    const z = local ? local.group.position.z - 2.2 : -2.2;
    this.cameraTarget.lerp(this.scratch.set(x, 0, z), Math.min(1, delta * 5));
    this.camera.position.set(this.cameraTarget.x + CAMERA_OFFSET.x, CAMERA_OFFSET.y, this.cameraTarget.z + CAMERA_OFFSET.z);
    this.camera.lookAt(this.cameraTarget);
    this.sun.position.set(this.cameraTarget.x - 5, 14, this.cameraTarget.z + 6);
    this.sun.target.position.copy(this.cameraTarget);
  }

  /** Nombres sobre las gallinas. */
  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-cr-label]'))) {
      const chicken = this.chickens.get(label.dataset['crLabel'] || '');

      if (!chicken) {
        label.style.opacity = '0';
        continue;
      }

      const vector = this.scratch.set(chicken.group.position.x, chicken.dead ? 0.5 : 1.25 + chicken.body.position.y, chicken.group.position.z).project(this.camera);
      const visible = Math.abs(vector.x) < 1.05 && Math.abs(vector.y) < 1.05;
      label.style.opacity = visible ? (chicken.dead ? '0.6' : '1') : '0';
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, -100%)`;
    }
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const aspect = width / height;
    this.renderer.setSize(width, height, false);
    // Siempre cabe el ancho jugable entero (y algo de margen) tanto en horizontal como en movil.
    const halfHeight = Math.max(5.2, 4.9 / aspect);
    Object.assign(this.camera, { left: -halfHeight * aspect, right: halfHeight * aspect, top: halfHeight, bottom: -halfHeight });
    this.camera.updateProjectionMatrix();
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }
}
