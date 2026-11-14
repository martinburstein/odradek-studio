import catalog from '../../assets/theme/workspaces.json';
export const WORKSPACE_TABS=catalog.tabs;
const valid=new Set([...catalog.tabs,...catalog.tools].map(item=>item.id));
export function mountWorkspace({root,notify,initialMode='manual'}){
 const bridge=window.odradekWorkspace;
 if(!bridge)return; // The web/embedded replica remains a portable preview.
 const shell=document.createElement('div');shell.className='workspace-shell';
 root.before(shell);shell.append(root);
 const nav=document.createElement('nav');nav.className='workspace-nav panel';nav.setAttribute('aria-label','Odradek Lab workspace');
 nav.setAttribute('role','tablist');root.id='simulation-workspace';
 nav.innerHTML=`<span class="workspace-brand">ODRADEK<small>CONTROL TERMINAL</small></span>${catalog.tabs.map(({id,label},i)=>`<button role="tab" data-workspace="${id}" aria-selected="false" aria-pressed="false" aria-controls="${id==='preview'?'simulation':'operator'}-workspace"><small>0${i+1}</small>${label}</button>`).join('')}`;
 shell.prepend(nav);
 const heading=document.createElement('header');heading.className='workspace-heading';heading.innerHTML='<div><p class="eyebrow"></p><h2></h2><p class="mode-description"></p></div><nav class="workspace-subnav" aria-label="Manual tools">'+catalog.tools.map(({id,label})=>`<button data-tool="${id}" aria-pressed="false">${label}</button>`).join('')+'</nav>';shell.append(heading);
 const dock=document.createElement('section');dock.className='operator-dock panel';dock.setAttribute('aria-label','Existing Odradek Studio controls');
 dock.id='operator-workspace';dock.setAttribute('role','tabpanel');
 dock.innerHTML='<p>Opening Studio controls…</p>';shell.append(dock);
 const requested=new URL(location.href).searchParams.get('workspace');
 let mode=valid.has(requested)?requested:valid.has(initialMode)?initialMode:'manual',lastBounds='',scheduled=false;
 const layout=()=>{
  const r=dock.getBoundingClientRect(),bounds={x:r.x,y:r.y,width:r.width,height:r.height};
  const next=JSON.stringify({mode,bounds});if(next===lastBounds)return;lastBounds=next;
  bridge.update({mode,bounds});
 };
 const schedule=()=>{if(!scheduled){scheduled=true;requestAnimationFrame(()=>{scheduled=false;layout();});}};
 const select=(next,{send=true}={})=>{
  if(!valid.has(next))return;
  mode=next;shell.classList.toggle('with-operator',mode!=='preview');dock.hidden=mode==='preview';
  shell.classList.toggle('focus-operator',['sync','camera','safety'].includes(mode));
  const primary=['presets','map'].includes(mode)?'manual':mode;
  for(const b of nav.querySelectorAll('[data-workspace]')){const active=b.dataset.workspace===primary;b.setAttribute('aria-pressed',String(active));b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;}
  const info=[...catalog.tabs,...catalog.tools].find(item=>item.id===mode);
  heading.querySelector('h2').textContent=info.title;heading.querySelector('.eyebrow').textContent=info.eyebrow;heading.querySelector('.mode-description').textContent=info.description;
  heading.querySelector('.workspace-subnav').hidden=primary!=='manual';for(const b of heading.querySelectorAll('[data-tool]'))b.setAttribute('aria-pressed',String(b.dataset.tool===mode));
  shell.classList.toggle('rehearsing',mode==='automatic');window.dispatchEvent(new CustomEvent('odradek-workspace',{detail:mode}));
  if(send)schedule();
 };
 for(const button of nav.querySelectorAll('[data-workspace]'))button.onclick=()=>select(button.dataset.workspace);
 for(const button of heading.querySelectorAll('[data-tool]'))button.onclick=()=>select(button.dataset.tool);
 nav.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const buttons=[...nav.querySelectorAll('[data-workspace]')],index=buttons.indexOf(document.activeElement);if(index<0)return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:buttons.length-1))%buttons.length;buttons[next].focus();select(buttons[next].dataset.workspace);});
 bridge.subscribe(state=>{if(state.error){notify(state.error);dock.querySelector('p').textContent=state.error;}if(state.ready)dock.querySelector('p').hidden=true;if(state.mode&&state.mode!==mode)select(state.mode);if(state.rehearsal)window.dispatchEvent(new CustomEvent('odradek-rehearsal',{detail:state.rehearsal}));});
 new ResizeObserver(schedule).observe(dock);window.addEventListener('resize',schedule);
 select(mode);
 return{select};
}
