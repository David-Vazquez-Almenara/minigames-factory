import type * as ThreeModule from 'three';
import { MiiMood, MiiRig, createFaceTexture } from '../../../../shared/components/mii-stage/mii-rig';
import { SWING_PIVOT, SWING_ROPE, SwingLaunch, swingAngleAt, swingFlightPoint, swingLaunch } from './swing-physics';

type Three = typeof ThreeModule;

// Vista lateral: el salto va hacia +x y la camara mira desde +z. Plataforma en lo alto del arbol (x <= 0).
const PLATFORM_TOP = 6.6;
const PLATFORM_FRONT = 0.6;
const QUEUE_X = [-0.3, -1.25, -2.2, -3.15];
// Donde se agarra a la cuerda (al borde de la plataforma).
const GRAB_X = 0.7;
export const SWING_QUEUE_SIZE = QUEUE_X.length;
// Altura de las manos sobre los pies con los brazos arriba (para colgar al Mii de la cuerda).
const HANG_DROP = 1.85;
const WALK_SPEED = 2.6;
const FOV = 45;

export interface SwingPlayerView {
  playerId: string;
  name: string;
  avatarUrl: string;
  shirt: string;
  isLocal: boolean;
}

export interface SwingSceneState {
  order: string[];
  turnIndex: number;
  stage: 'walking' | 'swinging' | 'flying' | 'finished';
  /** Inicio del balanceo del turno (reloj performance.now). */
  swingStartsAt: number | null;
  periodMs: number;
  /** Saltos conocidos, con el instante local en que empezo el vuelo (-Infinity = ya aterrizado al cargar). */
  jumps: Array<{ playerId: string; angle: number; dir: 1 | -1; distance: number; startedAt: number }>;
}

type Mode = 'queue' | 'to-rope' | 'rope' | 'flying' | 'landed';

interface Jumper {
  view: SwingPlayerView;
  holder: ThreeModule.Group;
  facer: ThreeModule.Group;
  rig: MiiRig;
  mode: Mode;
  launch: SwingLaunch | null;
  flightStartedAt: number;
  landedAt: number;
  landZ: number;
}

/**
 * Escena 3D de "Salto con cuerda": campo con marcas de distancia, un arbol con una plataforma arriba y una cuerda
 * colgando de una rama. La fila de la plataforma muestra al de la cuerda y a los cuatro siguientes; quien ya ha
 * saltado se queda en el suelo donde ha caido. La camara sigue el turno y luego se aleja para ver a todos.
 */
export class SwingScene {
  private readonly renderer: ThreeModule.WebGLRenderer;
  private readonly scene: ThreeModule.Scene;
  private readonly camera: ThreeModule.PerspectiveCamera;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly jumpers = new Map<string, Jumper>();
  private readonly views: Map<string, SwingPlayerView>;
  private readonly rope: ThreeModule.Mesh;
  private readonly scratch: ThreeModule.Vector3;
  private readonly cameraTarget: ThreeModule.Vector3;
  private cameraDistance = 16;
  private state: SwingSceneState;
  private ropeAngle = 0;
  private frameHandle = 0;
  private lastFrame = performance.now();
  private disposed = false;

  /** Avisos para los sonidos: al soltarse y al aterrizar. */
  onRelease?: (playerId: string) => void;
  onLand?: (playerId: string, distance: number) => void;

  constructor(
    private readonly THREE: Three,
    canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly labelLayer: HTMLElement,
    views: SwingPlayerView[],
    state: SwingSceneState,
    private readonly proxyBase: string,
  ) {
    const T = THREE;
    this.state = state;
    this.views = new Map(views.map((view) => [view.playerId, view]));
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.background = new T.Color('#9ed8ff');
    this.scene.fog = new T.Fog('#9ed8ff', 70, 160);
    this.camera = new T.PerspectiveCamera(FOV, 1, 0.1, 300);
    this.scratch = new T.Vector3();
    this.cameraTarget = new T.Vector3(0, 8, 0);

    this.scene.add(new T.HemisphereLight(0xffffff, 0x7fb069, 1.5));
    const sun = new T.DirectionalLight(0xfff2d6, 1.4);
    sun.position.set(8, 20, 12);
    this.scene.add(sun);

    this.buildWorld();
    this.rope = new T.Mesh(this.track(new T.CylinderGeometry(0.04, 0.04, 1, 8)), this.track(new T.MeshStandardMaterial({ color: '#b98a4e', roughness: 0.9 })));
    this.scene.add(this.rope);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.sync(state);
    this.loop();
  }

  sync(state: SwingSceneState): void {
    if (this.disposed) {
      return;
    }

    this.state = state;
    const now = performance.now();
    const jumped = new Map(state.jumps.map((jump) => [jump.playerId, jump]));
    const current = state.order[state.turnIndex];

    // Quien ya ha saltado: en el aire o en el suelo donde cayo.
    for (const jump of state.jumps) {
      const jumper = this.ensureJumper(jump.playerId);

      if (!jumper || jumper.launch) {
        continue;
      }

      jumper.launch = swingLaunch(jump.angle, jump.dir);
      jumper.flightStartedAt = jump.startedAt;
      jumper.mode = 'flying';
      jumper.landZ = ((state.jumps.indexOf(jump) % 3) - 1) * 0.9;

      if (Number.isFinite(jump.startedAt)) {
        this.onRelease?.(jump.playerId);
      }
    }

    // Fila de la plataforma: el de la cuerda y los cuatro siguientes (los demas aun no se ven).
    const waiting = state.order.slice(state.turnIndex + (current && !jumped.has(current) ? 1 : 0)).filter((id) => !jumped.has(id)).slice(0, SWING_QUEUE_SIZE);
    waiting.forEach((playerId, slot) => {
      const jumper = this.ensureJumper(playerId);

      if (jumper && jumper.mode === 'queue') {
        jumper.holder.userData['slot'] = slot;
      }
    });

    // El del turno camina hasta la cuerda (o ya esta colgado si se entra con el turno empezado).
    if (current && !jumped.has(current) && state.stage !== 'finished') {
      const jumper = this.ensureJumper(current);

      if (jumper && jumper.mode === 'queue') {
        jumper.mode = state.stage === 'swinging' && state.swingStartsAt !== null && now > state.swingStartsAt ? 'rope' : 'to-rope';
      }
    }
  }

  /** Salto del jugador local: arranca al instante con su propio calculo (sin esperar al servidor). */
  launchLocal(playerId: string, angle: number, dir: 1 | -1): void {
    const jumper = this.jumpers.get(playerId);

    if (!jumper || jumper.launch) {
      return;
    }

    jumper.launch = swingLaunch(angle, dir);
    jumper.flightStartedAt = performance.now();
    jumper.mode = 'flying';
    jumper.landZ = ((this.state.jumps.length % 3) - 1) * 0.9;
    this.onRelease?.(playerId);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();

    for (const jumper of this.jumpers.values()) {
      jumper.rig.dispose();
    }

    for (const item of this.disposables) {
      item.dispose();
    }

    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /* ------------------------------ Construccion ------------------------------ */

  private material(color: string, roughness = 0.8): ThreeModule.MeshStandardMaterial {
    return this.track(new this.THREE.MeshStandardMaterial({ color, roughness }));
  }

  private buildWorld(): void {
    const T = this.THREE;

    // Campo de hierba con una franja de tierra donde se cae y marcas cada 5 metros (numeradas cada 10).
    const grass = new T.Mesh(this.track(new T.PlaneGeometry(260, 80)), this.material('#7bc96f', 1));
    grass.rotation.x = -Math.PI / 2;
    grass.position.x = 20;
    this.scene.add(grass);
    const strip = new T.Mesh(this.track(new T.PlaneGeometry(140, 4)), this.material('#d9b77a', 1));
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(15, 0.01, 0);
    this.scene.add(strip);
    const lineGeometry = this.track(new T.PlaneGeometry(0.12, 4));
    const lineMaterial = this.material('#ffffff', 0.6);

    for (let meter = -50; meter <= 90; meter += 5) {
      const line = new T.Mesh(lineGeometry, meter === 0 ? this.material('#e8262b', 0.6) : lineMaterial);
      line.rotation.x = -Math.PI / 2;
      line.position.set(meter, 0.02, 0);
      this.scene.add(line);

      if (meter % 10 === 0) {
        const sign = new T.Mesh(this.track(new T.PlaneGeometry(1.6, 0.8)), this.track(new T.MeshBasicMaterial({ map: this.numberTexture(`${meter} m`), transparent: true })));
        sign.position.set(meter, 0.5, 2.4);
        this.scene.add(sign);
      }
    }

    // Arbol: tronco, copa y una rama larga de la que cuelga la cuerda; diana pintada en el tronco.
    const bark = this.material('#7a4b2a', 0.9);
    const trunk = new T.Mesh(this.track(new T.CylinderGeometry(0.55, 0.8, 16, 14)), bark);
    trunk.position.set(-2, 8, -1.6);
    this.scene.add(trunk);
    const leaves = this.material('#3f9b45', 0.9);

    for (const [x, y, z, radius] of [
      [-2, 16.5, -1.6, 3.2],
      [0.5, 15.6, -1.4, 2.4],
      [-4.4, 15.4, -1.8, 2.4],
      [-2, 14.6, 0.2, 2],
    ]) {
      const ball = new T.Mesh(this.track(new T.SphereGeometry(radius, 16, 12)), leaves);
      ball.position.set(x, y, z);
      this.scene.add(ball);
    }

    const branch = new T.Mesh(this.track(new T.CylinderGeometry(0.18, 0.28, 1, 10)), bark);
    const from = new T.Vector3(-2, 14.2, -1.4);
    const to = new T.Vector3(SWING_PIVOT.x + 0.6, SWING_PIVOT.y + 0.15, 0);
    branch.scale.y = from.distanceTo(to);
    branch.position.copy(from).add(to).multiplyScalar(0.5);
    branch.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    this.scene.add(branch);

    const target = new T.Group();

    for (const [radius, color] of [
      [0.6, '#ffffff'],
      [0.45, '#e8262b'],
      [0.3, '#ffffff'],
      [0.15, '#e8262b'],
    ] as Array<[number, string]>) {
      const ring = new T.Mesh(this.track(new T.CircleGeometry(radius, 24)), this.material(color, 0.6));
      ring.position.z = (0.6 - radius) * 0.02;
      target.add(ring);
    }

    target.position.set(-2, 3.2, -0.88);
    this.scene.add(target);

    // Plataforma de madera con barandilla, escalera y patas.
    const wood = this.material('#b07a45', 0.85);
    const platform = new T.Mesh(this.track(new T.BoxGeometry(PLATFORM_FRONT + 4.6, 0.3, 2)), wood);
    platform.position.set((PLATFORM_FRONT - 4.6) / 2, PLATFORM_TOP - 0.15, 0);
    this.scene.add(platform);
    const rail = new T.Mesh(this.track(new T.BoxGeometry(4.6, 0.08, 0.08)), wood);
    rail.position.set(-2, PLATFORM_TOP + 1, -0.95);
    this.scene.add(rail);

    for (const x of [-4.3, 0.3]) {
      const leg = new T.Mesh(this.track(new T.CylinderGeometry(0.12, 0.12, PLATFORM_TOP, 8)), wood);
      leg.position.set(x, PLATFORM_TOP / 2, 0.8);
      this.scene.add(leg);
    }

    // Unas colinas y nubes de fondo.
    for (const [x, radius] of [
      [-30, 18],
      [10, 24],
      [55, 20],
    ]) {
      const hill = new T.Mesh(this.track(new T.SphereGeometry(radius, 20, 12)), this.material('#5fb35a', 1));
      hill.position.set(x, -radius * 0.55, -45);
      this.scene.add(hill);
    }
  }

  private numberTexture(text: string): ThreeModule.CanvasTexture {
    const T = this.THREE;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'rgba(255,247,236,0.92)';
    context.fillRect(6, 10, 116, 44);
    context.strokeStyle = '#000';
    context.lineWidth = 4;
    context.strokeRect(6, 10, 116, 44);
    context.fillStyle = '#000';
    context.font = 'bold 30px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 64, 33);
    const texture = this.track(new T.CanvasTexture(canvas));
    texture.colorSpace = T.SRGBColorSpace;
    return texture;
  }

  private ensureJumper(playerId: string): Jumper | null {
    const existing = this.jumpers.get(playerId);

    if (existing) {
      return existing;
    }

    const view = this.views.get(playerId);

    if (!view) {
      return null;
    }

    const T = this.THREE;
    const holder = new T.Group();
    const facer = new T.Group();
    const rig = new MiiRig(T, view.shirt);
    rig.enter(performance.now() / 1000);
    facer.add(rig.root);
    holder.add(facer);
    // Aparece al final de la fila (los que ya estaban avanzan un puesto).
    holder.position.set(QUEUE_X[QUEUE_X.length - 1] - 0.8, PLATFORM_TOP, 0.2);
    holder.userData['slot'] = QUEUE_X.length - 1;
    this.scene.add(holder);

    void createFaceTexture(T, view.avatarUrl, view.name, this.proxyBase).then((texture) => {
      if (this.disposed) {
        texture.dispose();
        return;
      }

      rig.setFaceTexture(texture);
    });

    const jumper: Jumper = { view, holder, facer, rig, mode: 'queue', launch: null, flightStartedAt: 0, landedAt: -Infinity, landZ: 0 };
    this.jumpers.set(playerId, jumper);
    return jumper;
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private updateJumper(jumper: Jumper, now: number, time: number, delta: number): void {
    const { holder, facer, rig } = jumper;
    let mood: MiiMood = 'idle';
    rig.pose = 'stand';
    holder.rotation.z = 0;
    facer.rotation.set(0, Math.PI / 2, 0);
    facer.position.y = 0;

    switch (jumper.mode) {
      case 'queue':
      case 'to-rope': {
        const targetX = jumper.mode === 'to-rope' ? GRAB_X : QUEUE_X[holder.userData['slot'] ?? 0];
        const step = WALK_SPEED * delta;
        const gap = targetX - holder.position.x;
        holder.position.y = PLATFORM_TOP;
        holder.position.z = 0.2;

        if (Math.abs(gap) > 0.02) {
          holder.position.x += Math.sign(gap) * Math.min(step, Math.abs(gap));
          mood = 'walk';
        } else if (jumper.mode === 'to-rope') {
          // Agarra la cuerda en cuanto empieza su balanceo.
          const startsAt = this.state.swingStartsAt;
          mood = 'hang';

          if (startsAt !== null && now >= startsAt && this.state.stage !== 'walking') {
            jumper.mode = 'rope';
          }
        }

        break;
      }
      case 'rope': {
        // Colgado del extremo de la cuerda, siguiendo el balanceo comun.
        const startsAt = this.state.swingStartsAt ?? now;
        const { angle } = swingAngleAt(Math.max(0, now - startsAt), this.state.periodMs);
        const radians = (angle * Math.PI) / 180;
        this.ropeAngle = radians;
        // El holder esta en las manos (extremo de la cuerda) y el cuerpo cuelga por debajo, alineado con ella.
        holder.position.set(SWING_PIVOT.x + SWING_ROPE * Math.sin(radians), SWING_PIVOT.y - SWING_ROPE * Math.cos(radians), 0);
        holder.rotation.z = radians;
        facer.position.y = -HANG_DROP;
        mood = 'hang';
        break;
      }
      case 'flying': {
        const launch = jumper.launch!;
        const elapsed = (now - jumper.flightStartedAt) / 1000;

        if (!Number.isFinite(jumper.flightStartedAt) || elapsed >= launch.flightMs / 1000) {
          jumper.mode = 'landed';
          jumper.landedAt = Number.isFinite(jumper.flightStartedAt) ? now : -Infinity;

          if (Number.isFinite(jumper.flightStartedAt)) {
            this.onLand?.(jumper.view.playerId, launch.distance);
          }

          break;
        }

        const point = swingFlightPoint(launch, elapsed);
        // Da vueltas en el aire alrededor de su centro (sin atravesar el suelo al llegar).
        facer.position.y = -HANG_DROP / 2;
        holder.position.set(point.x, Math.max(HANG_DROP / 2, point.y - HANG_DROP / 2), jumper.landZ * Math.min(1, elapsed));
        holder.rotation.z = -elapsed * 4 * Math.sign(launch.vx || 1);
        mood = 'fly';
        break;
      }
      case 'landed': {
        holder.position.set(jumper.launch?.distance ?? 0, 0, jumper.landZ);
        // De cara a la camara, sentado en el suelo; mareado un momento y luego contento (o triste si va hacia atras).
        facer.rotation.set(0, 0, 0);
        rig.pose = 'ground-sit';
        mood = now - jumper.landedAt < 1600 ? 'dizzy' : (jumper.launch?.distance ?? 0) < 0 ? 'sad' : 'happy';
        break;
      }
    }

    rig.mood = mood;
    rig.update(time, delta, 'game');
  }

  private updateRope(now: number): void {
    // Sin nadie colgado, la cuerda vuelve poco a poco al centro.
    const hanging = [...this.jumpers.values()].some((jumper) => jumper.mode === 'rope');

    if (!hanging) {
      this.ropeAngle *= Math.max(0, 1 - 0.04);
      this.ropeAngle = Math.abs(this.ropeAngle) < 0.001 ? Math.sin(now / 900) * 0.03 : this.ropeAngle;
    }

    const endX = SWING_PIVOT.x + SWING_ROPE * Math.sin(this.ropeAngle);
    const endY = SWING_PIVOT.y - SWING_ROPE * Math.cos(this.ropeAngle);
    this.rope.position.set((SWING_PIVOT.x + endX) / 2, (SWING_PIVOT.y + endY) / 2, 0);
    this.rope.scale.y = SWING_ROPE;
    this.rope.rotation.z = this.ropeAngle;
  }

  /** Camara lateral: sigue al del turno, le acompana en el vuelo y despues se aleja para que se vea a todos. */
  private updateCamera(now: number, delta: number): void {
    const flying = [...this.jumpers.values()].find((jumper) => jumper.mode === 'flying' && Number.isFinite(jumper.flightStartedAt));
    const justLanded = [...this.jumpers.values()].some((jumper) => jumper.mode === 'landed' && now - jumper.landedAt < 450);
    let targetX = 0.5;
    let targetY = 9.2;
    let distance = 12.5;

    if (flying) {
      targetX = flying.holder.position.x;
      targetY = Math.max(4, flying.holder.position.y + 1);
      distance = 17;
    } else if (justLanded) {
      const landed = [...this.jumpers.values()].find((jumper) => jumper.mode === 'landed' && now - jumper.landedAt < 450)!;
      targetX = landed.holder.position.x;
      targetY = 3;
      distance = 14;
    } else if (this.state.stage === 'flying' || this.state.stage === 'finished' || this.state.stage === 'walking') {
      // Vista general: desde el mas atrasado hasta el mas lejano (y el arbol).
      const xs = [...this.jumpers.values()].filter((jumper) => jumper.mode === 'landed').map((jumper) => jumper.holder.position.x);

      if (xs.length && (this.state.stage !== 'walking' || now - Math.max(...[...this.jumpers.values()].map((jumper) => jumper.landedAt)) < 2500)) {
        const minX = Math.min(-5, ...xs) - 3;
        const maxX = Math.max(3, ...xs) + 3;
        targetX = (minX + maxX) / 2;
        targetY = 6;
        const horizontalFov = 2 * Math.atan(Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect);
        distance = Math.max(18, (maxX - minX) / 2 / Math.tan(horizontalFov / 2));
      }
    }

    const follow = Math.min(1, delta * (flying ? 6 : 2.2));
    this.cameraTarget.x += (targetX - this.cameraTarget.x) * follow;
    this.cameraTarget.y += (targetY - this.cameraTarget.y) * follow;
    this.cameraDistance += (distance - this.cameraDistance) * follow;
    this.camera.position.set(this.cameraTarget.x, this.cameraTarget.y + this.cameraDistance * 0.18, this.cameraDistance);
    this.camera.lookAt(this.cameraTarget);
  }

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const time = now / 1000;

    for (const jumper of this.jumpers.values()) {
      this.updateJumper(jumper, now, time, delta);
    }

    this.updateRope(now);
    this.updateCamera(now, delta);
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  private placeLabels(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    for (const label of Array.from(this.labelLayer.querySelectorAll<HTMLElement>('[data-sw-jumper]'))) {
      const jumper = this.jumpers.get(label.dataset['swJumper'] || '');

      if (!jumper) {
        label.style.opacity = '0';
        continue;
      }

      const lift = jumper.mode === 'landed' ? 1.4 : jumper.mode === 'rope' || jumper.mode === 'flying' ? 0.3 : 2.2;
      const vector = this.scratch.copy(jumper.holder.position).setY(jumper.holder.position.y + lift).project(this.camera);
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
    this.camera.fov = width / height < 1 ? 70 : FOV;
    this.camera.updateProjectionMatrix();
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }
}
