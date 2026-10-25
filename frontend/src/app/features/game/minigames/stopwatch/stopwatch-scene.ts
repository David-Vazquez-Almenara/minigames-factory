import type * as ThreeModule from 'three';
import { MiiMood, MiiRig, createFaceTexture } from '../../../../shared/components/mii-stage/mii-rig';

type Three = typeof ThreeModule;

// Cuatro atriles siempre (como en el plato de un concurso); los que sobran quedan vacios.
export const PODIUM_COUNT = 4;
const PODIUM_X = [-3.3, -1.1, 1.1, 3.3];
const PODIUM_COLORS = ['#3d8bff', '#ff5a5f', '#38c172', '#ffcc33'];
const PODIUM_Z = 0.9;
const PLAYER_Z = -0.15;
const PRESS_MS = 260;
const FOV = 40;

export interface StopwatchPlayerView {
  playerId: string;
  name: string;
  avatarUrl: string;
  shirt: string;
  isLocal: boolean;
}

export interface StopwatchSceneState {
  /** Una entrada por atril (null = atril vacio). */
  seats: Array<{ playerId: string; mood: 'idle' | 'happy' | 'sad' } | null>;
}

interface Contestant {
  rig: MiiRig;
  slot: number;
  mood: 'idle' | 'happy' | 'sad';
  pressedAt: number;
}

/**
 * Escena 3D de "Para el cronometro": plato de concurso con una rueda de colores al fondo, cuatro atriles con su
 * boton y los Miis detras. El marcador grande y las pantallas de los atriles son HTML (la escena solo las situa).
 */
export class StopwatchScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly contestants = new Map<string, Contestant>();
  private readonly buttons: ThreeModule.Mesh[] = [];
  private readonly wheel: ThreeModule.Mesh;
  private readonly scratch: ThreeModule.Vector3;
  private frameHandle = 0;
  private lastFrame = performance.now();
  private disposed = false;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    seats: Array<StopwatchPlayerView | null>,
    proxyBase: string,
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#ffd1e6');
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 100);
    this.scratch = new T.Vector3();

    this.scene.add(new T.HemisphereLight(0xffffff, 0xffc4dc, 1.6));
    const key = new T.DirectionalLight(0xffffff, 1.3);
    key.position.set(2, 8, 9);
    this.scene.add(key);

    this.buildFloor();
    this.wheel = this.buildWheel();
    this.buildPodiums();

    seats.slice(0, PODIUM_COUNT).forEach((view, slot) => {
      if (!view) {
        return;
      }

      const rig = new MiiRig(T, view.shirt);
      rig.enter(performance.now() / 1000 + slot * 0.12);
      rig.root.position.set(PODIUM_X[slot], 0, PLAYER_Z);
      rig.targetX = PODIUM_X[slot];
      // Subidos a una tarima detras del atril, para que se les vea de cintura para arriba.
      rig.baseY = 0.42;
      this.scene.add(rig.root);
      this.contestants.set(view.playerId, { rig, slot, mood: 'idle', pressedAt: -Infinity });

      void createFaceTexture(T, view.avatarUrl, view.name, proxyBase).then((texture) => {
        if (this.disposed) {
          texture.dispose();
          return;
        }

        rig.setFaceTexture(texture);
      });
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.loop();
  }

  sync(state: StopwatchSceneState): void {
    for (const seat of state.seats) {
      const contestant = seat ? this.contestants.get(seat.playerId) : undefined;

      if (contestant && seat) {
        contestant.mood = seat.mood;
      }
    }
  }

  /** Pulsa el boton de su atril (el propio al instante; el resto, al saber que ya han parado). */
  press(playerId: string): void {
    const contestant = this.contestants.get(playerId);

    if (contestant) {
      contestant.pressedAt = performance.now();
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();

    for (const contestant of this.contestants.values()) {
      contestant.rig.dispose();
    }

    for (const item of this.disposables) {
      item.dispose();
    }

    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private canvasTexture(size: number, draw: (context: CanvasRenderingContext2D) => void): ThreeModule.CanvasTexture {
    const T = this.THREE;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    draw(canvas.getContext('2d')!);
    const texture = this.track(new T.CanvasTexture(canvas));
    texture.colorSpace = T.SRGBColorSpace;
    return texture;
  }

  private buildFloor(): void {
    const T = this.THREE;
    const texture = this.canvasTexture(128, (context) => {
      for (let y = 0; y < 2; y += 1) {
        for (let x = 0; x < 2; x += 1) {
          context.fillStyle = (x + y) % 2 ? '#ffffff' : '#ffb3d1';
          context.fillRect(x * 64, y * 64, 64, 64);
        }
      }
    });
    texture.wrapS = T.RepeatWrapping;
    texture.wrapT = T.RepeatWrapping;
    texture.repeat.set(12, 6);
    const floor = new T.Mesh(this.track(new T.PlaneGeometry(30, 14)), this.track(new T.MeshStandardMaterial({ map: texture, roughness: 0.5 })));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = 2;
    this.scene.add(floor);
  }

  /** Rueda de colores gigante al fondo, con un aro blanco (como en el plato del concurso). */
  private buildWheel(): ThreeModule.Mesh {
    const T = this.THREE;
    const colors = ['#ff5a5f', '#ff9f43', '#ffd93d', '#6bd66b', '#38c7c7', '#4d8bff', '#9b6bff', '#ff6bd6'];
    const texture = this.canvasTexture(512, (context) => {
      const segments = 24;

      for (let index = 0; index < segments; index += 1) {
        context.beginPath();
        context.moveTo(256, 256);
        context.arc(256, 256, 256, (index / segments) * Math.PI * 2, ((index + 1) / segments) * Math.PI * 2);
        context.closePath();
        context.fillStyle = colors[index % colors.length];
        context.fill();
      }

      context.beginPath();
      context.arc(256, 256, 120, 0, Math.PI * 2);
      context.fillStyle = '#fff7ec';
      context.fill();
    });
    const wall = new T.Mesh(this.track(new T.PlaneGeometry(40, 16)), this.track(new T.MeshStandardMaterial({ color: '#ffc2dc', roughness: 0.9 })));
    wall.position.set(0, 6, -4.2);
    this.scene.add(wall);
    const wheel = new T.Mesh(this.track(new T.CircleGeometry(6.5, 64)), this.track(new T.MeshBasicMaterial({ map: texture })));
    wheel.position.set(0, 3.6, -4.1);
    this.scene.add(wheel);
    const ring = new T.Mesh(this.track(new T.TorusGeometry(6.55, 0.18, 10, 80)), this.track(new T.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4 })));
    ring.position.copy(wheel.position);
    this.scene.add(ring);
    return wheel;
  }

  private buildPodiums(): void {
    const T = this.THREE;
    const body = this.track(new T.BoxGeometry(1.75, 1.05, 0.9));
    const top = this.track(new T.BoxGeometry(1.95, 0.14, 1.1));
    const screen = this.track(new T.PlaneGeometry(1.4, 0.48));
    const buttonGeometry = this.track(new T.CylinderGeometry(0.2, 0.22, 0.12, 24));
    const dark = this.track(new T.MeshStandardMaterial({ color: '#1b1f2a', roughness: 0.3 }));
    const white = this.track(new T.MeshStandardMaterial({ color: '#fff7ec', roughness: 0.5 }));

    PODIUM_X.forEach((x, slot) => {
      const color = this.track(new T.MeshStandardMaterial({ color: PODIUM_COLORS[slot], roughness: 0.45 }));
      const base = new T.Mesh(body, color);
      base.position.set(x, 0.52, PODIUM_Z);
      const lid = new T.Mesh(top, white);
      lid.position.set(x, 1.1, PODIUM_Z);
      // Pantalla del atril (el texto va encima en HTML) y el boton rojo para parar.
      const panel = new T.Mesh(screen, dark);
      panel.position.set(x, 0.62, PODIUM_Z + 0.46);
      const button = new T.Mesh(buttonGeometry, this.track(new T.MeshStandardMaterial({ color: '#e8262b', roughness: 0.35, emissive: '#3a0000' })));
      button.position.set(x, 1.22, PODIUM_Z + 0.15);
      this.buttons.push(button);
      this.scene.add(base, lid, panel, button);
    });
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const time = now / 1000;
    this.wheel.rotation.z = -time * 0.08;

    for (const contestant of this.contestants.values()) {
      const press = (now - contestant.pressedAt) / PRESS_MS;
      const pushing = press >= 0 && press < 1;
      let mood: MiiMood = contestant.mood;

      // Al pulsar, las dos manos bajan sobre el boton del atril.
      if (pushing) {
        mood = 'lever';
        contestant.rig.leverPull = Math.sin(Math.PI * press);
      }

      contestant.rig.mood = mood;
      contestant.rig.update(time, delta, 'game');
      this.buttons[contestant.slot].position.y = 1.22 - (pushing ? Math.sin(Math.PI * press) * 0.06 : 0);
    }

    this.camera.position.set(0, 2.55, 8.6);
    this.camera.lookAt(0, 1.55, 0);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  /** Pantalla de cada atril (data-sw-label="screen:N") y nombre bajo ella (data-sw-label="name:N"). */
  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-sw-label]'))) {
      const [kind, slotText] = (label.dataset['swLabel'] || '').split(':');
      const slot = Number(slotText);
      const vector = this.scratch.set(PODIUM_X[slot] ?? 0, kind === 'screen' ? 0.62 : 0.12, PODIUM_Z + 0.5).project(this.camera);
      label.style.opacity = vector.z < 1 ? '1' : '0';
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, -50%)`;
    }
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.fov = width / height < 1 ? 70 : FOV;
    this.camera.updateProjectionMatrix();
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }
}
