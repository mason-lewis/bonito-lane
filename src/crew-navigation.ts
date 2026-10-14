/** Small clearance grid, with continuous segment validation and no corner cuts. */
export type YardPoint = [number, number];
export interface YardSurface { y:number; nx:number; ny:number; nz:number }
export interface CrewYard { min:YardPoint; max:YardPoint; step:number; radius:number; groundY:number; roads:{points:YardPoint[];width:number}[]; plants:{center:YardPoint;radius:number}[] }
export function segmentDistance(p:YardPoint,a:YardPoint,b:YardPoint):number {
  const dx=b[0]-a[0],dz=b[1]-a[1],d=dx*dx+dz*dz;
  const t=d?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/d)):0;
  return Math.hypot(p[0]-a[0]-dx*t,p[1]-a[1]-dz*t);
}
export class CrewNavigation {
  readonly cells:YardPoint[]=[];
  private grid=new Map<string,YardPoint>();
  readonly yard:CrewYard;
  private placement:(p:YardPoint)=>boolean;
  readonly surface:(p:YardPoint)=>YardSurface|null;
  constructor(yard:CrewYard,placement:(p:YardPoint)=>boolean,surface:(p:YardPoint)=>YardSurface|null){
    this.yard=yard;this.placement=placement;this.surface=surface;
    for(let x=yard.min[0];x<=yard.max[0];x+=yard.step)for(let z=yard.min[1];z<=yard.max[1];z+=yard.step){const p:YardPoint=[x,z];if(this.safe(p)){this.cells.push(p);this.grid.set(this.key(p),p);}}
  }
  private key(p:YardPoint){return `${Math.round((p[0]-this.yard.min[0])/this.yard.step)},${Math.round((p[1]-this.yard.min[1])/this.yard.step)}`;}
  safe(p:YardPoint):boolean {
    const {yard}=this;
    if(p[0]<yard.min[0]||p[1]<yard.min[1]||p[0]>yard.max[0]||p[1]>yard.max[1])return false;
    if(yard.plants.some(q=>Math.hypot(p[0]-q.center[0],p[1]-q.center[1])<yard.radius+q.radius))return false;
    for(const r of yard.roads)for(let i=1;i<r.points.length;i++)if(segmentDistance(p,r.points[i-1],r.points[i])<r.width/2+yard.radius+.5)return false;
    const s=this.surface(p);return !!s&&s.ny>.96&&this.placement(p);
  }
  clear(a:YardPoint,b:YardPoint):boolean {
    const count=Math.max(1,Math.ceil(Math.hypot(a[0]-b[0],a[1]-b[1])/.12));let prev=this.surface(a);
    for(let i=0;i<=count;i++){
      const t=i/count,p:YardPoint=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];if(!this.safe(p))return false;
      const s=this.surface(p)!;if(prev&&Math.abs(s.y-prev.y)>.035)return false;prev=s;
    }return true;
  }
  nearest(p:YardPoint):YardPoint|undefined {return this.cells.reduce<YardPoint|undefined>((best,q)=>!best||Math.hypot(q[0]-p[0],q[1]-p[1])<Math.hypot(best[0]-p[0],best[1]-p[1])?q:best,undefined);}
  route(start:YardPoint,end:YardPoint):YardPoint[]|null {
    if(!this.safe(start)||!this.safe(end))return null;
    if(this.clear(start,end))return [end];
    const a=this.nearest(start),b=this.nearest(end);if(!a||!b||!this.clear(start,a)||!this.clear(b,end))return null;
    const dist=(p:YardPoint,q:YardPoint)=>Math.hypot(p[0]-q[0],p[1]-q[1]);
    const open=[a],cost=new Map([[this.key(a),0]]),parents=new Map<string,YardPoint>();let found=false;
    while(open.length){
      open.sort((p,q)=>(cost.get(this.key(p))!+dist(p,b))-(cost.get(this.key(q))!+dist(q,b)));const p=open.shift()!,pk=this.key(p);
      if(pk===this.key(b)){found=true;break;}
      for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
        const q=this.grid.get(this.key([p[0]+dx*this.yard.step,p[1]+dz*this.yard.step]));if(!q||!this.clear(p,q))continue;
        const k=this.key(q),g=cost.get(pk)!+dist(p,q);if(g>=(cost.get(k)??Infinity))continue;
        cost.set(k,g);parents.set(k,p);if(!open.includes(q))open.push(q);
      }
    }
    if(!found)return null;
    const points:YardPoint[]=[b,end];let q=b;
    while(this.key(q)!==this.key(a)){q=parents.get(this.key(q))!;points.unshift(q);}
    // Shortcut only through swept, validated clear space.
    const result:YardPoint[]=[];let current=start;
    for(let i=0;i<points.length;){let j=points.length-1;while(j>i&&!this.clear(current,points[j]))j--;result.push(points[j]);current=points[j];i=j+1;}
    return result;
  }
}
