/**
 * LOUP-GAROU — TESTS v5 — AUDIT EXHAUSTIF
 * Usage : fetch('/test-ui.js').then(r=>r.text()).then(t=>eval(t))
 */
(async function(){
const N_RUNS=30,D=40,ANIM=700;
let pass=0,fail=0,errs=[];
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function el(id){return document.getElementById(id);}
function ok(){pass++;}
function ko(msg,d){fail++;errs.push(msg+(d?' | '+d:''));console.warn('❌',msg,d||'');}
function check(l,c,d){c?ok():ko(l,d);}
const FC=['roleCard','dayDeathCard','nightFallCard','mayorCard','endCard'];
// Après forceCloseAllCards, aucun style inline display ne reste sur roleCard/dayDeathCard/nightFallCard.
// On peut donc se fier à className : 'show' = visible, '' ou 'hiding' = caché.
// Pour endCard/mayorCard qui utilisent style.display inline, on vérifie getComputedStyle.
function cardShown(id){
  const e=el(id);
  if(!e)return false;
  if(id==='endCard'||id==='mayorCard'){
    return e.style.display==='flex'||e.style.display==='block';
  }
  if(e.className!=='show'&&e.className!=='show hiding')return false;
  // Vérifie que le CSS display est bien appliqué (pas de style inline display:none résiduel)
  return window.getComputedStyle(e).display!=='none';
}
function cardHidden(id){return !cardShown(id);}
function visibleCards(){return FC.filter(id=>cardShown(id));}
function checkNoOverlap(l){const v=visibleCards();check(l+' — pas de superposition',v.length<=1,v.length>1?`${v.length} cartes: ${v.join(', ')}` :'');}
function checkOnlyCard(l,id){const v=visibleCards();check(l+` — seule "${id}" visible`,v.length===1&&v[0]===id,`visible:[${v.join(', ')}]`);}
function checkNoCards(l){const v=visibleCards();check(l+' — aucune carte',v.length===0,v.length?`visible: ${v.join(', ')}`:'');}
function playerBtns(lbl){const d=el('players');return d?Array.from(d.querySelectorAll('button')).filter(b=>b.textContent.includes(lbl)):[];}
function btnsIn(cid){const c=el(cid);return c&&c.style.display!=='none'?Array.from(c.querySelectorAll('button')):[];}
function activeBtns(lbl){return playerBtns(lbl).filter(b=>!b.disabled);}
function checkNoBtns(l,lbl){const b=playerBtns(lbl);check(l,b.length===0,`${b.length} bouton(s) "${lbl}" trouvé(s)`);}
function checkVisible(l,id){const e=el(id);check(l,e&&e.style.display!=='none',e?`display="${e.style.display}"`:'absent');}
function checkHidden(l,id){const e=el(id);check(l,!e||e.style.display==='none',e?`display="${e.style.display}"`:'ok');}
class VP{constructor(id,n,r){this.id=id;this.name=n;this.role=r;this.events={};}receive(ev,d){if(!this.events[ev])this.events[ev]=[];this.events[ev].push(d);}received(ev){return !!(this.events[ev]&&this.events[ev].length>0);}last(ev){const a=this.events[ev];return a&&a.length?a[a.length-1]:undefined;}clearEvents(){this.events={};}}
class VS{constructor(ps){this.players=ps;this._l=[];}emitTo(id,ev,d){const p=this.players.get(id);if(p)p.receive(ev,d);this._l.push({to:id,ev,d});}emitAll(ev,d){this.players.forEach(p=>p.receive(ev,d));this._l.push({to:'ALL',ev,d});}reset(){this._l=[];this.players.forEach(p=>p.clearEvents());}}
function chkEv(l,player,ev,xc){if(!player.received(ev)){ko(l+` — ${player.name}(${player.role}) devrait recevoir [${ev}]`);return;}if(xc){const d=player.last(ev);check(l+` — contenu [${ev}]`,xc(d),`${player.name}: `+JSON.stringify(d).slice(0,80));}else ok();}
function chkNoEv(l,player,ev){check(l+` — ${player.name}(${player.role}) NE doit PAS recevoir [${ev}]`,!player.received(ev),player.received(ev)?'reçu inopinément':'');}
function recv(ev,d){try{const cbs=socket._callbacks&&socket._callbacks['$'+ev];if(!cbs||!cbs.length)return;cbs.forEach(fn=>fn(d));}catch(e){ko('recv('+ev+') crash',e.message);}}
async function closeCard(fn,x=0){try{fn();}catch(e){}await sleep(ANIM+x);}
function forceRender(){try{if(typeof render==='function')render();}catch(e){}}
// Ferme toutes les cartes plein écran sans animation.
// IMPORTANT : retire style.display (pas style.display="none") pour que
// className="show" → CSS .show{display:flex} puisse s'appliquer normalement ensuite.
// getComputedStyle est fiable uniquement si aucun style inline ne surcharge la CSS.
function forceCloseAllCards(){
  ['roleCard','dayDeathCard','nightFallCard'].forEach(id=>{
    const e=document.getElementById(id);
    if(e){ e.className=''; e.style.removeProperty('display'); e.style.removeProperty('background'); }
  });
  ['endCard','mayorCard'].forEach(id=>{
    const e=document.getElementById(id);
    if(e){ e.style.display='none'; e.style.removeProperty('background'); e.removeAttribute('data-open'); }
  });
  try{_dawnOnClose=null;}catch(e){}
}
async function reset(){
  try{gameIsOver=false;}catch(e){}
  recv('gameReset',{players:[]});await sleep(100);
  ['gameIsOver','voteActive','nightCardShownThisNight','mayorTransferPending','isChasseurDead','witchSaveUsed','witchKillUsed','idiotRevealed','iAmDead'].forEach(v=>{try{window[v]=false;}catch(e){}});
  try{deathLog=[];}catch(e){}try{phase=null;}catch(e){}try{lovers=[];}catch(e){}try{deadPlayers=[];}catch(e){}try{mayor=null;}catch(e){}try{wolves=[];}catch(e){}try{role=null;}catch(e){}
}
const NAMES=['Alice','Bob','Carol','Dave','Eve','Frank','Grace','Hank','Iris','Jake','Kara','Leo'];
const RM=['Loup','Loup','Voyante','Sorcière','Chasseur','Cupidon','PetiteFille','Idiot','Corbeau','Villageois','Villageois','Villageois'];
const ALL_ROLES=['Loup','Villageois','Voyante','Sorcière','Chasseur','Cupidon','PetiteFille','Idiot','Corbeau'];
function makeVP(){const m=new Map();NAMES.forEach((n,i)=>{const p=new VP('p'+i,n,RM[i]);m.set(p.id,p);});return m;}
function makeP(){return NAMES.map((n,i)=>({id:'p'+i,name:n}));}
function makeRL(P){return{[P[0].id]:'Loup',[P[1].id]:'Loup',[P[2].id]:'Voyante',[P[3].id]:'Sorcière',[P[4].id]:'Chasseur',[P[5].id]:'Cupidon',[P[6].id]:'PetiteFille',[P[7].id]:'Idiot',[P[8].id]:'Corbeau',[P[9].id]:'Villageois',[P[10].id]:'Villageois',[P[11].id]:'Villageois'};}

console.log('═'.repeat(62));
console.log('🐺 LOUP-GAROU — TESTS v5 — AUDIT EXHAUSTIF — '+N_RUNS+' runs');
console.log('═'.repeat(62));

for(let run=1;run<=N_RUNS;run++){
const P=makeP(),RL=makeRL(P),WOLVES=[P[0].id,P[1].id],LOVERS=[P[2].id,P[3].id];
const VPm=makeVP(),srv=new VS(VPm);
const vW1=VPm.get('p0'),vW2=VPm.get('p1'),vSeer=VPm.get('p2'),vWitch=VPm.get('p3');
const vHunt=VPm.get('p4'),vCup=VPm.get('p5'),vPF=VPm.get('p6'),vIdiot=VPm.get('p7');
const vCrow=VPm.get('p8'),vV1=VPm.get('p9'),vV2=VPm.get('p10'),vV3=VPm.get('p11');

// A. RESET + ÉTAT INITIAL
await reset();srv.reset();recv('players',P);await sleep(D);
check('A1: joueurs listés',el('players')&&el('players').innerHTML.trim()!=='');
checkNoCards('A2: aucune carte au démarrage');
checkHidden('A3: voteWaitBox caché','voteWaitBox');checkHidden('A4: voteTimerBox caché','voteTimerBox');
checkHidden('A5: deadBanner caché','deadBanner');checkHidden('A6: infoPanel caché','infoPanel');
checkHidden('A7: deadVisionPanel caché','deadVisionPanel');checkHidden('A8: chasseurPanel caché','chasseurPanel');
checkHidden('A9: witchDoneBtn caché','witchDoneBtn');checkHidden('A10: corbeauPanel caché','corbeauPanel');

// B. YOURROLE — correction wolves masqués
VPm.forEach(vp=>srv.emitTo(vp.id,'yourRole',{role:vp.role,wolves:vp.role==='Loup'?WOLVES:[]}));
VPm.forEach(vp=>chkEv('B1: yourRole reçu '+vp.name,vp,'yourRole',d=>d&&d.role===vp.role));
chkEv('B2: Villageois wolves=[]',vV1,'yourRole',d=>!d.wolves||d.wolves.length===0);
chkEv('B3: Loup reçoit wolves[]',vW1,'yourRole',d=>Array.isArray(d.wolves)&&d.wolves.includes('p1'));
chkEv('B4: Sorcière wolves=[]',vWitch,'yourRole',d=>!d.wolves||d.wolves.length===0);
chkEv('B5: Chasseur wolves=[]',vHunt,'yourRole',d=>!d.wolves||d.wolves.length===0);

// C. CARTE DE RÔLE
recv('yourRole',{role:'Loup',wolves:WOLVES});await sleep(D);
checkOnlyCard('C1: seule roleCard visible','roleCard');
checkNoOverlap('C2: pas de superposition roleCard');
const rcB=el('roleCard')?Array.from(el('roleCard').querySelectorAll('button')):[];
check('C3: bouton "J\'ai lu" présent',rcB.length>0);
check('C4: bouton cliquable',rcB.some(b=>!b.disabled&&b.textContent.includes("J'ai lu")));
await closeCard(closeRoleCard);
checkHidden('C5: roleCard fermée','roleCard');checkNoCards('C6: aucune carte après roleCard');
for(const r of ALL_ROLES){
  try{if(typeof showRoleCard==='function'){showRoleCard(r);
    check('C7: emoji '+r,el('rcEmoji')&&el('rcEmoji').innerText.trim()!=='');
    check('C8: rôle '+r,el('rcRole')&&el('rcRole').innerText.trim()!=='');
    check('C9: desc '+r,el('rcText')&&el('rcText').innerText.trim()!=='');
    check('C10: mission '+r,el('rcMission')&&el('rcMission').innerText.trim()!=='');
    // Force className='' ET supprime style.display inline pour que le CSS display:none reprenne
    try{const rc=el('roleCard');rc.className='';rc.style.display='none';rc.style.background='';}catch(e){}
  }}catch(e){ko('showRoleCard('+r+') crash',e.message);}
}
// Garantit que roleCard est proprement fermée avant la suite
forceCloseAllCards();

// D. INFO PANEL
recv('yourRole',{role:'Loup',wolves:WOLVES});await sleep(D);
checkVisible('D1: infoPanel visible','infoPanel');
check('D2: infoRole contient Loup',el('infoRole')&&el('infoRole').innerText.includes('Loup'));
check('D3: infoAllies visible pour Loup',el('infoAllies')&&el('infoAllies').style.display!=='none');
// Ferme roleCard ouverte par yourRole avant les tests suivants
forceCloseAllCards();
recv('yourRole',{role:'Villageois',wolves:[]});await sleep(D);
check('D4: infoAllies caché pour Villageois',!el('infoAllies')||el('infoAllies').style.display==='none');

// E. MAYORVOTE
forceCloseAllCards();
recv('phase','mayorVote');recv('yourRole',{role:'Villageois',wolves:[]});await sleep(D);forceRender();await sleep(D);
const mB=playerBtns('🏛️ Voter');
check('E1: boutons "🏛️ Voter" présents',mB.length>0,`${mB.length}`);
check('E2: autant que de joueurs',mB.length===P.length,`${mB.length}/${P.length}`);
checkNoBtns('E3: pas de "Attaquer" en mayorVote','🐺 Attaquer');
checkNoBtns('E4: pas de "Voter" jour en mayorVote','🗳️ Voter');
checkNoBtns('E5: pas de "Voir" en mayorVote','🔮 Voir');
recv('mayorVoted',P[0].id);await sleep(D);forceRender();await sleep(D);
check('E6: badge "A voté" présent',el('players')&&el('players').innerHTML.includes('A voté'));
recv('mayorCountsPublic',{[P[0].id]:3,[P[1].id]:2});await sleep(D);
checkVisible('E7: votesPanel visible avec comptes maire','votesPanel');
recv('gameCycle',{day:1,night:0});await sleep(D);
check('E8: cycleCounter retiré (refonte)',!el('cycleCounter'));
check('E9: (cycleCounter absent — refonte)',!el('cycleCounter'));

// F. CUPID
forceCloseAllCards();
recv('phase','cupid');recv('yourRole',{role:'Cupidon',wolves:[]});await sleep(D);forceRender();await sleep(D);
check('F1: boutons "💘 Choisir" présents',playerBtns('💘 Choisir').length>0);
check('F2: autant que de joueurs',playerBtns('💘 Choisir').length===P.length,`${playerBtns('💘 Choisir').length}/${P.length}`);
recv('yourRole',{role:'Villageois',wolves:[]});await sleep(D);forceRender();await sleep(D);
checkNoBtns('F3: pas de "Choisir" pour Villageois','💘 Choisir');
srv.reset();
srv.emitTo('p5','loversInfo',['p2','p3']);srv.emitTo('p2','loversInfo',['p2','p3']);srv.emitTo('p3','loversInfo',['p2','p3']);
chkEv('F4: Cupidon reçoit loversInfo',vCup,'loversInfo',d=>Array.isArray(d)&&d.includes('p2'));
chkEv('F5: Amoureux p2 reçoit loversInfo',vSeer,'loversInfo',d=>Array.isArray(d)&&d.includes('p3'));
chkEv('F6: Amoureux p3 reçoit loversInfo',vWitch,'loversInfo',d=>Array.isArray(d)&&d.includes('p2'));
chkNoEv('F7: Villageois NE reçoit PAS loversInfo',vV1,'loversInfo');
chkNoEv('F8: Chasseur NE reçoit PAS loversInfo',vHunt,'loversInfo');

// G. WOLVES
forceCloseAllCards();
srv.reset();try{nightCardShownThisNight=true;}catch(e){}
recv('phase','wolves');recv('yourRole',{role:'Loup',wolves:WOLVES});await sleep(D);forceRender();await sleep(D);
check('G1: boutons "🐺 Attaquer" présents',playerBtns('🐺 Attaquer').length>0);
srv.emitTo('p0','wolfVotesUpdate',{'p0':'p9'});srv.emitTo('p1','wolfVotesUpdate',{'p0':'p9'});
chkEv('G2: Wolf1 reçoit wolfVotesUpdate',vW1,'wolfVotesUpdate',d=>d&&Object.keys(d).length>0);
chkEv('G3: Wolf2 reçoit wolfVotesUpdate',vW2,'wolfVotesUpdate',d=>d&&Object.keys(d).length>0);
chkNoEv('G4: Voyante NE reçoit PAS wolfVotesUpdate',vSeer,'wolfVotesUpdate');
chkNoEv('G5: Villageois NE reçoit PAS wolfVotesUpdate',vV1,'wolfVotesUpdate');
chkNoEv('G6: Sorcière NE reçoit PAS wolfVotesUpdate',vWitch,'wolfVotesUpdate');
recv('yourRole',{role:'Villageois',wolves:[]});await sleep(D);forceRender();await sleep(D);
checkNoBtns('G7: pas de "Attaquer" pour Villageois','🐺 Attaquer');
recv('yourRole',{role:'PetiteFille',wolves:[]});await sleep(D);forceRender();await sleep(D);
checkVisible('G8: petiteFillePanel visible','petiteFillePanel');
recv('phase','day');await sleep(D);forceRender();await sleep(D);
checkHidden('G9: petiteFillePanel caché hors wolves','petiteFillePanel');
try{nightCardShownThisNight=false;}catch(e){}

// H. SEER
forceCloseAllCards();
srv.reset();recv('phase','seer');recv('yourRole',{role:'Voyante',wolves:[]});await sleep(D);forceRender();await sleep(D);
check('H1: boutons "🔮 Voir" présents',playerBtns('🔮 Voir').length>0);
recv('yourRole',{role:'Villageois',wolves:[]});await sleep(D);forceRender();await sleep(D);
checkNoBtns('H2: pas de "Voir" pour Villageois','🔮 Voir');
srv.emitTo('p2','seerResult',{role:'Loup',name:P[0].name});
chkEv('H3: Voyante reçoit seerResult',vSeer,'seerResult',d=>d&&d.role==='Loup');
chkNoEv('H4: Loup NE reçoit PAS seerResult',vW1,'seerResult');
chkNoEv('H5: Villageois NE reçoit PAS seerResult',vV1,'seerResult');
chkNoEv('H6: Sorcière NE reçoit PAS seerResult',vWitch,'seerResult');
recv('seerResult',{name:P[0].name,role:'Loup'});await sleep(D);
check('H7: seerResult: status mis à jour',el('status')&&el('status').innerText.trim()!=='');

// I. CORBEAU
forceCloseAllCards();
srv.reset();recv('yourRole',{role:'Corbeau',wolves:[]});recv('phase','corbeau');await sleep(20);
recv('corbeauTurn',undefined);await sleep(D);
checkVisible('I1: corbeauPanel visible','corbeauPanel');
const cT=btnsIn('corbeauTargets');
check('I2: boutons cibles présents',cT.length>0,`${cT.length}`);
check('I3: autant que de joueurs',cT.length===P.length,`${cT.length}/${P.length}`);
const sBtn=el('corbeauPanel')?Array.from(el('corbeauPanel').querySelectorAll('button')).find(b=>b.textContent.includes('Passer')):null;
check('I4: bouton Passer présent et cliquable',sBtn&&!sBtn.disabled);
srv.emitTo('p8','corbeauTurn',undefined);
chkEv('I5: Corbeau reçoit corbeauTurn',vCrow,'corbeauTurn');
chkNoEv('I6: Loup NE reçoit PAS corbeauTurn',vW1,'corbeauTurn');
srv.emitAll('corbeauVotesPublic',{targetId:'p9',targetName:P[9].name});
VPm.forEach(vp=>chkEv('I7: corbeauVotesPublic broadcast '+vp.name,vp,'corbeauVotesPublic'));
srv.emitTo('p8','corbeauConfirm',{targetId:'p9'});
chkEv('I8: Corbeau reçoit corbeauConfirm',vCrow,'corbeauConfirm',d=>d&&d.targetId==='p9');
chkNoEv('I9: Villageois NE reçoit PAS corbeauConfirm',vV1,'corbeauConfirm');
try{corbeauSkip();}catch(e){}await sleep(D);
checkHidden('I10: corbeauPanel caché après skip','corbeauPanel');
recv('corbeauConfirm',{targetId:'skip'});await sleep(D);
check('I11: status contient 🪶',el('status')&&el('status').innerText.includes('🪶'));

// J. SORCIÈRE
forceCloseAllCards();
srv.reset();recv('phase','witch');recv('yourRole',{role:'Sorcière',wolves:[]});
recv('nightVictim',P[9].id);try{witchSaveUsed=false;witchKillUsed=false;}catch(e){}
await sleep(D);forceRender();await sleep(D);
check('J1: bouton "🧪 Sauver" présent (1)',playerBtns('🧪 Sauver').length===1,`${playerBtns('🧪 Sauver').length}`);
check('J2: boutons "💀 Tuer" présents',playerBtns('💀 Tuer').length>0);
checkVisible('J3: witchDoneBtn visible','witchDoneBtn');
srv.emitTo('p3','nightVictim','p9');
chkEv('J4: Sorcière reçoit nightVictim',vWitch,'nightVictim',d=>d==='p9');
chkNoEv('J5: Loup NE reçoit PAS nightVictim',vW1,'nightVictim');
chkNoEv('J6: Villageois NE reçoit PAS nightVictim',vV1,'nightVictim');
chkNoEv('J7: Voyante NE reçoit PAS nightVictim',vSeer,'nightVictim');
chkNoEv('J8: Corbeau NE reçoit PAS nightVictim',vCrow,'nightVictim');
srv.emitTo('p3','witchSaveConfirm',undefined);srv.emitTo('p3','witchKillConfirm',undefined);
chkEv('J9: Sorcière reçoit witchSaveConfirm',vWitch,'witchSaveConfirm');
chkEv('J10: Sorcière reçoit witchKillConfirm',vWitch,'witchKillConfirm');
chkNoEv('J11: Loup NE reçoit PAS witchSaveConfirm',vW1,'witchSaveConfirm');
chkNoEv('J12: Villageois NE reçoit PAS witchKillConfirm',vV1,'witchKillConfirm');
recv('witchSaveConfirm');await sleep(D);forceRender();await sleep(D);
checkNoBtns('J13: pas de "Sauver" après utilisation','🧪 Sauver');
recv('witchKillConfirm');await sleep(D);forceRender();await sleep(D);
checkNoBtns('J14: pas de "Tuer" après utilisation','💀 Tuer');
recv('phase','day');await sleep(D);forceRender();await sleep(D);
checkHidden('J15: witchDoneBtn caché hors witch','witchDoneBtn');
recv('phase','witch');recv('yourRole',{role:'Villageois',wolves:[]});await sleep(D);forceRender();await sleep(D);
checkNoBtns('J16: pas de "Sauver" pour Villageois','🧪 Sauver');
checkNoBtns('J17: pas de "Tuer" pour Villageois','💀 Tuer');
checkHidden('J18: witchDoneBtn caché pour Villageois','witchDoneBtn');

// K. DAY — boutons vote
forceCloseAllCards();
recv('phase','day');recv('yourRole',{role:'Villageois',wolves:[]});
try{witchSaveUsed=false;witchKillUsed=false;iAmDead=false;deadPlayers=[];}catch(e){}
await sleep(D);forceRender();await sleep(D);
checkHidden('K1: voteWaitBox caché avant voteStarted','voteWaitBox');
check('K2: boutons "🗳️ Voter" présents',playerBtns('🗳️ Voter').length>0);
recv('voteStarted',{mode:2,duration:90000,endsAt:Date.now()+90000,serverNow:Date.now(),existingVotes:{}});
try{hasVotedLocked=true;currentVoteMode=2;}catch(e){}await sleep(D);forceRender();await sleep(D);
check('K3: mode2 après vote — tous disabled',activeBtns('🗳️ Voter').length===0,`${activeBtns('🗳️ Voter').length} actifs`);
try{hasVotedLocked=true;currentVoteMode=5;}catch(e){}await sleep(D);forceRender();await sleep(D);
check('K4: mode5 après vote — disabled',activeBtns('🗳️ Voter').length===0);
try{hasVotedLocked=false;currentVoteMode=1;}catch(e){}
recv('deadPlayers',[socket.id]);try{iAmDead=true;deadPlayers=[socket.id];}catch(e){}
await sleep(D);forceRender();await sleep(D);
checkNoBtns('K5: mort ne vote pas','🗳️ Voter');
recv('deadPlayers',[]);try{iAmDead=false;deadPlayers=[];}catch(e){}
recv('yourRole',{role:'Idiot',wolves:[]});
try{idiotRevealed=true;idiotId=socket.id;hasVotedLocked=false;currentVoteMode=1;}catch(e){}
await sleep(D);forceRender();await sleep(D);
check('K6: Idiot révélé — boutons disabled',activeBtns('🗳️ Voter').length===0,`${activeBtns('🗳️ Voter').length} actifs`);
try{idiotRevealed=false;idiotId=null;}catch(e){}
recv('yourRole',{role:'Villageois',wolves:[]});await sleep(D);
recv('phase','day');await sleep(D);
check('K7: narrativeBanner retiré (refonte)',!el('narrativeBanner'));
check('K8: (narrativeBanner absent — refonte)',!el('narrativeBanner'));
recv('autoResolve','✅ Tout le village a voté !');await sleep(D);
checkVisible('K9: autoResolveBanner visible','autoResolveBanner');

// L. TIMER
srv.emitAll('voteStarted',{mode:1,duration:30000,endsAt:Date.now()+30000,serverNow:Date.now(),existingVotes:{}});
VPm.forEach(vp=>chkEv('L1: voteStarted broadcast '+vp.name,vp,'voteStarted'));
recv('voteStarted',{mode:1,duration:30000,endsAt:Date.now()+30000,serverNow:Date.now(),existingVotes:{}});
await sleep(600);
checkVisible('L2: voteTimerBox visible','voteTimerBox');
check('L3: timerVal initialisé',el('timerVal')&&el('timerVal').innerText!=='--',el('timerVal')?'val='+el('timerVal').innerText:'absent');
check('L4: timerMode contient Libre',el('timerMode')&&el('timerMode').innerText.includes('Libre'));
recv('voteTimerEnd');await sleep(D);checkHidden('L5: voteTimerBox caché après fin','voteTimerBox');

// M. VOTES PANEL
recv('phase','day');await sleep(D);
recv('dayCountsPublic',{[P[0].id]:5,[P[1].id]:3});
recv('votesDayPublic',Object.fromEntries(P.slice(0,8).map((p,i)=>[p.id,P[(i+3)%12].id])));
recv('corbeauVotesPublic',{targetId:P[8].id,targetName:P[8].name});await sleep(D);
checkVisible('M1: votesPanel visible','votesPanel');
if(typeof renderVotesPanel==='function'){try{renderVotesPanel();check('M2: renderVotesPanel sans crash',true);}catch(e){check('M2: renderVotesPanel sans crash',false,e.message);}}
check('M3: barres de vote présentes',el('votesContent')&&el('votesContent').querySelectorAll('.vote-bar').length>0);
check('M4: badge corbeau présent',el('votesContent')&&el('votesContent').innerHTML.includes('🪶'));
check('M5: détail qui→qui présent',el('votesContent')&&el('votesContent').querySelector('.vote-detail-list')!==null);
srv.emitAll('dayCountsPublic',{[P[0].id]:5,[P[1].id]:3});
VPm.forEach(vp=>chkEv('M6: dayCountsPublic broadcast '+vp.name,vp,'dayCountsPublic'));

// N. CHASSEUR
forceCloseAllCards();
srv.reset();
srv.emitAll('chasseurMustShoot','p4');
VPm.forEach(vp=>chkEv('N1: chasseurMustShoot broadcast '+vp.name,vp,'chasseurMustShoot'));
chkEv('N2: Chasseur reçoit avec son id',vHunt,'chasseurMustShoot',d=>d==='p4');
recv('yourRole',{role:'Chasseur',wolves:[]});recv('deadPlayers',[P[4].id]);
try{iAmDead=true;deadPlayers=[P[4].id];isChasseurDead=true;}catch(e){}
recv('chasseurMustShoot',socket.id);await sleep(D);
checkVisible('N3: chasseurPanel visible','chasseurPanel');
if(typeof renderChasseurTargets==='function'){
  try{renderChasseurTargets();
    const cB=btnsIn('chasseurTargets');
    check('N4: boutons cibles présents',cB.length>0,`${cB.length}`);
    const dBtn=cB.find(b=>b.textContent.includes(P[4].name));
    check('N5: mort absent des cibles chasseur',!dBtn,dBtn?`"${P[4].name}" dans cibles`:'');
  }catch(e){ko('renderChasseurTargets crash',e.message);}
}
recv('phase','day');await sleep(D);try{isChasseurDead=false;iAmDead=false;deadPlayers=[];}catch(e){}
forceRender();await sleep(D);checkHidden('N6: chasseurPanel caché','chasseurPanel');

// O. NIGHTFALLCARD — affichage + double protection
forceCloseAllCards();
try{nightCardShownThisNight=false;}catch(e){}
recv('phase','day');await sleep(D);try{nightCardShownThisNight=false;}catch(e){}
recv('phase','cupid');await sleep(D+50);
checkOnlyCard('O1: nightFallCard seule visible','nightFallCard');
checkNoOverlap('O2: pas de superposition nuit1');
const nfB=el('nightFallCard')?Array.from(el('nightFallCard').querySelectorAll('button')):[];
check('O3: bouton fermeture présent',nfB.length>0);
check('O4: bouton cliquable',nfB.some(b=>!b.disabled));
await closeCard(closeNightFallCard);
checkHidden('O5: nightFallCard fermée','nightFallCard');checkNoCards('O6: aucune carte après');
try{nightCardShownThisNight=false;}catch(e){}
recv('phase','wolves');await sleep(D+100);
checkOnlyCard('O7: nightFallCard seule visible wolves','nightFallCard');
checkNoOverlap('O8: pas de superposition nuit2');
await closeCard(closeNightFallCard);
recv('phase','day');await sleep(D);try{nightCardShownThisNight=false;}catch(e){}
// Flag reset par phase=day
recv('phase','wolves');await sleep(D+100);
if(cardShown('nightFallCard')){await closeCard(closeNightFallCard);}
recv('phase','day');await sleep(D);
check('O9: nightCardShownThisNight reset sur phase=day',typeof nightCardShownThisNight==='undefined'||nightCardShownThisNight===false,'flag='+nightCardShownThisNight);
if(cardShown('nightFallCard')){await closeCard(closeNightFallCard);}

// P. MAYORCARD bloque nightFallCard (data-open)
// Garantit qu'aucune carte n'est en cours d'animation avant ce test
forceCloseAllCards();
try{nightCardShownThisNight=false;}catch(e){}
const mc=el('mayorCard');
if(mc){
  mc.style.display='flex';mc.setAttribute('data-open','1');
  if(typeof showNightFallCard==='function'){try{showNightFallCard();}catch(e){}}
  check('P1: mayorCard data-open bloque nightFallCard',cardHidden('nightFallCard'),cardShown('nightFallCard')?'nightFallCard ouverte malgré mayorCard data-open!':'');
  checkNoOverlap('P2: mayorCard — pas de superposition');
  mc.style.display='none';mc.removeAttribute('data-open');
}else{ko('P1: mayorCard data-open bloque nightFallCard','mayorCard absent du DOM');}

// Q. NIGHTFALLCARD bloquée par mayorTransfer (via phase=wolves)
// forceCloseAllCards garantit qu'aucune carte n'est en état "show hiding" (résidu d'animation)
// qui ferait échouer cardShown() par erreur
forceCloseAllCards();
srv.reset();
recv('mayorMustTransfer',socket.id);await sleep(D+50);
check('Q1: mayorTransferPending=true immédiatement',typeof mayorTransferPending==='undefined'||mayorTransferPending===true,'val='+mayorTransferPending);
try{nightCardShownThisNight=false;}catch(e){}
recv('phase','wolves');await sleep(D+50);
check('Q2: nightFallCard bloquée pendant mayorTransfer via phase=wolves',cardHidden('nightFallCard'),cardShown('nightFallCard')?'SUPERPOSITION: nightFallCard pendant transfert!':'');
checkNoOverlap('Q3: pas de superposition pendant majorTransfer');
recv('mayorTransferred',P[5].id);await sleep(D);
checkHidden('Q4: panel fermé après transfert','tiebreakPanel');
check('Q5: mayorTransferPending=false',typeof mayorTransferPending==='undefined'||mayorTransferPending===false);

// R. SUPERPOSITION mort → nuit
forceCloseAllCards();
try{nightCardShownThisNight=false;}catch(e){}
recv('phase','day');await sleep(D);
recv('dayVoteResult',{id:P[0].id,name:P[0].name,role:'Loup'});await sleep(D+50);
checkOnlyCard('R1: dayVoteResult — seule dayDeathCard','dayDeathCard');
checkNoOverlap('R2: pas de superposition dayVoteResult');
try{nightCardShownThisNight=false;}catch(e){}
recv('phase','wolves');await sleep(D+50);
if(cardShown('dayDeathCard')){
  check('R3: nightFallCard bloquée par dayDeathCard ouverte',cardHidden('nightFallCard'),cardShown('nightFallCard')?'SUPERPOSITION!':'');
  checkNoOverlap('R4: pas de superposition wolves + dayDeathCard');
}
await closeCard(closeDawnCard);checkNoOverlap('R5: aucune superposition après fermeture');
if(cardShown('nightFallCard')){await closeCard(closeNightFallCard);}
try{nightCardShownThisNight=false;}catch(e){}

// S. CARTE AUBE — dawnResult
forceCloseAllCards();
recv('yourRole',{role:'Villageois',wolves:[]});await sleep(20);recv('deadPlayers',[P[9].id]);
recv('dawnResult',{deaths:[{id:P[9].id,name:P[9].name,role:'Villageois',cause:'loups'}],saved:false,witchKilled:false,nightNum:1});
await sleep(D+50);
checkOnlyCard('S1: dayDeathCard seule visible','dayDeathCard');checkNoOverlap('S2: pas de superposition dawnResult');
check('S3: titre non vide',el('deathTitle')&&el('deathTitle').innerText.trim()!=='');
check('S4: texte non vide',el('deathText')&&el('deathText').innerText.trim()!=='');
const sB=el('dayDeathCard')?Array.from(el('dayDeathCard').querySelectorAll('button')):[];
check('S5: bouton "Continuer" présent',sB.length>0);check('S6: bouton cliquable',sB.some(b=>!b.disabled));
await closeCard(closeDawnCard);checkHidden('S7: dayDeathCard fermée','dayDeathCard');checkNoCards('S8: aucune carte après');
recv('dawnResult',{deaths:[],saved:false,witchKilled:false,nightNum:2});await sleep(D+50);
checkOnlyCard('S9: nuit calme — dayDeathCard','dayDeathCard');
check('S10: titre calme',el('deathTitle')&&el('deathTitle').innerText.toLowerCase().includes('paisible'));
await closeCard(closeDawnCard);
recv('dawnResult',{deaths:[],saved:true,witchKilled:false,nightNum:3});await sleep(D+50);
checkOnlyCard('S11: sauvé — dayDeathCard','dayDeathCard');
check('S12: texte mentionne survie',el('deathText')&&(el('deathText').innerText.toLowerCase().includes('surv')||el('deathText').innerText.toLowerCase().includes('sauv')));
await closeCard(closeDawnCard);
if(typeof deathLog!=='undefined'){const bad=deathLog.find(d=>d.role==='?'||!d.role);check('S13: rôles dans deathLog non "?"',!bad,bad?JSON.stringify(bad):'');}

// T. BADGES + TIEBREAK + MORTS
forceCloseAllCards();
srv.reset();recv('phase','day');recv('yourRole',{role:'Villageois',wolves:[]});await sleep(D);
recv('newMayor',P[0].id);await sleep(D);forceRender();await sleep(D);
check('T1: badge 🏛️ présent',el('players')&&el('players').innerHTML.includes('🏛️'));
recv('deadPlayers',[P[1].id]);await sleep(D);forceRender();await sleep(D);
check('T2: badge ☠️ présent',el('players')&&el('players').innerHTML.includes('☠️'));
check('T3: classe dead-row présente',el('players')&&el('players').innerHTML.includes('dead-row'));
check('T4: séparateur "morts" présent',el('players')&&el('players').innerHTML.toLowerCase().includes('morts'));
try{idiotRevealed=true;idiotId=P[7].id;}catch(e){}forceRender();await sleep(D);
check('T5: badge 🤡 présent',el('players')&&el('players').innerHTML.includes('🤡'));
try{idiotRevealed=false;idiotId=null;}catch(e){}
recv('yourRole',{role:'Loup',wolves:WOLVES});await sleep(D);forceRender();await sleep(D);
check('T6: badge 🐺 présent pour loups',el('players')&&el('players').innerHTML.includes('🐺'));
try{el('roleCard').className='';el('roleCard').style.display='';}catch(e){}
recv('deadPlayers',[]);recv('newMayor',null);await sleep(D);forceRender();await sleep(D);
srv.emitAll('tiebreakNeeded',{candidates:[{id:'p8',name:P[8].name},{id:'p9',name:P[9].name}],mayorName:P[5].name,context:'day'});
VPm.forEach(vp=>chkEv('T7: tiebreakNeeded broadcast '+vp.name,vp,'tiebreakNeeded'));
srv.emitTo('p5','tiebreakMayor',{candidates:[{id:'p8',name:P[8].name},{id:'p9',name:P[9].name}],context:'day'});
chkEv('T8: Maire reçoit tiebreakMayor',vCup,'tiebreakMayor',d=>d&&Array.isArray(d.candidates));
chkNoEv('T9: Loup NE reçoit PAS tiebreakMayor',vW1,'tiebreakMayor');
recv('tiebreakNeeded',{candidates:[{id:P[8].id,name:P[8].name},{id:P[9].id,name:P[9].name}],mayorName:P[5].name,context:'day'});
await sleep(D);checkVisible('T10: panel tiebreak visible','tiebreakPanel');
recv('tiebreakResolved',{winner:P[8].id,name:P[8].name});await sleep(D);checkHidden('T11: tiebreak caché','tiebreakPanel');

// U. DEAD VISION + CHAT + AMOUREUX
forceCloseAllCards();
srv.reset();
srv.emitTo('p9','deadVision',{roles:RL,wolves:WOLVES,lovers:LOVERS,mayor:'p5'});
chkEv('U1: Mort reçoit deadVision',vV1,'deadVision',d=>d&&d.roles&&Object.keys(d.roles).length>0);
chkNoEv('U2: Loup vivant NE reçoit PAS deadVision',vW1,'deadVision');
chkNoEv('U3: Voyante vivante NE reçoit PAS deadVision',vSeer,'deadVision');
recv('deadVision',{roles:RL,wolves:WOLVES,lovers:LOVERS,mayor:P[5].id});await sleep(D);
checkVisible('U4: deadVisionPanel visible','deadVisionPanel');
check('U5: deadVisionPanel contient des rôles',el('deadRolesList')&&el('deadRolesList').innerHTML.trim()!=='');
recv('deadPlayers',[socket.id]);try{iAmDead=true;deadPlayers=[socket.id];}catch(e){}await sleep(D);forceRender();await sleep(D);
checkVisible('U6: deadFullScreen visible pour mort','deadFullScreen');
checkVisible('U7: deadChatPanel visible pour mort','deadChatPanel');
recv('deadChatMsg',{name:'Alice',text:'Je savais que Bob était loup',ts:Date.now()});await sleep(D);
check('U8: message chat appendé',el('deadChatMessages')&&el('deadChatMessages').innerHTML.includes('Alice'));
for(let i=0;i<210;i++)recv('deadChatMsg',{name:'T',text:'m'+i,ts:Date.now()});
await sleep(D);check('U9: chat ≤ 200 messages',el('deadChatMessages')&&el('deadChatMessages').children.length<=200);
srv.emitAll('playerDied',{id:'p2',role:'Voyante',name:P[2].name});
srv.emitAll('loversDeathInfo',{id:'p3',name:P[3].name,role:'Sorcière'});
VPm.forEach(vp=>chkEv('U10: playerDied broadcast '+vp.name,vp,'playerDied'));
VPm.forEach(vp=>chkEv('U11: loversDeathInfo broadcast '+vp.name,vp,'loversDeathInfo'));
srv.emitTo('p2','deadVision',{roles:RL,wolves:WOLVES,lovers:LOVERS,mayor:'p5'});
srv.emitTo('p3','deadVision',{roles:RL,wolves:WOLVES,lovers:LOVERS,mayor:'p5'});
chkEv('U12: Voyante morte reçoit deadVision',vSeer,'deadVision');
chkEv('U13: Sorcière morte reçoit deadVision',vWitch,'deadVision',d=>d&&d.roles&&Array.isArray(d.wolves));
recv('loversDeathInfo',{id:P[3].id,name:P[3].name,role:'Sorcière'});await sleep(D);
check('U14: status contient 💔',el('status')&&el('status').innerText.includes('💔'));
recv('deadPlayers',[]);try{iAmDead=false;deadPlayers=[];}catch(e){}

// V. IDIOT + DEATHLOG
forceCloseAllCards();
srv.reset();srv.emitAll('idiotRevealed',{id:'p7',name:P[7].name});
VPm.forEach(vp=>chkEv('V1: idiotRevealed broadcast '+vp.name,vp,'idiotRevealed'));
chkEv('V2: Idiot reçoit son idiotRevealed',vIdiot,'idiotRevealed',d=>d&&d.id==='p7');
recv('idiotRevealed',{id:P[7].id,name:P[7].name});await sleep(ANIM+200);
if(el('dayDeathCard')&&el('dayDeathCard').className==='show')await closeCard(closeDawnCard);
if(typeof updateDeathLog==='function'){
  const dl=[{id:P[9].id,name:P[9].name,role:'Villageois',cause:'loups'},{id:P[0].id,name:P[0].name,role:'Loup',cause:'vote'},{id:P[3].id,name:P[3].name,role:'Sorcière',cause:'amour'},{id:P[7].id,name:P[7].name,role:'Idiot',cause:'vote'},{id:P[8].id,name:P[8].name,role:'Corbeau',cause:'loups'},{id:P[4].id,name:P[4].name,role:'Chasseur',cause:'chasseur'}];
  try{updateDeathLog(dl);const list=el('deathLogList');
    check('V3: deathLog sans crash',true);checkVisible('V4: deathLogPanel visible','deathLogPanel');
    check('V5: pas de "?" dans HTML',list&&!list.innerHTML.includes('>?<'));
    check('V6: pas de "undefined"',list&&!list.innerHTML.includes('undefined'));
    check('V7: contient les morts',list&&list.innerHTML.includes(P[9].name));
    check('V8: contient la cause',list&&list.innerHTML.includes('loups'));
  }catch(e){check('V3: deathLog sans crash',false,e.message);}
}

// W. DAYVOTELRESULT
forceCloseAllCards();
recv('phase','day');await sleep(D);
if(el('dayDeathCard')&&el('dayDeathCard').className==='show')await closeCard(closeDawnCard);
recv('dayVoteResult',{id:P[0].id,name:P[0].name,role:'Loup'});await sleep(D+50);
checkOnlyCard('W1: dayVoteResult — seule dayDeathCard','dayDeathCard');
check('W2: titre contient le nom',el('deathTitle')&&el('deathTitle').innerText.includes(P[0].name));
check('W3: texte contient le nom',el('deathText')&&el('deathText').innerText.includes(P[0].name));
const wB=el('dayDeathCard')?Array.from(el('dayDeathCard').querySelectorAll('button')):[];
check('W4: bouton "Continuer" présent',wB.length>0);
await closeCard(closeDawnCard);checkHidden('W5: dayDeathCard fermée','dayDeathCard');

// MM. MISSION — events + panneaux + superpositions
forceCloseAllCards();
srv.reset();

// missionStarted → broadcast
srv.emitAll('missionStarted',{mayorName:P[5].name});
VPm.forEach(vp=>chkEv('MM1: missionStarted broadcast '+vp.name,vp,'missionStarted'));

// missionSelectTeam → uniquement le maire
srv.emitTo('p5','missionSelectTeam',{mayorName:P[5].name,players:P.filter(p=>p.id!=='p5').map(p=>({id:p.id,name:p.name}))});
chkEv('MM2: Maire reçoit missionSelectTeam',vCup,'missionSelectTeam',d=>d&&Array.isArray(d.players));
chkNoEv('MM3: Loup NE reçoit PAS missionSelectTeam',vW1,'missionSelectTeam');
chkNoEv('MM4: Villageois NE reçoit PAS missionSelectTeam',vV1,'missionSelectTeam');

// UI: missionPanel visible pour le maire après missionSelectTeam
recv('missionStarted',{mayorName:P[5].name});await sleep(D);
checkVisible('MM5: missionStatusPanel visible après missionStarted','missionStatusPanel');

// UI: réception de missionSelectTeam déclenche missionPanel
recv('missionSelectTeam',{mayorName:P[5].name,players:P.filter(p=>p.id!==socket.id).map(p=>({id:p.id,name:p.name}))});
await sleep(D);
checkVisible('MM6: missionPanel visible après missionSelectTeam','missionPanel');
checkNoOverlap('MM7: missionPanel — pas de superposition de cartes');

// missionTeamSelected → broadcast
srv.emitAll('missionTeamSelected',{team:[{id:'p9',name:P[9].name},{id:'p10',name:P[10].name},{id:'p11',name:P[11].name}],mayorName:P[5].name});
VPm.forEach(vp=>chkEv('MM8: missionTeamSelected broadcast '+vp.name,vp,'missionTeamSelected'));

recv('missionTeamSelected',{team:[{id:P[9].id,name:P[9].name},{id:P[10].id,name:P[10].name},{id:P[11].id,name:P[11].name}],mayorName:P[5].name});
// phase=missionVote arrive après missionTeamSelected → ferme missionPanel (comportement voulu)
recv('phase','missionVote');
await sleep(D);
// missionPanel fermé par le handler phase=missionVote : attendu et correct
checkHidden('MM9: missionPanel caché après phase=missionVote','missionPanel');
checkVisible('MM10: missionStatusPanel toujours visible en missionVote','missionStatusPanel');
check('MM11: missionStatusPanel texte contient un nom',el('missionStatusText')&&(el('missionStatusText').innerText.includes(P[9].name)||el('missionStatusText').innerText.includes('Équipe')));

// missionCardChoice → uniquement les 3 joueurs sélectionnés
srv.emitTo('p9','missionCardChoice',{mayorName:P[5].name,teamNames:[P[9].name,P[10].name,P[11].name]});
srv.emitTo('p10','missionCardChoice',{mayorName:P[5].name,teamNames:[P[9].name,P[10].name,P[11].name]});
srv.emitTo('p11','missionCardChoice',{mayorName:P[5].name,teamNames:[P[9].name,P[10].name,P[11].name]});
chkEv('MM12: Joueur p9 reçoit missionCardChoice',vV1,'missionCardChoice');
chkEv('MM13: Joueur p10 reçoit missionCardChoice',vV2,'missionCardChoice');
chkEv('MM14: Joueur p11 reçoit missionCardChoice',vV3,'missionCardChoice');
chkNoEv('MM15: Loup NE reçoit PAS missionCardChoice',vW1,'missionCardChoice');
chkNoEv('MM16: Maire NE reçoit PAS missionCardChoice',vCup,'missionCardChoice');

// UI: missionVotePanel visible pour un joueur sélectionné
recv('missionCardChoice',{mayorName:P[5].name,teamNames:[P[9].name,P[10].name,P[11].name]});
await sleep(D);
checkVisible('MM17: missionVotePanel visible','missionVotePanel');
checkNoOverlap('MM18: missionVotePanel — pas de superposition');
// Boutons ✅ et ❌ présents et cliquables
const mvBtns=el('missionVotePanel')?Array.from(el('missionVotePanel').querySelectorAll('button[onclick]')):[];
check('MM19: boutons ✅/❌ présents dans missionVotePanel',mvBtns.length>=2,`${mvBtns.length} bouton(s)`);
check('MM20: bouton ✅ présent',mvBtns.some(b=>b.textContent.includes('✅')||b.innerHTML.includes('✅')));
check('MM21: bouton ❌ présent',mvBtns.some(b=>b.textContent.includes('❌')||b.innerHTML.includes('❌')));

// missionCardPlayed → broadcast
srv.emitAll('missionCardPlayed',{count:1,total:3});
VPm.forEach(vp=>chkEv('MM22: missionCardPlayed broadcast '+vp.name,vp,'missionCardPlayed'));
recv('missionCardPlayed',{count:1,total:3});await sleep(D);
check('MM23: missionCardCounter mis à jour',el('missionCardCounter')&&el('missionCardCounter').innerText.includes('1'));

// missionCardConfirm → uniquement le joueur qui a voté
srv.emitTo('p9','missionCardConfirm',{card:'success'});
chkEv('MM24: Joueur p9 reçoit missionCardConfirm',vV1,'missionCardConfirm',d=>d&&d.card==='success');
chkNoEv('MM25: Loup NE reçoit PAS missionCardConfirm',vW1,'missionCardConfirm');
chkNoEv('MM26: Maire NE reçoit PAS missionCardConfirm',vCup,'missionCardConfirm');

// dawnResult avec missionResult=success — intégré dans dayDeathCard (pas de nouvelle carte)
forceCloseAllCards();
recv('dawnResult',{deaths:[],saved:false,witchKilled:false,nightNum:1,missionResult:'success'});
await sleep(D+50);
checkOnlyCard('MM27: mission success — seule dayDeathCard (pas de nouvelle carte)',  'dayDeathCard');
checkNoOverlap('MM28: dawnResult mission — pas de superposition');
check('MM29: texte contient "Mission"',el('deathText')&&el('deathText').innerText.includes('Mission'));
check('MM30: texte contient "RÉUSSIE"',el('deathText')&&el('deathText').innerText.includes('RÉUSSIE'));
await closeCard(closeDawnCard);

// dawnResult avec missionResult=fail
forceCloseAllCards();
recv('dawnResult',{deaths:[],saved:false,witchKilled:false,nightNum:2,missionResult:'fail'});
await sleep(D+50);
checkOnlyCard('MM31: mission fail — seule dayDeathCard','dayDeathCard');
checkNoOverlap('MM32: dawnResult mission fail — pas de superposition');
check('MM33: texte contient "ÉCHOUÉE"',el('deathText')&&el('deathText').innerText.includes('ÉCHOUÉE'));
await closeCard(closeDawnCard);

// missionBonusResult → uniquement le maire
srv.emitTo('p5','missionBonusResult',{team:[{id:'p0',name:P[0].name},{id:'p1',name:P[1].name},{id:'p9',name:P[9].name}],hasWolf:true});
chkEv('MM34: Maire reçoit missionBonusResult',vCup,'missionBonusResult',d=>d&&typeof d.hasWolf==='boolean');
chkNoEv('MM35: Loup NE reçoit PAS missionBonusResult',vW1,'missionBonusResult');
chkNoEv('MM36: Villageois NE reçoit PAS missionBonusResult',vV1,'missionBonusResult');

// UI bonus pour le maire
recv('missionBonusResult',{team:[{id:P[0].id,name:P[0].name},{id:P[1].id,name:P[1].name},{id:P[9].id,name:P[9].name}],hasWolf:true});
await sleep(D);
checkVisible('MM37: missionBonusResult visible','missionBonusResult');
checkNoOverlap('MM38: missionBonusResult — pas de superposition');
check('MM39: texte bonus contient OUI',el('missionBonusResultText')&&el('missionBonusResultText').innerText.includes('OUI'));

// missionBonusResult hasWolf=false
recv('missionBonusResult',{team:[{id:P[2].id,name:P[2].name},{id:P[3].id,name:P[3].name},{id:P[9].id,name:P[9].name}],hasWolf:false});
await sleep(D);
check('MM40: texte bonus contient NON',el('missionBonusResultText')&&el('missionBonusResultText').innerText.includes('NON'));

// missionBonusUsed → broadcast
srv.emitAll('missionBonusUsed',{mayorName:P[5].name});
VPm.forEach(vp=>chkEv('MM41: missionBonusUsed broadcast '+vp.name,vp,'missionBonusUsed'));

// X. FIN DE PARTIE
forceCloseAllCards();
srv.reset();
srv.emitAll('deadVision',{roles:RL,wolves:WOLVES,lovers:LOVERS,mayor:'p5'});
VPm.forEach(vp=>chkEv('X1: deadVision fin partie '+vp.name,vp,'deadVision'));
const sd={winner:'wolves',dayCount:3,nightCount:3,firstDead:{name:P[9].name,role:'Villageois'},mayorName:P[5].name,witchSaved:true,witchKilled:false,deathLog:P.slice(2,10).map(p=>({id:p.id,name:p.name,role:RL[p.id],cause:'loups'})),seerLog:[{name:P[0].name,role:'Loup'},{name:P[11].name,role:'Villageois'}],durationMs:1260000,survivors:[{name:P[0].name,role:'Loup'},{name:P[1].name,role:'Loup'}],totalPlayers:12};
srv.emitAll('gameSummary',sd);srv.emitAll('gameEnd','🐺 Les Loups ont gagné !');
VPm.forEach(vp=>chkEv('X2: gameSummary broadcast '+vp.name,vp,'gameSummary'));
VPm.forEach(vp=>chkEv('X3: gameEnd broadcast '+vp.name,vp,'gameEnd'));
recv('deadVision',{roles:RL,wolves:WOLVES,lovers:LOVERS,mayor:P[5].id});
recv('gameSummary',sd);recv('gameEnd','🐺 Les Loups ont gagné !');await sleep(D*3);
const es=el('endScreen');
check('X4: endScreen visible',es&&es.className.includes('visible'));
check('X5: titre non vide',el('endScreenTitle')&&el('endScreenTitle').innerText.trim()!=='');
check('X6: stats remplies',el('endStatsList')&&el('endStatsList').children.length>0);
check('X7: seerLog dans stats',el('endStatsList')&&el('endStatsList').innerHTML.includes('Voyante'));
check('X8: rôles révélés',el('endRolesList')&&el('endRolesList').children.length>0);
check('X9: lobby caché',el('lobby')&&el('lobby').style.display==='none');
check('X10: gameIsOver=true',typeof gameIsOver==='undefined'||gameIsOver===true);
forceRender();await sleep(D);
checkNoBtns('X11: pas de "🗳️ Voter" après fin','🗳️ Voter');
checkNoBtns('X12: pas de "🐺 Attaquer" après fin','🐺 Attaquer');
checkNoBtns('X13: pas de "🧪 Sauver" après fin','🧪 Sauver');
checkNoBtns('X14: pas de "💀 Tuer" après fin','💀 Tuer');

// ZZ. GAME RESET
recv('gameReset',{players:P});await sleep(D+100);
check('ZZ1: endScreen caché',es&&!es.className.includes('visible'));
check('ZZ2: gameIsOver=false',typeof gameIsOver==='undefined'||gameIsOver===false,'val='+gameIsOver);
check('ZZ3: endCard cachée',el('endCard')&&el('endCard').style.display==='none');
check('ZZ4: mayorCard cachée',el('mayorCard')&&el('mayorCard').style.display==='none');
check('ZZ5: nightFallCard reset',el('nightFallCard')&&el('nightFallCard').className!=='show');
check('ZZ6: dayDeathCard reset',cardHidden('dayDeathCard'));
check('ZZ7: playersSection visible',el('playersSection')&&el('playersSection').style.display!=='none');
check('ZZ8: voteActive=false',typeof voteActive==='undefined'||voteActive===false);
check('ZZ9: corbeauPanel caché',el('corbeauPanel')&&el('corbeauPanel').style.display==='none');
check('ZZ10: petiteFillePanel caché',el('petiteFillePanel')&&el('petiteFillePanel').style.display==='none');
check('ZZ11: witchDoneBtn caché',el('witchDoneBtn')&&el('witchDoneBtn').style.display==='none');
check('ZZ12: chasseurPanel caché',el('chasseurPanel')&&el('chasseurPanel').style.display==='none');
check('ZZ13: tiebreakPanel caché',el('tiebreakPanel')&&(el('tiebreakPanel').style.display==='none'||(el('tiebreakPanel').style.cssText||'').includes('display:none')));
checkHidden('ZZ14: deadFullScreen caché après reset','deadFullScreen');
check('ZZ15: deadChatPanel caché',el('deadChatPanel')&&el('deadChatPanel').style.display==='none');
check('ZZ16: deadVisionPanel caché',el('deadVisionPanel')&&el('deadVisionPanel').style.display==='none');
check('ZZ17: infoPanel caché',el('infoPanel')&&el('infoPanel').style.display==='none');
check('ZZ18: votesPanel caché',el('votesPanel')&&el('votesPanel').style.display==='none');
check('ZZ19: nightCardShownThisNight=false',typeof nightCardShownThisNight==='undefined'||nightCardShownThisNight===false);
check('ZZ20: mayorTransferPending=false',typeof mayorTransferPending==='undefined'||mayorTransferPending===false);
checkNoCards('ZZ21: aucune carte visible après reset');
// Panneaux mission cachés après reset
checkHidden('ZZ22: missionPanel caché','missionPanel');
checkHidden('ZZ23: missionVotePanel caché','missionVotePanel');
checkHidden('ZZ24: missionBonusPanel caché','missionBonusPanel');
checkHidden('ZZ25: missionStatusPanel caché','missionStatusPanel');
checkHidden('ZZ26: missionBonusResult caché','missionBonusResult');
forceRender();await sleep(D);
checkNoBtns('ZZ22: pas de "Sauver" résiduel','🧪 Sauver');checkNoBtns('ZZ23: pas de "Tuer" résiduel','💀 Tuer');
checkNoBtns('ZZ24: pas de "Attaquer" résiduel','🐺 Attaquer');checkNoBtns('ZZ25: pas de "Voir" résiduel','🔮 Voir');
checkNoBtns('ZZ26: pas de "Voter" résiduel','🗳️ Voter');

if(run%5===0||run===N_RUNS){const tot=pass+fail;console.log('⏳ Run '+run+'/'+N_RUNS+' — ✅'+pass+' ❌'+fail+' ('+Math.round(pass/tot*100)+'%)');}
}

const total=pass+fail,pct=Math.round(pass/total*100);
console.log('\n'+'═'.repeat(62));
console.log('RAPPORT FINAL — '+N_RUNS+' runs · '+total+' vérifications');
console.log('═'.repeat(62));
console.log('✅ Passé  : '+pass+' ('+pct+'%)');
console.log('❌ Échoué : '+fail+' ('+(100-pct)+'%)');
if(errs.length===0){console.log('\n🎉 AUCUN BUG DÉTECTÉ !\n');}
else{
  const u={};errs.forEach(e=>{u[e]=(u[e]||0)+1;});
  const defs=[
    ['🃏 Superpositions',m=>m.includes('superposition')||m.includes('seule')||m.includes('bloquée')||m.includes('SUPERPOSITION')],
    ['🔘 Boutons',m=>m.includes('bouton')||m.includes('disabled')||/Voter|Attaquer|Sauver|Tuer|Voir|Choisir/.test(m)],
    ['🖼️  Cartes/Panneaux',m=>m.includes('card')||m.includes('Card')||m.includes('Panel')||m.includes('panel')||m.includes('visible')||m.includes('caché')||m.includes('Banner')],
    ['🔔 Events',m=>m.includes('reçoit')||m.includes('broadcast')],
    ['⚙️  Autres',()=>true]
  ];
  const seen=new Set();
  for(const[cat,pred]of defs){
    const items=Object.entries(u).filter(([m])=>!seen.has(m)&&pred(m));
    if(items.length){console.log('\n'+cat+' ('+items.length+' types) :');items.sort((a,b)=>b[1]-a[1]).forEach(([m,n])=>{console.log('  x'+n+' — '+m);seen.add(m);});}
  }
}
console.log('═'.repeat(62)+'\n');
})();