import { Routes } from '@angular/router';
import { MainMenuComponent } from './features/main-menu/main-menu.component';

export const routes: Routes = [
  {
    path: '',
    component: MainMenuComponent,
  },
  {
    path: '**',
    redirectTo: '',
  },
];
