const $ = (selector) => document.querySelector(selector);
let socket;
let currentRoom;
let currentUsername = '';
let lastMessageDay = '';

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data.error || 'Có lỗi xảy ra');
  return data;
}

function showAuthError(message) {
  const messages = {
    'Invalid username or password': 'Tên tài khoản phải gồm 3–32 chữ cái, số hoặc dấu gạch dưới; mật khẩu cần từ 10 ký tự.',
    'Username exists': 'Tên tài khoản này đã được đăng ký. Hãy đăng nhập bằng mật khẩu đã tạo trước đó.',
    'Invalid credentials': 'Tên tài khoản hoặc mật khẩu không đúng. Nếu chưa có tài khoản, hãy bấm “Tạo tài khoản”.',
    'Failed to fetch': 'Không kết nối được máy chủ. Hãy kiểm tra Docker và tải lại trang.',
  };
  $('#authError').textContent = messages[message] || message;
}

function enterChat(user) {
  const username = user?.username || 'Tài khoản của bạn';
  currentUsername = username;
  const initial = username === 'Tài khoản của bạn' ? 'D' : username.charAt(0).toUpperCase();
  $('#accountName').textContent = username;
  $('#profileInitial').textContent = initial;
  $('.account-avatar').textContent = initial;
  $('#auth').hidden = true;
  $('#chat').hidden = false;
  $('#logout').hidden = false;
  socket = io();
  socket.on('chat-message', (message) => {
    if (String(message.room_id) === String(currentRoom)) addMessage(message);
  });
  socket.on('connect', () => {
    $('#liveStatus').classList.remove('disconnected');
    $('#liveStatusText').textContent = 'Đang trực tuyến';
    $('#notice').textContent = '';
  });
  socket.on('disconnect', () => {
    $('#liveStatus').classList.add('disconnected');
    $('#liveStatusText').textContent = 'Mất kết nối';
  });
  socket.on('connect_error', () => {
    $('#liveStatus').classList.add('disconnected');
    $('#liveStatusText').textContent = 'Mất kết nối';
    $('#notice').textContent = 'Chưa kết nối được máy chủ realtime. Hãy kiểm tra Docker.';
  });
  loadRooms().catch((error) => { $('#notice').textContent = error.message; });
}

async function loadRooms() {
  const { rooms } = await api('/api/rooms');
  $('#rooms').replaceChildren();
  $('#roomCount').textContent = rooms.length;
  rooms.forEach((room) => {
    const active = String(room.id) === String(currentRoom);
    const item = document.createElement('li');
    item.className = `room-item${active ? ' active' : ''}`;
    item.setAttribute('aria-current', active ? 'true' : 'false');
    const icon = document.createElement('span');
    icon.className = 'room-icon';
    icon.textContent = '#';
    const copy = document.createElement('span');
    copy.className = 'room-copy';
    const title = document.createElement('strong');
    title.textContent = room.name;
    const id = document.createElement('small');
    id.textContent = `Phòng #${room.id}`;
    copy.append(title, id);
    item.append(icon, copy);
    item.onclick = () => selectRoom(room);
    $('#rooms').append(item);
  });
}

function addMessage(message) {
  const emptyState = $('#messages .empty-state');
  if (emptyState) emptyState.remove();
  const date = message.created_at ? new Date(message.created_at) : new Date();
  const day = new Intl.DateTimeFormat('vi-VN', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  if (day !== lastMessageDay) {
    const divider = document.createElement('div');
    divider.className = 'date-divider';
    const label = document.createElement('span');
    label.textContent = day;
    divider.append(label);
    $('#messages').append(divider);
    lastMessageDay = day;
  }
  const own = message.username === currentUsername;
  const row = document.createElement('div');
  row.className = `message-row${own ? ' own' : ''}`;
  const avatar = document.createElement('span');
  avatar.className = 'message-avatar';
  avatar.textContent = (message.username || '?').charAt(0).toUpperCase();
  const item = document.createElement('div');
  item.className = 'message';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const author = document.createElement('strong');
  author.textContent = own ? 'Bạn' : message.username;
  const time = document.createElement('time');
  time.dateTime = date.toISOString();
  time.textContent = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(date);
  meta.append(author, time);
  const body = document.createElement('p');
  body.textContent = message.body;
  item.append(meta, body);
  row.append(avatar, item);
  $('#messages').append(row);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

async function selectRoom(room) {
  currentRoom = room.id;
  $('#roomTitle').textContent = room.name;
  $('#roomSubtitle').textContent = `Phòng #${room.id} · Tin nhắn được cập nhật theo thời gian thực`;
  $('#messages').replaceChildren();
  lastMessageDay = '';
  $('#rooms').querySelectorAll('.room-item').forEach((item) => {
    const active = item.querySelector('small')?.textContent === `Phòng #${room.id}`;
    item.classList.toggle('active', active);
    item.setAttribute('aria-current', active ? 'true' : 'false');
  });
  $('#messageForm').hidden = false;
  socket.emit('join-room', room.id);
  try {
    const { messages } = await api(`/api/rooms/${room.id}/messages`);
    if (messages.length === 0) {
      $('#messages').innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">✉</span><h3>Chưa có tin nhắn</h3><p>Hãy gửi lời chào đầu tiên cho phòng này.</p></div>';
    } else {
      messages.forEach(addMessage);
    }
  } catch (error) {
    $('#notice').textContent = error.message;
  }
}

$('#authForm').onsubmit = async (event) => {
  event.preventDefault();
  $('#authError').textContent = '';
  try {
    const credentials = Object.fromEntries(new FormData(event.currentTarget));
    const { user } = await api('/api/login', { method: 'POST', body: JSON.stringify(credentials) });
    enterChat(user);
  } catch (error) {
    showAuthError(error.message);
  }
};

$('#register').onclick = async () => {
  $('#authError').textContent = '';
  const button = $('#register');
  button.disabled = true;
  try {
    const credentials = Object.fromEntries(new FormData($('#authForm')));
    const { user } = await api('/api/register', { method: 'POST', body: JSON.stringify(credentials) });
    enterChat(user);
  } catch (error) {
    showAuthError(error.message);
  } finally {
    button.disabled = false;
  }
};

$('#roomForm').onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const name = new FormData(form).get('name');
    const { room } = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) });
    form.reset();
    await loadRooms();
    await selectRoom(room);
  } catch (error) {
    $('#notice').textContent = error.message;
  }
};

$('#joinRoom').onclick = async () => {
  try {
    const id = $('#joinId').value.trim();
    await api(`/api/rooms/${encodeURIComponent(id)}/join`, { method: 'POST' });
    $('#joinId').value = '';
    await loadRooms();
  } catch (error) {
    $('#notice').textContent = error.message;
  }
};

$('#messageForm').onsubmit = (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.body;
  const body = input.value.trim();
  if (!body) return;
  socket.emit('chat-message', { roomId: currentRoom, body }, (result) => {
    if (result?.error) $('#notice').textContent = result.error;
  });
  input.value = '';
  input.focus();
};

$('#logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
};

api('/api/me').then(({ user }) => enterChat(user)).catch(() => {});
