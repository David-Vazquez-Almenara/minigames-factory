import type * as ThreeModule from 'three';
import { MiiMood, MiiRig, createFaceTexture } from '../../../../shared/components/mii-stage/mii-rig';
import { CameraDirector, CameraGoal, ViewInsets } from '../../../../shared/three/camera-director';

type Three = typeof ThreeModule;

// Encimera a lo largo del eje x; los cocineros detras (mirando a camara) y su tabla delante, sobre la encimera.
export const CHOP_MAX_VISIBLE = 5;
const SLOT_GAP = 1.7;
const COUNTER_TOP = 0.84;
const COUNTER_Z = 0.55;
const COOK_Z = -0.25;
const BOARD_Z = 0.55;
// Corte decorativo de los demas (no se sabe cuanto cortan de verdad): una verdura cada ~1 s.
const OTHERS_CUT_MS = [850, 1400];
const SLIDE_OUT_MS = 380;
const SLIDE_IN_MS = 260;
const FOV = 40;

type VeggieKind = 'carrot' | 'potato' | 'pepper' | 'tomato' | 'eggplant' | 'onion';
const VEGGIES: VeggieKind[] = ['carrot', 'tomato', 'pepper', 'potato', 'eggplant', 'onion'];

export interface ChopCookView {
  playerId: string;
  name: string;
  avatarUrl: string;
  shirt: string;
  isLocal: boolean;
}

export interface ChopSceneState {
  /** Quien esta moviendo el cuchillo ahora mismo. */
  chopping: string[];
  /** true cuando la camara ya debe acercarse al jugador local. */
  closeUp: boolean;
}

interface Cook {
  view: ChopCookView;
  rig: MiiRig;
  x: number;
  veggie: ThreeModule.Group;
  kindIndex: number;
  enteredAt: number;
  leaving: Array<{ group: ThreeModule.Group; startedAt: number }>;
  nextAutoCutAt: number;
}

/**
 * Escena 3D de "Corta verduras": cocina con una encimera larga y hasta cinco cocineros (el jugador local en el
 * centro). Cada uno tiene su tabla con una verdura; al cortarla se parte en dos, sale por la derecha y entra la
 * siguiente por la izquierda. Los cortes de los demas son decorativos (no se espera a nadie).
 */
export class ChopScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly director: CameraDirector;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly cooks = new Map<string, Cook>();
  private readonly materials = new Map<string, ThreeModule.MeshStandardMaterial>();
  private readonly geometries = new Map<string, ThreeModule.BufferGeometry>();
  private readonly scratch: ThreeModule.Vector3;
  private state: ChopSceneState = { chopping: [], closeUp: false };
  private insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private frameHandle = 0;
  private lastFrame = performance.now();
  private disposed = false;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    views: ChopCookView[],
    proxyBase: string,
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#fdf1dc');
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 80);
    this.director = new CameraDirector(T, this.camera);
    this.scratch = new T.Vector3();

    this.scene.add(new T.HemisphereLight(0xffffff, 0xe0c9a6, 1.5));
    const key = new T.DirectionalLight(0xffffff, 1.3);
    key.position.set(3, 7, 6);
    this.scene.add(key);

    this.buildKitchen(views.length);
    const now = performance.now();
    views.slice(0, CHOP_MAX_VISIBLE).forEach((view, index) => this.createCook(view, (index - (views.length - 1) / 2) * SLOT_GAP, index, now, proxyBase));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.director.focus('overview', () => this.overviewGoal(), now);
    this.loop();
  }

  sync(state: ChopSceneState): void {
    const now = performance.now();

    if (state.closeUp && !this.state.closeUp) {
      this.director.focus('close', () => this.closeGoal(), now, { durationMs: 1300 });
    }

    this.state = state;
  }

  /** Verdura cortada (la del jugador local, cada 10 clics). */
  cut(playerId: string): void {
    const cook = this.cooks.get(playerId);

    if (cook) {
      this.cutVeggie(cook, performance.now());
    }
  }

  setInsets(insets: ViewInsets): void {
    this.insets = insets;
    this.director.setViewport(this.host.clientWidth, this.host.clientHeight, insets);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();

    for (const cook of this.cooks.values()) {
      cook.rig.dispose();
    }

    for (const item of [...this.disposables, ...this.materials.values(), ...this.geometries.values()]) {
      item.dispose();
    }

    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private material(color: string, roughness = 0.6): ThreeModule.MeshStandardMaterial {
    let material = this.materials.get(`${color}:${roughness}`);

    if (!material) {
      material = new this.THREE.MeshStandardMaterial({ color, roughness });
      this.materials.set(`${color}:${roughness}`, material);
    }

    return material;
  }

  private geometry<G extends ThreeModule.BufferGeometry>(key: string, create: () => G): G {
    let geometry = this.geometries.get(key) as G | undefined;

    if (!geometry) {
      geometry = create();
      this.geometries.set(key, geometry);
    }

    return geometry;
  }

  private box(width: number, height: number, depth: number, color: string, x: number, y: number, z: number, roughness = 0.6): ThreeModule.Mesh {
    const mesh = new this.THREE.Mesh(this.geometry('box', () => new this.THREE.BoxGeometry(1, 1, 1)), this.material(color, roughness));
    mesh.scale.set(width, height, depth);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    return mesh;
  }

  private buildKitchen(count: number): void {
    const T = this.THREE;
    const width = Math.max(6, Math.min(CHOP_MAX_VISIBLE, count) * SLOT_GAP + 2.5);

    // Suelo de baldosas y pared de azulejos.
    const tiles = document.createElement('canvas');
    tiles.width = 64;
    tiles.height = 64;
    const context = tiles.getContext('2d')!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 64, 64);
    context.fillStyle = '#bfe3ff';
    context.fillRect(0, 0, 32, 32);
    context.fillRect(32, 32, 32, 32);
    const texture = this.track(new T.CanvasTexture(tiles));
    texture.colorSpace = T.SRGBColorSpace;
    texture.wrapS = T.RepeatWrapping;
    texture.wrapT = T.RepeatWrapping;
    texture.repeat.set(20, 8);
    const wall = new T.Mesh(this.track(new T.PlaneGeometry(26, 8)), this.track(new T.MeshStandardMaterial({ map: texture, roughness: 0.4 })));
    wall.position.set(0, 4, -2.4);
    this.scene.add(wall);
    const floor = new T.Mesh(this.track(new T.PlaneGeometry(26, 12)), this.material('#d8b48a', 0.8));
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    // Muebles de cocina al fondo: armarios altos, encimera trasera con fogones y campana, y una ventana.
    this.box(width + 4, 0.9, 0.6, '#ffffff', 0, 0.45, -2.1);
    this.box(width + 4, 0.06, 0.66, '#c7c2bb', 0, 0.93, -2.1, 0.3);
    this.box(width + 4, 0.9, 0.4, '#8fd1a8', 0, 3.1, -2.2);

    for (let x = -width / 2 - 1.5; x <= width / 2 + 1.5; x += 1.1) {
      this.box(0.04, 0.8, 0.02, '#5c9c75', x, 3.1, -1.99);
    }

    this.box(1.6, 0.04, 0.5, '#2f3238', 2.6, 0.97, -2.1, 0.3);
    this.box(1.4, 0.7, 0.6, '#c7c2bb', 2.6, 2.4, -2.1, 0.3);
    this.box(1.8, 1.1, 0.05, '#bfe6ff', -2.4, 2, -2.36, 0.1);
    this.box(1.9, 0.08, 0.1, '#ffffff', -2.4, 1.43, -2.3);

    // Encimera central donde cortan: mueble de madera y tablero claro.
    this.box(width, COUNTER_TOP - 0.06, 1.2, '#a8723f', 0, (COUNTER_TOP - 0.06) / 2, COUNTER_Z, 0.7);
    this.box(width + 0.1, 0.08, 1.3, '#efe6d6', 0, COUNTER_TOP - 0.03, COUNTER_Z, 0.35);
  }

  private createCook(view: ChopCookView, x: number, index: number, now: number, proxyBase: string): void {
    const T = this.THREE;
    const rig = new MiiRig(T, view.shirt);
    rig.enter(now / 1000 + index * 0.1);
    rig.root.position.set(x, 0, COOK_Z);
    rig.targetX = x;
    this.scene.add(rig.root);

    // Cuchillo en la mano derecha: mango oscuro y hoja metalica a lo largo del brazo.
    const knife = new T.Group();
    const handle = new T.Mesh(this.geometry('knifeHandle', () => new T.BoxGeometry(0.05, 0.14, 0.05)), this.material('#3b2416'));
    const blade = new T.Mesh(this.geometry('knifeBlade', () => new T.BoxGeometry(0.02, 0.26, 0.09)), this.material('#d9dde3', 0.2));
    blade.position.y = -0.19;
    knife.add(handle, blade);
    rig.attachToRightHand(knife);

    // Tabla de cortar de madera delante de cada cocinero.
    const board = new T.Mesh(this.geometry('board', () => new T.BoxGeometry(0.95, 0.05, 0.55)), this.material('#c9935a', 0.75));
    board.position.set(x, COUNTER_TOP + 0.025, BOARD_Z);
    this.scene.add(board);

    void createFaceTexture(T, view.avatarUrl, view.name, proxyBase).then((texture) => {
      if (this.disposed) {
        texture.dispose();
        return;
      }

      rig.setFaceTexture(texture);
    });

    const kindIndex = index % VEGGIES.length;
    const veggie = this.buildVeggie(VEGGIES[kindIndex]);
    veggie.position.set(x, COUNTER_TOP + 0.05, BOARD_Z);
    this.scene.add(veggie);
    this.cooks.set(view.playerId, { view, rig, x, veggie, kindIndex, enteredAt: -Infinity, leaving: [], nextAutoCutAt: 0 });
  }

  /** Verduras sencillas hechas con primitivas (tumbadas a lo largo de la tabla). */
  private buildVeggie(kind: VeggieKind): ThreeModule.Group {
    const T = this.THREE;
    const group = new T.Group();
    const add = (geometry: ThreeModule.BufferGeometry, color: string, x: number, y: number, z: number, scale: [number, number, number] = [1, 1, 1]) => {
      const mesh = new T.Mesh(geometry, this.material(color, 0.55));
      mesh.position.set(x, y, z);
      mesh.scale.set(...scale);
      group.add(mesh);
      return mesh;
    };
    const sphere = this.geometry('sphere', () => new T.SphereGeometry(0.1, 16, 12));

    switch (kind) {
      case 'carrot': {
        const body = add(this.geometry('cone', () => new T.ConeGeometry(0.07, 0.42, 14)), '#ff8a1f', 0, 0.07, 0);
        body.rotation.z = Math.PI / 2;
        add(this.geometry('leaf', () => new T.ConeGeometry(0.04, 0.14, 8)), '#3fa34d', -0.27, 0.07, 0).rotation.z = Math.PI / 2;
        break;
      }
      case 'potato':
        add(sphere, '#b98a4e', 0, 0.08, 0, [1.4, 0.85, 1]);
        break;
      case 'pepper':
        add(sphere, '#e8262b', 0, 0.11, 0, [1.1, 1.15, 1.1]);
        add(this.geometry('stem', () => new T.CylinderGeometry(0.015, 0.02, 0.07, 8)), '#3fa34d', 0, 0.25, 0);
        break;
      case 'tomato':
        add(sphere, '#ff4b3a', 0, 0.1, 0, [1.05, 0.9, 1.05]);
        add(this.geometry('leafDisc', () => new T.CylinderGeometry(0.04, 0.04, 0.015, 6)), '#3fa34d', 0, 0.19, 0);
        break;
      case 'eggplant': {
        const body = add(this.geometry('capsule', () => new T.CapsuleGeometry(0.075, 0.24, 6, 12)), '#6b2d8f', 0, 0.08, 0);
        body.rotation.z = Math.PI / 2;
        add(this.geometry('stem', () => new T.CylinderGeometry(0.015, 0.02, 0.07, 8)), '#3fa34d', -0.2, 0.08, 0).rotation.z = Math.PI / 2;
        break;
      }
      default:
        add(sphere, '#e9d38a', 0, 0.1, 0, [1, 1, 1]);
        add(this.geometry('cone', () => new T.ConeGeometry(0.07, 0.42, 14)), '#e9d38a', 0, 0.23, 0, [0.4, 0.3, 0.4]);
        break;
    }

    return group;
  }

  /** La verdura actual se parte en dos y sale por la derecha; entra la siguiente por la izquierda. */
  private cutVeggie(cook: Cook, now: number): void {
    const T = this.THREE;
    const old = cook.veggie;
    // Dos mitades: la misma verdura escalada a la mitad, separandose.
    const halves = new T.Group();
    halves.position.copy(old.position);

    for (const side of [-1, 1]) {
      const half = old.clone();
      half.scale.set(0.5, 1, 1);
      half.position.set(side * 0.09, 0, 0);
      half.rotation.z = side * 0.25;
      halves.add(half);
    }

    this.scene.remove(old);
    this.scene.add(halves);
    cook.leaving.push({ group: halves, startedAt: now });
    cook.kindIndex = (cook.kindIndex + 1) % VEGGIES.length;
    cook.veggie = this.buildVeggie(VEGGIES[cook.kindIndex]);
    cook.veggie.position.set(cook.x - 0.9, COUNTER_TOP + 0.05, BOARD_Z);
    cook.enteredAt = now;
    this.scene.add(cook.veggie);
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private updateCook(cook: Cook, now: number, time: number, delta: number): void {
    const chopping = this.state.chopping.includes(cook.view.playerId);
    const mood: MiiMood = chopping ? 'shuffle' : 'idle';
    cook.rig.mood = mood;
    cook.rig.update(time, delta, 'game');

    // Los demas cortan "de mentira" mientras dura la fase (no se pregunta a nadie cuanto llevan).
    if (chopping && !cook.view.isLocal && now >= cook.nextAutoCutAt) {
      if (cook.nextAutoCutAt) {
        this.cutVeggie(cook, now);
      }

      cook.nextAutoCutAt = now + OTHERS_CUT_MS[0] + Math.random() * (OTHERS_CUT_MS[1] - OTHERS_CUT_MS[0]);
    }

    if (!chopping) {
      cook.nextAutoCutAt = 0;
    }

    // Entrada de la verdura nueva desde la izquierda.
    const enter = Math.min(1, (now - cook.enteredAt) / SLIDE_IN_MS);
    cook.veggie.position.x = cook.x - 0.9 * (1 - (1 - Math.pow(1 - enter, 3)));

    // La cortada sale disparada por la derecha y desaparece.
    for (let index = cook.leaving.length - 1; index >= 0; index -= 1) {
      const leaving = cook.leaving[index];
      const progress = (now - leaving.startedAt) / SLIDE_OUT_MS;

      if (progress >= 1) {
        this.scene.remove(leaving.group);
        cook.leaving.splice(index, 1);
        continue;
      }

      leaving.group.position.x = cook.x + progress * 1.1;
      leaving.group.position.y = COUNTER_TOP + 0.05 + Math.sin(progress * Math.PI) * 0.15;
      leaving.group.scale.setScalar(1 - progress * 0.6);
      leaving.group.children.forEach((half, side) => (half.position.x = (side ? 1 : -1) * (0.09 + progress * 0.12)));
    }
  }

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const time = now / 1000;

    for (const cook of this.cooks.values()) {
      this.updateCook(cook, now, time, delta);
    }

    this.director.update(now, delta);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-chop-label]'))) {
      const cook = this.cooks.get(label.dataset['chopLabel'] || '');

      if (!cook) {
        label.style.opacity = '0';
        continue;
      }

      const vector = this.scratch.set(cook.x, COUNTER_TOP - 0.25, COUNTER_Z + 0.62).project(this.camera);
      const visible = vector.z < 1 && Math.abs(vector.x) < 1.05 && Math.abs(vector.y) < 1.05;
      label.style.opacity = visible ? '1' : '0';
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, -50%)`;
    }
  }

  /* --------------------------------- Camara --------------------------------- */

  private overviewGoal(): CameraGoal {
    const T = this.THREE;
    const half = Math.max(2, (Math.min(CHOP_MAX_VISIBLE, this.cooks.size) - 1) * SLOT_GAP * 0.5 + 0.9);
    return {
      target: new T.Vector3(0, 1.3, 0.2),
      direction: new T.Vector3(0, 0.32, 1).normalize(),
      fit: [new T.Vector3(-half, 0.4, 1.2), new T.Vector3(half, 0.4, 1.2), new T.Vector3(-half, 2.2, COOK_Z), new T.Vector3(half, 2.2, COOK_Z)],
      margin: 0.95,
    };
  }

  /** Primer plano del jugador local (siempre en el centro), con algo de sus vecinos a los lados. */
  private closeGoal(): CameraGoal {
    const T = this.THREE;
    return {
      target: new T.Vector3(0, 1.35, 0.25),
      direction: new T.Vector3(0, 0.38, 1).normalize(),
      fit: [new T.Vector3(-1.25, 0.65, 1.1), new T.Vector3(1.25, 0.65, 1.1), new T.Vector3(0, 2.5, COOK_Z)],
      margin: 0.92,
    };
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.director.setViewport(width, height, this.insets);
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }
}
