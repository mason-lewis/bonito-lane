import { containsXZPolygon, type Vec3 } from './schema.ts';

export interface InteriorZone {
  id: string; group: string; floor: string; polygon: [number, number][]; minY: number; maxY: number;
}
export interface InteriorPractical {
  id: string; roomId: string; group: string; floor: string; position: Vec3; target: Vec3;
  color: string; intensity: number; distance: number; angle: number; penumbra: number;
  style: string; fixtureSemanticId?: string;
  anchorNode?: string; anchorOrigin?: Vec3;
}
export interface InteriorLightingData {
  version: number; units: string; zones: InteriorZone[]; lights: InteriorPractical[];
  quality: {high: {maxLights: number; shadowSize: number}; low: {maxLights: number; shadowSize: number}};
}

const validVector = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

export function validateInteriorLighting(value: unknown): InteriorLightingData {
  const data = value as InteriorLightingData;
  if (!data || data.version !== 1 || data.units !== 'meters' || !Array.isArray(data.zones) || !Array.isArray(data.lights)) throw new Error('Interior lighting metadata is missing or invalid. Re-export the house.');
  if (new Set(data.lights.map(light => light.id)).size !== data.lights.length) throw new Error('Interior lighting IDs must be unique.');
  for (const zone of data.zones) {
    if (!Number.isFinite(zone.minY) || !Number.isFinite(zone.maxY) || zone.maxY <= zone.minY || !Array.isArray(zone.polygon) || zone.polygon.length < 3 || zone.polygon.some(p => p.length !== 2 || !p.every(Number.isFinite))) throw new Error(`Invalid interior lighting zone ${zone.id}.`);
  }
  for (const light of data.lights) {
    if (!validVector(light.position) || !validVector(light.target) || !Number.isFinite(light.intensity) || light.intensity <= 0 || !Number.isFinite(light.distance) || light.distance <= 0 || !Number.isFinite(light.angle) || light.angle <= 0 || light.angle >= Math.PI / 2 || !Number.isFinite(light.penumbra) || light.penumbra < 0 || light.penumbra > 1 || !/^#[0-9a-f]{6}$/i.test(light.color) || !data.zones.some(zone => zone.group === light.group)) throw new Error(`Invalid interior practical ${light.id}.`);
    if (light.anchorNode && !validVector(light.anchorOrigin)) throw new Error(`Invalid moving light anchor ${light.id}.`);
  }
  for (const key of ['high', 'low'] as const) {
    const quality = data.quality?.[key];
    if (!quality || !Number.isInteger(quality.maxLights) || quality.maxLights < 1 || quality.maxLights > 4 || quality.shadowSize !== 512) throw new Error(`Invalid ${key} interior lighting budget.`);
  }
  return data;
}

export function interiorZoneAt(zones: InteriorZone[], eye: Vec3): InteriorZone | undefined {
  // A small room wins over a containing stair volume. Polygon membership keeps
  // concave hall cut-outs and exterior porches from activating interior lights.
  const area = (zone: InteriorZone) => Math.abs(zone.polygon.reduce((sum, p, i) => {
    const q = zone.polygon[(i + 1) % zone.polygon.length]; return sum + p[0] * q[1] - q[0] * p[1];
  }, 0));
  return zones.filter(zone => eye[1] >= zone.minY && eye[1] <= zone.maxY && containsXZPolygon(zone.polygon, eye, .035)).sort((a, b) => area(a) - area(b))[0];
}

export function selectInteriorLights(data: InteriorLightingData, eye: Vec3, lowQuality: boolean, planMode = false, previous: string[] = []): InteriorPractical[] {
  if (planMode) return [];
  const zone = interiorZoneAt(data.zones, eye);
  if (!zone) return [];
  const distanceSquared = (light: InteriorPractical) => light.position.reduce((sum, v, i) => sum + (v - eye[i]) ** 2, 0);
  const score = (light: InteriorPractical) => distanceSquared(light) - (light.roomId === zone.id ? 1.5 : 0) - (previous.includes(light.id) ? 1 : 0);
  return data.lights.filter(light => light.group === zone.group && distanceSquared(light) <= (light.distance + .5) ** 2)
    .sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id))
    .slice(0, data.quality[lowQuality ? 'low' : 'high'].maxLights);
}
