import { Component, OnDestroy, OnInit, output, signal } from '@angular/core';

@Component({
  selector: 'app-countdown',
  templateUrl: './countdown.component.html',
  styleUrl: './countdown.component.scss',
})
export class CountdownComponent implements OnInit, OnDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private readonly numbers = [3, 2, 1];
  private index = 0;

  readonly currentNumber = signal(this.numbers[0]);
  readonly finished = output<void>();

  ngOnInit(): void {
    this.timer = setInterval(() => {
      this.index += 1;

      if (this.index >= this.numbers.length) {
        this.clearTimer();
        this.finished.emit();
        return;
      }

      this.currentNumber.set(this.numbers[this.index]);
    }, 950);
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }
}
