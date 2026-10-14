import type { Quaternion, Vec3 } from './schema';

export const INTERACTION_DISTANCE = 2.5;
export interface InteractionCandidate {
  id:string;
  position:Vec3;
  visible:boolean;
  directHit?:boolean;
  distanceM?:number;
}

/** Select what the user is looking at, after the caller proves line of sight. */
export function selectInteractionTarget(eye:Vec3, forward:Vec3, candidates:InteractionCandidate[], preferredId?:string):string|null {
  // A passenger aiming through the car entrance needs the elevator controls,
  // even when the ray also reaches a room door across the landing.
  if(preferredId){
    const preferred=selectInteractionTarget(eye,forward,candidates.filter(candidate=>candidate.id===preferredId));
    if(preferred)return preferred;
  }
  const forwardLength=Math.hypot(...forward);
  if(forwardLength<1e-6)return null;
  let selected:string|null=null,best=Infinity;
  for(const candidate of candidates){
    if(!candidate.visible)continue;
    const delta=candidate.position.map((value,index)=>value-eye[index]);
    const centerDistance=Math.hypot(...delta);
    const distance=candidate.distanceM??centerDistance;
    if(distance>INTERACTION_DISTANCE||centerDistance<1e-6)continue;
    const alignment=delta.reduce((sum,value,index)=>sum+value*forward[index],0)/(centerDistance*forwardLength);
    if(!candidate.directHit&&alignment<Math.cos(Math.PI/4))continue;
    const score=(candidate.directHit?-100:0)+(1-alignment)*10+distance*.04;
    if(score<best){best=score;selected=candidate.id;}
  }
  return selected;
}

/** Aim at the current leaf, near eye height rather than its old floor origin. */
export function doorAimPoint(center:Vec3, halfExtents:Vec3, rotation:Quaternion, eye:Vec3):Vec3 {
  const [x,y,z,w]=rotation;
  const verticalHalf=Math.abs(2*(x*y+z*w))*halfExtents[0]+Math.abs(1-2*(x*x+z*z))*halfExtents[1]+Math.abs(2*(y*z-x*w))*halfExtents[2];
  const inset=Math.min(.08,verticalHalf*.25);
  return [center[0],Math.max(center[1]-verticalHalf+inset,Math.min(center[1]+verticalHalf-inset,eye[1])),center[2]];
}

/** The exposed jamb pull remains reachable when a pocket leaf is in its wall.
 * Keep the target 8cm inside the clear aperture; callers still test line of sight. */
export function slidingDoorPullPoint(center:Vec3, halfExtents:Vec3, direction:Vec3, travel:number, eye:Vec3):Vec3 {
  const offset=Math.sign(travel)*Math.max(0,halfExtents[0]-.08);
  return [center[0]+direction[0]*offset,
    Math.max(center[1]-halfExtents[1]+.08,Math.min(center[1]+halfExtents[1]-.08,eye[1])),
    center[2]+direction[2]*offset];
}
