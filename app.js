// ======================================================================
// ORBIT — P2P мессенджер без сервера (использует публичный signaling PeerJS,
// сами данные — сообщения/файлы/голос/звонки — идут напрямую между браузерами)
// ======================================================================

const LS_PROFILE = 'orbit_profile';
const LS_FRIENDS = 'orbit_friends';
const chatKey = (id) => 'orbit_chat_' + id;

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB — по факту base64 займёт больше в localStorage

// ---------------------------------------------------------------------
// РАМКИ АВАТАРА (визуальная "фишка" приложения)
// ---------------------------------------------------------------------
const FRAMES = [
  { id: 'none', name: 'Без рамки', svg: () => '' },
  { id: 'amber', name: 'Янтарь', svg: () => `<circle cx="50" cy="50" r="45" fill="none" stroke="#FFB86B" stroke-width="5"/>` },
  { id: 'violet', name: 'Фиолет', svg: () => `<circle cx="50" cy="50" r="45" fill="none" stroke="#6C5CE7" stroke-width="5"/>` },
  { id: 'dual', name: 'Дуальная', svg: () => `<circle cx="50" cy="50" r="45" fill="none" stroke="#FFB86B" stroke-width="4"/><circle cx="50" cy="50" r="37" fill="none" stroke="#6C5CE7" stroke-width="2.5"/>` },
  { id: 'dashed', name: 'Пунктир', svg: () => `<circle cx="50" cy="50" r="45" fill="none" stroke="#8A7CF0" stroke-width="4" stroke-dasharray="8 7"/>` },
  { id: 'gradient', name: 'Орбита', svg: (uid) => `
      <defs><linearGradient id="g${uid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#FFB86B"/><stop offset="100%" stop-color="#6C5CE7"/>
      </linearGradient></defs>
      <circle cx="50" cy="50" r="45" fill="none" stroke="url(#g${uid})" stroke-width="5"/>
      <circle cx="50" cy="5" r="4" fill="#FFB86B">
        <animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="6s" repeatCount="indefinite"/>
      </circle>` },
  { id: 'glow', name: 'Свечение', svg: (uid) => `
      <defs><filter id="f${uid}"><feGaussianBlur stdDeviation="2.2"/></filter></defs>
      <circle cx="50" cy="50" r="45" fill="none" stroke="#FFB86B" stroke-width="5" filter="url(#f${uid})" opacity="0.9"/>
      <circle cx="50" cy="50" r="45" fill="none" stroke="#FFB86B" stroke-width="2"/>` },
];
let frameSvgUidCounter = 0;
function frameById(id){ return FRAMES.find(f => f.id === id) || FRAMES[0]; }
function renderFrameInto(svgEl, frameId){
  const f = frameById(frameId);
  frameSvgUidCounter++;
  svgEl.innerHTML = f.svg(frameSvgUidCounter);
}

// ---------------------------------------------------------------------
// STORAGE HELPERS
// ---------------------------------------------------------------------
function loadProfile(){ try{ return JSON.parse(localStorage.getItem(LS_PROFILE)); }catch(e){ return null; } }
function saveProfile(p){ localStorage.setItem(LS_PROFILE, JSON.stringify(p)); }

function loadFriends(){ try{ return JSON.parse(localStorage.getItem(LS_FRIENDS)) || {}; }catch(e){ return {}; } }
function saveFriends(f){ localStorage.setItem(LS_FRIENDS, JSON.stringify(f)); }

function loadChat(id){ try{ return JSON.parse(localStorage.getItem(chatKey(id))) || []; }catch(e){ return []; } }
function saveChat(id, arr){
  try{ localStorage.setItem(chatKey(id), JSON.stringify(arr)); }
  catch(e){
    // квота localStorage превышена — обрезаем старые тяжёлые сообщения (файлы/голос/картинки)
    let trimmed = arr.filter(m => m.type === 'text').slice(-200);
    try{ localStorage.setItem(chatKey(id), JSON.stringify(trimmed)); showToast('Хранилище переполнено — старые файлы из истории удалены.'); }
    catch(e2){ showToast('Не удалось сохранить сообщение локально.'); }
  }
}

function genId(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for(let i=0;i<7;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

// ---------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------
let profile = loadProfile();
let friends = loadFriends();

// ---------------------------------------------------------------------
// ВСТРОЕННЫЙ ЖУРНАЛ (чтобы диагностировать проблемы с телефона, без devtools)
// ---------------------------------------------------------------------
const debugLog = [];
function logEvent(msg){
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  debugLog.push(line);
  if(debugLog.length > 300) debugLog.shift();
  console.log(line);
  const panel = document.getElementById('debug-log-text');
  if(panel && document.getElementById('modal-debug').classList.contains('show')) panel.textContent = debugLog.join('\n');
}

let peer = null;
let connections = {};       // id -> DataConnection
let outbox = {};            // id -> [payload,...]
let pendingConnectAttempt = {}; // id -> bool
let activeChatId = null;
let activeCall = null;
let localCallStream = null;
let isMuted = false;
let mediaRecorder = null, recordedChunks = [], recordStartTime = 0, recordTimerInt = null;

// ---------------------------------------------------------------------
// DOM REFS
// ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const screens = { boot: $('screen-boot'), onboard: $('screen-onboard'), app: $('screen-app') };
function showScreen(name){ Object.values(screens).forEach(s=>s.classList.remove('active')); screens[name].classList.add('active'); }

// ---------------------------------------------------------------------
// AVATAR RENDER HELPER
// ---------------------------------------------------------------------
function renderAvatar({wrapEl, svgEl, circleEl, initialEl}, entity){
  renderFrameInto(svgEl, entity.frameId || 'none');
  if(entity.avatarData){
    circleEl.innerHTML = `<img src="${entity.avatarData}" alt="">`;
  } else {
    circleEl.innerHTML = `<span></span>`;
    circleEl.querySelector('span').textContent = (entity.nickname||'?').trim().charAt(0).toUpperCase() || '?';
  }
}

// ---------------------------------------------------------------------
// TOASTS
// ---------------------------------------------------------------------
function showToast(text){
  const stack = $('toast-stack');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  stack.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(), 300); }, 3800);
}

// ======================================================================
// ONBOARDING
// ======================================================================
let onboardState = { avatarData: null, frameId: 'amber' };

function buildFrameSwatches(container, currentId, onPick){
  container.innerHTML = '';
  FRAMES.forEach(f => {
    const el = document.createElement('div');
    el.className = 'frame-swatch' + (f.id === currentId ? ' active' : '');
    el.title = f.name;
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    frameSvgUidCounter++;
    svg.innerHTML = f.svg(frameSvgUidCounter);
    const dot = document.createElement('div');
    dot.className = 'fs-dot';
    el.appendChild(svg);
    el.appendChild(dot);
    el.addEventListener('click', () => {
      container.querySelectorAll('.frame-swatch').forEach(s=>s.classList.remove('active'));
      el.classList.add('active');
      onPick(f.id);
    });
    container.appendChild(el);
  });
}

function initOnboarding(){
  buildFrameSwatches($('onboard-frame-swatches'), onboardState.frameId, (id) => {
    onboardState.frameId = id;
    updateOnboardPreview();
  });
  updateOnboardPreview();

  $('input-nickname').addEventListener('input', updateOnboardPreview);

  $('btn-upload-avatar').addEventListener('click', () => $('input-avatar-file').click());
  $('input-avatar-file').addEventListener('change', (e) => handleAvatarFile(e, (dataUrl) => { onboardState.avatarData = dataUrl; updateOnboardPreview(); }));
  $('btn-remove-avatar').addEventListener('click', () => { onboardState.avatarData = null; updateOnboardPreview(); });

  $('btn-create-profile').addEventListener('click', () => {
    const nickname = $('input-nickname').value.trim();
    if(!nickname){ showToast('Введите никнейм.'); return; }
    const id = genId();
    profile = { id, nickname, avatarData: onboardState.avatarData, frameId: onboardState.frameId };
    saveProfile(profile);
    bootIntoApp();
  });
}
function updateOnboardPreview(){
  renderAvatar({
    wrapEl: $('onboard-avatar-wrap'), svgEl: $('onboard-frame-svg'),
    circleEl: $('onboard-avatar-circle'), initialEl: $('onboard-avatar-initial')
  }, { nickname: $('input-nickname').value || '?', avatarData: onboardState.avatarData, frameId: onboardState.frameId });
}

function handleAvatarFile(e, cb){
  const file = e.target.files[0];
  if(!file) return;
  if(file.size > 8*1024*1024){ showToast('Слишком большое фото (макс. 8МБ).'); e.target.value=''; return; }
  compressImageFile(file, 240, 0.85).then(dataUrl => { cb(dataUrl); }).catch(() => showToast('Не удалось обработать фото.'));
  e.target.value = '';
}

// Сжимаем аватар до небольшого размера (canvas) — иначе большой base64 в профиле
// может слишком долго/ненадёжно передаваться по WebRTC при первом подключении.
function compressImageFile(file, maxDim, quality){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        let { width, height } = img;
        if(width > height){ if(width > maxDim){ height = Math.round(height * maxDim / width); width = maxDim; } }
        else { if(height > maxDim){ width = Math.round(width * maxDim / height); height = maxDim; } }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ======================================================================
// PROFILE MODAL (редактирование)
// ======================================================================
let profileEditState = {};
function openProfileModal(){
  profileEditState = { avatarData: profile.avatarData, frameId: profile.frameId };
  $('profile-my-id').textContent = profile.id;
  $('input-nickname-edit').value = profile.nickname;
  buildFrameSwatches($('profile-frame-swatches'), profileEditState.frameId, (id) => { profileEditState.frameId = id; updateProfilePreview(); });
  updateProfilePreview();
  $('modal-profile').classList.add('show');
}
function updateProfilePreview(){
  renderAvatar({
    wrapEl: $('profile-avatar-wrap'), svgEl: $('profile-frame-svg'),
    circleEl: $('profile-avatar-circle'), initialEl: $('profile-avatar-initial')
  }, { nickname: $('input-nickname-edit').value || '?', avatarData: profileEditState.avatarData, frameId: profileEditState.frameId });
}

function initProfileModal(){
  $('btn-open-profile').addEventListener('click', openProfileModal);
  $('btn-close-profile').addEventListener('click', () => $('modal-profile').classList.remove('show'));
  $('input-nickname-edit').addEventListener('input', updateProfilePreview);
  $('btn-upload-avatar-2').addEventListener('click', () => $('input-avatar-file-2').click());
  $('input-avatar-file-2').addEventListener('change', (e) => handleAvatarFile(e, (dataUrl) => { profileEditState.avatarData = dataUrl; updateProfilePreview(); }));
  $('btn-remove-avatar-2').addEventListener('click', () => { profileEditState.avatarData = null; updateProfilePreview(); });
  $('btn-copy-id').addEventListener('click', () => {
    navigator.clipboard?.writeText(profile.id).then(()=>showToast('ID скопирован.')).catch(()=>showToast('Не удалось скопировать.'));
  });
  if(navigator.share){
    $('btn-share-id').hidden = false;
    $('btn-share-id').addEventListener('click', () => {
      navigator.share({ title: 'Orbit', text: `Мой ID в Orbit: ${profile.id}` }).catch(()=>{});
    });
  }
  $('btn-save-profile').addEventListener('click', () => {
    const nickname = $('input-nickname-edit').value.trim();
    if(!nickname){ showToast('Введите никнейм.'); return; }
    profile.nickname = nickname;
    profile.avatarData = profileEditState.avatarData;
    profile.frameId = profileEditState.frameId;
    saveProfile(profile);
    renderMyBadge();
    $('modal-profile').classList.remove('show');
    // разослать обновлённый профиль всем подключенным друзьям
    Object.keys(connections).forEach(id => trySend(id, { type:'profile', nickname: profile.nickname, avatarData: profile.avatarData, frameId: profile.frameId }));
    showToast('Профиль сохранён.');
  });

  $('btn-open-debug').addEventListener('click', () => {
    $('debug-log-text').textContent = debugLog.join('\n') || 'Журнал пока пуст.';
    $('modal-debug').classList.add('show');
  });
  $('btn-close-debug').addEventListener('click', () => $('modal-debug').classList.remove('show'));
  $('btn-copy-debug').addEventListener('click', () => {
    navigator.clipboard?.writeText(debugLog.join('\n')).then(()=>showToast('Журнал скопирован.')).catch(()=>showToast('Не удалось скопировать.'));
  });
}

function renderMyBadge(){
  $('my-nickname-display').textContent = profile.nickname;
  $('my-id-display').textContent = profile.id;
  renderAvatar({ wrapEl: $('my-avatar-wrap'), svgEl: $('my-frame-svg'), circleEl: $('my-avatar-circle'), initialEl: $('my-avatar-initial') }, profile);
}

// ======================================================================
// ADD FRIEND MODAL
// ======================================================================
function initAddFriendModal(){
  const open = () => { $('input-friend-id').value=''; $('add-friend-error').textContent=''; $('modal-add-friend').classList.add('show'); $('input-friend-id').focus(); };
  $('btn-add-friend').addEventListener('click', open);
  $('btn-add-friend-2').addEventListener('click', open);
  $('btn-cancel-add-friend').addEventListener('click', () => $('modal-add-friend').classList.remove('show'));
  $('btn-confirm-add-friend').addEventListener('click', () => {
    const id = $('input-friend-id').value.trim().toUpperCase();
    if(!id){ $('add-friend-error').textContent = 'Введите ID.'; return; }
    if(id === profile.id){ $('add-friend-error').textContent = 'Это ваш собственный ID.'; return; }
    if(friends[id]){ $('add-friend-error').textContent = 'Этот друг уже в списке.'; return; }
    friends[id] = { id, nickname: id, avatarData: null, frameId: 'none', online: false, lastMessage: '', lastMessageTime: 0, unread: 0 };
    saveFriends(friends);
    renderFriendsList();
    $('modal-add-friend').classList.remove('show');
    logEvent(`Друг ${id} добавлен локально, инициируем подключение…`);
    ensureConnected(id);
    showToast('Друг добавлен. Ждём, пока он будет онлайн…');
  });
  $('input-friend-id').addEventListener('keydown', (e) => { if(e.key==='Enter') $('btn-confirm-add-friend').click(); });
}

// ======================================================================
// FRIENDS LIST
// ======================================================================
function renderFriendsList(){
  const list = $('friends-list');
  const ids = Object.keys(friends).sort((a,b) => (friends[b].lastMessageTime||0) - (friends[a].lastMessageTime||0));
  list.innerHTML = '';
  $('empty-friends').classList.toggle('show', ids.length === 0);
  ids.forEach(id => {
    const f = friends[id];
    const item = document.createElement('div');
    item.className = 'friend-item' + (id === activeChatId ? ' active' : '');
    item.innerHTML = `
      <div class="avatar-frame-wrap sm"><svg class="avatar-frame-svg" viewBox="0 0 100 100"></svg><div class="avatar-circle"><span></span></div></div>
      <div class="friend-meta">
        <div class="friend-name-row"><span class="friend-name"></span><span class="online-dot ${f.online?'online':''}"></span></div>
        <div class="friend-preview"></div>
      </div>
      ${f.unread ? `<div class="friend-unread">${f.unread > 9 ? '9+' : f.unread}</div>` : ''}
    `;
    renderAvatar({ svgEl: item.querySelector('.avatar-frame-svg'), circleEl: item.querySelector('.avatar-circle') }, f);
    item.querySelector('.friend-name').textContent = f.nickname;
    item.querySelector('.friend-preview').textContent = f.lastMessage || 'Нет сообщений';
    item.addEventListener('click', () => openChat(id));
    list.appendChild(item);
  });
}

// ======================================================================
// PEERJS — СЕТЬ
// ======================================================================
function initPeer(){
  peer = new Peer(profile.id, { debug: 1 });
  logEvent(`Инициализация Peer с ID ${profile.id}…`);

  peer.on('open', (id) => {
    logEvent(`Peer открыт, зарегистрирован ID: ${id}`);
    bootIntoApp(true);
    Object.keys(friends).forEach(id => ensureConnected(id));
    setInterval(() => Object.keys(friends).forEach(id => ensureConnected(id)), 6000);
  });

  peer.on('connection', (conn) => { logEvent(`Входящее соединение от ${conn.peer}`); setupConnection(conn); });

  peer.on('call', (call) => { logEvent(`Входящий звонок от ${call.peer}`); handleIncomingCall(call); });

  peer.on('disconnected', () => { logEvent('Отключено от signaling-сервера, пробуем переподключиться…'); peer.reconnect(); });

  peer.on('error', (err) => {
    console.warn('Peer error', err);
    logEvent(`ОШИБКА Peer: тип="${err.type}", сообщение="${err.message}"`);
    const type = String(err.type || '');

    if(type === 'unavailable-id'){
      showToast('Этот ID уже занят в сети (возможно, открыт в другой вкладке этого же браузера). Создаём новый ID…');
      profile.id = genId();
      saveProfile(profile);
      setTimeout(() => { peer.destroy(); initPeer(); }, 500);
      return;
    }

    if(type === 'peer-unavailable'){
      // друг сейчас не в сети — вытащим его ID из текста ошибки и просто тихо подождём
      const m = /peer\s+([A-Za-z0-9]+)/i.exec(err.message || '');
      const fid = m ? m[1] : null;
      if(fid){
        pendingConnectAttempt[fid] = false;
        notifyFriendOfflineOnce(fid);
      }
      return;
    }

    if(type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed'){
      showToast('Проблема с сетью. Проверьте интернет-соединение — переподключаемся…');
      return;
    }
  });
}

let offlineNotifiedAt = {};
function notifyFriendOfflineOnce(friendId){
  const now = Date.now();
  if(offlineNotifiedAt[friendId] && now - offlineNotifiedAt[friendId] < 30000) return;
  offlineNotifiedAt[friendId] = now;
  const name = friends[friendId]?.nickname || friendId;
  showToast(`${name} пока не в сети. Подключимся автоматически, когда он(а) зайдёт.`);
}

function ensureConnected(friendId){
  if(!peer || peer.disconnected) return;
  const existing = connections[friendId];
  if(existing && existing.open) return;
  if(pendingConnectAttempt[friendId]) return;
  pendingConnectAttempt[friendId] = true;
  logEvent(`Пытаемся подключиться к ${friendId}…`);
  try{
    const conn = peer.connect(friendId, { reliable: true });
    setupConnection(conn);
    setTimeout(() => { pendingConnectAttempt[friendId] = false; }, 5000);
  }catch(e){ logEvent(`Ошибка при попытке подключения к ${friendId}: ${e}`); pendingConnectAttempt[friendId] = false; }
}

function setupConnection(conn){
  conn.on('open', () => {
    logEvent(`Соединение с ${conn.peer} ОТКРЫТО — отправляем свой профиль`);
    connections[conn.peer] = conn;
    pendingConnectAttempt[conn.peer] = false;
    setFriendOnline(conn.peer, true);
    trySend(conn.peer, { type:'profile', nickname: profile.nickname, avatarData: profile.avatarData, frameId: profile.frameId });
    flushOutbox(conn.peer);
  });
  conn.on('data', (data) => { logEvent(`Получены данные от ${conn.peer}, тип: ${data && data.type}`); handleIncomingData(conn.peer, data); });
  conn.on('close', () => { logEvent(`Соединение с ${conn.peer} закрыто`); delete connections[conn.peer]; setFriendOnline(conn.peer, false); });
  conn.on('error', (e) => { logEvent(`Ошибка соединения с ${conn.peer}: ${e}`); delete connections[conn.peer]; setFriendOnline(conn.peer, false); });
}

function setFriendOnline(id, isOnline){
  if(!friends[id]) return;
  friends[id].online = isOnline;
  if(isOnline) delete offlineNotifiedAt[id];
  saveFriends(friends);
  renderFriendsList();
  if(activeChatId === id) updateChatHeaderStatus(isOnline);
}

function trySend(friendId, payload){
  const conn = connections[friendId];
  if(conn && conn.open){ conn.send(payload); return true; }
  outbox[friendId] = outbox[friendId] || [];
  outbox[friendId].push(payload);
  ensureConnected(friendId);
  return false;
}
function flushOutbox(friendId){
  const q = outbox[friendId];
  if(!q || !q.length) return;
  const conn = connections[friendId];
  if(!conn || !conn.open) return;
  q.forEach(p => conn.send(p));
  outbox[friendId] = [];
}

function handleIncomingData(fromId, data){
  if(!data || !data.type) return;

  if(data.type === 'profile'){
    if(!friends[fromId]){
      friends[fromId] = { id: fromId, nickname: data.nickname, avatarData: data.avatarData, frameId: data.frameId, online: true, lastMessage:'', lastMessageTime:0, unread:0 };
      showToast(`${data.nickname} добавил(а) вас в друзья и теперь на связи.`);
    } else {
      friends[fromId].nickname = data.nickname;
      friends[fromId].avatarData = data.avatarData;
      friends[fromId].frameId = data.frameId;
    }
    saveFriends(friends);
    renderFriendsList();
    if(activeChatId === fromId) renderChatHeader(friends[fromId]);
    return;
  }

  if(['text','image','file','voice'].includes(data.type)){
    const msg = { dir:'in', type:data.type, text:data.text, filename:data.filename, mime:data.mime, dataUrl:data.dataUrl, duration:data.duration, ts:data.ts || Date.now() };
    const chat = loadChat(fromId);
    chat.push(msg);
    saveChat(fromId, chat);

    if(!friends[fromId]) friends[fromId] = { id: fromId, nickname: fromId, avatarData:null, frameId:'none', online:true, lastMessage:'', lastMessageTime:0, unread:0 };
    friends[fromId].lastMessage = previewForMessage(msg);
    friends[fromId].lastMessageTime = msg.ts;
    if(activeChatId !== fromId){
      friends[fromId].unread = (friends[fromId].unread||0) + 1;
      showToast(`${friends[fromId].nickname}: ${previewForMessage(msg)}`);
    }
    saveFriends(friends);
    renderFriendsList();
    if(activeChatId === fromId) appendMessageToDom(msg);
  }
}

function previewForMessage(m){
  if(m.type === 'text') return m.text.length > 40 ? m.text.slice(0,40)+'…' : m.text;
  if(m.type === 'image') return '📷 Фото';
  if(m.type === 'file') return '📎 ' + (m.filename || 'Файл');
  if(m.type === 'voice') return '🎤 Голосовое сообщение';
  return '';
}

// ======================================================================
// CHAT UI
// ======================================================================
function openChat(id){
  activeChatId = id;
  if(friends[id]){ friends[id].unread = 0; saveFriends(friends); }
  renderFriendsList();
  renderChatHeader(friends[id]);
  renderChatMessages(id);
  $('chat-placeholder').style.display = 'none';
  $('chat-active').classList.add('show');
  // mobile: показать чат-панель
  $('panel-list').classList.add('hide-mobile');
  $('panel-chat').classList.add('show-mobile');
  ensureConnected(id);
}

$('btn-back-to-list') && $('btn-back-to-list').addEventListener('click', () => {
  $('panel-list').classList.remove('hide-mobile');
  $('panel-chat').classList.remove('show-mobile');
});

function renderChatHeader(f){
  if(!f) return;
  renderAvatar({ svgEl: $('chat-frame-svg'), circleEl: $('chat-avatar-circle') }, f);
  $('chat-header-name').textContent = f.nickname;
  updateChatHeaderStatus(f.online);
}
function updateChatHeaderStatus(online){
  const el = $('chat-header-status');
  el.textContent = online ? 'в сети' : 'не в сети';
  el.classList.toggle('online', !!online);
}

function renderChatMessages(id){
  const scroll = $('messages-scroll');
  scroll.innerHTML = '';
  const chat = loadChat(id);
  chat.forEach(m => appendMessageToDom(m, false));
  scroll.scrollTop = scroll.scrollHeight;
}

function fmtTime(ts){
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}
function fmtBytes(n){
  if(n < 1024) return n + ' Б';
  if(n < 1024*1024) return (n/1024).toFixed(1) + ' КБ';
  return (n/1024/1024).toFixed(1) + ' МБ';
}

function appendMessageToDom(m, scroll=true){
  const wrap = $('messages-scroll');
  const row = document.createElement('div');
  row.className = 'msg-row ' + (m.dir === 'out' ? 'me' : 'them');
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if(m.type === 'text'){
    const span = document.createElement('div');
    span.textContent = m.text;
    bubble.appendChild(span);
  } else if(m.type === 'image'){
    const img = document.createElement('img');
    img.className = 'msg-image';
    img.src = m.dataUrl;
    img.addEventListener('click', () => window.open(m.dataUrl, '_blank'));
    bubble.appendChild(img);
  } else if(m.type === 'file'){
    const div = document.createElement('div');
    div.className = 'msg-file';
    div.innerHTML = `<div class="msg-file-icon">📎</div><div class="msg-file-info"><span class="msg-file-name"></span><span class="msg-file-size"></span></div>`;
    div.querySelector('.msg-file-name').textContent = m.filename || 'Файл';
    div.querySelector('.msg-file-size').textContent = m.size ? fmtBytes(m.size) : '';
    div.style.cursor = 'pointer';
    div.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = m.dataUrl; a.download = m.filename || 'file';
      document.body.appendChild(a); a.click(); a.remove();
    });
    bubble.appendChild(div);
  } else if(m.type === 'voice'){
    const div = document.createElement('div');
    div.className = 'msg-voice';
    div.innerHTML = `<button class="voice-play-btn">▶</button><div class="voice-waveform"><div class="voice-waveform-fill"></div></div><span class="voice-duration"></span>`;
    const audio = new Audio(m.dataUrl);
    const btn = div.querySelector('.voice-play-btn');
    const fill = div.querySelector('.voice-waveform-fill');
    const durEl = div.querySelector('.voice-duration');
    durEl.textContent = m.duration ? m.duration + '″' : '';
    btn.addEventListener('click', () => {
      if(audio.paused){ audio.play(); btn.textContent = '❚❚'; } else { audio.pause(); btn.textContent = '▶'; }
    });
    audio.addEventListener('timeupdate', () => { fill.style.width = (audio.currentTime/(audio.duration||1)*100) + '%'; });
    audio.addEventListener('ended', () => { btn.textContent = '▶'; fill.style.width='0%'; });
    bubble.appendChild(div);
  }

  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = fmtTime(m.ts);
  bubble.appendChild(time);
  row.appendChild(bubble);
  wrap.appendChild(row);
  if(scroll) wrap.scrollTop = wrap.scrollHeight;
}

function sendChatPayload(payload){
  if(!activeChatId) return;
  const msg = { dir:'out', ...payload };
  const chat = loadChat(activeChatId);
  chat.push(msg);
  saveChat(activeChatId, chat);
  appendMessageToDom(msg);

  friends[activeChatId].lastMessage = previewForMessage(msg);
  friends[activeChatId].lastMessageTime = msg.ts;
  saveFriends(friends);
  renderFriendsList();

  trySend(activeChatId, payload);
}

function initComposer(){
  const input = $('input-message');
  input.addEventListener('input', () => { input.style.height='auto'; input.style.height = Math.min(input.scrollHeight,120)+'px'; });
  input.addEventListener('keydown', (e) => { if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendTextMessage(); } });
  $('btn-send-text').addEventListener('click', sendTextMessage);

  function sendTextMessage(){
    const text = input.value.trim();
    if(!text || !activeChatId) return;
    sendChatPayload({ type:'text', text, ts: Date.now() });
    input.value=''; input.style.height='auto';
  }

  $('btn-attach').addEventListener('click', () => $('input-attach-file').click());
  $('input-attach-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if(!file || !activeChatId) return;
    if(file.size > MAX_FILE_BYTES){ showToast('Файл слишком большой (макс. 15МБ).'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const isImage = file.type.startsWith('image/');
      sendChatPayload({
        type: isImage ? 'image' : 'file',
        dataUrl: reader.result, filename: file.name, mime: file.type, size: file.size, ts: Date.now()
      });
    };
    reader.readAsDataURL(file);
  });
}

// ======================================================================
// ГОЛОСОВЫЕ СООБЩЕНИЯ
// ======================================================================
function initVoiceRecording(){
  $('btn-record-voice').addEventListener('click', startRecording);
  $('btn-cancel-record').addEventListener('click', () => stopRecording(false));
  $('btn-stop-record').addEventListener('click', () => stopRecording(true));

  async function startRecording(){
    if(!activeChatId) return;
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => { if(e.data.size>0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = () => { stream.getTracks().forEach(t=>t.stop()); };
      mediaRecorder.start();
      recordStartTime = Date.now();
      $('voice-recording-bar').classList.add('show');
      recordTimerInt = setInterval(() => {
        const s = Math.floor((Date.now()-recordStartTime)/1000);
        $('rec-timer').textContent = Math.floor(s/60)+':'+(s%60).toString().padStart(2,'0');
      }, 250);
    }catch(e){ showToast('Нет доступа к микрофону.'); }
  }

  function stopRecording(send){
    if(!mediaRecorder) return;
    const duration = Math.round((Date.now()-recordStartTime)/1000);
    clearInterval(recordTimerInt);
    $('voice-recording-bar').classList.remove('show');
    mediaRecorder.onstop = () => {
      mediaRecorder.stream.getTracks().forEach(t=>t.stop());
      if(send && recordedChunks.length){
        const blob = new Blob(recordedChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = () => sendChatPayload({ type:'voice', dataUrl: reader.result, duration, ts: Date.now() });
        reader.readAsDataURL(blob);
      }
    };
    mediaRecorder.stop();
    mediaRecorder = null;
  }
}

// ======================================================================
// ЗВОНКИ
// ======================================================================
function showCallModal(){ $('modal-call').classList.add('show'); }
function hideCallModal(){ $('modal-call').classList.remove('show'); }

function setCallUI({name, avatarEntity, status, showAccept, showDeclineAsHangup}){
  $('call-peer-name').textContent = name;
  $('call-status').textContent = status;
  if(avatarEntity) renderAvatar({ svgEl: $('call-frame-svg'), circleEl: $('call-avatar-circle') }, avatarEntity);
  $('btn-accept-call').classList.toggle('hidden', !showAccept);
  $('btn-decline-call').classList.toggle('hidden', !showAccept);
  $('btn-hangup-call').classList.toggle('hidden', showAccept);
  $('btn-mute-call').classList.toggle('hidden', showAccept);
}

async function startOutgoingCall(friendId){
  const f = friends[friendId];
  if(!f){ return; }
  if(!f.online){ showToast('Друг сейчас не в сети.'); return; }
  try{
    localCallStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }catch(e){ showToast('Нет доступа к микрофону.'); return; }
  setCallUI({ name: f.nickname, avatarEntity: f, status: 'Звоним…', showAccept: false });
  showCallModal();
  const call = peer.call(friendId, localCallStream);
  activeCall = call;
  call.on('stream', (remoteStream) => {
    $('remote-audio').srcObject = remoteStream;
    setCallUI({ name: f.nickname, avatarEntity: f, status: 'Соединено', showAccept: false });
  });
  call.on('close', endCallUI);
  call.on('error', endCallUI);
}

function handleIncomingCall(call){
  const fromId = call.peer;
  const f = friends[fromId] || { nickname: fromId, avatarData:null, frameId:'none' };
  activeCall = call;
  setCallUI({ name: f.nickname, avatarEntity: f, status: 'Входящий звонок…', showAccept: true });
  showCallModal();

  $('btn-accept-call').onclick = async () => {
    try{
      localCallStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }catch(e){ showToast('Нет доступа к микрофону.'); call.close(); return; }
    call.answer(localCallStream);
    call.on('stream', (remoteStream) => {
      $('remote-audio').srcObject = remoteStream;
      setCallUI({ name: f.nickname, avatarEntity: f, status: 'Соединено', showAccept: false });
    });
  };
  $('btn-decline-call').onclick = () => { call.close(); endCallUI(); };
  call.on('close', endCallUI);
  call.on('error', endCallUI);
}

function endCallUI(){
  hideCallModal();
  if(localCallStream){ localCallStream.getTracks().forEach(t=>t.stop()); localCallStream = null; }
  isMuted = false;
  activeCall = null;
}

function initCallControls(){
  $('btn-call-audio').addEventListener('click', () => { if(activeChatId) startOutgoingCall(activeChatId); });
  $('btn-hangup-call').addEventListener('click', () => { if(activeCall) activeCall.close(); endCallUI(); });
  $('btn-mute-call').addEventListener('click', () => {
    if(!localCallStream) return;
    isMuted = !isMuted;
    localCallStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    $('btn-mute-call').style.background = isMuted ? 'var(--danger)' : '';
    showToast(isMuted ? 'Микрофон выключен' : 'Микрофон включён');
  });
}

// ======================================================================
// BOOTSTRAP
// ======================================================================
function bootIntoApp(fromPeerOpen){
  renderMyBadge();
  renderFriendsList();
  showScreen('app');
}

function init(){
  logEvent(`Экран: ${window.innerWidth}x${window.innerHeight}, DPR: ${window.devicePixelRatio}, UA: ${navigator.userAgent}`);

  // Принудительно зачищаем ЛЮБЫЕ старые service worker'ы и кэши от предыдущих версий сайта —
  // они могли остаться зарегистрированными с ранних этапов разработки и подсовывать устаревший CSS/JS.
  if('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(reg => { logEvent(`Удаляем старый service worker: ${reg.scope}`); reg.unregister(); });
    });
  }
  if('caches' in window){
    caches.keys().then(keys => keys.forEach(k => { logEvent(`Удаляем старый кэш: ${k}`); caches.delete(k); }));
  }

  initOnboarding();
  initProfileModal();
  initAddFriendModal();
  initComposer();
  initVoiceRecording();
  initCallControls();

  if(profile && profile.id && profile.nickname){
    showScreen('boot');
    initPeer();
  } else {
    showScreen('onboard');
  }
  // Service worker больше НЕ регистрируем — слишком много проблем со старым кэшем на разных
  // устройствах. Приложению всё равно нужен интернет постоянно (P2P), офлайн-режим не нужен.
  // Старые SW от предыдущих версий сайта принудительно удаляются в блоке выше.
}

init();
