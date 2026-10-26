import { ARENA_RADIUS, DISC_RADIUS, MAX_SPEED, PushResult, STEP, isOut, predictStop } from './push-physics';

/** Lo que dura la caida al agua (el disco se encoge hasta desaparecer). */
const FALL_MS = 750;
/** Lo que tarda en hundirse el anillo de pista que se pierde al empezar una ronda. */
const SHRINK_MS = 1200;

export interface PushDisc {
  playerId: string;
  x: number;
  y: number;
  color: string;
  image: HTMLImageElement | null;
  mine: boolean;
  name: string;
  confirmed: boolean;
}

interface Playback {
  result: PushResult;
  /** performance.now() en que salen todos. */
  startAt: number;
  hitIndex: number;
  fallIndex: number;
}

/**
 * Tablero 2D de Empujar: agua alrededor, pista de hielo redonda y las fichas de los jugadores (su foto en un circulo).
 * Se apunta arrastrando (como el golf) y se ve donde acabaria la ficha si no chocara con nadie.
 */
export class PushBoard {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private frameHandle = 0;
  private width = 1;
  private height = 1;
  private scale = 20;
  private centerX = 0;
  private centerY = 0;
  private discs: PushDisc[] = [];
  private aiming = false;
  private drag: { startX: number; startY: number; x: number; y: number } | null = null;
  private aim: { vx: number; vy: number } | null = null;
  private playback: Playback | null = null;
  private insets = { top: 70, bottom: 120 };
  private readonly splashes: Array<{ x: number; y: number; at: number }> = [];
  /** Radio actual de la pista y el que tendra en la ronda siguiente (el anillo entre ambos va en rojo). */
  private arenaRadius = ARENA_RADIUS;
  private nextRadius = ARENA_RADIUS;
  /** Anillo que se esta hundiendo (al empezar la ronda) y fichas que se hunden con el. */
  private shrink: { from: number; to: number; startAt: number } | null = null;
  private sinking: Array<{ disc: PushDisc; startAt: number; splashed: boolean }> = [];

  /** Nueva direccion y fuerza elegidas al soltar el arrastre. */
  onAim?: (vx: number, vy: number) => void;
  /** Choque entre fichas (fuerza aproximada) y caida al agua, para los sonidos. */
  onHit?: (strength: number) => void;
  onFall?: (playerId: string) => void;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
  ) {
    this.context = canvas.getContext('2d')!;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    canvas.addEventListener('pointerdown', this.pointerDown);
    window.addEventListener('pointermove', this.pointerMove);
    window.addEventListener('pointerup', this.pointerUp);
    this.loop();
  }

  setDiscs(discs: PushDisc[]): void {
    this.discs = discs;
  }

  /** Tamano de la pista (y de la siguiente ronda). Si se pasa `shrink`, el anillo perdido se hunde animado. */
  setArena(radius: number, nextRadius: number, shrink: { from: number; to: number; startAt: number } | null): void {
    this.arenaRadius = radius;
    this.nextRadius = Math.min(radius, nextRadius);
    this.shrink = shrink;
  }

  /** Fichas que estaban en la zona roja: se hunden con el anillo (una sola vez por ronda). */
  sink(discs: PushDisc[], startAt: number): void {
    this.sinking = discs.map((disc) => ({ disc, startAt: startAt + SHRINK_MS * 0.35, splashed: false }));
  }

  setAiming(aiming: boolean): void {
    this.aiming = aiming;

    if (!aiming) {
      this.drag = null;
    }
  }

  /** Direccion elegida (se dibuja la flecha y el destino); null = sin elegir. */
  setAim(aim: { vx: number; vy: number } | null): void {
    this.aim = aim;
  }

  /** Reproduce la simulacion de la ronda desde `startAt` (todos salen a la vez). */
  play(result: PushResult | null, startAt = 0): void {
    this.playback = result ? { result, startAt, hitIndex: 0, fallIndex: 0 } : null;
  }

  setInsets(top: number, bottom: number): void {
    this.insets = { top, bottom };
    this.resize();
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

    // Cada arrastre nuevo empieza de cero (se puede rectificar todas las veces que se quiera).
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    this.drag = { startX: x, startY: y, x, y };
    this.aim = null;
    event.preventDefault();
  };

  private readonly pointerMove = (event: PointerEvent) => {
    if (this.drag) {
      const rect = this.canvas.getBoundingClientRect();
      this.drag.x = event.clientX - rect.left;
      this.drag.y = event.clientY - rect.top;
      this.aim = this.dragAim();
    }
  };

  private readonly pointerUp = () => {
    if (!this.drag) {
      return;
    }

    const aim = this.dragAim();
    this.drag = null;
    this.aim = aim && Math.hypot(aim.vx, aim.vy) > MAX_SPEED * 0.03 ? aim : null;
    this.onAim?.(this.aim?.vx ?? 0, this.aim?.vy ?? 0);
  };

  /** Como un tirachinas: hacia el lado contrario del arrastre y mas fuerte cuanto mas largo. */
  private dragAim(): { vx: number; vy: number } | null {
    if (!this.drag) {
      return null;
    }

    const dx = this.drag.startX - this.drag.x;
    const dy = this.drag.startY - this.drag.y;
    const length = Math.hypot(dx, dy);

    if (length < 4) {
      return null;
    }

    const maxDrag = Math.max(110, Math.min(this.width, this.height) * 0.3);
    const speed = (Math.min(length, maxDrag) / maxDrag) * MAX_SPEED;
    // En pantalla la y crece hacia abajo, igual que en el mundo.
    return { vx: (dx / length) * speed, vy: (dy / length) * speed };
  }

  /* --------------------------------- Dibujo --------------------------------- */

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    this.draw(performance.now());
  }

  private toScreen(x: number, y: number): [number, number] {
    return [this.centerX + x * this.scale, this.centerY + y * this.scale];
  }

  private draw(now: number): void {
    const context = this.context;
    const ratio = window.devicePixelRatio || 1;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.drawWater(context, now);
    this.drawArena(context, now);
    this.drawSinking(context, now);

    const positions = this.currentPositions(now);

    for (const splash of this.splashes) {
      const age = (now - splash.at) / 900;

      if (age < 1) {
        const [sx, sy] = this.toScreen(splash.x, splash.y);
        context.strokeStyle = `rgba(255, 255, 255, ${1 - age})`;
        context.lineWidth = 3;
        context.beginPath();
        context.arc(sx, sy, DISC_RADIUS * this.scale * (0.6 + age * 1.6), 0, Math.PI * 2);
        context.stroke();
      }
    }

    // Primero el destino previsto y la flecha (debajo de las fichas).
    const mine = this.discs.find((disc) => disc.mine);

    if (mine && this.aim && !this.playback && positions.has(mine.playerId)) {
      this.drawAim(context, mine, positions.get(mine.playerId)!);
    }

    // La propia, encima de las demas.
    const ordered = [...this.discs].sort((first, second) => Number(first.mine) - Number(second.mine));

    for (const disc of ordered) {
      const position = positions.get(disc.playerId);

      if (position) {
        this.drawDisc(context, disc, position.x, position.y, position.scale);
      }
    }
  }

  /** Posicion (y escala, para la caida) de cada ficha en este instante. */
  private currentPositions(now: number): Map<string, { x: number; y: number; scale: number }> {
    const positions = new Map<string, { x: number; y: number; scale: number }>();
    const playback = this.playback;

    if (!playback || now < playback.startAt) {
      for (const disc of this.discs) {
        positions.set(disc.playerId, { x: disc.x, y: disc.y, scale: 1 });
      }

      return positions;
    }

    const { result } = playback;
    const step = Math.floor((now - playback.startAt) / 1000 / STEP);
    const frameIndex = Math.min(result.frames.length - 1, Math.floor(step / result.frameEvery));
    const frame = result.frames[frameIndex];

    // Sonidos de los choques y caidas a medida que se alcanzan.
    while (playback.hitIndex < result.hits.length && result.hits[playback.hitIndex].step <= step) {
      this.onHit?.(result.hits[playback.hitIndex].strength);
      playback.hitIndex += 1;
    }

    while (playback.fallIndex < result.falls.length && result.falls[playback.fallIndex].step <= step) {
      const fall = result.falls[playback.fallIndex];
      this.splashes.push({ x: fall.x, y: fall.y, at: now });
      this.onFall?.(fall.playerId);
      playback.fallIndex += 1;
    }

    result.ids.forEach((playerId, index) => {
      const fall = result.falls.find((entry) => entry.playerId === playerId);

      if (fall && step >= fall.step) {
        // Cae al agua: sigue un poco con su inercia mientras se encoge hasta desaparecer.
        const elapsed = now - playback.startAt - fall.step * STEP * 1000;
        const progress = elapsed / FALL_MS;

        if (progress < 1) {
          const drift = (elapsed / 1000) * (1 - progress * 0.5);
          positions.set(playerId, { x: fall.x + fall.vx * drift * 0.5, y: fall.y + fall.vy * drift * 0.5, scale: 1 - progress });
        }

        return;
      }

      positions.set(playerId, { x: frame[index * 2], y: frame[index * 2 + 1], scale: 1 });
    });

    return positions;
  }

  private drawWater(context: CanvasRenderingContext2D, now: number): void {
    context.fillStyle = '#35c6dc';
    context.fillRect(0, 0, this.width, this.height);
    // Ondas suaves que se mueven.
    context.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    context.lineWidth = 2;

    for (let y = -20; y < this.height + 20; y += 34) {
      context.beginPath();

      for (let x = 0; x <= this.width; x += 12) {
        const wave = Math.sin(x / 38 + now / 700 + y) * 4;
        if (x === 0) context.moveTo(x, y + wave);
        else context.lineTo(x, y + wave);
      }

      context.stroke();
    }
  }

  private drawArena(context: CanvasRenderingContext2D, now: number): void {
    const shrink = this.shrink;
    const shrinking = shrink && now < shrink.startAt + SHRINK_MS ? Math.max(0, (now - shrink.startAt) / SHRINK_MS) : null;
    const radius = (shrinking !== null && shrink ? shrink.to : this.arenaRadius) * this.scale;

    // Anillo que se hunde: se oscurece, se agrieta y se desvanece en el agua.
    if (shrinking !== null && shrink) {
      const outer = shrink.from * this.scale;
      context.save();
      context.globalAlpha = 1 - shrinking;
      context.fillStyle = '#e9a3a3';
      context.beginPath();
      context.arc(this.centerX, this.centerY, outer * (1 - shrinking * 0.04), 0, Math.PI * 2);
      context.arc(this.centerX, this.centerY, radius, 0, Math.PI * 2, true);
      context.fill('evenodd');
      context.strokeStyle = 'rgba(90, 20, 20, 0.6)';
      context.lineWidth = 2;

      for (let index = 0; index < 18; index += 1) {
        const angle = (index / 18) * Math.PI * 2 + 0.2;
        context.beginPath();
        context.moveTo(this.centerX + Math.cos(angle) * radius, this.centerY + Math.sin(angle) * radius);
        context.lineTo(this.centerX + Math.cos(angle + 0.05) * outer, this.centerY + Math.sin(angle + 0.05) * outer);
        context.stroke();
      }

      context.restore();
    }

    // Sombra bajo la pista y borde de nieve.
    context.fillStyle = 'rgba(0, 60, 90, 0.3)';
    context.beginPath();
    context.arc(this.centerX + 6, this.centerY + 10, radius + 6, 0, Math.PI * 2);
    context.fill();
    const gradient = context.createRadialGradient(this.centerX - radius * 0.3, this.centerY - radius * 0.35, radius * 0.1, this.centerX, this.centerY, radius);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.7, '#dff4ff');
    gradient.addColorStop(1, '#bfe6f7');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(this.centerX, this.centerY, radius, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = Math.max(4, this.scale * 0.35);
    context.strokeStyle = '#f7fdff';
    context.stroke();
    context.lineWidth = 3;
    context.strokeStyle = '#000';
    context.beginPath();
    context.arc(this.centerX, this.centerY, radius + Math.max(2, this.scale * 0.17), 0, Math.PI * 2);
    context.stroke();

    // Rayas de patines en el hielo (siempre las mismas, del tamano de la pista entera; recortadas a la que queda).
    const full = ARENA_RADIUS * this.scale;
    context.save();
    context.beginPath();
    context.arc(this.centerX, this.centerY, radius, 0, Math.PI * 2);
    context.clip();
    context.strokeStyle = 'rgba(120, 170, 200, 0.25)';
    context.lineWidth = 1.5;

    for (let index = 0; index < 9; index += 1) {
      const angle = index * 2.39;
      const distance = (0.2 + ((index * 0.37) % 0.6)) * full;
      const x = this.centerX + Math.cos(angle) * distance;
      const y = this.centerY + Math.sin(angle) * distance;
      context.beginPath();
      context.arc(x, y, full * (0.25 + (index % 3) * 0.1), angle, angle + 0.9);
      context.stroke();
    }

    // Circulo central como en una pista de curling.
    context.strokeStyle = 'rgba(232, 38, 43, 0.35)';
    context.lineWidth = 3;
    context.beginPath();
    context.arc(this.centerX, this.centerY, full * 0.18, 0, Math.PI * 2);
    context.stroke();

    // Zona que se hundira al empezar la ronda siguiente: anillo rojo palido con borde discontinuo.
    if (shrinking === null && this.nextRadius < this.arenaRadius) {
      const inner = this.nextRadius * this.scale;
      const pulse = 0.26 + Math.sin(now / 260) * 0.06;
      context.fillStyle = `rgba(255, 70, 70, ${pulse})`;
      context.beginPath();
      context.arc(this.centerX, this.centerY, radius, 0, Math.PI * 2);
      context.arc(this.centerX, this.centerY, inner, 0, Math.PI * 2, true);
      context.fill('evenodd');
      context.setLineDash([10, 8]);
      context.strokeStyle = 'rgba(200, 30, 30, 0.85)';
      context.lineWidth = 3;
      context.beginPath();
      context.arc(this.centerX, this.centerY, inner, 0, Math.PI * 2);
      context.stroke();
      context.setLineDash([]);
    }

    context.restore();
  }

  /** Fichas que se hunden con el anillo perdido (se encogen hasta desaparecer). */
  private drawSinking(context: CanvasRenderingContext2D, now: number): void {
    for (const entry of this.sinking) {
      const progress = (now - entry.startAt) / FALL_MS;

      if (progress < 0) {
        this.drawDisc(context, entry.disc, entry.disc.x, entry.disc.y, 1);
        continue;
      }

      if (!entry.splashed) {
        entry.splashed = true;
        this.splashes.push({ x: entry.disc.x, y: entry.disc.y, at: now });
        this.onFall?.(entry.disc.playerId);
      }

      if (progress < 1) {
        this.drawDisc(context, entry.disc, entry.disc.x, entry.disc.y, 1 - progress);
      }
    }
  }

  private drawDisc(context: CanvasRenderingContext2D, disc: PushDisc, x: number, y: number, scale: number): void {
    const [sx, sy] = this.toScreen(x, y);
    const radius = DISC_RADIUS * this.scale * scale;

    if (radius < 0.5) {
      return;
    }

    // Sombra.
    context.fillStyle = 'rgba(0, 40, 70, 0.25)';
    context.beginPath();
    context.ellipse(sx + radius * 0.12, sy + radius * 0.22, radius, radius * 0.95, 0, 0, Math.PI * 2);
    context.fill();

    context.save();
    context.beginPath();
    context.arc(sx, sy, radius, 0, Math.PI * 2);
    context.fillStyle = disc.color;
    context.fill();

    if (disc.image?.complete && disc.image.naturalWidth) {
      context.clip();
      context.drawImage(disc.image, sx - radius, sy - radius, radius * 2, radius * 2);
    }

    context.restore();
    // Aro del color del jugador; la propia ademas con un aro blanco.
    context.lineWidth = Math.max(3, radius * 0.18);
    context.strokeStyle = disc.color;
    context.beginPath();
    context.arc(sx, sy, radius, 0, Math.PI * 2);
    context.stroke();
    context.lineWidth = 2;
    context.strokeStyle = '#000';
    context.beginPath();
    context.arc(sx, sy, radius + context.lineWidth, 0, Math.PI * 2);
    context.stroke();

    if (disc.mine) {
      context.lineWidth = 3;
      context.strokeStyle = '#ffffff';
      context.beginPath();
      context.arc(sx, sy, radius + 6, 0, Math.PI * 2);
      context.stroke();
    }

    if (scale < 1) {
      return;
    }

    // Nombre debajo y marca de "listo" mientras se apunta.
    context.font = `900 ${Math.max(11, Math.min(14, this.scale * 0.55))}px sans-serif`;
    context.textAlign = 'center';
    context.lineWidth = 3;
    context.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    context.fillStyle = disc.mine ? '#ffe891' : '#ffffff';
    const label = disc.mine ? 'Tú' : disc.name;
    context.strokeText(label, sx, sy + radius + 16);
    context.fillText(label, sx, sy + radius + 16);

    if (disc.confirmed && !this.playback) {
      context.fillStyle = '#2fbf55';
      context.strokeStyle = '#000';
      context.lineWidth = 2;
      context.beginPath();
      context.arc(sx + radius * 0.75, sy - radius * 0.75, Math.max(7, radius * 0.28), 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.fillStyle = '#fff';
      context.font = `900 ${Math.max(9, radius * 0.32)}px sans-serif`;
      context.fillText('✔', sx + radius * 0.75, sy - radius * 0.75 + Math.max(3, radius * 0.11));
    }
  }

  /** Flecha de la direccion y circulo donde acabaria la ficha (si no choca con nadie). */
  private drawAim(context: CanvasRenderingContext2D, disc: PushDisc, position: { x: number; y: number }): void {
    const aim = this.aim!;
    const stop = predictStop({ playerId: disc.playerId, x: position.x, y: position.y }, aim.vx, aim.vy, this.arenaRadius);
    const [fromX, fromY] = this.toScreen(position.x, position.y);
    const [toX, toY] = this.toScreen(stop.x, stop.y);
    const radius = DISC_RADIUS * this.scale;
    // En rojo si se caeria (o si se quedaria en la zona que se hunde la ronda siguiente).
    const falls = isOut(stop.x, stop.y, this.arenaRadius) || Math.hypot(stop.x, stop.y) > this.nextRadius;

    context.setLineDash([8, 7]);
    context.lineWidth = 3;
    context.strokeStyle = falls ? 'rgba(232, 38, 43, 0.9)' : 'rgba(30, 60, 120, 0.7)';
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
    context.setLineDash([]);

    // Fantasma de la ficha en el destino.
    context.save();
    context.globalAlpha = 0.45;
    context.beginPath();
    context.arc(toX, toY, radius, 0, Math.PI * 2);
    context.fillStyle = disc.color;
    context.fill();

    if (disc.image?.complete && disc.image.naturalWidth) {
      context.clip();
      context.drawImage(disc.image, toX - radius, toY - radius, radius * 2, radius * 2);
    }

    context.restore();
    context.setLineDash([5, 4]);
    context.lineWidth = 3;
    context.strokeStyle = falls ? '#e8262b' : '#ffffff';
    context.beginPath();
    context.arc(toX, toY, radius + 3, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);

    // Fuerza junto a la ficha.
    const power = Math.round((Math.hypot(aim.vx, aim.vy) / MAX_SPEED) * 100);
    context.font = '900 14px sans-serif';
    context.textAlign = 'center';
    context.lineWidth = 4;
    context.strokeStyle = '#000';
    context.fillStyle = '#fff';
    context.strokeText(`${power}%`, fromX, fromY - radius - 12);
    context.fillText(`${power}%`, fromX, fromY - radius - 12);
  }

  private resize(): void {
    const ratio = window.devicePixelRatio || 1;
    this.width = Math.max(1, this.host.clientWidth);
    this.height = Math.max(1, this.host.clientHeight);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    const usableHeight = Math.max(160, this.height - this.insets.top - this.insets.bottom);
    // Un poco de agua visible alrededor de la pista.
    this.scale = Math.min(this.width - 24, usableHeight) / (2 * (ARENA_RADIUS + 1.6));
    this.centerX = this.width / 2;
    this.centerY = this.insets.top + usableHeight / 2;
  }
}
