import type {CrewNavigation,YardPoint} from './crew-navigation';
export type CrewState='Idle'|'Walk'|'Sniff'|'LookAround';
/** Fixed-step calm roaming. Every move stays on a continuously checked route. */
export class CrewBehavior {
  state:CrewState='Idle';timer=2;speed=0;heading=0;elapsed=0;cycles=0;blocked=0;distance=0;path:YardPoint[]=[];position:YardPoint;
  readonly nominalSpeed=.52/(34/30);readonly acceleration=.36;
  private accumulator=0;
  private random:()=>number;private nav:CrewNavigation;
  constructor(nav:CrewNavigation,start:YardPoint,random:()=>number=Math.random){this.nav=nav;this.position=[...start];this.random=random;}
  private pause(){
    this.path=[];this.speed=0;this.cycles++;this.timer=3+this.random()*6;
    const choice=this.random();this.state=choice<.45?'Sniff':choice<.75?'LookAround':'Idle';
  }
  private choose(){
    for(let attempt=0;attempt<28;attempt++){
      const goal=this.nav.cells[Math.floor(this.random()*this.nav.cells.length)];
      if(Math.hypot(goal[0]-this.position[0],goal[1]-this.position[1])<2)continue;
      const route=this.nav.route(this.position,goal);if(route){this.path=route;this.state='Walk';return;}
    }this.state='Idle';this.timer=2;this.blocked++;
  }
  resetTime(){this.accumulator=0;}
  update(dt:number){this.accumulator+=Math.min(dt,.1);while(this.accumulator>=1/60){this.step(1/60);this.accumulator-=1/60;}}
  step(dt:number){
    this.elapsed+=dt;this.timer-=dt;
    if(!this.path.length){this.speed=Math.max(0,this.speed-this.acceleration*dt);if(this.timer<=0)this.choose();}
    if(!this.path.length)return;
    const target=this.path[0],dx=target[0]-this.position[0],dz=target[1]-this.position[1],remaining=Math.hypot(dx,dz);
    const desired=Math.atan2(dx,dz);let angle=Math.atan2(Math.sin(desired-this.heading),Math.cos(desired-this.heading));
    this.heading+=Math.max(-.72*dt,Math.min(.72*dt,angle));angle=Math.atan2(Math.sin(desired-this.heading),Math.cos(desired-this.heading));
    const limit=Math.abs(angle)>.12?0:Math.min(this.nominalSpeed,Math.sqrt(2*this.acceleration*Math.max(0,remaining-.008)));
    this.speed+=Math.max(-this.acceleration*dt,Math.min(this.acceleration*dt,limit-this.speed));
    const travel=Math.min(remaining,this.speed*dt),next:YardPoint=[this.position[0]+dx/Math.max(remaining,1e-6)*travel,this.position[1]+dz/Math.max(remaining,1e-6)*travel];
    if(!this.nav.clear(this.position,next)){this.path=[];this.state='Idle';this.timer=1.5;this.blocked++;this.speed=0;return;}
    this.position=next;this.distance+=travel;
    if(remaining<.015&&this.speed<.11){this.path.shift();if(!this.path.length)this.pause();}
  }
}
