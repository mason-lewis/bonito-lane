import * as THREE from 'three/webgpu';
import { assetUrl } from './asset-url';
import { selectInteriorLights, validateInteriorLighting, interiorZoneAt, type InteriorLightingData, type InteriorPractical } from './interior-light-selection';
import type { Vec3 } from './schema';

/** A stable four-light shader budget; one shadow map per practical, never six
 * point-light cube faces. Maps freeze until fixtures or moving geometry change. */
export async function createInteriorLighting(scene: THREE.Scene, house: THREE.Object3D, vehicles: THREE.Object3D[] = []) {
  const response = await fetch(assetUrl('/data/interior-lighting.json'));
  if (!response.ok) throw new Error('Interior lighting export is missing. Run the Blender house export.');
  const data: InteriorLightingData = validateInteriorLighting(await response.json());
  const movingSources = data.lights.filter(source => source.anchorNode).map(source => {
    const anchor = house.getObjectByName(source.anchorNode!);
    if (!anchor) throw new Error(`Moving practical anchor is missing: ${source.anchorNode}.`);
    return {source, anchor, position: [...source.position] as Vec3, target: [...source.target] as Vec3};
  });
  const anchorPosition = new THREE.Vector3();
  const SHADOW_LAYER = 2;
  for (const root of [house, ...vehicles]) root.traverse(object => {
    if (!(object as THREE.Mesh).isMesh) return;
    object.layers.enable(SHADOW_LAYER);
    const mesh = object as THREE.Mesh;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (materials.some(material => material.name === 'luminaire-emitter')) mesh.castShadow = false;
  });
  const slots = Array.from({length: 4}, (_, index) => {
    const light = new THREE.SpotLight('#ffe7c4', 0, 6, Math.PI / 3, .58, 2);
    light.name = `interior-practical-slot-${index}`;
    light.castShadow = true;
    light.shadow.mapSize.set(512, 512);
    // A 3.5cm near plane wastes perspective depth precision at room distance.
    // No fixture illuminates a receiver within 15cm of its optical centre.
    light.shadow.camera.near = .15;
    light.shadow.camera.far = 6;
    light.shadow.camera.layers.set(SHADOW_LAYER);
    light.shadow.bias = -.0003;
    light.shadow.normalBias = .02;
    light.shadow.autoUpdate = false;
    // Initialize the map once even outside, avoiding an uninitialized sample
    // when the first selected room activates these stable shader slots.
    light.shadow.needsUpdate = true;
    light.position.set(0, 2, 0); light.target.position.set(0, 0, 0);
    scene.add(light, light.target);
    return {light, source: undefined as InteriorPractical | undefined};
  });
  let lastLowQuality = false, active: InteriorPractical[] = [], zoneId: string | null = null;
  let selectionAge = .2, previousEye: Vec3 = [Infinity, Infinity, Infinity];
  let shadowRefreshes = 0;

  function update(eye: Vec3, deltaSeconds: number, options: {lowQuality: boolean; planMode: boolean; movingGeometry?: boolean}) {
    const {lowQuality, planMode, movingGeometry = false} = options;
    let anchorMoved = false;
    for (const item of movingSources) {
      item.anchor.getWorldPosition(anchorPosition);
      const offset = [anchorPosition.x, anchorPosition.y, anchorPosition.z].map((value, i) => value - item.source.anchorOrigin![i]);
      const next = item.position.map((value, i) => value + offset[i]) as Vec3;
      if (next.some((value, i) => Math.abs(value - item.source.position[i]) > .0001)) anchorMoved = true;
      item.source.position = next;
      item.source.target = item.target.map((value, i) => value + offset[i]) as Vec3;
    }
    const nextZone = planMode ? undefined : interiorZoneAt(data.zones, eye);
    selectionAge += deltaSeconds;
    const teleported = Math.hypot(...eye.map((v, i) => v - previousEye[i])) > 1;
    if (selectionAge >= .15 || (nextZone?.id ?? null) !== zoneId || lowQuality !== lastLowQuality || teleported) {
      active = selectInteriorLights(data, eye, lowQuality, planMode, active.map(light => light.id));
      selectionAge = 0; zoneId = nextZone?.id ?? null; previousEye = [...eye];
      // Retain matching sources in their slots to avoid shadow-map churn.
      const remaining = active.filter(source => !slots.some(slot => slot.source?.id === source.id));
      for (const slot of slots) {
        const retained = slot.source && active.some(source => source.id === slot.source!.id);
        const source = retained ? slot.source : remaining.shift();
        const changed = source?.id !== slot.source?.id;
        if (changed) slot.light.intensity = 0;
        slot.source = source;
        if (source && changed) {
          slot.light.position.set(...source.position);
          slot.light.target.position.set(...source.target);
          slot.light.target.updateMatrixWorld();
          slot.light.color.set(source.color);
          slot.light.distance = source.distance;
          slot.light.angle = source.angle;
          slot.light.penumbra = source.penumbra;
          slot.light.shadow.camera.far = source.distance;
          slot.light.shadow.needsUpdate = true;
          shadowRefreshes++;
        }
        // r180 WebGPU targets stay at 512px: quality changes active count only.
        // Reallocating a live shadow target has failed on this renderer/device.
      }
      lastLowQuality = lowQuality;
    }
    for (const slot of slots) {
      if (!slot.source || planMode || !nextZone) {slot.light.intensity = 0; continue;}
      if (slot.source.anchorNode && anchorMoved) {
        slot.light.position.set(...slot.source.position);
        slot.light.target.position.set(...slot.source.target);
        slot.light.target.updateMatrixWorld();
        slot.light.shadow.needsUpdate = true; shadowRefreshes++;
      }
      // Light fades in over ~150ms after a newly selected fixture; exterior and
      // plan mode turn it off immediately rather than illuminating hidden floors.
      slot.light.intensity = THREE.MathUtils.damp(slot.light.intensity, slot.source.intensity, 20, deltaSeconds);
      if (movingGeometry) {slot.light.shadow.needsUpdate = true; shadowRefreshes++;}
    }
  }

  return {
    update,
    get diagnostics() {return {zone: zoneId, quality: lastLowQuality ? 'low' : 'high', authoredPracticals: data.lights.length, active: active.map(source => source.id), activeCount: active.length, maxLights: lastLowQuality ? 2 : 4, shadowSize: 512, shadowRefreshes};},
    dispose() {for (const {light} of slots) {scene.remove(light, light.target); light.dispose();}},
  };
}
