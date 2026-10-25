import { JavelinFlight, JavelinMap, flightPoint, speedFor, terrainHeight } from './javelin-course';

// Metros de campo que se ven a lo ancho mientras se apunta (y de alto como minimo).
const VIEW_WIDTH = 30;
const VIEW_HEIGHT = 15;
const JAVELIN_LENGTH = 2.6;
/** Parte de la jabalina que se clava en el suelo. */
const STUCK_DEPTH = 0.35;
/** Del arco de apuntado solo se ve el principio del vuelo (para que haya que calcular). */
const PREVIEW_SECONDS = 0.75;
// Angulos permitidos: siempre hacia delante y nunca en vertical.
const MIN_ANGLE = 0.05;
const MAX_ANGLE = 1.45;
/** Separacion (m) entre los jugadores que esperan detras de la linea. */
const THROWER_GAP = 0.6;

export interface JavelinThrower {
  playerId: string;
  mine: boolean;
  color: string;
  image: HTMLImageElement | null;
}

export interface JavelinShot {
  key: string;
  playerId: string;
  mine: boolean;
  color: string;
  image: HTMLImageElement | null;
  flight: JavelinFlight;
  /** Momento (performance.now) en que sale. */
  startedAt: number;
}

interface Camera {
  x: number;
  y: number;
  scale: number;
}

/**
 * Tablero 2D del Tiro de jabalina: terreno con colinas, la bandera, los jugadores en la linea de lanzamiento y las
 * jabalinas (las propias opacas, las de los demas semitransparentes). Se apunta arrastrando hacia atras.
 */
export class JavelinBoard {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private frameHandle = 0;
  private width = 1;
  private height = 1;
  private map: JavelinMap;
  private flagX = 30;
  private throwers: JavelinThrower[] = [];
  private shots: JavelinShot[] = [];
  private drag: { startX: number; startY: number; x: number; y: number } | null = null;
  private aiming = false;
  private zoomOut = false;
  private camera: Camera = { x: VIEW_WIDTH / 2 - 4, y: 4, scale: 30 };
  private insets = { top: 70, bottom: 110 };
  private lastFrame = performance.now();

  /** Lanzamiento (angulo en radianes y fuerza 0-1) al soltar el arrastre. */
  onThrow?: (angle: number, power: number) => void;
  /** Aviso cuando una jabalina se clava (para el sonido). */
  onLand?: (shot: JavelinShot) => void;
  private readonly landed = new Set<string>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    map: JavelinMap,
  ) {
    this.context = canvas.getContext('2d')!;
    this.map = map;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.camera = this.restCamera();
    canvas.addEventListener('pointerdown', this.pointerDown);
    window.addEventListener('pointermove', this.pointerMove);
    window.addEventListener('pointerup', this.pointerUp);
    this.loop();
  }

  setCourse(map: JavelinMap, flagX: number): void {
    this.map = map;
    this.flagX = flagX;
  }

  setThrowers(throwers: JavelinThrower[]): void {
    this.throwers = throwers;
  }

  setShots(shots: JavelinShot[]): void {
    this.shots = shots;

    // Las que ya estaban clavadas al llegar (p. ej. al recargar) no vuelven a sonar.
    for (const shot of shots) {
      if (performance.now() > shot.startedAt + shot.flight.time * 1000 + 500) {
        this.landed.add(shot.key);
      }
    }
  }

  setAiming(aiming: boolean): void {
    this.aiming = aiming;

    if (!aiming) {
      this.drag = null;
    }
  }

  /** Al final, la camara se aleja para ver todas las jabalinas y la bandera. */
  setZoomOut(zoomOut: boolean): void {
    this.zoomOut = zoomOut;
  }

  setInsets(top: number, bottom: number): void {
    this.insets = { top, bottom };
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    window.removeEventListener('pointermove', this.pointerMove);
    window.removeEventListener('pointerup', this.pointerUp);
  }

  /* --------------------------------- Apuntar -------------------------------- */

  private readonly pointerDown = (event: PointerEvent) => {
    if (!this.aiming) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    this.drag = { startX: x, startY: y, x, y };
    event.preventDefault();
  };

  private readonly pointerMove = (event: PointerEvent) => {
    if (this.drag) {
      const rect = this.canvas.getBoundingClientRect();
      this.drag.x = event.clientX - rect.left;
      this.drag.y = event.clientY - rect.top;
    }
  };

  private readonly pointerUp = () => {
    const shot = this.currentShot();
    this.drag = null;

    if (shot && this.aiming && shot.power > 0.04) {
      this.onThrow?.(shot.angle, shot.power);
    }
  };

  /** Tiro segun el arrastre (como un tirachinas): hacia el lado contrario y con fuerza segun lo largo que sea. */
  private currentShot(): { angle: number; power: number } | null {
    if (!this.drag) {
      return null;
    }

    const dx = this.drag.startX - this.drag.x;
    const dy = this.drag.y - this.drag.startY;
    const length = Math.hypot(dx, dy);
    const maxDrag = Math.max(120, Math.min(this.width, this.height) * 0.38);
    const angle = Math.max(MIN_ANGLE, Math.min(MAX_ANGLE, Math.atan2(dy, Math.max(0.0001, dx))));
    return { angle, power: Math.min(1, length / maxDrag) };
  }

  /* --------------------------------- Camara --------------------------------- */

  /** Camara en reposo: los jugadores a la izquierda y unos 25 m de campo por delante. */
  private restCamera(): Camera {
    const scale = this.baseScale();
    const behind = 1.5 + Math.max(0, this.throwers.length - 1) * THROWER_GAP;
    const span = this.screenSpanMeters(scale);
    const x = span / 2 - behind;
    let sum = 0;

    for (let step = 0; step <= 10; step += 1) {
      sum += terrainHeight(this.map, -behind + (span * step) / 10);
    }

    // Altura media del terreno que se ve (y un poco por encima, para que quepa el lanzador).
    return { x, y: Math.max(sum / 11, -2) + 3, scale };
  }

  private baseScale(): number {
    const usable = Math.max(120, this.height - this.insets.top - this.insets.bottom);
    // En vertical (movil) se ven menos metros a lo ancho para que el lanzador no quede diminuto.
    const viewWidth = this.width < this.height ? VIEW_WIDTH * 0.55 : VIEW_WIDTH;
    return Math.min(this.width / viewWidth, (usable / VIEW_HEIGHT) * 1.6);
  }

  private screenSpanMeters(scale: number): number {
    return this.width / scale;
  }

  private targetCamera(now: number): Camera {
    if (this.zoomOut) {
      return this.zoomCamera();
    }

    // Sigue a la jabalina propia mientras vuela y un poco despues de clavarse.
    const flying = this.shots
      .filter((shot) => shot.mine && now >= shot.startedAt && now < shot.startedAt + shot.flight.time * 1000 + 1100)
      .at(-1);

    if (flying) {
      const t = Math.min(flying.flight.time, (now - flying.startedAt) / 1000);
      const point = flightPoint(flying.flight, t);
      const scale = this.baseScale();
      return { x: Math.max(this.restCamera().x, point.x), y: Math.max(terrainHeight(this.map, point.x) + 2.5, point.y - 1), scale };
    }

    return this.restCamera();
  }

  /** Encuadre final: desde la jabalina mas atrasada hasta la mas lejana (y la bandera). */
  private zoomCamera(): Camera {
    const xs = [this.flagX, ...this.shots.map((shot) => shot.flight.landX)];
    const minX = Math.min(...xs) - 3;
    const maxX = Math.max(...xs) + 3;
    const heights: number[] = [];

    for (let x = minX; x <= maxX; x += 1) {
      heights.push(terrainHeight(this.map, x));
    }

    const minY = Math.min(...heights) - 1;
    const maxY = Math.max(...heights) + 4;
    const usable = Math.max(120, this.height - this.insets.top - this.insets.bottom);
    const scale = Math.min(this.baseScale(), (this.width - 40) / (maxX - minX), usable / (maxY - minY));
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale };
  }

  private toScreen(x: number, y: number): [number, number] {
    const usable = this.height - this.insets.top - this.insets.bottom;
    const centerY = this.insets.top + usable / 2;
    return [(x - this.camera.x) * this.camera.scale + this.width / 2, centerY - (y - this.camera.y) * this.camera.scale];
  }

  private toWorldX(screenX: number): number {
    return (screenX - this.width / 2) / this.camera.scale + this.camera.x;
  }

  /* --------------------------------- Dibujo --------------------------------- */

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const target = this.targetCamera(now);
    const ease = Math.min(1, delta * (this.zoomOut ? 2.2 : 5));
    this.camera = {
      x: this.camera.x + (target.x - this.camera.x) * ease,
      y: this.camera.y + (target.y - this.camera.y) * ease,
      scale: this.camera.scale + (target.scale - this.camera.scale) * ease,
    };
    this.draw(now);
  }

  private draw(now: number): void {
    const context = this.context;
    const ratio = window.devicePixelRatio || 1;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.drawSky(context);
    this.drawTerrain(context);
    this.drawMarkers(context);
    this.drawFlag(context, now);

    // Jabalinas clavadas detras de los jugadores; las que vuelan, delante.
    const stuck = this.shots.filter((shot) => now >= shot.startedAt + shot.flight.time * 1000);
    const flying = this.shots.filter((shot) => now >= shot.startedAt && now < shot.startedAt + shot.flight.time * 1000);

    for (const shot of [...stuck.filter((shot) => !shot.mine), ...stuck.filter((shot) => shot.mine)]) {
      this.drawJavelin(context, shot.flight.landX, shot.flight.landY, shot.flight.landAngle, shot, true);

      if (!this.landed.has(shot.key)) {
        this.landed.add(shot.key);
        this.onLand?.(shot);
      }
    }

    this.drawThrowers(context, now);

    for (const shot of flying) {
      const point = flightPoint(shot.flight, (now - shot.startedAt) / 1000);
      this.drawJavelin(context, point.x, point.y, point.angle, shot, false);
    }

    this.drawAim(context);
  }

  private drawSky(context: CanvasRenderingContext2D): void {
    const gradient = context.createLinearGradient(0, 0, 0, this.height);
    gradient.addColorStop(0, this.map.sky[0]);
    gradient.addColorStop(1, this.map.sky[1]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, this.width, this.height);

    // Montanas lejanas con paralaje (se mueven mas despacio que el terreno).
    const layers: Array<[number, string, number]> = [
      [0.15, 'rgba(90, 110, 150, 0.35)', 0.55],
      [0.35, 'rgba(70, 120, 90, 0.35)', 0.68],
    ];

    for (const [parallax, color, base] of layers) {
      context.fillStyle = color;
      context.beginPath();
      context.moveTo(0, this.height);

      for (let x = 0; x <= this.width + 8; x += 8) {
        const world = (x - this.width / 2) / 30 + this.camera.x * parallax;
        const y = this.height * base - (Math.sin(world * 0.35) * 40 + Math.sin(world * 0.9 + 1.3) * 18 + 30);
        context.lineTo(x, y);
      }

      context.lineTo(this.width, this.height);
      context.closePath();
      context.fill();
    }
  }

  private drawTerrain(context: CanvasRenderingContext2D): void {
    context.beginPath();
    context.moveTo(0, this.height + 10);

    for (let x = -4; x <= this.width + 4; x += 4) {
      const [, y] = this.toScreen(0, terrainHeight(this.map, this.toWorldX(x)));
      context.lineTo(x, y);
    }

    context.lineTo(this.width + 4, this.height + 10);
    context.closePath();
    context.fillStyle = this.map.dirt;
    context.fill();

    // Capa de cesped encima de la tierra.
    context.beginPath();

    for (let x = -4; x <= this.width + 4; x += 4) {
      const [, y] = this.toScreen(0, terrainHeight(this.map, this.toWorldX(x)));
      if (x === -4) context.moveTo(x, y);
      else context.lineTo(x, y);
    }

    context.lineWidth = Math.max(6, this.camera.scale * 0.45);
    context.strokeStyle = this.map.grass;
    context.lineJoin = 'round';
    context.stroke();

    // Linea de lanzamiento.
    const [lineX, lineY] = this.toScreen(0.6, terrainHeight(this.map, 0));
    context.fillStyle = '#ffffff';
    context.fillRect(lineX - 2, lineY - 2, 4, Math.max(6, this.camera.scale * 0.5));
  }

  /** Postes cada 10 m. */
  private drawMarkers(context: CanvasRenderingContext2D): void {
    const step = this.camera.scale < 9 ? 20 : 10;
    const first = Math.max(step, Math.ceil(this.toWorldX(0) / step) * step);

    context.font = `900 ${Math.max(10, Math.min(14, this.camera.scale * 0.5))}px sans-serif`;
    context.textAlign = 'center';

    for (let x = first; x <= Math.min(110, this.toWorldX(this.width)); x += step) {
      const [sx, sy] = this.toScreen(x, terrainHeight(this.map, x));
      const top = sy - Math.max(14, this.camera.scale * 0.9);
      context.fillStyle = 'rgba(255, 255, 255, 0.85)';
      context.fillRect(sx - 1.5, top, 3, sy - top);
      context.fillStyle = 'rgba(0, 0, 0, 0.55)';
      context.fillText(`${x} m`, sx, top - 4);
    }
  }

  private drawFlag(context: CanvasRenderingContext2D, now: number): void {
    const ground = terrainHeight(this.map, this.flagX);
    const [x, y] = this.toScreen(this.flagX, ground);
    const height = Math.max(36, this.camera.scale * 2.6);
    context.strokeStyle = '#3a3a3a';
    context.lineWidth = Math.max(2, this.camera.scale * 0.08);
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x, y - height);
    context.stroke();
    // Bandera roja ondeando.
    const wave = Math.sin(now / 180) * height * 0.06;
    context.fillStyle = '#e8262b';
    context.strokeStyle = '#000';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x, y - height);
    context.quadraticCurveTo(x + height * 0.3, y - height + wave, x + height * 0.55, y - height * 0.84);
    context.quadraticCurveTo(x + height * 0.3, y - height * 0.66 - wave, x, y - height * 0.66);
    context.closePath();
    context.fill();
    context.stroke();
    // Base para que se vea bien clavada en el suelo.
    context.fillStyle = 'rgba(0, 0, 0, 0.25)';
    context.beginPath();
    context.ellipse(x, y, height * 0.16, height * 0.05, 0, 0, Math.PI * 2);
    context.fill();
  }

  /** Jugadores en la linea de lanzamiento: el propio delante (opaco) y el resto detras, semitransparentes. */
  private drawThrowers(context: CanvasRenderingContext2D, now: number): void {
    const others = this.throwers.filter((thrower) => !thrower.mine);
    const mine = this.throwers.find((thrower) => thrower.mine);
    const ground = terrainHeight(this.map, 0);

    others.forEach((thrower, index) => this.drawPerson(context, -1 - index * THROWER_GAP, ground, thrower, 0.45, null));

    if (mine) {
      // Brazo hacia atras mientras se apunta; justo despues de lanzar, hacia delante.
      const shot = this.currentShot();
      const lastMine = this.shots.filter((entry) => entry.mine).at(-1);
      const justThrew = lastMine && now - lastMine.startedAt < 350;
      this.drawPerson(context, 0, ground, mine, 1, shot ? shot.angle : justThrew ? -0.4 : this.aiming ? 0.6 : null);
    }
  }

  private drawPerson(context: CanvasRenderingContext2D, x: number, ground: number, thrower: JavelinThrower, alpha: number, javelinAngle: number | null): void {
    const unit = this.camera.scale;
    const [footX, footY] = this.toScreen(x, ground);
    const bodyHeight = 1.05 * unit;
    const headRadius = 0.34 * unit;
    context.save();
    context.globalAlpha = alpha;
    context.strokeStyle = '#000';
    context.lineWidth = Math.max(2, unit * 0.09);
    context.lineCap = 'round';
    // Piernas.
    context.beginPath();
    context.moveTo(footX - unit * 0.22, footY);
    context.lineTo(footX, footY - unit * 0.7);
    context.lineTo(footX + unit * 0.22, footY);
    context.stroke();
    // Cuerpo (camiseta del color del jugador).
    context.fillStyle = thrower.color;
    context.beginPath();
    context.roundRect(footX - unit * 0.26, footY - unit * 0.7 - bodyHeight * 0.8, unit * 0.52, bodyHeight * 0.85, unit * 0.12);
    context.fill();
    context.stroke();
    // Cabeza con la foto.
    const headY = footY - unit * 0.7 - bodyHeight * 0.8 - headRadius * 0.9;
    this.drawFace(context, footX, headY, headRadius, thrower);

    // Jabalina en la mano mientras queden por lanzar.
    if (javelinAngle !== null) {
      const handX = footX + unit * 0.1;
      const handY = footY - unit * 1.55;
      this.drawShaft(context, handX, handY, javelinAngle, thrower.color, 1);
    }

    context.restore();
  }

  private drawFace(context: CanvasRenderingContext2D, x: number, y: number, radius: number, thrower: Pick<JavelinThrower, 'color' | 'image'>): void {
    context.save();
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = '#ffe0c2';
    context.fill();

    if (thrower.image?.complete && thrower.image.naturalWidth) {
      context.clip();
      context.drawImage(thrower.image, x - radius, y - radius, radius * 2, radius * 2);
    }

    context.restore();
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.strokeStyle = thrower.color;
    context.lineWidth = Math.max(2, radius * 0.22);
    context.stroke();
  }

  /** Vara de la jabalina con el centro en (x, y) y la punta hacia `angle`. */
  private drawShaft(context: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string, scale: number): void {
    const half = (JAVELIN_LENGTH / 2) * this.camera.scale * scale;
    const dx = Math.cos(angle) * half;
    const dy = -Math.sin(angle) * half;
    context.lineCap = 'round';
    context.strokeStyle = '#000';
    context.lineWidth = Math.max(4, this.camera.scale * 0.16);
    context.beginPath();
    context.moveTo(x - dx, y - dy);
    context.lineTo(x + dx, y + dy);
    context.stroke();
    context.strokeStyle = color;
    context.lineWidth = Math.max(2, this.camera.scale * 0.09);
    context.beginPath();
    context.moveTo(x - dx, y - dy);
    context.lineTo(x + dx * 0.78, y + dy * 0.78);
    context.stroke();
    // Punta metalica.
    context.strokeStyle = '#d9dde3';
    context.beginPath();
    context.moveTo(x + dx * 0.78, y + dy * 0.78);
    context.lineTo(x + dx, y + dy);
    context.stroke();
  }

  /** Jabalina volando (centro en x, y) o clavada (punta en x, y). Lleva la foto del jugador en el centro. */
  private drawJavelin(context: CanvasRenderingContext2D, x: number, y: number, angle: number, shot: JavelinShot, stuck: boolean): void {
    let [sx, sy] = this.toScreen(x, y);

    if (stuck) {
      // Desde la punta (algo enterrada) hacia atras.
      const back = (JAVELIN_LENGTH / 2 - STUCK_DEPTH) * this.camera.scale;
      sx -= Math.cos(angle) * back;
      sy += Math.sin(angle) * back;
    }

    context.save();
    context.globalAlpha = shot.mine ? 1 : 0.45;
    this.drawShaft(context, sx, sy, angle, shot.color, 1);
    this.drawFace(context, sx, sy, Math.max(7, this.camera.scale * 0.3), shot);
    context.restore();
  }

  /** Arco de apuntado: solo el principio del vuelo, con puntos que se van haciendo pequenos. */
  private drawAim(context: CanvasRenderingContext2D): void {
    const shot = this.currentShot();

    if (!shot || !this.drag) {
      return;
    }

    // Linea del arrastre (como un tirachinas).
    context.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    context.lineWidth = 3;
    context.setLineDash([6, 6]);
    context.beginPath();
    context.moveTo(this.drag.startX, this.drag.startY);
    context.lineTo(this.drag.x, this.drag.y);
    context.stroke();
    context.setLineDash([]);

    const flight = { angle: shot.angle, speed: speedFor(shot.power) };
    const ground = terrainHeight(this.map, 0);
    const dots = 16;

    for (let index = 1; index <= dots; index += 1) {
      const t = (index / dots) * PREVIEW_SECONDS;
      const point = flightPoint(flight, t);
      const [px, py] = this.toScreen(point.x, point.y);
      context.fillStyle = `rgba(255, 255, 255, ${1 - index / (dots + 4)})`;
      context.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(px, py, Math.max(2, 6 - index * 0.25), 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }

    // Fuerza en porcentaje junto al jugador.
    const [hx, hy] = this.toScreen(0, ground + 3.2);
    context.font = '900 15px sans-serif';
    context.textAlign = 'center';
    context.lineWidth = 4;
    context.strokeStyle = '#000';
    context.fillStyle = '#fff';
    const label = `${Math.round(shot.power * 100)}% · ${Math.round((shot.angle * 180) / Math.PI)}º`;
    context.strokeText(label, hx, hy);
    context.fillText(label, hx, hy);
  }

  private resize(): void {
    const ratio = window.devicePixelRatio || 1;
    this.width = Math.max(1, this.host.clientWidth);
    this.height = Math.max(1, this.host.clientHeight);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
  }
}
