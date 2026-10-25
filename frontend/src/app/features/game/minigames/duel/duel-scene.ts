import type * as ThreeModule from 'three';
import { createDealerRig } from '../../../../shared/components/mii-stage/dealer-rig';
import { MiiMood, MiiRig, createFaceTexture } from '../../../../shared/components/mii-stage/mii-rig';

type Three = typeof ThreeModule;

// Los jugadores, de espaldas a la camara; el crupier al fondo de la calle, mirandoles.
const PLAYER_SLOTS = [-1.95, -0.65, 0.65, 1.95];
const PLAYER_Z = 0;
const DEALER_Z = -11;
const STREET_HALF_WIDTH = 5.5;
const FALL_MS = 520;
const FLASH_MS = 90;
const FOV = 46;

export interface DuelPlayerView {
  playerId: string;
  name: string;
  avatarUrl: string;
  shirt: string;
  isLocal: boolean;
}

export interface DuelSceneState {
  players: Array<{ playerId: string; aiming: boolean; dead: boolean }>;
  /** Momento (reloj performance.now) en que dispara el crupier; null si aun no se sabe o no toca. */
  dealerShootsAt: number | null;
  dealerDead: boolean;
}

interface Gunslinger {
  view: DuelPlayerView | null;
  holder: ThreeModule.Group;
  faller: ThreeModule.Group;
  rig: MiiRig;
  gun: ThreeModule.Group;
  flash: ThreeModule.Mesh;
  aiming: boolean;
  dead: boolean;
  deadSince: number;
  firedAt: number;
}

/**
 * Escena 3D de "Desenfundar": calle del oeste de arena con edificios a los lados. Los cuatro jugadores de la
 * ventana del cliente estan de espaldas a la camara y el crupier les espera al fondo con su revolver.
 */
export class DuelScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly players = new Map<string, Gunslinger>();
  private readonly dealer: Gunslinger;
  private readonly scratch: ThreeModule.Vector3;
  private readonly tumbleweed: ThreeModule.Mesh;
  private state: DuelSceneState = { players: [], dealerShootsAt: null, dealerDead: false };
  private frameHandle = 0;
  private lastFrame = performance.now();
  private disposed = false;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    views: DuelPlayerView[],
    proxyBase: string,
    dealerSeed: string,
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#f7c98b');
    this.scene.fog = new T.Fog('#f7c98b', 18, 46);
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 120);
    this.scratch = new T.Vector3();

    this.scene.add(new T.HemisphereLight(0xfff1d6, 0xb07a45, 1.5));
    const sun = new T.DirectionalLight(0xffe0b0, 1.7);
    sun.position.set(-6, 10, 6);
    this.scene.add(sun);

    this.buildStreet();
    this.tumbleweed = this.buildTumbleweed();

    // Siempre cuatro huecos; si hay menos jugadores, los sobrantes quedan vacios.
    views.slice(0, PLAYER_SLOTS.length).forEach((view, index) => {
      const slinger = this.createSlinger(new MiiRig(T, view.shirt), view);
      slinger.holder.position.set(PLAYER_SLOTS[index], 0, PLAYER_Z);
      // De espaldas a la camara, mirando al crupier.
      slinger.holder.rotation.y = Math.PI;

      void createFaceTexture(T, view.avatarUrl, view.name, proxyBase).then((texture) => {
        if (this.disposed) {
          texture.dispose();
          return;
        }

        slinger.rig.setFaceTexture(texture);
      });

      this.players.set(view.playerId, slinger);
    });

    this.dealer = this.createSlinger(createDealerRig(T, dealerSeed), null);
    this.dealer.holder.position.set(0, 0, DEALER_Z);
    this.dealer.holder.scale.setScalar(1.15);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.loop();
  }

  sync(state: DuelSceneState): void {
    const now = performance.now();
    this.state = state;

    for (const entry of state.players) {
      const slinger = this.players.get(entry.playerId);

      if (!slinger) {
        continue;
      }

      if (entry.dead && !slinger.dead) {
        slinger.deadSince = now;
      }

      slinger.dead = entry.dead;
      // Ronda nueva: todos de pie y con el arma enfundada.
      slinger.aiming = entry.aiming;
    }

    if (state.dealerDead && !this.dealer.dead) {
      this.dealer.deadSince = now;
    }

    this.dealer.dead = state.dealerDead;
  }

  /** Disparo de un jugador (el local al instante; los demas al conocerse el resultado). */
  fire(playerId: string): void {
    const slinger = this.players.get(playerId);

    if (slinger) {
      slinger.aiming = true;
      slinger.firedAt = performance.now();
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();

    for (const slinger of [...this.players.values(), this.dealer]) {
      slinger.rig.dispose();
    }

    for (const item of this.disposables) {
      item.dispose();
    }

    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private material(color: string, roughness = 0.75): ThreeModule.MeshStandardMaterial {
    return this.track(new this.THREE.MeshStandardMaterial({ color, roughness }));
  }

  private box(width: number, height: number, depth: number, material: ThreeModule.Material, x: number, y: number, z: number): ThreeModule.Mesh {
    const T = this.THREE;
    const mesh = new T.Mesh(this.track(new T.BoxGeometry(width, height, depth)), material);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    return mesh;
  }

  private signTexture(text: string, background: string): ThreeModule.CanvasTexture {
    const T = this.THREE;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const context = canvas.getContext('2d')!;
    context.fillStyle = background;
    context.fillRect(0, 0, 256, 64);
    context.strokeStyle = '#3b2412';
    context.lineWidth = 6;
    context.strokeRect(3, 3, 250, 58);
    context.fillStyle = '#fff3d6';
    context.font = 'bold 38px Georgia, serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 128, 34);
    const texture = this.track(new T.CanvasTexture(canvas));
    texture.colorSpace = T.SRGBColorSpace;
    return texture;
  }

  private buildStreet(): void {
    const T = this.THREE;
    const sand = new T.Mesh(this.track(new T.PlaneGeometry(80, 80)), this.material('#e3b273', 1));
    sand.rotation.x = -Math.PI / 2;
    this.scene.add(sand);

    // Huellas de ruedas a lo largo de la calle.
    for (const x of [-1.2, 1.2]) {
      const rut = new T.Mesh(this.track(new T.PlaneGeometry(0.35, 60)), this.material('#d29e5f', 1));
      rut.rotation.x = -Math.PI / 2;
      rut.position.set(x, 0.005, -12);
      this.scene.add(rut);
    }

    const woods = ['#8a5a32', '#a86d3c', '#7a4b2a', '#b98048'].map((color) => this.material(color));
    const trim = this.material('#5b3a1e');
    const glass = this.material('#3a2a1d', 0.4);
    const signs = ['SALOON', 'BANK', 'SHERIFF', 'HOTEL', 'GENERAL', 'BARBER'];

    // Fachadas del oeste a ambos lados: frontal alto, porche con postes y ventanas.
    for (const side of [-1, 1]) {
      for (let index = 0; index < 5; index += 1) {
        const z = 2 - index * 5.6;
        const height = 4.2 + ((index + (side > 0 ? 1 : 0)) % 3) * 0.7;
        const x = side * (STREET_HALF_WIDTH + 2.2);
        this.box(4.4, height, 5.2, woods[(index + (side > 0 ? 2 : 0)) % woods.length], x, height / 2, z);
        // Porche con tejadillo y postes.
        this.box(1.4, 0.12, 5.2, trim, side * (STREET_HALF_WIDTH - 0.2), 2.6, z);

        for (const offset of [-2.3, 2.3]) {
          this.box(0.14, 2.6, 0.14, trim, side * (STREET_HALF_WIDTH - 0.8), 1.3, z + offset);
        }

        this.box(0.1, 1.9, 1.1, glass, side * (STREET_HALF_WIDTH), 1, z - 0.6);
        this.box(0.1, 0.9, 1.1, glass, side * (STREET_HALF_WIDTH), 1.6, z + 1.4);
        const signName = signs[(index * 2 + (side > 0 ? 1 : 0)) % signs.length];
        const sign = new T.Mesh(
          this.track(new T.PlaneGeometry(3.2, 0.8)),
          this.track(new T.MeshStandardMaterial({ map: this.signTexture(signName, '#6b3f1f'), roughness: 0.8 })),
        );
        sign.position.set(side * STREET_HALF_WIDTH - side * 0.02, height - 0.7, z);
        sign.rotation.y = -side * (Math.PI / 2);
        this.scene.add(sign);
      }
    }

    // Al fondo, mesetas rojizas para cerrar la calle.
    for (const [x, width, height] of [
      [-14, 16, 7],
      [3, 20, 9],
      [18, 14, 6],
    ]) {
      this.box(width, height, 4, this.material('#c9784a', 1), x, height / 2, -34);
    }
  }

  private buildTumbleweed(): ThreeModule.Mesh {
    const T = this.THREE;
    const mesh = new T.Mesh(this.track(new T.IcosahedronGeometry(0.42, 1)), this.track(new T.MeshStandardMaterial({ color: '#a9824d', wireframe: true })));
    this.scene.add(mesh);
    return mesh;
  }

  private createSlinger(rig: MiiRig, view: DuelPlayerView | null): Gunslinger {
    const T = this.THREE;
    const holder = new T.Group();
    const faller = new T.Group();
    // Ya en escena (sin la animacion de entrada que cae desde arriba).
      rig.enter(0);
    faller.add(rig.root);
    holder.add(faller);
    this.scene.add(holder);

    // Revolver en la mano derecha: canon a lo largo del brazo, culata y fogonazo en la boca.
    const metal = this.material('#2b2f36', 0.35);
    const gun = new T.Group();
    const barrel = new T.Mesh(this.track(new T.CylinderGeometry(0.035, 0.035, 0.36, 10)), metal);
    barrel.position.y = -0.2;
    const grip = new T.Mesh(this.track(new T.BoxGeometry(0.07, 0.14, 0.16)), this.material('#6b3f1f'));
    grip.position.set(0, -0.02, -0.06);
    const flash = new T.Mesh(this.track(new T.SphereGeometry(0.13, 12, 8)), this.track(new T.MeshBasicMaterial({ color: '#ffe36b' })));
    flash.position.y = -0.42;
    flash.visible = false;
    gun.add(barrel, grip, flash);
    rig.attachToRightHand(gun);

    return { view, holder, faller, rig, gun, flash, aiming: false, dead: false, deadSince: 0, firedAt: -Infinity };
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private updateSlinger(slinger: Gunslinger, now: number, time: number, delta: number, isDealer: boolean): void {
    let mood: MiiMood = 'idle';

    if (isDealer) {
      const shootsAt = this.state.dealerShootsAt;
      // El crupier levanta el arma justo antes de disparar y la mantiene hasta el final de la ronda.
      mood = shootsAt !== null && now >= shootsAt - 160 && !slinger.dead ? 'aim' : 'idle';

      if (shootsAt !== null && now >= shootsAt && slinger.firedAt < shootsAt) {
        slinger.firedAt = now;
      }
    } else if (slinger.aiming && !slinger.dead) {
      mood = 'aim';
    } else if (slinger.dead) {
      mood = 'sad';
    }

    slinger.gun.visible = mood === 'aim';
    slinger.flash.visible = now - slinger.firedAt < FLASH_MS && mood === 'aim';
    slinger.rig.mood = mood;
    slinger.rig.update(time, delta, 'game');

    // Caido: se desploma de lado hacia el exterior de la calle (hacia atras taparia la pantalla). El crupier, al
    // fondo, cae de espaldas.
    const fall = slinger.dead ? Math.min(1, (now - slinger.deadSince) / FALL_MS) : 0;
    const eased = fall < 1 ? 1 - Math.pow(1 - fall, 3) : 1;

    if (isDealer) {
      slinger.faller.rotation.x = -eased * (Math.PI / 2) * 0.92;
    } else {
      // Con el jugador girado hacia el fondo, su eje x local va al reves que el de la calle.
      const outward = slinger.holder.position.x < 0 ? -1 : 1;
      slinger.faller.rotation.z = outward * eased * (Math.PI / 2) * 0.92;
    }

    slinger.faller.position.y = eased * 0.12;
  }

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const time = now / 1000;

    for (const slinger of this.players.values()) {
      this.updateSlinger(slinger, now, time, delta, false);
    }

    this.updateSlinger(this.dealer, now, time, delta, true);

    // Una bola de matojos cruza la calle de vez en cuando.
    const cycle = (time % 14) / 14;
    this.tumbleweed.position.set(-9 + cycle * 18, 0.42 + Math.abs(Math.sin(time * 4)) * 0.25, -6);
    this.tumbleweed.rotation.z = -time * 5;

    this.camera.position.set(0, 2.5, 5.2);
    this.camera.lookAt(0, 1.25, DEALER_Z + 2);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  /** Nombre (y tiempo de reaccion) sobre la cabeza de cada jugador. */
  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-du-label]'))) {
      const slinger = this.players.get(label.dataset['duLabel'] || '');

      if (!slinger) {
        label.style.opacity = '0';
        continue;
      }

      const vector = this.scratch.copy(slinger.holder.position).setY(slinger.dead ? 0.9 : 2.25).project(this.camera);
      label.style.opacity = vector.z < 1 ? '1' : '0';
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, -100%)`;
    }
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    // En vertical (movil) se abre el angulo para que quepan los cuatro jugadores.
    this.camera.fov = width / height < 1 ? 74 : FOV;
    this.camera.updateProjectionMatrix();
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }
}
