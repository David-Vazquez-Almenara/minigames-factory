import type * as ThreeModule from 'three';
import { MiiMood, MiiParts, MiiRig, createFaceTexture } from '../../../../shared/components/mii-stage/mii-rig';
import { BlastEffects, applyBlastPose } from '../../../../shared/three/blast-effects';
import { BLAST_STAND_Y, BLAST_VARIANT_COUNT, blastImpacts, sampleBlast } from '../../../../shared/three/blast-ragdoll';
import { CameraDirector, CameraGoal, ViewInsets } from '../../../../shared/three/camera-director';

type Three = typeof ThreeModule;
type Vector3 = ThreeModule.Vector3;

// Separacion entre jugadores en el circulo: con mas jugadores el circulo crece para que quepan todos.
const SEAT_GAP = 1.15;
const MIN_RADIUS = 1.7;
const WALK_SPEED = 2.6;
const FOV = 42;
const BOMB_RADIUS = 0.2;
// Brazos estirados hacia delante sujetando la bomba con las dos manos.
const HOLD_ARM_X = -1.2;
const HOLD_ARM_Z = 0.4;
const HANDS_FORWARD = 0.5;
const HANDS_HEIGHT = 1.02;
const CORPSE_FADE_MS = 600;
const BLOOD_TRAIL_S = 0.9;

export interface BombPlayerView {
  playerId: string;
  name: string;
  avatarUrl: string;
  shirt: string;
}

/** Estado que pinta la escena; los instantes ya vienen en el reloj local (performance.now). */
export interface BombSceneState {
  order: string[];
  alive: string[];
  stage: 'intro' | 'passing' | 'typing' | 'boom' | 'finished';
  round: number;
  holderId: string | null;
  fromId: string | null;
  passStartsAt: number;
  passEndsAt: number;
  orbitEndsAt: number;
  boom: { playerId: string; at: number; round: number } | null;
}

interface Walker {
  view: BombPlayerView;
  holder: ThreeModule.Group;
  flier: ThreeModule.Group;
  rig: MiiRig;
  parts: MiiParts | null;
  target: Vector3;
  dead: boolean;
  deadAt: number;
  deadRound: number;
  variant: number;
  impacts: number[];
  fadeAt: number;
}

interface BombModel {
  group: ThreeModule.Group;
  spark: ThreeModule.Mesh;
  light: ThreeModule.PointLight;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const ease = (value: number) => {
  const clamped = clamp01(value);
  return clamped * clamped * (3 - 2 * clamped);
};

/**
 * Escena 3D de Patata caliente: los jugadores en circulo en un claro del bosque, mirando al centro. Quien tiene
 * la bomba la sujeta con los brazos hacia delante; al acertar la lanza en parabola al siguiente. Si le explota,
 * sale volando hacia atras (voladura pregrabada) entre fuego, humo y mucha sangre.
 */
export class BombScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly director: CameraDirector;
  private readonly effects: BlastEffects;
  private readonly walkers = new Map<string, Walker>();
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly scratch: Vector3;
  private readonly bomb: BombModel;
  private readonly handled = new Set<string>();
  private state: BombSceneState;
  private layoutRound = -1;
  private radius = MIN_RADIUS;
  private shakeUntil = 0;
  private insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private frameHandle = 0;
  private lastFrame = performance.now();
  private disposed = false;

  /** Avisos para los sonidos. */
  onSound?: (sound: 'spawn' | 'throw' | 'catch' | 'boom' | 'thud') => void;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    players: BombPlayerView[],
    initialState: BombSceneState,
    proxyBase: string,
  ) {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#8fd0f2');
    this.scene.fog = new T.Fog('#8fd0f2', 20, 42);
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 120);
    this.director = new CameraDirector(T, this.camera);
    this.effects = new BlastEffects(T, this.scene);
    this.scratch = new T.Vector3();
    this.state = initialState;

    this.radius = Math.max(MIN_RADIUS, (SEAT_GAP * initialState.order.length) / (Math.PI * 2));
    this.buildClearing();
    this.bomb = this.buildBomb();
    this.scene.add(this.bomb.group);

    const time = performance.now() / 1000;
    const byId = new Map(players.map((player) => [player.playerId, player]));
    initialState.order.forEach((playerId, index) => {
      const view = byId.get(playerId);

      if (view) {
        this.createWalker(view, time + 0.15 + index * 0.08, proxyBase);
      }
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.layout(initialState, true);
    this.sync(initialState);
    this.director.focus('orbit', () => this.orbitGoal(performance.now()), performance.now());
    this.loop();
  }

  sync(state: BombSceneState): void {
    if (this.disposed) {
      return;
    }

    this.state = state;

    // Ronda nueva: los que siguen vivos rehacen el circulo (mas pequeno) y los caidos desaparecen.
    if (state.round !== this.layoutRound && state.round > 0) {
      this.layout(state, false);
    }

    // Explosion: el que la tenia sale volando (la misma voladura en todas las pantallas).
    if (state.boom && !this.handled.has(`dead:${state.boom.round}`)) {
      this.handled.add(`dead:${state.boom.round}`);
      const walker = this.walkers.get(state.boom.playerId);

      if (walker && !walker.dead) {
        walker.dead = true;
        walker.deadAt = state.boom.at;
        walker.deadRound = state.boom.round;
        walker.variant = (state.boom.round + state.order.indexOf(state.boom.playerId)) % BLAST_VARIANT_COUNT;
        walker.impacts = blastImpacts(walker.variant);
        walker.target.copy(walker.holder.position);
      }
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

    for (const walker of this.walkers.values()) {
      walker.rig.dispose();
    }

    this.effects.dispose();

    for (const item of this.disposables) {
      item.dispose();
    }

    this.walkers.clear();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private material(color: string, roughness = 0.7, extra: Partial<ThreeModule.MeshStandardMaterialParameters> = {}): ThreeModule.MeshStandardMaterial {
    return this.track(new this.THREE.MeshStandardMaterial({ color, roughness, ...extra }));
  }

  /** Claro del bosque: cesped, un circulo de tierra donde se ponen los jugadores, arboles y piedras alrededor. */
  private buildClearing(): void {
    const T = this.THREE;
    this.scene.add(new T.HemisphereLight(0xffffff, 0x4a7a3a, 1.35));
    const sun = new T.DirectionalLight(0xfff1d6, 1.3);
    sun.position.set(6, 12, 8);
    this.scene.add(sun);

    const grass = new T.Mesh(this.track(new T.CircleGeometry(60, 48)), this.material('#6cbf4a', 0.95));
    grass.rotation.x = -Math.PI / 2;
    this.scene.add(grass);

    const dirt = new T.Mesh(this.track(new T.CircleGeometry(1, 48)), this.material('#c9a46a', 1));
    dirt.rotation.x = -Math.PI / 2;
    dirt.position.y = 0.004;
    dirt.scale.setScalar(this.radius + 1.4);
    this.scene.add(dirt);

    // Arboles y piedras alrededor (siempre en el mismo sitio).
    const trunk = this.material('#7a4f2c', 0.8);
    const leaves = [this.material('#3f8f3a', 0.8), this.material('#4fa346', 0.8), this.material('#2f7a33', 0.8)];
    const stone = this.material('#9a9a94', 0.9);
    const trunkGeometry = this.track(new T.CylinderGeometry(0.18, 0.26, 1.6, 8));
    const crownGeometry = this.track(new T.IcosahedronGeometry(1.2, 0));
    const rockGeometry = this.track(new T.DodecahedronGeometry(0.45, 0));

    for (let index = 0; index < 22; index += 1) {
      const angle = (index / 22) * Math.PI * 2 + Math.sin(index * 12.9) * 0.12;
      const distance = this.radius + 8 + ((index * 37) % 7);
      const tree = new T.Group();
      const stem = new T.Mesh(trunkGeometry, trunk);
      stem.position.y = 0.8;
      const crown = new T.Mesh(crownGeometry, leaves[index % leaves.length]);
      crown.position.y = 2.3;
      crown.scale.set(1, 1.15 + (index % 3) * 0.15, 1);
      tree.add(stem, crown);
      tree.position.set(Math.sin(angle) * distance, 0, Math.cos(angle) * distance);
      tree.scale.setScalar(0.9 + (index % 4) * 0.18);
      this.scene.add(tree);
    }

    for (let index = 0; index < 9; index += 1) {
      const angle = (index / 9) * Math.PI * 2 + 0.4;
      const rock = new T.Mesh(rockGeometry, stone);
      const distance = this.radius + 3.5 + (index % 3);
      rock.position.set(Math.sin(angle) * distance, 0.15, Math.cos(angle) * distance);
      rock.rotation.set(index, index * 2, 0);
      rock.scale.setScalar(0.6 + (index % 3) * 0.3);
      this.scene.add(rock);
    }
  }

  /** Bomba de dibujo animado: bola negra, boquilla y mecha con una chispa en la punta. */
  private buildBomb(): BombModel {
    const T = this.THREE;
    const group = new T.Group();
    const shell = new T.Mesh(this.track(new T.SphereGeometry(BOMB_RADIUS, 28, 20)), this.material('#1f2228', 0.3, { metalness: 0.4 }));
    const shine = new T.Mesh(this.track(new T.SphereGeometry(0.05, 12, 8)), this.track(new T.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55 })));
    shine.position.set(-0.08, 0.1, 0.13);
    const cap = new T.Mesh(this.track(new T.CylinderGeometry(0.065, 0.075, 0.08, 16)), this.material('#8a8f99', 0.35, { metalness: 0.7 }));
    cap.position.y = BOMB_RADIUS + 0.02;
    const curve = new T.CatmullRomCurve3([
      new T.Vector3(0, BOMB_RADIUS + 0.05, 0),
      new T.Vector3(0.03, BOMB_RADIUS + 0.13, 0.01),
      new T.Vector3(0.09, BOMB_RADIUS + 0.18, 0.02),
      new T.Vector3(0.14, BOMB_RADIUS + 0.17, 0.02),
    ]);
    const fuse = new T.Mesh(this.track(new T.TubeGeometry(curve, 16, 0.014, 8, false)), this.material('#d9c39a', 0.9));
    const spark = new T.Mesh(this.track(new T.SphereGeometry(0.04, 10, 8)), this.track(new T.MeshBasicMaterial({ color: '#ffe066' })));
    spark.position.set(0.14, BOMB_RADIUS + 0.17, 0.02);
    const light = new T.PointLight(0xffb030, 1.2, 2.2, 2);
    light.position.copy(spark.position);
    group.add(shell, shine, cap, fuse, spark, light);
    group.visible = false;
    return { group, spark, light };
  }

  private createWalker(view: BombPlayerView, enterAt: number, proxyBase: string): void {
    const T = this.THREE;
    const holder = new T.Group();
    // Pivote en la cadera (para las voladuras) y el Mii colgado por debajo.
    const flier = new T.Group();
    flier.position.y = BLAST_STAND_Y;
    const offset = new T.Group();
    offset.position.y = -BLAST_STAND_Y;
    const rig = new MiiRig(T, view.shirt);
    rig.enter(enterAt);
    offset.add(rig.root);
    flier.add(offset);
    holder.add(flier);
    this.scene.add(holder);

    void createFaceTexture(T, view.avatarUrl, view.name, proxyBase).then((texture) => {
      if (this.disposed) {
        texture.dispose();
        return;
      }

      rig.setFaceTexture(texture);
    });

    const walker: Walker = {
      view,
      holder,
      flier,
      rig,
      parts: null,
      target: new T.Vector3(),
      dead: false,
      deadAt: 0,
      deadRound: 0,
      variant: 0,
      impacts: [],
      fadeAt: 0,
    };
    rig.poseOverride = (parts) => {
      walker.parts = parts;
      this.applyPose(walker, parts);
    };
    this.walkers.set(view.playerId, walker);
  }

  /** Reparte a los vivos por el circulo (en el orden de la partida) mirando al centro. */
  private layout(state: BombSceneState, instant: boolean): void {
    this.layoutRound = state.round;
    const alive = state.order.filter((playerId) => state.alive.includes(playerId));
    const count = Math.max(1, alive.length);
    const radius = Math.max(MIN_RADIUS, (SEAT_GAP * count) / (Math.PI * 2));

    alive.forEach((playerId, index) => {
      const walker = this.walkers.get(playerId);

      if (!walker) {
        return;
      }

      const angle = (index / count) * Math.PI * 2;
      walker.target.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);

      if (instant) {
        walker.holder.position.copy(walker.target);
        walker.holder.rotation.y = Math.atan2(-walker.target.x, -walker.target.z);
      }
    });

    // Los caidos en rondas anteriores se desvanecen (dejando la sangre en el suelo).
    for (const walker of this.walkers.values()) {
      if (walker.dead && walker.deadRound < state.round && !walker.fadeAt) {
        walker.fadeAt = performance.now();
      }
    }
  }

  /* --------------------------------- Bomba --------------------------------- */

  /** Donde quedan las manos de un jugador que sujeta la bomba (delante del pecho). */
  private handsOf(walker: Walker | undefined, target: Vector3): Vector3 {
    if (!walker) {
      return target.set(0, HANDS_HEIGHT, 0);
    }

    const position = walker.holder.position;
    const facing = walker.holder.rotation.y;
    return target.set(position.x + Math.sin(facing) * HANDS_FORWARD, HANDS_HEIGHT, position.z + Math.cos(facing) * HANDS_FORWARD);
  }

  /** Progreso del pase actual (0..1), o null si no hay pase. */
  private passProgress(now: number): number | null {
    const state = this.state;

    if (state.stage !== 'passing' || !state.holderId) {
      return null;
    }

    return clamp01((now - state.passStartsAt) / Math.max(1, state.passEndsAt - state.passStartsAt));
  }

  private updateBomb(now: number): void {
    const state = this.state;
    const group = this.bomb.group;
    const holder = state.holderId ? this.walkers.get(state.holderId) : undefined;
    const exploded = Boolean(state.boom && now >= state.boom.at);
    group.visible = Boolean(holder) && !exploded && state.stage !== 'intro' && state.stage !== 'finished';

    if (!group.visible || !holder) {
      return;
    }

    const progress = this.passProgress(now);
    const hands = this.handsOf(holder, new this.THREE.Vector3());
    group.scale.setScalar(1);
    group.rotation.set(0, 0, 0);

    if (progress !== null && state.fromId) {
      // Lanzamiento en parabola de unas manos a otras, girando.
      const from = this.handsOf(this.walkers.get(state.fromId), new this.THREE.Vector3());
      const height = 1 + from.distanceTo(hands) * 0.22;
      group.position.lerpVectors(from, hands, progress);
      group.position.y += Math.sin(Math.PI * progress) * height;
      group.rotation.set(progress * 7, 0, progress * 4);

      if (!this.handled.has(`throw:${state.passStartsAt}`)) {
        this.handled.add(`throw:${state.passStartsAt}`);
        this.onSound?.('throw');
      }

      if (progress >= 1 && !this.handled.has(`catch:${state.passStartsAt}`)) {
        this.handled.add(`catch:${state.passStartsAt}`);
        this.onSound?.('catch');
      }

      return;
    }

    group.position.copy(hands);

    if (progress !== null) {
      // Aparece en las manos con un "pop" al empezar la ronda.
      const pop = clamp01((now - state.passStartsAt) / 450);
      group.scale.setScalar(Math.max(0.001, pop < 1 ? Math.sin(pop * Math.PI * 0.75) * 1.25 : 1));

      if (!this.handled.has(`spawn:${state.passStartsAt}`)) {
        this.handled.add(`spawn:${state.passStartsAt}`);
        this.onSound?.('spawn');
      }
    } else if (state.stage === 'typing' || state.stage === 'boom') {
      // Tiembla un poco en las manos mientras se escribe.
      group.position.x += Math.sin(now / 37) * 0.012;
      group.position.y += Math.sin(now / 53) * 0.01;
      group.rotation.z = Math.sin(now / 90) * 0.08;
    }

    // Chispa de la mecha que parpadea.
    const flicker = 0.7 + Math.random() * 0.6;
    this.bomb.spark.scale.setScalar(flicker);
    this.bomb.light.intensity = 1.1 * flicker;
  }

  /* --------------------------------- Posturas -------------------------------- */

  private applyPose(walker: Walker, parts: MiiParts): void {
    const now = performance.now();

    if (walker.dead) {
      if (now >= walker.deadAt) {
        applyBlastPose(walker.flier, parts, sampleBlast(walker.variant, (now - walker.deadAt) / 1000));
      }

      return;
    }

    const state = this.state;
    const id = walker.view.playerId;
    const progress = this.passProgress(now);
    let hold = 0;
    let lift = 0;

    if (id === state.holderId) {
      if (progress === null) {
        hold = state.stage === 'typing' || state.stage === 'boom' ? 1 : 0;
      } else if (!state.fromId) {
        hold = ease(progress * 3);
      } else {
        // Va estirando los brazos para cogerla al vuelo.
        hold = ease((progress - 0.35) / 0.5);
      }
    } else if (id === state.fromId && progress !== null) {
      // Lanza: los brazos suben de golpe y vuelven abajo.
      hold = 1 - ease(progress / 0.45);
      lift = Math.sin(Math.PI * clamp01(progress / 0.4));
    }

    if (hold <= 0 && lift <= 0) {
      return;
    }

    const tremble = id === state.holderId && state.stage === 'typing' ? Math.sin(now / 41) * 0.03 : 0;
    parts.armLeft.rotation.set(HOLD_ARM_X * hold - 1.1 * lift + tremble, 0, -0.16 + (HOLD_ARM_Z + 0.16) * hold);
    parts.armRight.rotation.set(HOLD_ARM_X * hold - 1.1 * lift - tremble, 0, 0.16 - (HOLD_ARM_Z + 0.16) * hold);
    parts.head.rotation.x = 0.18 * hold;
    parts.body.rotation.x += 0.08 * hold;
  }

  private updateWalker(walker: Walker, now: number, time: number, delta: number): void {
    const holder = walker.holder;
    let moving = false;

    if (walker.fadeAt) {
      const fade = (now - walker.fadeAt) / CORPSE_FADE_MS;
      holder.scale.setScalar(Math.max(0.001, 1 - ease(fade)));
      holder.visible = fade < 1;

      if (fade >= 1) {
        return;
      }
    }

    if (!walker.dead) {
      const distance = holder.position.distanceTo(walker.target);

      if (distance > 0.02) {
        const step = Math.min(distance, WALK_SPEED * delta);
        this.scratch.subVectors(walker.target, holder.position).normalize();
        holder.position.addScaledVector(this.scratch, step);
        holder.rotation.y = Math.atan2(this.scratch.x, this.scratch.z);
        moving = true;
      } else {
        // En su sitio: mirando al centro del circulo.
        const facing = Math.atan2(-holder.position.x, -holder.position.z);
        let turn = facing - holder.rotation.y;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        holder.rotation.y += turn * Math.min(1, delta * 7);
      }
    }

    const state = this.state;
    let mood: MiiMood = 'idle';

    if (walker.dead) {
      mood = 'idle';
    } else if (moving) {
      mood = 'walk';
    } else if (state.stage === 'finished' && state.alive.includes(walker.view.playerId)) {
      mood = 'happy';
    } else if (state.stage === 'typing' && walker.view.playerId !== state.holderId) {
      // Los demas, nerviosos mirando la bomba.
      mood = 'look-up';
    }

    walker.rig.mood = mood;
    walker.rig.update(time, delta, 'game');

    if (walker.dead) {
      this.updateCorpse(walker, now);
    }
  }

  /** Explosion, reguero de sangre en el vuelo y charcos donde golpea el suelo. */
  private updateCorpse(walker: Walker, now: number): void {
    const elapsed = (now - walker.deadAt) / 1000;
    const key = `${walker.view.playerId}:${walker.deadRound}`;

    if (elapsed < 0) {
      return;
    }

    if (!this.handled.has(`boom:${key}`)) {
      this.handled.add(`boom:${key}`);
      const T = this.THREE;
      const at = this.handsOf(walker, new T.Vector3());
      const facing = walker.holder.rotation.y;
      const backward = new T.Vector3(-Math.sin(facing), 0, -Math.cos(facing));
      this.effects.explode(at, now, 1);
      this.effects.bloodBurst(at.clone().setY(1.1), backward, 320);
      // Tambien salpica hacia el centro (hacia los demas).
      this.effects.bloodBurst(at.clone().setY(1.0), backward.clone().negate(), 90);
      this.shakeUntil = now + 900;
      this.onSound?.('boom');
    }

    const body = walker.flier.getWorldPosition(this.scratch);

    if (elapsed < BLOOD_TRAIL_S) {
      this.effects.bloodTrail(body, 3);
    }

    walker.impacts.forEach((impact, index) => {
      if (elapsed >= impact && !this.handled.has(`hit:${key}:${index}`)) {
        this.handled.add(`hit:${key}:${index}`);
        this.effects.pool(body.x, body.z, index === walker.impacts.length - 1 ? 1.5 : 0.6, index === walker.impacts.length - 1 ? 2400 : 300);
        this.onSound?.('thud');
      }
    });
  }

  /* --------------------------------- Camara --------------------------------- */

  private seatsFit(): Vector3[] {
    const T = this.THREE;
    const points: Vector3[] = [];
    const radius = Math.max(MIN_RADIUS, this.radiusFor(this.state));

    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2;
      points.push(new T.Vector3(Math.sin(angle) * (radius + 0.5), 0, Math.cos(angle) * (radius + 0.5)));
      points.push(new T.Vector3(Math.sin(angle) * radius, 2.1, Math.cos(angle) * radius));
    }

    return points;
  }

  private radiusFor(state: BombSceneState): number {
    const alive = Math.max(1, state.order.filter((playerId) => state.alive.includes(playerId)).length);
    return Math.max(MIN_RADIUS, (SEAT_GAP * alive) / (Math.PI * 2));
  }

  /** Vuelta alrededor del circulo (al empezar y al final). */
  private orbitGoal(now: number): CameraGoal {
    const T = this.THREE;
    const angle = now / 1000 * 0.55;
    return {
      target: new T.Vector3(0, 0.9, 0),
      direction: new T.Vector3(Math.sin(angle), 0.62, Math.cos(angle)).normalize(),
      fit: this.seatsFit(),
      margin: 0.9,
    };
  }

  /** Desde detras del circulo, enfrente de quien tiene la bomba (se le ve la cara) y con todo el circulo. */
  private holderGoal(playerId: string, wide: boolean): CameraGoal {
    const T = this.THREE;
    const walker = this.walkers.get(playerId);
    const spot = walker ? walker.target.clone() : new T.Vector3(0, 0, 1);
    const out = spot.clone().setY(0);

    if (out.lengthSq() < 0.001) {
      out.set(0, 0, 1);
    }

    out.normalize();
    const fit = this.seatsFit();

    if (wide) {
      // Hueco para la voladura hacia atras.
      fit.push(spot.clone().addScaledVector(out, 6.2), spot.clone().addScaledVector(out, 6).setY(2.4));
    }

    return {
      target: out.clone().multiplyScalar(this.radiusFor(this.state) * (wide ? 0.9 : 0.35)).setY(0.95),
      direction: new T.Vector3(-out.x * 0.78, 0.6, -out.z * 0.78).normalize(),
      fit,
      margin: 0.92,
    };
  }

  private updateCamera(now: number): void {
    const state = this.state;

    if (state.stage === 'intro' || now < state.orbitEndsAt || state.stage === 'finished') {
      this.director.focus(state.stage === 'finished' ? 'final' : 'orbit', () => this.orbitGoal(now), now, { durationMs: 1600 });
    } else if (state.stage === 'boom' && state.boom) {
      const playerId = state.boom.playerId;
      this.director.focus(`boom:${state.boom.round}`, () => this.holderGoal(playerId, true), now, { durationMs: 700 });
    } else if (state.holderId) {
      const playerId = state.holderId;
      this.director.focus(`holder:${playerId}`, () => this.holderGoal(playerId, false), now, { durationMs: 900 });
    }
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const time = now / 1000;

    for (const walker of this.walkers.values()) {
      this.updateWalker(walker, now, time, delta);
    }

    this.updateBomb(now);
    this.effects.update(now, delta);
    this.updateCamera(now);
    this.director.update(now, delta);

    // Temblor de camara con la explosion.
    if (now < this.shakeUntil) {
      const strength = ((this.shakeUntil - now) / 900) * 0.25;
      this.camera.position.x += Math.sin(now * 0.09) * strength;
      this.camera.position.y += Math.cos(now * 0.11) * strength;
    }

    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  /** Nombre bajo los pies de cada Mii (los caidos, sin nombre). */
  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-bb-label]'))) {
      const walker = this.walkers.get(label.dataset['bbLabel'] || '');

      if (!walker || walker.dead) {
        label.style.opacity = '0';
        continue;
      }

      const vector = this.scratch.copy(walker.holder.position).project(this.camera);
      const visible = vector.z < 1 && Math.abs(vector.x) < 1.02 && Math.abs(vector.y) < 1.02;
      label.style.opacity = visible ? '1' : '0';
      label.style.transform = `translate(${((vector.x + 1) / 2) * width}px, ${((1 - vector.y) / 2) * height}px) translate(-50%, 4px)`;
    }
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
