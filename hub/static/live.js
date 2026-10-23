'use strict';
/* The hub is the only source of operational data. Artwork lives in models.js. */
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when = value => value ? new Date(value * 1000).toLocaleString() : 'Not reported';
const severity = e => e.severity === 'critical' ? 'bad' : ['bad', 'warn'].includes(e.severity) ? 'warn' : 'info';
const state = {devices: [], events: [], summary: null, status: null, selected: null, board: null, view: 'map', failed: false};
let cam = {x: 0, y: 0, s: 1}, boardCam = {x: 0, y: 0, s: 1}, initial = true, mapKey = '', boardKey = '';
let selectionRequest = 0;
async function api(path, options) {
  const response = await fetch(path, {...options, signal: AbortSignal.timeout(8000), cache: 'no-store'});
  if (!response.ok) throw new Error(`Hub returned ${response.status}`);
  return response.json();
}
function guess(d) {
  const s = [d.hostname, d.name, d.vendor, d.os, ...(d.names || []), ...(d.ports || []).map(p => `${p.service || ''} ${p.product || ''}`)].join(' ').toLowerCase();
  const ports = new Set((d.ports || []).map(p => p.port));
  if (/router|gateway|dream.machine|mikrotik|openwrt|pfsense|opnsense/.test(s) || (/ubiquiti|netgear|tp.?link|asus/.test(s) && /\.1$/.test(d.ip || '') && [53,80,443].some(p=>ports.has(p)))) return ['gw', 'Gateway'];
  if (/printer|laserjet|deskjet|epson|brother/.test(s) || ports.has(9100) || ports.has(631)) return ['pr', 'Printer'];
  if (/camera|hikvision|reolink|dahua|rtsp/.test(s) || ports.has(554)) return ['cam', 'Camera'];
  if (/synology|qnap|truenas|diskstation|\bnas\b/.test(s)) return ['nas', 'NAS'];
  if (/bravia|smart.?tv|samsung.*tv|roku|chromecast|apple.?tv|tizen/.test(s) || ports.has(8008)) return ['tv', 'TV / media'];
  if (/iphone|ipad|android|pixel|galaxy|\bios\b/.test(s)) return ['ph', 'Phone / tablet'];
  if (/macbook|mac.?os|darwin|imac|windows|laptop|notebook/.test(s)) return ['lap', 'Computer'];
  if (/switch/.test(s)) return ['sw', 'Switch'];
  if (/access.point|unifi.*ap|wi-?fi/.test(s)) return ['wifi', 'Access point'];
  if (/linux|ubuntu|debian|server|freebsd/.test(s)) return ['srv', 'Server'];
  return ['unk', 'Unknown device'];
}
function deviceState(d) {
  const recent = state.events.filter(e => e.device_id === d.id && e.at > Date.now()/1000 - 86400);
  if (recent.some(e => e.severity === 'critical')) return 'bad';
  if ((d.risky || []).length || recent.some(e => ['bad','warn'].includes(e.severity))) return 'warn';
  return d.online ? 'ok' : 'offline';
}
function model(d) { const [ic, type] = guess(d); return {...d, ic, type, h: deviceState(d)}; }
function pill(value, label, color) { return `<div class="pill glass">${color ? `<span class="c" style="background:var(--${color})"></span>` : ''}<b>${esc(value)}</b>${esc(label)}</div>`; }
function eventHTML(events) {
  return events.length ? events.map(e => `<div class="event ${severity(e)}"><i></i><div><time>${esc(when(e.at))} · ${esc(e.kind)} · ${esc(e.severity)}</time><p>${esc(e.detail || 'No additional detail')}</p>${e.device ? `<small class="muted">${esc(e.device)}</small>` : ''}</div></div>`).join('') : '<p class="muted">No events reported.</p>';
}
function facts(d) {
  return `<dl class="facts">${[['IP',d.ip],['MAC',d.mac],['Vendor',d.vendor],['Hostname',d.hostname],['OS',d.os],['Names',(d.names || []).join(', ')],['First seen',when(d.first_seen)],['Last seen',when(d.last_seen)],['Port scan',when(d.ports_scanned)],['Sentry',d.sentry]].map(([k,v]) => `<dt>${k}</dt><dd>${esc(v || 'Not reported')}</dd>`).join('')}</dl>`;
}
function portsHTML(d) {
  return (d.ports || []).length ? `<table class="live-table"><thead><tr><th>Port</th><th>Service / product</th></tr></thead><tbody>${d.ports.map(p => `<tr><td>${esc(p.port)}/${esc(p.proto)}</td><td>${esc([p.service,p.product,p.version].filter(Boolean).join(' · ') || 'Unknown service')}</td></tr>`).join('')}</tbody></table>` : `<p class="muted">${d.ports_scanned ? 'No open ports in the last scan.' : 'Ports not scanned yet.'}</p>`;
}
function labelForm(d) { return `<form class="label-form" data-label="${d.id}"><input name="label" aria-label="Device label" placeholder="Name this device" maxlength="200" value="${esc(d.label || '')}"><button class="btn p" type="submit">Save</button></form><div class="label-result" role="status"></div>`; }
function bindLabel(root, d) {
  const form = root.querySelector('[data-label]'); if (!form) return;
  form.onsubmit = async event => {
    event.preventDefault(); const button = form.querySelector('button'); const result = root.querySelector('.label-result'); button.disabled = true;
    try {
      await api(`/api/devices/${d.id}/label`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:form.elements.label.value})});
      result.textContent = 'Label saved.'; await refresh();
    } catch (e) { result.textContent = `Label not saved. ${e.message}`; }
    finally { button.disabled = false; }
  };
}
function paintCamera(world, camera) {
  world.style.transform = `translate(${camera.x}px,${camera.y}px) scale(${camera.s})`;
  world.style.setProperty('--inv', Math.min(1.5, Math.max(1,1/camera.s)).toFixed(2));
}
function fitMap() {
  const points = state.devices;
  if (!points.length) return;
  const left = innerWidth > 1000 ? 350 : innerWidth > 650 ? 290 : 80;
  const minX = Math.min(...points.map(d=>d.x))-110, maxX = Math.max(...points.map(d=>d.x))+110;
  const minY = Math.min(...points.map(d=>d.y))-130, maxY = Math.max(...points.map(d=>d.y))+100;
  const s = Math.max(.12, Math.min(1.3,(innerWidth-left-45)/(maxX-minX),(innerHeight-250)/(maxY-minY)));
  cam = {s, x:left+(innerWidth-left-45-(maxX-minX)*s)/2-minX*s, y:150+(innerHeight-250-(maxY-minY)*s)/2-minY*s};
  paintCamera($('world'),cam);
}
function positionDevices(devices) {
  const gateway = devices.find(d => d.ic === 'gw');
  if (gateway) { gateway.x=1200; gateway.y=700; }
  const rest = devices.filter(d=>d!==gateway).sort((a,b)=>a.id-b.id);
  // Inferred hub-and-spoke only when an actual gateway candidate exists.
  rest.forEach((d,i) => { const ring=Math.floor(i/10), slot=i%10, count=Math.min(10,rest.length-ring*10); const angle=-Math.PI/2+slot*2*Math.PI/count; d.x=1200+Math.cos(angle)*(400+ring*300); d.y=700+Math.sin(angle)*(285+ring*210); });
  if (!gateway && rest.length === 1) { rest[0].x=1200; rest[0].y=700; }
  return gateway;
}
function renderMap() {
  const gateway=positionDevices(state.devices);
  const key=JSON.stringify(state.devices.map(d=>[d.id,d.name,d.ip,d.ic,d.h,d.online,d.x,d.y]));
  if (key !== mapKey) {
    mapKey=key; $('world').querySelectorAll('.dev').forEach(e=>e.remove()); $('links').innerHTML=''; $('list').innerHTML='';
    for (const d of state.devices) {
      const node=document.createElement('button'); node.type='button'; node.id='d-'+d.id; node.className=`dev seen ${d.h} ${d.online?'':'offline'}`; node.style.left=d.x+'px'; node.style.top=d.y+'px'; node.style.setProperty('--d',(-d.id*.27)+'s');
      node.innerHTML=isoSVG(d.ic,false)+`<span class="lbl"><b>${esc(d.name || d.ip)}</b><span>${esc(d.type)} · ${esc(d.ip)}</span></span>`;
      node.title=`${d.name || d.ip} · ${d.online?'Online':'Offline'} · Type inferred\nDouble-click to open Board`;
      node.onclick=()=>{ if (!mapDragged) inspectDevice(d.id); }; node.ondblclick=()=>openBoard(d.id);
      node.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();openBoard(d.id)}}; $('world').appendChild(node);
      const item=document.createElement('button'); item.className=`li seen done ${d.h} ${d.online?'':'offline'}`; item.innerHTML=`<span class="k"></span><span class="nm">${esc(d.name || d.ip)}</span>`;
      item.onclick=()=>openBoard(d.id); $('list').appendChild(item);
      if (gateway && gateway!==d) {
        const path=document.createElementNS('http://www.w3.org/2000/svg','path'); const mid=(gateway.x+d.x)/2;
        path.setAttribute('d',`M${gateway.x} ${gateway.y} H${mid} V${d.y} H${d.x}`); path.setAttribute('class',`link drawn ${d.h} ${d.online?'':'offline'}`); $('links').appendChild(path);
      }
    }
    if(initial && state.devices.length){fitMap();initial=false;}
  }
  $('empty').hidden = !!state.devices.length;
  $('listpanel').hidden = !state.devices.length;
  const summary=state.summary;
  $('empty').querySelector('h2').textContent=summary.sentries.length ? 'No devices reported yet' : 'Waiting for the first sentry report';
  $('counts').innerHTML=pill(summary.devices,'discovered')+pill(summary.online,'online','ok')+pill(summary.risky_ports,'risky ports','warn');
  const latest=Math.max(0,...summary.sentries.map(s=>s.last_seen || 0));
  $('eyes').textContent=`${summary.sentries.length} sentry reports · last seen ${when(latest)}. Types & links are inferred; physical paths and traffic are not measured.`;
  if(state.devices.length) $('say').textContent='Double-click to go inside · types & links inferred · no traffic telemetry';
}
async function inspectDevice(id) {
  const request=++selectionRequest; state.selected=id;
  try {
    const d=model(await api('/api/devices/'+id)); if(request!==selectionRequest || state.board) return;
    $('inspect').innerHTML=`<button class="x" aria-label="Close">×</button><div class="scroll"><div class="detail-title">${isoSVG(d.ic,false)}<h3>${esc(d.name)}</h3></div><p><span class="status ${d.h}">${d.online?'Online':'Offline'}</span> <span class="muted">· ${esc(d.type)} (inferred)</span></p>${facts(d)}${labelForm(d)}<h4>Open ports</h4>${portsHTML(d)}<h4>Recent events</h4>${eventHTML(d.events || [])}<button class="btn p" data-board>Go inside →</button></div>`;
    $('inspect').classList.add('on'); $('inspect').querySelector('.x').onclick=closeInspect; $('inspect').querySelector('[data-board]').onclick=()=>openBoard(id); bindLabel($('inspect'),d);
  } catch(e) { showError(e); }
}
function closeInspect(){++selectionRequest;state.selected=null;$('inspect').classList.remove('on');}
function setView(view) {
  state.view=view; closeInspect();
  document.querySelectorAll('.rail [data-view]').forEach(b=>b.classList.toggle('on',b.dataset.view===view));
  document.body.classList.toggle('view-other',view!=='map'); $('view').classList.toggle('on',view!=='map');
  if(view!=='map')renderView();
}
function renderView() {
  const titles={table:'Devices',security:'Security',alerts:'Needs attention',report:'Observed events',people:'People',policies:'Policies & procedures',tickets:'Tickets',tonight:'Tonight'};
  $('view-title').textContent=titles[state.view] || state.view;
  if(state.view==='table') {
    $('view-body').innerHTML='<p class="topology-note">Device types are inferred from reported identity and services.</p><table class="live-table"><thead><tr><th>Device</th><th>IP</th><th>Type</th><th>State</th><th>Ports</th></tr></thead><tbody>'+state.devices.map(d=>`<tr data-device="${d.id}" tabindex="0"><td>${esc(d.name)}</td><td>${esc(d.ip)}</td><td>${esc(d.type)}</td><td><span class="status ${d.h}">${d.online?'Online':'Offline'}${d.h==='warn'?' · warning':d.h==='bad'?' · critical event':''}</span></td><td>${esc(d.ports.length)}</td></tr>`).join('')+'</tbody></table>';
    $('view-body').querySelectorAll('[data-device]').forEach(e=>{e.onclick=()=>openBoard(Number(e.dataset.device));e.onkeydown=k=>{if(k.key==='Enter')e.click()}});
  } else if(['security','alerts','report'].includes(state.view)) {
    const events=state.events.filter(e=>state.view==='report'||severity(e)!=='info');
    const risky=state.view==='security'?state.devices.filter(d=>d.risky.length):[];
    $('view-body').innerHTML='<p class="live-note">Reported observations only. No remediation, intrusion detector, or internet exposure measurement is connected. Risky ports are not proof of compromise.</p>'+risky.map(d=>`<div class="event warn"><i></i><div><b>${esc(d.name)}</b><p>Risky open ports: ${esc(d.risky.join(', '))}</p><button class="btn" data-device="${d.id}">Open Board</button></div></div>`).join('')+eventHTML(events);
    $('view-body').querySelectorAll('[data-device]').forEach(e=>e.onclick=()=>openBoard(Number(e.dataset.device)));
  } else $('view-body').innerHTML=`<div class="not-connected"><h3>Not connected yet</h3><p>${esc(titles[state.view])} have no data source in this hub.</p><p>No sample data is shown.</p></div>`;
}
function showError(e) { if(state.board!==null)$('bx-crumb').textContent='Hub unavailable — showing last report'; $('st').textContent=`Hub unavailable — ${e.message}. Retrying…`; $('status-dot').style.background='var(--warn)'; }
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [devices, events, summary, status]=await Promise.all([api('/api/devices'),api('/api/events?limit=1000'),api('/api/summary'),api('/api/status')]);
    state.events=events; state.summary=summary; state.status=status; state.devices=devices.map(model); state.failed=false;
    $('st').textContent=status.summary; $('status-dot').style.background=`var(--${{ok:'ok',warn:'warn',bad:'bad'}[status.level] || 'ink-3'})`;
    renderMap(); if(state.view!=='map')renderView();
    if(state.board!==null) await updateBoard(state.board);
    // Keep label input stable while it is being edited; metadata refreshes on reopen.
    if(state.selected!==null && !$('inspect').contains(document.activeElement)) await inspectDevice(state.selected);
  } catch(e) { state.failed=true; showError(e); $('say').textContent='Connection lost. Displaying the last received data; retrying every 10 seconds.'; }
  finally { refreshing = false; }
}
/* Board: approved PCB visual grammar, populated only from observed device data. */
function boardFit() {
  const s=Math.max(.14,Math.min(.85,(innerWidth-55)/2200,(innerHeight-245)/1100));
  boardCam={s,x:(innerWidth-2400*s)/2,y:150-150*s};paintCamera($('bx-world'),boardCam);
}
let savedMapCamera = null;
async function openBoard(id) {
  if (state.board === null) savedMapCamera = {...cam};
  closeInspect();state.board=id;boardKey='';document.body.classList.add('bx-zoom');
  const device = state.devices.find(d=>d.id===id);
  if (device && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    paintCamera($('world'),{s:7,x:innerWidth/2-device.x*7,y:innerHeight/2-device.y*7});
    setTimeout(()=>{if(state.board===id)document.body.classList.add('bx-on')},420);
  } else document.body.classList.add('bx-on');
  $('bx-crumb').textContent='Loading device…';$('bx-insp').classList.remove('on');$('bx-world').querySelectorAll('.fp,.pin').forEach(e=>e.remove());$('bx-pcb').innerHTML='';
  boardFit();await updateBoard(id);
}
function closeBoard(){state.board=null;boardKey='';document.body.classList.remove('bx-on','bx-zoom');if(savedMapCamera){cam=savedMapCamera;paintCamera($('world'),cam);savedMapCamera=null;}}
function boardPart(id,x,y,kind,name,met,ref,h,onClick) {
  const el=document.createElement('div');el.className=`fp ${kind} ${h || ''}`;el.id='bx-n-'+id;el.style.left=x+'px';el.style.top=y+'px';el.tabIndex=0;el.role='button';
  el.innerHTML=`<div class="body"><span class="ref">${esc(ref)}</span><b>${esc(name)}</b><div class="met">${esc(met)}</div></div>`;
  el.onclick=()=>{if(!boardDragged)onClick()};el.onkeydown=e=>{if(e.key==='Enter')onClick()};$('bx-world').appendChild(el);
}
function boardInspector(title,body,bind) {
  $('bx-insp').innerHTML=`<button class="bx-x" aria-label="Close details">×</button><div class="scroll"><span class="ref">HUB OBSERVATION</span><h3>${esc(title)}</h3>${body}</div>`;
  $('bx-insp').querySelector('.bx-x').onclick=()=>$('bx-insp').classList.remove('on');$('bx-insp').classList.add('on');if(bind)bind();
}
async function updateBoard(id) {
  try {
    const d=model(await api('/api/devices/'+id));if(state.board!==id)return;
    $('bx-crumb').textContent='Network › '+d.name;
    const key=JSON.stringify(d);if(key===boardKey)return;boardKey=key;
    $('bx-pills').innerHTML=pill(d.ports.length,'open ports','ok')+pill(d.risky.length,'risky','warn')+pill(d.events.filter(e=>e.severity==='critical').length,'critical events','bad');
    const world=$('bx-world'),pcb=$('bx-pcb');world.querySelectorAll('.fp,.pin').forEach(e=>e.remove());
    const add=html=>pcb.insertAdjacentHTML('beforeend',html);
    const height=Math.max(1000,300+d.ports.length*105); // all observed ports remain accessible by panning
    addBoard();
    function addBoard(){
      pcb.innerHTML=`<defs><pattern id="bx-bg" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1" fill="#e2e8f0"/></pattern></defs><rect class="board" x="560" y="200" width="1500" height="${height}" rx="18"/><rect x="560" y="200" width="1500" height="${height}" rx="18" fill="url(#bx-bg)"/>`;
      [[588,228],[2032,228],[588,172+height],[2032,172+height]].forEach(([x,y])=>add(`<circle class="hole" cx="${x}" cy="${y}" r="11"/>`));
      add(`<text class="silk big" x="2020" y="234" text-anchor="end">${esc((d.os || 'OS NOT REPORTED')+' · '+d.ip)}</text><text class="silk" x="548" y="262">J1 · OBSERVED PORTS</text><text class="silk" x="80" y="270">REPORTED EVENTS</text><text class="silk" x="1020" y="${155+height}">LOGICAL SERVICE BOARD · NOT A HARDWARE INVENTORY</text>`);
    }
    const trace=(x1,y1,x2,y2,cls='')=>{const mid=(x1+x2)/2;add(`<path class="tr-c ${cls}" d="M${x1} ${y1} H${mid} V${y2} H${x2}"/>`);add(`<circle class="via" cx="${mid}" cy="${y2}" r="4"/>`)};
    boardPart('door',330,150,'door','Your network','back out to the map','J0','',closeBoard);trace(430,150,560,300);
    boardPart('identity',1220,610,'chip',d.name,d.vendor || 'Vendor not reported','U1 · DEVICE',d.h,()=>boardInspector(d.name,`<p class="k">${esc(d.type)} · inferred</p>${facts(d)}${labelForm(d)}`,()=>bindLabel($('bx-insp'),d)));
    boardPart('identity-net',1780,420,'',d.ip,d.mac || 'MAC not reported','U2 · NETWORK',d.online?'ok':'',()=>boardInspector('Network identity',facts(d)));
    boardPart('os',1780,660,'',d.os || 'OS not reported',d.vendor || 'Vendor not reported','U3 · FINGERPRINT','',()=>boardInspector('Fingerprint',facts(d)));
    boardPart('telemetry',1610,1000,'issue','Resource telemetry','Not connected yet','UNAVAILABLE','',()=>boardInspector('Not connected yet','<p class="k">No CPU, memory, processes, storage, or agent telemetry is reported by this hub.</p>'));
    boardPart('history',1120,1000,'',`${d.events.length} recent events`,'observations from the hub','U4 · EVENT LOG',d.h,()=>boardInspector('Device events',eventHTML(d.events)));
    trace(1335,560,1700,420);trace(1335,650,1700,660);trace(1220,725,1120,1000);trace(1310,725,1610,1000);
    if(!d.ports.length){const el=document.createElement('div');el.className='pin none';el.style.left='538px';el.style.top='340px';el.innerHTML=`<span class="pad">—</span><span class="lb">${d.ports_scanned?'no open ports':'not scanned yet'}</span>`;world.appendChild(el);}
    d.ports.forEach((p,i)=>{
      const y=330+i*105, service=p.service || 'Unknown service', risk=d.risky.includes(p.port);
      const pin=document.createElement('button');pin.className='pin';pin.style.left='538px';pin.style.top=y+'px';pin.style.border='0';pin.style.background='none';pin.innerHTML=`<span class="pad">${esc(p.port)}</span><span class="lb">${esc(p.proto)} · ${esc(service)}</span>`;world.appendChild(pin);
      const inspect=()=>boardInspector(`${p.port}/${p.proto} · ${service}`,`<p class="k">${esc([p.product,p.version].filter(Boolean).join(' ') || 'Product / version not reported')}</p><p class="live-note">First observed: ${esc(when(p.first_seen))}</p>${risk?'<p class="error-note">Risky service. This does not establish internet exposure or compromise.</p>':''}`);
      pin.onclick=inspect;
      boardPart('service-'+i,850,y,'',service,[p.product,p.version].filter(Boolean).join(' ') || `${p.port}/${p.proto}`,`J1.${i+1} · SERVICE`,risk?'warn':'',inspect);
      trace(670,y,775,y,risk?'warn':'');trace(925,y,1105,610,risk?'warn':'');
    });
    const signals=d.events.filter(e=>severity(e)!=='info'||/scan|intrusion|attack/i.test(e.kind)).slice(0,5);
    if(!signals.length)add('<text class="silk" x="80" y="320">No security events reported.</text>');
    signals.forEach((e,i)=>{const y=380+i*160;boardPart('event-'+e.id,290,y,'issue',e.kind,e.detail || 'No detail',when(e.at),severity(e),()=>boardInspector(e.kind,eventHTML([e])));});
    // Never animate packet rates or invent attackers from an open port.
  } catch(e) { if(state.board===id){$('bx-crumb').textContent='Device unavailable';boardInspector('Unable to load device',`<p>${esc(e.message)}. Retrying with the next refresh.</p>`);} }
}
/* Pointer cameras: no dependencies, both layers retain the same pan/zoom motion. */
let mapDragged=false,boardDragged=false;
function bindCamera(stage,world,isBoard){
  let drag=null;
  stage.addEventListener('pointerdown',e=>{
    if(e.button!==0 || e.target.closest('button,input,.fp,.pin'))return;
    const c=isBoard?boardCam:cam;drag={x:e.clientX,y:e.clientY,tx:c.x,ty:c.y};if(isBoard)boardDragged=false;else mapDragged=false;
    stage.setPointerCapture(e.pointerId);stage.classList.add('dragging','drag');
  });
  stage.addEventListener('pointermove',e=>{if(!drag)return;const c=isBoard?boardCam:cam;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(dx,dy)>4){if(isBoard)boardDragged=true;else mapDragged=true;}c.x=drag.tx+dx;c.y=drag.ty+dy;world.style.transition='none';paintCamera(world,c);});
  const end=()=>{drag=null;stage.classList.remove('dragging','drag');world.style.transition='';setTimeout(()=>{if(isBoard)boardDragged=false;else mapDragged=false;},0)};
  stage.addEventListener('pointerup',end);stage.addEventListener('pointercancel',end);
  stage.addEventListener('wheel',e=>{e.preventDefault();const c=isBoard?boardCam:cam;const s=Math.max(.12,Math.min(2.5,c.s*Math.exp(-e.deltaY*.001)));const f=s/c.s;c.x=e.clientX-(e.clientX-c.x)*f;c.y=e.clientY-(e.clientY-c.y)*f;c.s=s;world.style.transition='none';paintCamera(world,c);},{passive:false});
}
bindCamera($('stage'),$('world'),false);bindCamera($('bx-stage'),$('bx-world'),true);
$('fit').onclick=fitMap;$('view-close').onclick=()=>setView('map');$('bx-up').onclick=closeBoard;
document.querySelectorAll('.rail [data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
addEventListener('keydown',e=>{if(e.key==='Escape'){if(state.board!==null)closeBoard();else{closeInspect();setView('map')}}});
addEventListener('resize',()=>{fitMap();if(state.board!==null)boardFit()});
refresh();setInterval(refresh,10000);
