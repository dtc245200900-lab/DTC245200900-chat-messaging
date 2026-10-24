const $ = (selector) => document.querySelector(selector);
let socket;
let currentRoom;
let currentUsername = '';
let currentDisplayName = '';
let currentUserId;
let pendingAvatarData;
let pendingAvatarType;
let avatarChanged = false;
let lastMessageDay = '';
let seenMessageIds = new Set();
let rooms = [];
let historyRequest = 0;
let currentRoomData;
let currentMessages = [];
let roomFilter = 'all';
let roomSearchRequest = 0;
let roomMembers = [];
let activeCall;
let localCallStream;
let peerConnection;
let pendingIceCandidates = [];

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data.error || 'Có lỗi xảy ra');
  return data;
}

function notify(message = '', type = 'error') {
  const notice = $('#globalNotice');
  notice.textContent = message;
  notice.classList.toggle('success', type === 'success');
  notice.classList.toggle('error', type === 'error');
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

function setProfile(user) {
  currentUserId = user.id;
  currentUsername = user.username;
  currentDisplayName = user.display_name || user.username;
  const profile = { ...user, display_name: currentDisplayName };
  const initial = currentDisplayName.charAt(0).toUpperCase() || 'D';
  $('#accountName').textContent = currentDisplayName;
  setAvatar($('.account-avatar'), profile, initial);
  setAvatar($('#profileInitial'), profile, initial);
  setAvatar($('#railInitial'), profile, initial);
  setAvatar($('#profileAvatarView'), profile, initial);
  $('#displayName').value = currentDisplayName;
  $('#settingsUsername').value = currentUsername;
  $('#jobTitle').value = user.job_title || '';
  $('#department').value = user.department || '';
  $('#bio').value = user.bio || '';
  pendingAvatarData = undefined;
  pendingAvatarType = undefined;
  avatarChanged = false;
  $('#avatarInput').value = '';
  $('#removeAvatar').hidden = !user.avatar_url;
}

function setAvatar(element, user, initial) {
  element.replaceChildren();
  element.textContent = initial || (user.display_name || user.username).charAt(0).toUpperCase();
  if (!user.avatar_url) return;
  const image = document.createElement('img');
  image.src = user.avatar_url;
  image.alt = '';
  image.addEventListener('error', () => image.remove(), { once: true });
  element.append(image);
}

function enterChat(user) {
  setProfile(user);
  $('#auth').hidden = true;
  $('#chat').hidden = false;
  $('#globalSearchForm').hidden = false;
  $('#logout').hidden = false;
  if (socket) socket.disconnect();
  socket = io();
  socket.on('chat-message', (message) => {
    if (String(message.room_id) === String(currentRoom)) addMessage(message);
  });
  socket.on('call:incoming', receiveCall);
  socket.on('call:accepted', (call) => {
    if (!activeCall || call.callId !== activeCall.callId) return;
    activeCall.peerSocketId = call.peerSocketId;
    activeCall.phase = 'connecting';
    updateCallPanel('Đang kết nối...', false);
    createCallOffer().catch((error) => failCall(error));
  });
  socket.on('call:signal', (message) => {
    if (!activeCall || message.callId !== activeCall.callId) return;
    handleCallSignal(message.signal).catch((error) => failCall(error));
  });
  socket.on('call:ended', ({ callId, reason }) => {
    if (!activeCall || callId !== activeCall.callId) return;
    const messages = {
      declined: 'Cuộc gọi đã bị từ chối.',
      disconnected: 'Cuộc gọi kết thúc do mất kết nối.',
      'left-room': 'Cuộc gọi kết thúc khi thành viên rời phòng.',
      'no-answer': activeCall.phase === 'dialing'
        ? 'Không có người trả lời cuộc gọi.'
        : 'Cuộc gọi đã kết thúc.',
    };
    finishCall(false);
    if (messages[reason]) notify(messages[reason]);
  });
  socket.on('operation-error', ({ error }) => notify(error));
  socket.on('connect', () => {
    $('#liveStatus').classList.remove('disconnected');
    $('#liveStatusText').textContent = 'Đang trực tuyến';
    if (currentRoom) socket.emit('join-room', currentRoom);
  });
  socket.on('disconnect', () => {
    $('#liveStatus').classList.add('disconnected');
    $('#liveStatusText').textContent = 'Mất kết nối';
    $('#messageForm button').disabled = false;
    if (activeCall) finishCall(false);
  });
  socket.on('connect_error', () => {
    $('#liveStatus').classList.add('disconnected');
    $('#liveStatusText').textContent = 'Mất kết nối';
    notify('Chưa kết nối được máy chủ realtime. Hãy kiểm tra Docker.');
  });
  loadRooms().then((loadedRooms) => {
    if (!currentRoom && loadedRooms[0]) selectRoom(loadedRooms[0]);
  }).catch((error) => notify(error.message));
}

function roomListItem(room, compact = false) {
  const active = String(room.id) === String(currentRoom);
  const item = document.createElement('li');
  item.className = `room-item${active ? ' active' : ''}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'room-item-button';
  button.setAttribute('aria-current', active ? 'page' : 'false');
  const icon = document.createElement('span');
  icon.className = 'room-icon';
  icon.textContent = '#';
  const copy = document.createElement('span');
  copy.className = 'room-copy';
  const title = document.createElement('strong');
  title.textContent = room.name;
  const subtitle = document.createElement('small');
  subtitle.textContent = `#${room.id} · ${room.member_count || 1} thành viên`;
  copy.append(title, subtitle);
  button.append(icon, copy);
  button.addEventListener('click', () => selectRoom(room));
  item.append(button);
  const favorite = document.createElement('button');
  favorite.type = 'button';
  favorite.className = `room-favorite${room.is_favorite ? ' selected' : ''}`;
  favorite.textContent = room.is_favorite ? '★' : '☆';
  favorite.setAttribute('aria-label', room.is_favorite ? 'Bỏ yêu thích' : 'Thêm vào yêu thích');
  favorite.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      await api(`/api/rooms/${room.id}/favorite`, {
        method: 'POST',
        body: JSON.stringify({ favorite: !room.is_favorite }),
      });
      await loadRooms();
      if (String(currentRoom) === String(room.id)) {
        currentRoomData = rooms.find((item) => String(item.id) === String(room.id));
        await loadRoomOverview();
      }
    } catch (error) {
      notify(error.message);
    }
  });
  item.append(favorite);
  if (compact) item.classList.add('compact-room');
  return item;
}

function renderRooms() {
  const query = $('#roomSearch').value.trim().toLocaleLowerCase();
  const filtered = rooms.filter((room) => {
    const matchesSearch = room.name.toLocaleLowerCase().includes(query);
    const matchesFilter = roomFilter === 'all'
      || (roomFilter === 'favorite' && room.is_favorite)
      || (roomFilter === 'recent' && room.last_message_at);
    return matchesSearch && matchesFilter;
  });
  $('#rooms').replaceChildren(...filtered.map((room) => roomListItem(room)));
  $('#roomCount').textContent = String(filtered.length);
}

async function loadRooms() {
  const { rooms: loadedRooms } = await api('/api/rooms');
  rooms = loadedRooms;
  renderRooms();
  const select = $('#fileRoom');
  const selectedRoom = select.value;
  select.replaceChildren(new Option('Chọn phòng...', ''));
  rooms.forEach((room) => select.add(new Option(`${room.name} (#${room.id})`, room.id)));
  if (rooms.some((room) => String(room.id) === selectedRoom)) select.value = selectedRoom;
  return rooms;
}

function addMessage(message) {
  if (message.id && seenMessageIds.has(String(message.id))) return;
  if (message.id) seenMessageIds.add(String(message.id));
  const emptyState = $('#messages .empty-state');
  if (emptyState) emptyState.remove();
  const date = message.created_at ? new Date(message.created_at) : new Date();
  const day = new Intl.DateTimeFormat('vi-VN', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  if (day !== lastMessageDay) {
    const divider = document.createElement('div');
    divider.className = 'date-divider';
    const label = document.createElement('span');
    const today = new Date();
    label.textContent = date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth()
      && date.getDate() === today.getDate()
      ? 'Hôm nay'
      : day;
    divider.append(label);
    $('#messages').append(divider);
    lastMessageDay = day;
  }
  const own = message.username === currentUsername;
  const row = document.createElement('div');
  row.className = `message-row${own ? ' own' : ''}`;
  row.dataset.messageId = message.id;
  const avatar = document.createElement('span');
  avatar.className = 'message-avatar';
  avatar.textContent = (message.username || '?').charAt(0).toUpperCase();
  const item = document.createElement('div');
  item.className = 'message-content';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const author = document.createElement('strong');
  author.textContent = own ? 'Bạn' : message.username;
  const time = document.createElement('time');
  time.dateTime = date.toISOString();
  time.textContent = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(date);
  meta.append(author, time);
  const body = document.createElement('p');
  body.className = 'message-bubble';
  body.textContent = message.body;
  const controls = document.createElement('div');
  controls.className = 'message-controls';
  const reactions = document.createElement('div');
  reactions.className = 'message-reactions';
  (message.reactions || []).forEach((reaction) => {
    const reactionButton = document.createElement('button');
    reactionButton.type = 'button';
    reactionButton.className = `reaction-chip${reaction.reacted ? ' reacted' : ''}`;
    reactionButton.append(reaction.emoji);
    const count = document.createElement('span');
    count.textContent = String(reaction.count);
    reactionButton.append(count);
    reactionButton.addEventListener('click', () => toggleReaction(message, reaction.emoji));
    reactions.append(reactionButton);
  });
  const reactionPicker = document.createElement('div');
  reactionPicker.className = 'reaction-picker';
  ['👍', '❤️', '😂', '🎉', '😮'].forEach((emoji) => {
    const reactionButton = document.createElement('button');
    reactionButton.type = 'button';
    reactionButton.textContent = emoji;
    reactionButton.setAttribute('aria-label', `Thả cảm xúc ${emoji}`);
    reactionButton.addEventListener('click', () => toggleReaction(message, emoji));
    reactionPicker.append(reactionButton);
  });
  reactionPicker.hidden = true;
  const reactionToggle = document.createElement('button');
  reactionToggle.type = 'button';
  reactionToggle.className = 'reaction-toggle';
  reactionToggle.textContent = '+';
  reactionToggle.setAttribute('aria-label', 'Thêm cảm xúc');
  reactionToggle.setAttribute('aria-expanded', 'false');
  reactionToggle.addEventListener('click', () => {
    const isOpen = reactionPicker.hidden;
    reactionPicker.hidden = !isOpen;
    reactionToggle.setAttribute('aria-expanded', String(isOpen));
    reactionToggle.classList.toggle('active', isOpen);
  });
  const pinButton = document.createElement('button');
  pinButton.type = 'button';
  pinButton.className = 'message-action';
  pinButton.title = message.is_pinned ? 'Bỏ ghim tin nhắn' : 'Ghim tin nhắn';
  pinButton.setAttribute('aria-label', pinButton.title);
  const pinIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  pinIcon.setAttribute('viewBox', '0 0 24 24');
  pinIcon.setAttribute('aria-hidden', 'true');
  const pinPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pinPath.setAttribute('d', 'M16 3l5 5-4 1-4 4-1 4-2-2-6 6-1-1 6-6-2-2 4-1 4-4 1-4z');
  pinPath.setAttribute('fill', 'none');
  pinPath.setAttribute('stroke', 'currentColor');
  pinPath.setAttribute('stroke-width', '1.7');
  pinPath.setAttribute('stroke-linecap', 'round');
  pinPath.setAttribute('stroke-linejoin', 'round');
  pinIcon.append(pinPath);
  pinButton.append(pinIcon);
  pinButton.addEventListener('click', () => togglePinnedMessage(message));
  controls.append(reactions, reactionToggle, reactionPicker, pinButton);
  item.append(meta, body, controls);
  if (message.is_pinned) row.classList.add('message-pinned');
  row.append(avatar, item);
  $('#messages').append(row);
  if (String(message.room_id) === String(currentRoom)
    && !currentMessages.some((item) => String(item.id) === String(message.id))) currentMessages.push(message);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

document.addEventListener('click', (event) => {
  document.querySelectorAll('.message-controls').forEach((controls) => {
    if (controls.contains(event.target)) return;
    const picker = controls.querySelector('.reaction-picker');
    const toggle = controls.querySelector('.reaction-toggle');
    picker.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.classList.remove('active');
  });
});

async function refreshCurrentRoomMessages() {
  if (!currentRoom) return;
  const roomId = currentRoom;
  const { messages } = await api(`/api/rooms/${roomId}/messages`);
  if (String(currentRoom) !== String(roomId)) return;
  currentMessages = messages;
  $('#messages').replaceChildren();
  lastMessageDay = '';
  seenMessageIds = new Set();
  if (messages.length) messages.forEach(addMessage);
  else $('#messages').innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">✉</span><h3>Chưa có tin nhắn</h3><p>Hãy gửi lời chào đầu tiên cho phòng này.</p></div>';
}

async function toggleReaction(message, emoji) {
  try {
    await api(`/api/rooms/${currentRoom}/messages/${message.id}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    });
    await refreshCurrentRoomMessages();
  } catch (error) {
    notify(error.message);
  }
}

async function togglePinnedMessage(message) {
  try {
    const method = message.is_pinned ? 'DELETE' : 'POST';
    await api(`/api/rooms/${currentRoom}/messages/${message.id}/pin`, { method });
    await refreshCurrentRoomMessages();
    await loadRoomOverview();
    notify(message.is_pinned ? 'Đã bỏ ghim tin nhắn.' : 'Đã ghim tin nhắn.', 'success');
  } catch (error) {
    notify(error.message);
  }
}

async function selectRoom(room) {
  if (currentRoom && String(currentRoom) !== String(room.id) && socket?.connected) {
    if (activeCall) finishCall(true);
    socket.emit('leave-room', currentRoom);
  }
  currentRoom = room.id;
  currentRoomData = room;
  roomMembers = [];
  updateCallRecipients();
  $('#callToolbar').hidden = false;
  $('#callPanel').hidden = true;
  $('#roomTitle').textContent = room.name;
  $('#roomSubtitle').textContent = `#${room.id} · ${room.member_count || 1} thành viên · Cập nhật theo thời gian thực`;
  $('#messages').replaceChildren();
  lastMessageDay = '';
  seenMessageIds = new Set();
  $('#rooms').querySelectorAll('.room-item').forEach((item) => {
    const active = item.querySelector('small')?.textContent.startsWith(`#${room.id} ·`);
    item.classList.toggle('active', active);
    item.querySelector('button').setAttribute('aria-current', active ? 'page' : 'false');
  });
  $('#messageForm').hidden = false;
  $('#favoriteRoom').disabled = false;
  if (socket?.connected) {
    socket.emit('join-room', room.id, (result) => {
      if (result?.error) notify(result.error);
    });
  }
  try {
    const { messages } = await api(`/api/rooms/${room.id}/messages`);
    if (String(currentRoom) !== String(room.id)) return;
    currentMessages = messages;
    if (messages.length === 0) {
      $('#messages').innerHTML = '<div class="empty-state"><span class="empty-icon" aria-hidden="true">✉</span><h3>Chưa có tin nhắn</h3><p>Hãy gửi lời chào đầu tiên cho phòng này.</p></div>';
    } else {
      messages.forEach(addMessage);
    }
    await loadRoomOverview();
    activateRoomTab('messages');
    notify('');
  } catch (error) {
    notify(error.message);
  }
}

async function loadRoomOverview() {
  if (!currentRoom) return;
  const roomId = currentRoom;
  const overview = await api(`/api/rooms/${roomId}/overview`);
  if (String(currentRoom) !== String(roomId)) return;
  currentRoomData = overview.room;
  roomMembers = overview.members;
  updateCallRecipients();
  $('#roomTitle').textContent = overview.room.name;
  $('#roomSubtitle').textContent = `#${roomId} · ${overview.room.member_count} thành viên · Cập nhật theo thời gian thực`;
  $('#favoriteRoom').textContent = overview.room.is_favorite ? '★' : '☆';
  $('#favoriteRoom').classList.toggle('selected', overview.room.is_favorite);
  $('#favoriteRoom').setAttribute('aria-label', overview.room.is_favorite ? 'Bỏ yêu thích' : 'Thêm vào yêu thích');
  $('#roomInfoEmpty').hidden = true;
  $('#roomInfoContent').hidden = false;
  $('#roomDetailsForm').hidden = true;
  $('#detailRoomName').value = overview.room.name;
  $('#detailRoomDescription').value = overview.room.description || '';
  $('#editRoomInfo').disabled = String(overview.room.created_by) !== String(currentUserId);
  $('#memberCount').textContent = `(${overview.members.length})`;
  $('#roomMembersList').replaceChildren(...overview.members.map(renderRoomMember));
  $('#taskAssignee').replaceChildren(new Option('Chưa phân công', ''));
  overview.members.forEach((member) => {
    $('#taskAssignee').add(new Option(member.display_name || member.username, member.username));
  });
  renderPinnedMessages(overview.pinned);
  renderRecentFiles(overview.files);
  renderRecentTasks(overview.tasks);
  renderRooms();
}

function renderRoomMember(member) {
  const item = document.createElement('li');
  item.className = 'room-member';
  const avatar = document.createElement('span');
  avatar.className = 'person-avatar';
  avatar.textContent = (member.display_name || member.username).charAt(0).toUpperCase();
  if (member.avatar_url) {
    const image = document.createElement('img');
    image.src = member.avatar_url;
    image.alt = '';
    avatar.append(image);
  }
  const copy = document.createElement('span');
  copy.className = 'room-member-copy';
  const name = document.createElement('strong');
  name.textContent = member.display_name || member.username;
  const role = document.createElement('small');
  role.textContent = member.is_owner ? 'Quản trị phòng' : member.job_title || 'Thành viên';
  copy.append(name, role);
  item.append(avatar, copy);
  return item;
}

function renderPinnedMessages(pinned) {
  const list = $('#pinnedMessagesList');
  list.replaceChildren();
  if (!pinned.length) {
    list.append(emptyCard('Chưa có tin ghim', 'Ghim tin nhắn quan trọng từ cuộc trò chuyện.'));
    return;
  }
  pinned.forEach((message) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pinned-message';
    const content = document.createElement('span');
    content.textContent = message.body;
    const author = document.createElement('small');
    author.textContent = message.username;
    button.append(content, author);
    button.addEventListener('click', () => {
      activateRoomTab('messages');
      document.querySelector(`[data-message-id="${message.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    list.append(button);
  });
}

function renderRecentFiles(files) {
  const list = $('#recentRoomFiles');
  list.replaceChildren();
  if (!files.length) {
    list.append(emptyCard('Chưa có tệp', 'Tệp chia sẻ trong phòng sẽ hiển thị ở đây.'));
    return;
  }
  files.forEach((file) => {
    const link = document.createElement('a');
    link.className = 'recent-file';
    link.href = `/api/files/${file.id}/download`;
    const name = document.createElement('strong');
    name.textContent = file.file_name;
    const details = document.createElement('small');
    details.textContent = `${file.username} · ${formatSize(file.size_bytes)}`;
    link.append(name, details);
    list.append(link);
  });
}

function renderRecentTasks(tasks) {
  const list = $('#recentRoomTasks');
  list.replaceChildren();
  if (!tasks.length) {
    list.append(emptyCard('Chưa có nhiệm vụ', 'Thêm nhiệm vụ để theo dõi công việc của nhóm.'));
    return;
  }
  tasks.forEach((task) => {
    const item = document.createElement('div');
    item.className = 'recent-task';
    const title = document.createElement('span');
    title.textContent = task.title;
    const status = document.createElement('small');
    status.textContent = task.assigned_name || (task.due_at ? `Hạn ${task.due_at}` : 'Chưa phân công');
    item.append(title, status);
    list.append(item);
  });
}

function activateRoomTab(tab) {
  const panels = {
    messages: 'roomMessagesPanel',
    files: 'roomFilesPanel',
    tasks: 'roomTasksPanel',
    notes: 'roomNotesPanel',
    events: 'roomEventsPanel',
  };
  if (!currentRoom && tab !== 'messages') {
    notify('Chọn hoặc tạo phòng trước khi mở nội dung phòng.');
    return;
  }
  document.querySelectorAll('.room-tab').forEach((button) => {
    const active = button.dataset.roomTab === tab;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  Object.entries(panels).forEach(([name, id]) => {
    $(`#${id}`).hidden = name !== tab;
  });
  if (!currentRoom) return;
  const loaders = {
    files: loadRoomFiles,
    tasks: loadRoomTasks,
    notes: loadRoomNotes,
    events: loadRoomEvents,
  };
  if (loaders[tab]) loaders[tab]().catch((error) => notify(error.message));
}

async function loadRoomFiles() {
  const roomId = currentRoom;
  const { files } = await api('/api/files');
  if (String(currentRoom) !== String(roomId)) return;
  const current = files.filter((file) => String(file.room_id) === String(roomId));
  const list = $('#roomFilesList');
  list.replaceChildren();
  if (!current.length) {
    list.append(emptyCard('Chưa có tệp trong phòng', 'Chia sẻ tệp bằng mục Tệp tin ở thanh bên.'));
    return;
  }
  current.forEach((file) => {
    const link = document.createElement('a');
    link.className = 'room-file-row';
    link.href = `/api/files/${file.id}/download`;
    const name = document.createElement('strong');
    name.textContent = file.file_name;
    const details = document.createElement('small');
    details.textContent = `${file.username} · ${formatSize(file.size_bytes)} · ${new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium' }).format(new Date(file.created_at))}`;
    link.append(name, details);
    list.append(link);
  });
}

async function loadRoomTasks() {
  const roomId = currentRoom;
  const { tasks } = await api(`/api/rooms/${roomId}/tasks`);
  if (String(currentRoom) !== String(roomId)) return;
  const list = $('#roomTasksList');
  list.replaceChildren();
  if (!tasks.length) {
    list.append(emptyCard('Chưa có nhiệm vụ', 'Tạo nhiệm vụ mới hoặc giao cho thành viên trong phòng.'));
    return;
  }
  tasks.forEach((task) => {
    const row = document.createElement('article');
    row.className = `room-task${task.status === 'done' ? ' completed' : ''}`;
    const statusSelect = document.createElement('select');
    statusSelect.className = 'task-status';
    statusSelect.setAttribute('aria-label', `Trạng thái nhiệm vụ: ${task.title}`);
    [
      ['open', 'Cần làm'],
      ['in_progress', 'Đang làm'],
      ['done', 'Hoàn thành'],
    ].forEach(([value, label]) => statusSelect.add(new Option(label, value)));
    statusSelect.value = task.status;
    statusSelect.addEventListener('change', async () => {
      try {
        await api(`/api/rooms/${roomId}/tasks/${task.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: statusSelect.value }),
        });
        await Promise.all([loadRoomTasks(), loadRoomOverview()]);
      } catch (error) {
        statusSelect.value = task.status;
        notify(error.message);
      }
    });
    const text = document.createElement('span');
    text.className = 'room-task-copy';
    const title = document.createElement('strong');
    title.textContent = task.title;
    const detail = document.createElement('small');
    detail.textContent = [
      task.description,
      task.assigned_name ? `Giao cho ${task.assigned_name}` : 'Chưa phân công',
      task.due_at ? `Hạn ${new Intl.DateTimeFormat('vi-VN').format(new Date(`${task.due_at}T00:00:00`))}` : '',
      task.status === 'in_progress' ? 'Đang thực hiện' : '',
    ].filter(Boolean).join(' · ');
    text.append(title, detail);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-icon-button';
    remove.textContent = 'Xóa';
    remove.addEventListener('click', async () => {
      try {
        await api(`/api/rooms/${roomId}/tasks/${task.id}`, { method: 'DELETE' });
        await Promise.all([loadRoomTasks(), loadRoomOverview()]);
      } catch (error) {
        notify(error.message);
      }
    });
    row.append(statusSelect, text, remove);
    list.append(row);
  });
}

async function loadRoomNotes() {
  const roomId = currentRoom;
  const { note } = await api(`/api/rooms/${roomId}/notes`);
  if (String(currentRoom) !== String(roomId)) return;
  $('#roomNotes').value = note.body || '';
  $('#notesUpdated').textContent = note.updated_at
    ? `Cập nhật ${new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(note.updated_at))}`
    : 'Chưa có ghi chú';
}

async function loadRoomEvents() {
  const roomId = currentRoom;
  const { events } = await api(`/api/rooms/${roomId}/events`);
  if (String(currentRoom) !== String(roomId)) return;
  const list = $('#roomEventsList');
  list.replaceChildren();
  if (!events.length) {
    list.append(emptyCard('Chưa có cuộc họp', 'Lên lịch cuộc họp để cả nhóm cùng theo dõi.'));
    return;
  }
  events.forEach((event) => {
    const row = document.createElement('article');
    row.className = 'room-event';
    const title = document.createElement('strong');
    title.textContent = event.title;
    const details = document.createElement('p');
    details.textContent = event.details || '';
    const time = document.createElement('time');
    time.dateTime = event.starts_at;
    time.textContent = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(event.starts_at));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-icon-button';
    remove.textContent = 'Hủy lịch';
    remove.addEventListener('click', async () => {
      try {
        await api(`/api/rooms/${roomId}/events/${event.id}`, { method: 'DELETE' });
        await loadRoomEvents();
      } catch (error) {
        notify(error.message);
      }
    });
    row.append(title, details, time, remove);
    list.append(row);
  });
}

function activateView(viewId) {
  $('#chatView').hidden = viewId !== 'chatView';
  document.querySelectorAll('.page-view').forEach((view) => {
    view.hidden = view.id !== viewId;
  });
  document.querySelectorAll('.nav-item').forEach((button) => {
    const active = button.dataset.view === viewId;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  notify('');
  if (viewId === 'groupsView') loadGroups().catch((error) => notify(error.message));
  if (viewId === 'contactsView') {
    Promise.all([loadContacts(), loadFriendRequests()]).catch((error) => notify(error.message));
  }
  if (viewId === 'filesView') {
    Promise.all([loadRooms(), loadFiles()]).catch((error) => notify(error.message));
  }
  if (viewId === 'historyView') loadHistory().catch((error) => notify(error.message));
  if (viewId === 'settingsView') loadProfile().catch((error) => notify(error.message));
}

let globalSearchTimer;

async function searchWorkspace(query) {
  const request = ++roomSearchRequest;
  const results = $('#globalSearchResults');
  if (query.trim().length < 2) {
    results.hidden = true;
    results.replaceChildren();
    return;
  }
  const [matches, people] = await Promise.all([
    api(`/api/search?q=${encodeURIComponent(query.trim())}`),
    api(`/api/users?search=${encodeURIComponent(query.trim())}`),
  ]);
  if (request !== roomSearchRequest) return;
  results.replaceChildren();
  const addSection = (title, entries) => {
    if (!entries.length) return;
    const heading = document.createElement('strong');
    heading.className = 'search-result-heading';
    heading.textContent = title;
    results.append(heading, ...entries);
  };
  const roomResults = matches.rooms.map((room) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'global-search-result';
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '#';
    const text = document.createElement('span');
    text.textContent = room.name;
    button.append(icon, text);
    button.addEventListener('click', async () => {
      results.hidden = true;
      const loaded = rooms.find((item) => String(item.id) === String(room.id)) || room;
      await selectRoom(loaded);
    });
    return button;
  });
  const messageResults = matches.messages.map((message) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'global-search-result search-message-result';
    const title = document.createElement('strong');
    title.textContent = `# ${message.room_name} · ${message.username}`;
    const body = document.createElement('span');
    body.textContent = message.body;
    button.append(title, body);
    button.addEventListener('click', async () => {
      results.hidden = true;
      const room = rooms.find((item) => String(item.id) === String(message.room_id));
      if (room) await selectRoom(room);
      document.querySelector(`[data-message-id="${message.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return button;
  });
  const peopleResults = people.users.slice(0, 5).map((user) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'global-search-result';
    const name = document.createElement('span');
    name.textContent = user.display_name || user.username;
    const handle = document.createElement('small');
    handle.textContent = `@${user.username}`;
    button.append(name, handle);
    button.addEventListener('click', async () => {
      results.hidden = true;
      activateView('contactsView');
      $('#userSearch').value = user.username;
      await searchUsers(user.username);
    });
    return button;
  });
  addSection('PHÒNG', roomResults);
  addSection('TIN NHẮN', messageResults);
  addSection('THÀNH VIÊN', peopleResults);
  if (!results.childElementCount) results.append(emptyCard('Không tìm thấy kết quả', 'Thử một từ khóa khác.'));
  results.hidden = false;
}

function renderGroup(group) {
  const card = document.createElement('article');
  card.className = 'group-card';
  const mark = document.createElement('span');
  mark.className = 'group-mark';
  mark.textContent = '#';
  const title = document.createElement('h2');
  title.textContent = group.name;
  const description = document.createElement('p');
  description.textContent = group.description || 'Chưa có mô tả cho nhóm này.';
  const details = document.createElement('small');
  details.textContent = `${group.member_count} thành viên · Nhóm công khai`;
  const action = document.createElement('button');
  action.className = group.is_member ? 'secondary-button' : 'primary-button';
  action.type = 'button';
  action.textContent = group.is_member ? 'Mở nhóm' : 'Tham gia nhóm';
  action.addEventListener('click', async () => {
    action.disabled = true;
    try {
      if (!group.is_member) await api(`/api/rooms/${group.id}/join`, { method: 'POST' });
      await loadRooms();
      const room = rooms.find((item) => String(item.id) === String(group.id)) || group;
      activateView('chatView');
      await selectRoom(room);
    } catch (error) {
      notify(error.message);
    } finally {
      action.disabled = false;
    }
  });
  card.append(mark, title, description, details, action);
  return card;
}

async function loadGroups(search = '') {
  const { groups } = await api(`/api/groups?search=${encodeURIComponent(search)}`);
  const list = $('#groupsList');
  list.replaceChildren();
  if (!groups.length) {
    list.append(emptyCard('Không tìm thấy nhóm', 'Hãy thử từ khóa khác hoặc tạo nhóm mới.'));
    return;
  }
  list.append(...groups.map(renderGroup));
}

function emptyCard(title, description) {
  const empty = document.createElement('div');
  empty.className = 'module-empty';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const message = document.createElement('p');
  message.textContent = description;
  empty.append(heading, message);
  return empty;
}

function personRow(user, mode = 'search') {
  const row = document.createElement('article');
  row.className = 'person-row';
  const avatar = document.createElement('span');
  avatar.className = 'person-avatar';
  avatar.textContent = (user.display_name || user.username).charAt(0).toUpperCase();
  if (user.avatar_url) {
    const image = document.createElement('img');
    image.src = user.avatar_url;
    image.alt = '';
    image.addEventListener('error', () => image.remove(), { once: true });
    avatar.append(image);
  }
  const copy = document.createElement('div');
  copy.className = 'person-copy';
  const name = document.createElement('strong');
  name.textContent = user.display_name || user.username;
  const username = document.createElement('small');
  username.textContent = `@${user.username}`;
  const details = document.createElement('small');
  details.className = 'person-details';
  details.textContent = [user.job_title, user.department].filter(Boolean).join(' · ') || 'Chưa cập nhật chức vụ hoặc phòng ban';
  const bio = document.createElement('p');
  bio.textContent = user.bio || 'Chưa có phần giới thiệu.';
  copy.append(name, username, details, bio);
  const actions = document.createElement('div');
  actions.className = 'person-actions';
  const requestId = user.request_id || user.sent_request_id || user.received_request_id;
  const relationship = mode === 'search'
    ? user.is_friend ? 'friend'
      : user.received_request_id ? 'incoming'
        : user.sent_request_id ? 'outgoing'
          : 'search'
    : mode;
  const action = document.createElement('button');
  action.type = 'button';
  action.className = relationship === 'search' || relationship === 'incoming'
    ? 'primary-button'
    : 'secondary-button';
  action.textContent = relationship === 'friend'
    ? 'Xóa bạn bè'
    : relationship === 'incoming'
      ? 'Chấp nhận'
      : relationship === 'outgoing'
        ? 'Hủy lời mời'
        : 'Thêm bạn bè';
  action.disabled = relationship === 'friend' && mode === 'search';
  const refreshFriendViews = async () => {
    await Promise.all([loadContacts(), loadFriendRequests()]);
    if ($('#userSearch').value.trim().length >= 2) {
      await searchUsers($('#userSearch').value.trim());
    }
  };
  const handleRequestAction = async (button, operation) => {
    button.disabled = true;
    try {
      if (relationship === 'friend') {
        await api(`/api/contacts/${user.id}`, { method: 'DELETE' });
      } else if (relationship === 'incoming' && operation === 'reject') {
        await api(`/api/friend-requests/${requestId}`, { method: 'DELETE' });
      } else if (relationship === 'incoming') {
        await api(`/api/friend-requests/${requestId}/accept`, { method: 'POST' });
      } else if (relationship === 'outgoing') {
        await api(`/api/friend-requests/${requestId}`, { method: 'DELETE' });
      } else if (user.received_request_id) {
        await api(`/api/friend-requests/${user.received_request_id}/accept`, { method: 'POST' });
      } else {
        await api('/api/friend-requests', {
          method: 'POST',
          body: JSON.stringify({ username: user.username }),
        });
      }
      await refreshFriendViews();
      const messages = {
        friend: 'Đã xóa bạn bè.',
        incoming: operation === 'reject' ? 'Đã từ chối lời mời kết bạn.' : 'Đã chấp nhận lời mời. Hai bạn đã là bạn bè.',
        outgoing: 'Đã hủy lời mời kết bạn.',
        search: user.received_request_id ? 'Đã chấp nhận lời mời. Hai bạn đã là bạn bè.' : 'Đã gửi lời mời kết bạn.',
      };
      notify(messages[relationship], 'success');
    } catch (error) {
      notify(error.message);
      button.disabled = false;
    }
  };
  action.addEventListener('click', () => handleRequestAction(action, 'accept'));
  actions.append(action);
  if (relationship === 'incoming') {
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'secondary-button';
    reject.textContent = 'Từ chối';
    reject.addEventListener('click', () => handleRequestAction(reject, 'reject'));
    actions.append(reject);
  }
  row.append(avatar, copy, actions);
  return row;
}

async function loadContacts() {
  const { contacts } = await api('/api/contacts');
  const list = $('#contactsList');
  list.replaceChildren();
  if (!contacts.length) {
    list.append(emptyCard('Bạn chưa có bạn bè', 'Tìm theo tên và chọn “Thêm bạn bè” để kết nối.'));
    return;
  }
  list.append(...contacts.map((contact) => personRow(contact, 'friend')));
}

async function loadFriendRequests() {
  const { incoming, outgoing } = await api('/api/friend-requests');
  const section = $('#friendRequestsSection');
  section.hidden = incoming.length === 0 && outgoing.length === 0;
  const incomingList = $('#incomingRequests');
  const outgoingList = $('#outgoingRequests');
  incomingList.replaceChildren();
  outgoingList.replaceChildren();
  if (incoming.length) incomingList.append(...incoming.map((request) => personRow(request, 'incoming')));
  else incomingList.append(emptyCard('Không có lời mời mới', 'Lời mời kết bạn nhận được sẽ hiển thị ở đây.'));
  if (outgoing.length) outgoingList.append(...outgoing.map((request) => personRow(request, 'outgoing')));
  else outgoingList.append(emptyCard('Chưa gửi lời mời nào', 'Lời mời bạn gửi đang chờ xác nhận sẽ hiển thị ở đây.'));
}

async function searchUsers(search) {
  if (search.trim().length < 2) {
    $('#userSearchResults').replaceChildren();
    return;
  }
  const { users } = await api(`/api/users?search=${encodeURIComponent(search.trim())}`);
  const results = $('#userSearchResults');
  results.replaceChildren();
  if (!users.length) results.append(emptyCard('Không tìm thấy bạn bè', 'Kiểm tra lại tên hoặc tên tài khoản rồi thử lại.'));
  else results.append(...users.map((user) => personRow(user)));
}

function formatSize(bytes) {
  const size = Number(bytes);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function updateCallRecipients() {
  const select = $('#callRecipient');
  const selected = select.value;
  select.replaceChildren(new Option('Chọn thành viên...', ''));
  roomMembers
    .filter((member) => String(member.id) !== String(currentUserId))
    .forEach((member) => select.add(new Option(member.display_name || member.username, member.id)));
  if (roomMembers.some((member) => String(member.id) === selected)) select.value = selected;
  select.disabled = !select.options.length || select.options.length === 1 || Boolean(activeCall);
  const hasRecipient = Boolean(select.value) && !activeCall;
  $('#audioCallButton').disabled = !hasRecipient;
  $('#videoCallButton').disabled = !hasRecipient;
}

function updateCallPanel(status, incoming) {
  $('#callPanel').hidden = false;
  $('#callTitle').textContent = activeCall?.video ? 'Cuộc gọi video' : 'Cuộc gọi thoại';
  $('#callStatus').textContent = status;
  $('#acceptCallButton').hidden = !incoming;
  $('#declineCallButton').hidden = !incoming;
  $('#endCallButton').hidden = incoming;
  $('#localVideo').hidden = !activeCall?.video;
  $('#remoteVideo').hidden = !activeCall?.video;
  $('#remoteAudio').hidden = Boolean(activeCall?.video);
  updateCallRecipients();
}

function createCallPeerConnection() {
  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  localCallStream.getTracks().forEach((track) => peerConnection.addTrack(track, localCallStream));
  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) emitCallSignal({ type: 'candidate', candidate: candidate.toJSON() });
  };
  peerConnection.ontrack = ({ streams }) => {
    const media = activeCall.video ? $('#remoteVideo') : $('#remoteAudio');
    media.srcObject = streams[0];
    media.play().catch(() => notify('Không thể phát âm thanh cuộc gọi. Hãy kiểm tra quyền phát media của trình duyệt.'));
  };
  peerConnection.onconnectionstatechange = () => {
    if (peerConnection?.connectionState === 'connected') {
      activeCall.phase = 'connected';
      updateCallPanel(`Đang gọi với ${activeCall.peerName}`, false);
    } else if (['failed', 'closed'].includes(peerConnection?.connectionState) && activeCall) {
      finishCall(true);
      notify('Không thể duy trì kết nối cuộc gọi. Hãy thử gọi lại.');
    }
  };
  if (activeCall.video) $('#localVideo').srcObject = localCallStream;
}

function emitCallSignal(signal) {
  if (!activeCall?.callId || !socket?.connected) return;
  socket.emit('call:signal', { callId: activeCall.callId, signal }, (result) => {
    if (result?.error) notify(result.error);
  });
}

async function createCallOffer() {
  createCallPeerConnection();
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  emitCallSignal({ type: 'offer', sdp: peerConnection.localDescription.sdp });
}

async function handleCallSignal(signal) {
  if (!peerConnection || !signal) return;
  if (signal.type === 'offer' && typeof signal.sdp === 'string') {
    await peerConnection.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    for (const candidate of pendingIceCandidates) await peerConnection.addIceCandidate(candidate);
    pendingIceCandidates = [];
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    emitCallSignal({ type: 'answer', sdp: peerConnection.localDescription.sdp });
  } else if (signal.type === 'answer' && typeof signal.sdp === 'string') {
    await peerConnection.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    for (const candidate of pendingIceCandidates) await peerConnection.addIceCandidate(candidate);
    pendingIceCandidates = [];
  } else if (signal.type === 'candidate' && signal.candidate) {
    if (peerConnection.remoteDescription) await peerConnection.addIceCandidate(signal.candidate);
    else pendingIceCandidates.push(signal.candidate);
  }
}

function finishCall(notifyPeer) {
  if (notifyPeer && activeCall?.callId && socket?.connected) {
    socket.emit('call:end', { callId: activeCall.callId });
  }
  peerConnection?.close();
  peerConnection = undefined;
  localCallStream?.getTracks().forEach((track) => track.stop());
  localCallStream = undefined;
  pendingIceCandidates = [];
  activeCall = undefined;
  $('#localVideo').srcObject = null;
  $('#remoteVideo').srcObject = null;
  $('#remoteAudio').srcObject = null;
  $('#callPanel').hidden = true;
  updateCallRecipients();
}

function failCall(error) {
  finishCall(true);
  notify(error.message || 'Không thể kết nối cuộc gọi.');
}

async function startCall(video) {
  if (!currentRoom || !socket?.connected || activeCall) {
    notify('Hãy kết nối và chọn phòng trước khi gọi.');
    return;
  }
  const targetId = $('#callRecipient').value;
  const target = roomMembers.find((member) => String(member.id) === targetId);
  if (!target) {
    notify('Chọn thành viên muốn gọi.');
    return;
  }
  const call = {
    roomId: currentRoom,
    peerName: target.display_name || target.username,
    phase: 'requesting',
    video,
  };
  activeCall = call;
  updateCallPanel('Đang chuẩn bị cuộc gọi...', false);
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Trình duyệt cần hỗ trợ WebRTC và kết nối HTTPS để gọi.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    if (activeCall !== call) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    localCallStream = stream;
    call.phase = 'dialing';
    updateCallPanel(`Đang gọi ${activeCall.peerName}...`, false);
    socket.timeout(10000).emit('call:invite', {
      roomId: call.roomId,
      targetUserId: target.id,
      video,
    }, (timeoutError, result) => {
      if (activeCall !== call) {
        if (result?.callId && socket.connected) socket.emit('call:end', { callId: result.callId });
        return;
      }
      if (timeoutError) {
        finishCall(false);
        notify('Máy chủ không phản hồi lời mời gọi. Hãy thử lại.');
        return;
      }
      if (result?.error) {
        finishCall(false);
        notify(result.error);
        return;
      }
      call.callId = result.callId;
      call.peerSocketId = result.recipientSocketId;
    });
  } catch (error) {
    if (activeCall === call) finishCall(false);
    notify(error.name === 'NotAllowedError'
      ? 'Bạn cần cấp quyền truy cập micro/camera để gọi.'
      : error.message || 'Không thể bắt đầu cuộc gọi.');
  }
}

function receiveCall(call) {
  if (String(call.roomId) !== String(currentRoom) || activeCall) {
    socket.emit('call:decline', { callId: call.callId });
    return;
  }
  activeCall = {
    callId: call.callId,
    roomId: call.roomId,
    peerSocketId: call.callerSocketId,
    peerName: call.callerName,
    phase: 'incoming',
    incoming: true,
    video: call.video,
  };
  updateCallPanel(`${call.callerName} đang gọi ${call.video ? 'video' : 'thoại'}...`, true);
}

async function acceptCall() {
  if (!activeCall?.incoming) return;
  const call = activeCall;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Trình duyệt cần hỗ trợ WebRTC và kết nối HTTPS để gọi.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.video });
    if (activeCall !== call) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    localCallStream = stream;
    createCallPeerConnection();
    const result = await new Promise((resolve) => {
      socket.timeout(10000).emit('call:accept', { callId: call.callId }, (error, response) => {
        resolve(error ? { error: 'Máy chủ không phản hồi khi trả lời cuộc gọi.' } : response);
      });
    });
    if (activeCall !== call) return;
    if (result?.error) throw new Error(result.error);
    call.peerSocketId = result.peerSocketId;
    call.phase = 'connecting';
    call.incoming = false;
    updateCallPanel('Đã trả lời, đang kết nối...', false);
  } catch (error) {
    if (activeCall === call) finishCall(true);
    notify(error.name === 'NotAllowedError'
      ? 'Bạn cần cấp quyền truy cập micro/camera để trả lời.'
      : error.message || 'Không thể trả lời cuộc gọi.');
  }
}

function declineCall() {
  if (activeCall?.callId && socket?.connected) {
    socket.emit('call:decline', { callId: activeCall.callId });
  }
  finishCall(false);
}

async function loadFiles() {
  const { files } = await api('/api/files');
  const list = $('#filesList');
  list.replaceChildren();
  if (!files.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.append(emptyCard('Chưa có tệp được chia sẻ', 'Chọn một phòng và tải tệp lên để chia sẻ với các thành viên.'));
    row.append(cell);
    list.append(row);
    return;
  }
  files.forEach((file) => {
    const row = document.createElement('tr');
    const values = [file.file_name, file.room_name, file.username, formatSize(file.size_bytes),
      new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium' }).format(new Date(file.created_at))];
    values.forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    });
    const actionCell = document.createElement('td');
    const download = document.createElement('a');
    download.className = 'download-link';
    download.href = `/api/files/${file.id}/download`;
    download.textContent = 'Tải xuống';
    actionCell.append(download);
    row.append(actionCell);
    list.append(row);
  });
}

async function loadHistory(search = '') {
  const request = ++historyRequest;
  const { messages } = await api(`/api/history?search=${encodeURIComponent(search)}`);
  if (request !== historyRequest) return;
  const list = $('#historyList');
  list.replaceChildren();
  if (!messages.length) {
    list.append(emptyCard('Không có tin nhắn phù hợp', 'Thử từ khóa khác hoặc chọn một phòng để bắt đầu trò chuyện.'));
    return;
  }
  messages.forEach((message) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'history-item';
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    const room = document.createElement('strong');
    room.textContent = `# ${message.room_name}`;
    const time = document.createElement('time');
    time.textContent = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(message.created_at));
    meta.append(room, time);
    const body = document.createElement('p');
    body.textContent = message.body;
    const author = document.createElement('small');
    author.textContent = message.username;
    item.append(meta, body, author);
    item.addEventListener('click', async () => {
      try {
        await loadRooms();
        const roomData = rooms.find((roomItem) => String(roomItem.id) === String(message.room_id));
        if (!roomData) throw new Error('Bạn không còn là thành viên của phòng này.');
        activateView('chatView');
        await selectRoom(roomData);
      } catch (error) {
        notify(error.message);
      }
    });
    list.append(item);
  });
}

async function loadProfile() {
  const { user } = await api('/api/me');
  setProfile(user);
}

$('#authForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#authError').textContent = '';
  try {
    const credentials = Object.fromEntries(new FormData(event.currentTarget));
    const { user } = await api('/api/login', { method: 'POST', body: JSON.stringify(credentials) });
    enterChat(user);
  } catch (error) {
    showAuthError(error.message);
  }
});

$('#register').addEventListener('click', async () => {
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
});

$('#mainNav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) activateView(button.dataset.view);
});

$('#globalSearchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(globalSearchTimer);
  searchWorkspace($('#globalSearch').value).catch((error) => notify(error.message));
});
$('#globalSearch').addEventListener('input', () => {
  clearTimeout(globalSearchTimer);
  globalSearchTimer = setTimeout(() => {
    searchWorkspace($('#globalSearch').value).catch((error) => notify(error.message));
  }, 220);
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#globalSearchForm')) $('#globalSearchResults').hidden = true;
});

$('#roomSearch').addEventListener('input', renderRooms);
$('.room-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-room-filter]');
  if (!button) return;
  roomFilter = button.dataset.roomFilter;
  document.querySelectorAll('.room-filter').forEach((item) => item.classList.toggle('active', item === button));
  renderRooms();
});
$('#roomTabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-room-tab]');
  if (button) activateRoomTab(button.dataset.roomTab);
});
$('#favoriteRoom').addEventListener('click', async () => {
  if (!currentRoom) return;
  try {
    await api(`/api/rooms/${currentRoom}/favorite`, {
      method: 'POST',
      body: JSON.stringify({ favorite: !currentRoomData?.is_favorite }),
    });
    await loadRooms();
    await loadRoomOverview();
    notify(currentRoomData.is_favorite ? 'Đã thêm phòng vào yêu thích.' : 'Đã bỏ phòng khỏi yêu thích.', 'success');
  } catch (error) {
    notify(error.message);
  }
});
$('#editRoomInfo').addEventListener('click', () => {
  $('#roomDetailsForm').hidden = false;
  $('#detailRoomName').focus();
});
$('#roomDetailsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api(`/api/rooms/${currentRoom}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: $('#detailRoomName').value,
        description: $('#detailRoomDescription').value,
      }),
    });
    await loadRooms();
    await loadRoomOverview();
    notify('Thông tin phòng đã được cập nhật.', 'success');
  } catch (error) {
    notify(error.message);
  }
});
$('#addRoomMember').addEventListener('click', () => {
  $('#addMemberForm').hidden = !$('#addMemberForm').hidden;
  if (!$('#addMemberForm').hidden) $('#memberUsername').focus();
});
$('#addMemberForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api(`/api/rooms/${currentRoom}/members`, {
      method: 'POST',
      body: JSON.stringify({ username: $('#memberUsername').value.trim() }),
    });
    event.currentTarget.reset();
    event.currentTarget.hidden = true;
    await Promise.all([loadRoomOverview(), loadRooms()]);
    notify('Đã thêm bạn bè vào phòng.', 'success');
  } catch (error) {
    notify(error.message);
  }
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-open-room-tab]');
  if (!button) return;
  const tab = button.dataset.openRoomTab;
  activateRoomTab(tab);
  if (tab === 'tasks') $('#taskTitle').focus();
});
$('#taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api(`/api/rooms/${currentRoom}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        title: $('#taskTitle').value,
        description: $('#taskDescription').value,
        assigned_username: $('#taskAssignee').value,
        due_at: $('#taskDueDate').value || null,
      }),
    });
    event.currentTarget.reset();
    await Promise.all([loadRoomTasks(), loadRoomOverview()]);
    notify('Đã thêm nhiệm vụ.', 'success');
  } catch (error) {
    notify(error.message);
  }
});
$('#roomNotesForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const { note } = await api(`/api/rooms/${currentRoom}/notes`, {
      method: 'PUT',
      body: JSON.stringify({ body: $('#roomNotes').value }),
    });
    $('#notesUpdated').textContent = `Cập nhật ${new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(note.updated_at))}`;
    notify('Ghi chú phòng đã được lưu.', 'success');
  } catch (error) {
    notify(error.message);
  }
});
$('#eventForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const startsAt = new Date($('#eventStart').value);
  if (Number.isNaN(startsAt.getTime()) || startsAt <= new Date()) {
    notify('Chọn ngày giờ cuộc họp trong tương lai.');
    return;
  }
  try {
    await api(`/api/rooms/${currentRoom}/events`, {
      method: 'POST',
      body: JSON.stringify({
        title: $('#eventTitle').value,
        details: $('#eventDetails').value,
        starts_at: startsAt.toISOString(),
      }),
    });
    event.currentTarget.reset();
    await loadRoomEvents();
    notify('Đã lên lịch cuộc họp.', 'success');
  } catch (error) {
    notify(error.message);
  }
});

function toggleGroupCreatePanel(open) {
  $('#groupCreatePanel').hidden = !open;
  $('[data-open-create]').setAttribute('aria-expanded', String(open));
  if (open) $('#groupName').focus();
}

$('#groupCreateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const name = new FormData(form).get('name');
    const description = new FormData(form).get('description');
    const isPublic = new FormData(form).get('is_public') === 'true';
    const { room } = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name, description, is_public: isPublic }),
    });
    form.reset();
    toggleGroupCreatePanel(false);
    await loadRooms();
    await selectRoom(room);
    await loadGroups($('#groupSearch').value);
    notify('Nhóm đã được tạo.', 'success');
  } catch (error) {
    notify(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

$('#joinForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const id = $('#joinId').value.trim();
    await api(`/api/rooms/${encodeURIComponent(id)}/join`, { method: 'POST' });
    $('#joinId').value = '';
    await loadRooms();
    const room = rooms.find((item) => String(item.id) === String(id));
    if (room) await selectRoom(room);
    notify('Đã tham gia nhóm.', 'success');
  } catch (error) {
    notify(error.message);
  }
});

$('#messageForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.elements.body;
  const body = input.value.trim();
  if (!body || !currentRoom || !socket?.connected) {
    if (!socket?.connected) notify('Mất kết nối realtime. Tin nhắn chưa được gửi.');
    return;
  }
  const button = form.querySelector('button');
  button.disabled = true;
  socket.emit('chat-message', { roomId: currentRoom, body }, (result) => {
    button.disabled = false;
    if (result?.error) {
      notify(result.error);
      return;
    }
    input.value = '';
    input.focus();
    notify('');
  });
});

$('#callRecipient').addEventListener('change', updateCallRecipients);
$('#audioCallButton').addEventListener('click', () => startCall(false));
$('#videoCallButton').addEventListener('click', () => startCall(true));
$('#acceptCallButton').addEventListener('click', acceptCall);
$('#declineCallButton').addEventListener('click', declineCall);
$('#endCallButton').addEventListener('click', () => finishCall(true));

$('#groupSearchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  loadGroups($('#groupSearch').value).catch((error) => notify(error.message));
});
$('#groupSearch').addEventListener('input', () => {
  if (!$('#groupSearch').value.trim()) loadGroups().catch((error) => notify(error.message));
});
document.querySelector('[data-open-create]').addEventListener('click', () => {
  toggleGroupCreatePanel($('#groupCreatePanel').hidden);
});
$('#cancelGroupCreate').addEventListener('click', () => toggleGroupCreatePanel(false));
$('#cancelGroupCreateForm').addEventListener('click', () => {
  $('#groupCreateForm').reset();
  toggleGroupCreatePanel(false);
});

$('#userSearchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  searchUsers($('#userSearch').value).catch((error) => notify(error.message));
});

$('#uploadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = $('#fileInput').files[0];
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) {
    notify('Tệp vượt quá giới hạn 100 MB.');
    return;
  }
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/api/files', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Upload-Room-Id': $('#fileRoom').value,
        'X-Upload-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Không thể tải tệp lên.');
    event.currentTarget.reset();
    await loadFiles();
    notify('Tệp đã được tải lên.', 'success');
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});

$('#historySearchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  loadHistory($('#historySearch').value).catch((error) => notify(error.message));
});

$('#avatarInput').addEventListener('change', async (event) => {
  const file = event.currentTarget.files[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 512 * 1024) {
    event.currentTarget.value = '';
    notify('Ảnh đại diện phải là PNG, JPEG hoặc WebP và nhỏ hơn 512 KB.');
    return;
  }
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Không thể đọc ảnh đã chọn.'));
      reader.readAsDataURL(file);
    });
    pendingAvatarData = String(dataUrl).split(',')[1];
    pendingAvatarType = file.type;
    avatarChanged = true;
    setAvatar($('#profileAvatarView'), {
      display_name: currentDisplayName,
      username: currentUsername,
      avatar_url: dataUrl,
    });
    $('#removeAvatar').hidden = false;
    notify('');
  } catch (error) {
    notify(error.message);
  }
});

$('#removeAvatar').addEventListener('click', () => {
  pendingAvatarData = null;
  pendingAvatarType = null;
  avatarChanged = true;
  setAvatar($('#profileAvatarView'), { display_name: currentDisplayName, username: currentUsername });
  $('#avatarInput').value = '';
  $('#removeAvatar').hidden = true;
});

$('#profileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const profile = {
      display_name: $('#displayName').value,
      job_title: $('#jobTitle').value,
      department: $('#department').value,
      bio: $('#bio').value,
    };
    if (avatarChanged) {
      profile.avatar_data = pendingAvatarData;
      if (pendingAvatarData !== null) profile.avatar_content_type = pendingAvatarType;
    }
    const { user } = await api('/api/me', {
      method: 'PATCH',
      body: JSON.stringify(profile),
    });
    setProfile(user);
    notify('Thông tin cá nhân đã được cập nhật.', 'success');
  } catch (error) {
    notify(error.message);
  }
});

$('#passwordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/api/me/password', {
      method: 'POST',
      body: JSON.stringify({
        current_password: $('#currentPassword').value,
        new_password: $('#newPassword').value,
      }),
    });
    form.reset();
    notify('Mật khẩu đã được cập nhật.', 'success');
  } catch (error) {
    notify(error.message);
  }
});

$('#logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  } catch (error) {
    notify(error.message);
  }
});

api('/api/me').then(({ user }) => enterChat(user)).catch(() => {});
