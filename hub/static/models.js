// Isometric artwork from the approved HUD. No demo data or behavior.

const C30=0.866, S30=0.5;
const P=(x,y,z)=>[ (x-y)*C30, (x+y)*S30 - z ];
const poly=(pts,cls,extra='')=>`<polygon class="${cls}" points="${pts.map(p=>p.join(',')).join(' ')}" ${extra}/>`;
function box(x0,y0,w,d,h,tone='a',cls='face'){
  const T=[P(x0,y0,h),P(x0+w,y0,h),P(x0+w,y0+d,h),P(x0,y0+d,h)];
  const L=[P(x0,y0+d,0),P(x0+w,y0+d,0),P(x0+w,y0+d,h),P(x0,y0+d,h)];
  const R=[P(x0+w,y0,0),P(x0+w,y0+d,0),P(x0+w,y0+d,h),P(x0+w,y0,h)];
  const F={a:['#f8fafc','#dbe2ea','#c3ccd8'],b:['#eef2ff','#c7d2fe','#a5b4fc'],c:['#f1f5f9','#cbd5e1','#94a3b8']}[tone];
  return poly(L,cls,`fill="${F[1]}" stroke="#94a3b8" stroke-width=".8"`)+poly(R,cls,`fill="${F[2]}" stroke="#94a3b8" stroke-width=".8"`)+poly(T,cls,`fill="${F[0]}" stroke="#94a3b8" stroke-width=".8"`);
}
const led=(x,y,z)=>{const p=P(x,y,z);return `<circle class="ledglow" cx="${p[0]}" cy="${p[1]}" r="6"/><circle class="led" cx="${p[0]}" cy="${p[1]}" r="2.6"/>`};
const ghost=()=>box(-18,-18,36,36,30,'c');
const ISO={
  gw(){return box(-30,-20,60,40,10,'b')+ `<path d="${['M',...P(-16,-6,10),'L',...P(-16,-6,40)].join(' ')} ${['M',...P(16,-6,10),'L',...P(16,-6,40)].join(' ')}" stroke="#64748b" stroke-width="2" stroke-linecap="round" fill="none"/>`+led(22,20,6)},
  sw(){let s=box(-38,-14,76,28,9,'a');for(let i=0;i<8;i++){const p=P(-30+i*8.5,14,4.5);s+=`<rect class="port" style="--bd:${(1.1+Math.random()*1.6).toFixed(2)}s;--bdl:${(Math.random()*2).toFixed(2)}s" x="${p[0]-1.5}" y="${p[1]-1.5}" width="3" height="3" fill="${i%3===0?'#f59e0b':'#22c55e'}"/>`}return s+led(36,14,4.5)},
  srv(){let s=box(-18,-16,36,32,54,'a');for(let i=0;i<4;i++){const a=P(-15,16,10+i*11),b=P(15,16,10+i*11);s+=`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#94a3b8" stroke-width="1.2"/>`;const q=P(12,16,13+i*11);s+=`<circle class="hdd" style="--bdl:${(Math.random()*1.1).toFixed(2)}s" cx="${q[0]}" cy="${q[1]}" r="1.4" fill="#22c55e"/>`}return s+led(18,12,48)},
  nas(){let s=box(-16,-15,32,30,40,'a');for(let i=0;i<2;i++){const a=P(-10+i*11,15,6),b=P(-10+i*11,15,34);s+=`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#94a3b8" stroke-width="3" stroke-linecap="round"/>`;const q=P(-10+i*11,15,36);s+=`<circle class="hdd" style="--bdl:${(Math.random()*1.1).toFixed(2)}s" cx="${q[0]}" cy="${q[1]}" r="1.4" fill="#f59e0b"/>`}return s+led(16,10,34)},
  tv(){return box(-10,-6,20,12,6,'c')+box(-32,-2,64,4,40,'b')+`<polygon class="screen" points="${[P(-28,-2,36),P(28,-2,36),P(28,-2,10),P(-28,-2,10)].map(p=>p.join(',')).join(' ')}" fill="#312e81"/>`+led(26,2,8)},
  pr(){return box(-24,-18,48,36,20,'a')+`<polygon class="paper" points="${[P(-14,-8,20),P(10,-8,20),P(10,8,20),P(-14,8,20)].map(p=>p.join(',')).join(' ')}" fill="#fff" stroke="#94a3b8" stroke-width=".8"/>`+led(24,10,14)},
  cam(){const d=P(0,0,16);return box(-12,-12,24,24,14,'c')+`<ellipse cx="${d[0]}" cy="${d[1]-4}" rx="11" ry="9" fill="#e2e8f0" stroke="#94a3b8" stroke-width=".8"/><ellipse class="lens" cx="${d[0]}" cy="${d[1]-4}" rx="5" ry="4" fill="#1e293b"/><circle class="rec" cx="${d[0]+8}" cy="${d[1]-10}" r="1.6" fill="#ef4444"/>`+led(12,8,8)},
  lap(){return box(-26,-18,52,36,4,'a')+box(-26,-18,52,3,34,'b')+`<polygon class="screen" points="${[P(-22,-18,31),P(22,-18,31),P(22,-18,8),P(-22,-18,8)].map(p=>p.join(',')).join(' ')}" fill="#312e81"/>`+led(26,10,3)},
  ph(){return box(-10,-20,20,40,3,'a')+`<polygon class="screen" points="${[P(-8,-17,3),P(8,-17,3),P(8,17,3),P(-8,17,3)].map(p=>p.join(',')).join(' ')}" fill="#312e81"/>`+led(10,18,2)},
  wifi(){const b=P(0,0,0);let s=box(-10,-10,20,20,8,'c');[14,24,34].forEach((r,i)=>{s+=`<path class="arc a${i+1}" d="M ${b[0]-r} ${b[1]-18-i*2} A ${r} ${r*0.55} 0 0 1 ${b[0]+r} ${b[1]-18-i*2}" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round"/>`});return s+led(10,10,4)},
  inet(){return `<g class="face cloud"><ellipse cx="-14" cy="-18" rx="18" ry="13" fill="#eef2ff" stroke="#a5b4fc" stroke-width="1"/><ellipse cx="8" cy="-24" rx="20" ry="15" fill="#eef2ff" stroke="#a5b4fc" stroke-width="1"/><ellipse cx="22" cy="-14" rx="15" ry="11" fill="#eef2ff" stroke="#a5b4fc" stroke-width="1"/><rect x="-30" y="-16" width="62" height="12" rx="6" fill="#eef2ff"/><path d="M-30-6h62" stroke="#a5b4fc" stroke-width="1"/></g>`+led(0,0,0).replace('r="6"','r="7"')},
  unk(){return ghost()},
};
function isoSVG(type,isGhost,acc){const inner=isGhost?ghost():ISO[type]();const sh=P(0,0,0);
  return `<svg class="iso" viewBox="-70 -78 140 104"><ellipse class="plate" cx="${sh[0]}" cy="${sh[1]+8}" rx="44" ry="16"/><ellipse class="shadow" cx="${sh[0]}" cy="${sh[1]+6}" rx="34" ry="11"/><g class="life"><g transform="translate(0,-6)">${inner}</g></g><rect class="scan" x="-48" y="-8" width="96" height="1.6" rx=".8" fill="var(--accent)"/></svg>`}
