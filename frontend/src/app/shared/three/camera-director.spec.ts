import * as THREE from 'three';
import { CameraDirector } from './camera-director';

describe('CameraDirector', () => {
  it('termina la transicion exactamente sobre el objetivo aunque este se mueva durante el viaje', () => {
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    const director = new CameraDirector(THREE, camera);
    director.setViewport(800, 600);

    director.focus('overview', () => ({ target: new THREE.Vector3(0, 0, 0), direction: new THREE.Vector3(0, 0, 1), distance: 5 }), 0);
    director.update(0, 0.016);
    expect(camera.position.toArray()).toEqual([0, 0, 5]);

    // Las cartas del jugador se desplazan (llega una carta nueva) en mitad de la transicion.
    const cards = new THREE.Vector3(3, 1, 0);
    director.focus('cards:p1', () => ({ target: cards.clone(), direction: new THREE.Vector3(0, 1, 0), distance: 4 }), 100, { durationMs: 1000 });
    director.update(600, 0.016);
    expect(director.settled(600)).toBeFalse();
    expect(camera.position.distanceTo(new THREE.Vector3(3, 5, 0))).toBeGreaterThan(0.01);

    cards.set(4, 1, 0);
    director.update(1100, 0.016);
    expect(director.settled(1100)).toBeTrue();
    expect(camera.position.toArray()).toEqual([4, 5, 0]);
  });

  it('repetir el mismo encuadre no reinicia la transicion', () => {
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    const director = new CameraDirector(THREE, camera);
    director.setViewport(800, 600);
    director.focus('a', () => ({ target: new THREE.Vector3(), direction: new THREE.Vector3(0, 0, 1), distance: 5 }), 0);
    director.focus('b', () => ({ target: new THREE.Vector3(2, 0, 0), direction: new THREE.Vector3(0, 0, 1), distance: 5 }), 0, { durationMs: 500 });
    director.focus('b', () => ({ target: new THREE.Vector3(2, 0, 0), direction: new THREE.Vector3(0, 0, 1), distance: 5 }), 400, { durationMs: 500 });
    expect(director.settled(500)).toBeTrue();
  });

  it('calcula la distancia minima para que todos los puntos quepan en la zona libre del HUD', () => {
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    const director = new CameraDirector(THREE, camera);
    director.setViewport(1000, 600, { top: 60, right: 0, bottom: 180, left: 0 });
    const points = [new THREE.Vector3(-1.5, 0, 0), new THREE.Vector3(1.5, 0, 0), new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, -0.5, 0)];
    director.focus('fit', () => ({ target: new THREE.Vector3(0, 0.75, 0), direction: new THREE.Vector3(0, 0, 1), fit: points, margin: 0.9 }), 0);

    // Las zonas tapadas por el HUD se aplican de forma progresiva: tras unos fotogramas ya son las finales.
    for (let frame = 0; frame < 120; frame += 1) {
      director.update(frame * 16, 0.016);
    }

    camera.updateMatrixWorld();
    const top = 1 - (2 * 60) / 600;
    const bottom = -1 + (2 * 180) / 600;
    const projected = points.map((point) => point.clone().project(camera));

    for (const point of projected) {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(0.9 + 1e-3);
      expect(point.y).toBeLessThanOrEqual(top + 1e-3);
      expect(point.y).toBeGreaterThanOrEqual(bottom - 1e-3);
    }

    // Y no se aleja de mas: algun punto queda pegado al limite.
    const center = (top + bottom) / 2;
    const tightest = Math.max(...projected.map((point) => Math.abs(point.y - center) / (((top - bottom) / 2) * 0.9)));
    expect(tightest).toBeGreaterThan(0.97);
  });
});
