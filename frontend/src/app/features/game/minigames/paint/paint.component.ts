import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatchService } from '../../../../core/services/match.service';

type PaintTool = 'brush' | 'eraser' | 'shape' | 'floodfill';
type PaintShape = 'circle' | 'square' | 'triangle';

const PAINT_TARGETS = [
  'Manzana',
  'Castillo',
  'Cohete',
  'Guitarra',
  'Zapato',
  'Helado',
  'Sombrero',
  'Llave',
  'Barco',
  'Robot',
  'Dinosaurio',
  'Camara',
  'Pizza',
  'Bicicleta',
  'Reloj',
  'Montana',
  'Avion',
  'Lampara',
  'Corona',
  'Paraguas',
  'Fantasma',
  'Taza',
  'Balon',
  'Arbol',
  'Coche',
];

@Component({
  selector: 'app-paint',
  imports: [FormsModule],
  templateUrl: './paint.component.html',
  styleUrl: './paint.component.scss',
})
export class PaintComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('paintCanvas');
  private context?: CanvasRenderingContext2D;
  private drawing = false;
  private lastPoint: { x: number; y: number } | null = null;
  private startPoint: { x: number; y: number } | null = null;
  private canvasBackup: ImageData | null = null;
  private preparedRoundKey = '';
  private submittedRoundKey = '';
  private timer?: ReturnType<typeof setInterval>;

  readonly match = this.matchService.match;
  readonly isHost = this.matchService.isHost;
  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly specialRound = computed(() => this.match()?.specialRound || null);
  readonly target = computed(() => this.specialRound()?.paintTarget || null);
  readonly submissions = computed(() => this.specialRound()?.paintSubmissions || []);
  readonly phase = computed(() => this.specialRound()?.paintPhase || 'preparing');
  readonly remainingSeconds = signal(60);
  readonly tool = signal<PaintTool>('brush');
  readonly shape = signal<PaintShape>('circle');
  readonly color = signal('#111111');
  readonly brushSize = signal(10);
  readonly eraserSize = signal(22);
  readonly submitted = signal(false);
  readonly votedTargetId = signal('');
  readonly loading = signal(false);
  readonly errorMessage = signal('');

  readonly canvasCursorStyle = computed(() => {
    const t = this.tool();
    const c = this.color();
    const bSize = this.brushSize();
    const eSize = this.eraserSize();

    if (t === 'brush') {
      const escapedColor = encodeURIComponent(c);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><circle cx="64" cy="64" r="${bSize / 2}" fill="none" stroke="%23000000" stroke-width="1.5"/><circle cx="64" cy="64" r="${bSize / 2 - 0.5}" fill="${escapedColor}" fill-opacity="0.4"/></svg>`;
      return `url("data:image/svg+xml;utf8,${svg}") 64 64, crosshair`;
    }

    if (t === 'eraser') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><circle cx="64" cy="64" r="${eSize / 2}" fill="none" stroke="%23000000" stroke-width="1.5"/><circle cx="64" cy="64" r="${eSize / 2 - 0.5}" fill="%23ffffff" fill-opacity="0.6"/></svg>`;
      return `url("data:image/svg+xml;utf8,${svg}") 64 64, cell`;
    }

    if (t === 'floodfill') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="%23000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14 2-4 4 2.5 2.5L3 18v3h3l9.5-9.5L14 2z"/><path d="m8.5 11.5 4 4"/></svg>`;
      return `url("data:image/svg+xml;utf8,${svg}") 3 18, pointer`;
    }

    return 'default';
  });

  readonly submittedCount = computed(() => this.submissions().length);
  readonly totalPlayers = computed(() => this.match()?.totalPlayers || 0);
  readonly votableSubmissions = computed(() =>
    this.submissions().filter((submission) => submission.playerId !== this.currentPlayerId),
  );
  readonly canSubmit = computed(() => this.phase() === 'drawing' && !this.submitted() && !this.loading());

  constructor() {
    effect(() => {
      const match = this.match();
      const specialRound = match?.specialRound;

      if (!match || !specialRound || specialRound.minigameId !== 'paint' || !this.isHost()) {
        return;
      }

      const roundKey = `${match.lobbyId}:${specialRound.roundNumber}:${specialRound.minigameId}`;

      if (this.preparedRoundKey === roundKey || specialRound.preparedByHost || specialRound.paintTarget) {
        return;
      }

      this.preparedRoundKey = roundKey;
      void this.preparePaint(match.lobbyId);
    });

    effect(() => {
      const phase = this.phase();
      const deadline = phase === 'drawing' ? this.specialRound()?.paintEndsAt : this.specialRound()?.paintVoteEndsAt;

      this.syncTimer(deadline || null);
    });

    effect(() => {
      const canvasEl = this.canvasRef();
      if (canvasEl) {
        this.setupCanvas();
      }
    });
  }

  ngAfterViewInit(): void {
    this.setupCanvas();
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  openImageSearch(): void {
    const label = this.target()?.label;

    if (!label) {
      return;
    }

    window.open(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(label)}`, '_blank', 'noopener');
  }

  setTool(tool: PaintTool): void {
    this.tool.set(tool);
  }

  setBrushSize(value: string | number): void {
    this.brushSize.set(Number(value));
  }

  setEraserSize(value: string | number): void {
    this.eraserSize.set(Number(value));
  }

  hasVoted(): boolean {
    return Boolean(this.votedTargetId());
  }

  startDrawing(event: PointerEvent): void {
    if (this.phase() !== 'drawing' || this.submitted()) {
      return;
    }

    const point = this.getCanvasPoint(event);

    if (this.tool() === 'floodfill') {
      this.floodFill(point.x, point.y, this.color());
      return;
    }

    this.drawing = true;
    this.lastPoint = point;

    if (this.tool() === 'shape') {
      this.startPoint = point;
      const canvas = this.canvasRef()?.nativeElement;
      if (canvas && this.context) {
        this.canvasBackup = this.context.getImageData(0, 0, canvas.width, canvas.height);
      }
    } else {
      this.paint(event);
    }
  }

  stopDrawing(): void {
    this.drawing = false;
    this.lastPoint = null;
    this.startPoint = null;
    this.canvasBackup = null;
  }

  paint(event: PointerEvent): void {
    if (!this.drawing || !this.context) {
      return;
    }

    const point = this.getCanvasPoint(event);

    if (this.tool() === 'eraser') {
      this.context.strokeStyle = '#ffffff';
      this.context.lineWidth = this.eraserSize();
      this.context.lineCap = 'round';
      this.context.lineJoin = 'round';

      this.context.beginPath();
      if (this.lastPoint) {
        this.context.moveTo(this.lastPoint.x, this.lastPoint.y);
      } else {
        this.context.moveTo(point.x, point.y);
      }
      this.context.lineTo(point.x, point.y);
      this.context.stroke();
      
      this.lastPoint = point;
      return;
    }

    if (this.tool() === 'shape') {
      if (this.startPoint && this.canvasBackup) {
        this.context.putImageData(this.canvasBackup, 0, 0);
        this.context.fillStyle = this.color();
        this.drawShapeFromPoints(this.startPoint, point);
      }
      return;
    }

    if (this.tool() === 'floodfill') {
      return;
    }

    this.context.strokeStyle = this.color();
    this.context.lineWidth = this.brushSize();
    this.context.lineCap = 'round';
    this.context.lineJoin = 'round';

    this.context.beginPath();
    if (this.lastPoint) {
      this.context.moveTo(this.lastPoint.x, this.lastPoint.y);
    } else {
      this.context.moveTo(point.x, point.y);
    }
    this.context.lineTo(point.x, point.y);
    this.context.stroke();
    
    this.lastPoint = point;
  }

  async submitDrawing(): Promise<void> {
    const lobbyId = this.match()?.lobbyId;
    const round = this.specialRound();
    const canvas = this.canvasRef()?.nativeElement;

    if (!lobbyId || !round || !canvas || !this.canSubmit()) {
      return;
    }

    const submitKey = `${lobbyId}:${round.roundNumber}:${this.currentPlayerId}`;

    if (submitKey === this.submittedRoundKey) {
      return;
    }

    this.submittedRoundKey = submitKey;
    this.loading.set(true);
    const response = await this.matchService.submitPaintDrawing(lobbyId, canvas.toDataURL('image/png'));
    this.loading.set(false);

    if (!response.ok) {
      this.submittedRoundKey = '';
      this.errorMessage.set(response.reason || 'No se pudo enviar el dibujo.');
      return;
    }

    this.submitted.set(true);
  }

  async vote(targetPlayerId: string): Promise<void> {
    const lobbyId = this.match()?.lobbyId;

    if (!lobbyId || this.phase() !== 'voting' || this.votedTargetId() || targetPlayerId === this.currentPlayerId) {
      return;
    }

    this.loading.set(true);
    const response = await this.matchService.submitPaintVote(lobbyId, targetPlayerId);
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo votar el dibujo.');
      return;
    }

    this.votedTargetId.set(targetPlayerId);
  }

  private async preparePaint(lobbyId: string): Promise<void> {
    const label = PAINT_TARGETS[Math.floor(Math.random() * PAINT_TARGETS.length)];
    const response = await this.matchService.preparePaintMinigame(lobbyId, {
      id: label.toLowerCase().replace(/\s+/g, '-'),
      label,
    });

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo preparar A Pintar.');
    }
  }

  private setupCanvas(): void {
    const canvas = this.canvasRef()?.nativeElement;

    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');

    if (!context) {
      return;
    }

    this.context = context;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  private drawShapeFromPoints(startPoint: { x: number; y: number }, endPoint: { x: number; y: number }): void {
    if (!this.context) {
      return;
    }

    const shapeType = this.shape();

    if (shapeType === 'square') {
      const width = endPoint.x - startPoint.x;
      const height = endPoint.y - startPoint.y;
      this.context.fillRect(startPoint.x, startPoint.y, width, height);
      return;
    }

    if (shapeType === 'triangle') {
      this.context.beginPath();
      this.context.moveTo((startPoint.x + endPoint.x) / 2, startPoint.y);
      this.context.lineTo(startPoint.x, endPoint.y);
      this.context.lineTo(endPoint.x, endPoint.y);
      this.context.closePath();
      this.context.fill();
      return;
    }

    // circle
    const radius = Math.sqrt(Math.pow(endPoint.x - startPoint.x, 2) + Math.pow(endPoint.y - startPoint.y, 2));
    this.context.beginPath();
    this.context.arc(startPoint.x, startPoint.y, radius, 0, Math.PI * 2);
    this.context.fill();
  }

  private floodFill(startX: number, startY: number, fillColorHex: string): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas || !this.context) {
      return;
    }

    const width = canvas.width;
    const height = canvas.height;
    
    const sX = Math.floor(startX);
    const sY = Math.floor(startY);
    if (sX < 0 || sX >= width || sY < 0 || sY >= height) {
      return;
    }

    const imageData = this.context.getImageData(0, 0, width, height);
    const data = imageData.data;

    const fillRGB = this.hexToRgb(fillColorHex);
    if (!fillRGB) {
      return;
    }

    const pixelPos = (sY * width + sX) * 4;
    const targetR = data[pixelPos];
    const targetG = data[pixelPos + 1];
    const targetB = data[pixelPos + 2];
    const targetA = data[pixelPos + 3];

    // If already the target fill color, return
    if (
      targetR === fillRGB.r &&
      targetG === fillRGB.g &&
      targetB === fillRGB.b &&
      targetA === 255
    ) {
      return;
    }

    const queue = new Int32Array(width * height);
    const visited = new Uint8Array(width * height);
    let head = 0;
    let tail = 0;

    const startIdx = sY * width + sX;
    queue[tail++] = startIdx;
    visited[startIdx] = 1;

    const matchThreshold = 25;

    while (head < tail) {
      const currIdx = queue[head++];
      const currX = currIdx % width;
      const currY = Math.floor(currIdx / width);

      const currentPixelPos = currIdx * 4;
      const r = data[currentPixelPos];
      const g = data[currentPixelPos + 1];
      const b = data[currentPixelPos + 2];
      const a = data[currentPixelPos + 3];

      const colorDistance = Math.abs(r - targetR) + Math.abs(g - targetG) + Math.abs(b - targetB) + Math.abs(a - targetA);

      if (colorDistance <= matchThreshold) {
        data[currentPixelPos] = fillRGB.r;
        data[currentPixelPos + 1] = fillRGB.g;
        data[currentPixelPos + 2] = fillRGB.b;
        data[currentPixelPos + 3] = 255;

        // 4-connected check
        if (currX > 0) {
          const nextIdx = currIdx - 1;
          if (!visited[nextIdx]) {
            visited[nextIdx] = 1;
            queue[tail++] = nextIdx;
          }
        }
        if (currX < width - 1) {
          const nextIdx = currIdx + 1;
          if (!visited[nextIdx]) {
            visited[nextIdx] = 1;
            queue[tail++] = nextIdx;
          }
        }
        if (currY > 0) {
          const nextIdx = currIdx - width;
          if (!visited[nextIdx]) {
            visited[nextIdx] = 1;
            queue[tail++] = nextIdx;
          }
        }
        if (currY < height - 1) {
          const nextIdx = currIdx + width;
          if (!visited[nextIdx]) {
            visited[nextIdx] = 1;
            queue[tail++] = nextIdx;
          }
        }
      }
    }

    this.context.putImageData(imageData, 0, 0);
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : null;
  }

  private getCanvasPoint(event: PointerEvent): { x: number; y: number } {
    const canvas = this.canvasRef()?.nativeElement;
    const rect = canvas?.getBoundingClientRect();

    if (!canvas || !rect) {
      return { x: 0, y: 0 };
    }

    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  private syncTimer(deadline: number | null): void {
    this.clearTimer();

    if (!deadline) {
      return;
    }

    const update = () => {
      const nextSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      this.remainingSeconds.set(nextSeconds);

      if (nextSeconds <= 0) {
        this.clearTimer();

        if (this.phase() === 'drawing' && !this.submitted()) {
          void this.submitDrawing();
        }
      }
    };

    update();
    this.timer = setInterval(update, 1000);
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }
}
