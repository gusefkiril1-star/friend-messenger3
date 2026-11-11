const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e8 // 100 MB
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// In-memory state with JSON persistence
let state = {
  users: {},   // tag -> { tag, name, avatar, customStatus, online, friends: [tags], createdAt }
  groups: {},  // groupId -> { id, name, avatar, creator, members: [tags], createdAt }
  messages: {} // roomKey -> [ { id, sender, senderName, senderAvatar, receiver, groupId, text, photoUrl, voiceUrl, timestamp, reactions: { emoji: [tags] } } ]
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      state.users = loaded.users || {};
      state.groups = loaded.groups || {};
      state.messages = loaded.messages || {};

      // Reset online statuses on restart
      Object.keys(state.users).forEach(tag => {
        state.users[tag].online = false;
      });
    }
  } catch (err) {
    console.error('Error loading data:', err);
  }
}

function saveData() {
  try {
    const toSave = {
      users: state.users,
      groups: state.groups,
      messages: state.messages
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving data:', err);
  }
}

loadData();

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

// Serve client frontend if available
const CLIENT_DIST = path.join(__dirname, '../client/dist');
const LOCAL_PUBLIC = path.join(__dirname, 'public');
if (fs.existsSync(LOCAL_PUBLIC)) {
  app.use(express.static(LOCAL_PUBLIC));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(LOCAL_PUBLIC, 'index.html'));
  });
} else if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send('<div style="font-family:sans-serif;text-align:center;padding:50px;background:#070a12;color:#fff;min-height:100vh;"><h1 style="color:#8b5cf6;">🚀 JoTiApp Server 2.0</h1><p style="color:#10b981;">Сервер успешно работает в сети 24/7!</p><p style="color:#94a3b8;">Мгновенная доставка сообщений, группы, голосовые и звонки активны.</p></div>');
  });
}

// Multer upload config for photos and voice recordings
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || (file.mimetype.includes('audio') ? '.webm' : '.jpg');
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не передан' });
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ url: fileUrl, photoUrl: fileUrl, voiceUrl: fileUrl });
});

app.post('/api/upload-photo', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo' });
  const photoUrl = `/uploads/${req.file.filename}`;
  res.json({ photoUrl, url: photoUrl });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    app: 'JoTiApp 2.0',
    usersCount: Object.keys(state.users).length,
    groupsCount: Object.keys(state.groups).length,
    activeSockets: io.engine.clientsCount
  });
});

function getRoomKey(tag1, tag2) {
  return [tag1.toLowerCase(), tag2.toLowerCase()].sort().join('__');
}

// Socket.io handlers
io.on('connection', (socket) => {
  let currentTag = null;

  // 1. User login / register with tag
  socket.on('auth', ({ tag, name, avatar, customStatus }, callback) => {
    if (!tag) {
      return callback?.({ success: false, error: 'Тег обязателен' });
    }

    const cleanTag = tag.trim().toLowerCase().replace(/^@+/, '');
    if (cleanTag.length < 2) {
      return callback?.({ success: false, error: 'Тег должен содержать минимум 2 символа' });
    }

    currentTag = cleanTag;

    // Join dedicated user room for instant message delivery
    socket.join(`user_${cleanTag}`);

    if (!state.users[cleanTag]) {
      state.users[cleanTag] = {
        tag: cleanTag,
        name: name?.trim() || cleanTag,
        avatar: avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${cleanTag}`,
        customStatus: customStatus || '🔥 На связи',
        online: true,
        friends: [],
        createdAt: Date.now()
      };
    } else {
      state.users[cleanTag].online = true;
      if (name?.trim()) state.users[cleanTag].name = name.trim();
      if (avatar) state.users[cleanTag].avatar = avatar;
      if (customStatus) state.users[cleanTag].customStatus = customStatus;
    }

    // Auto-join socket to all group rooms the user belongs to
    Object.values(state.groups).forEach(g => {
      if (g.members && g.members.includes(cleanTag)) {
        socket.join(`group_${g.id}`);
      }
    });

    saveData();

    // Broadcast online status to all friends
    notifyFriendsStatus(cleanTag, true);

    callback?.({
      success: true,
      user: state.users[cleanTag]
    });
  });

  // 2. Profile update
  socket.on('update_profile', ({ name, avatar, customStatus }, callback) => {
    if (!currentTag || !state.users[currentTag]) return callback?.({ success: false });

    if (name?.trim()) state.users[currentTag].name = name.trim();
    if (avatar) state.users[currentTag].avatar = avatar;
    if (customStatus !== undefined) state.users[currentTag].customStatus = customStatus;

    saveData();

    const currentUser = state.users[currentTag];
    currentUser.friends.forEach(fTag => {
      io.to(`user_${fTag}`).emit('friend_updated', { friend: currentUser });
    });

    callback?.({ success: true, user: currentUser });
  });

  // 3. Add friend by tag
  socket.on('add_friend', ({ targetTag }, callback) => {
    if (!currentTag) return callback?.({ success: false, error: 'Не авторизован' });

    const cleanTarget = targetTag.trim().toLowerCase().replace(/^@+/, '');
    if (cleanTarget === currentTag) {
      return callback?.({ success: false, error: 'Нельзя добавить самого себя' });
    }

    const targetUser = state.users[cleanTarget];
    if (!targetUser) {
      return callback?.({ success: false, error: `Пользователь @${cleanTarget} не найден` });
    }

    const currentUser = state.users[currentTag];
    if (!currentUser.friends.includes(cleanTarget)) {
      currentUser.friends.push(cleanTarget);
    }
    if (!targetUser.friends.includes(currentTag)) {
      targetUser.friends.push(currentTag);
    }

    saveData();

    // Notify target user instantly via their room
    io.to(`user_${cleanTarget}`).emit('friend_updated', {
      friend: {
        tag: currentUser.tag,
        name: currentUser.name,
        avatar: currentUser.avatar,
        customStatus: currentUser.customStatus,
        online: currentUser.online
      }
    });

    callback?.({
      success: true,
      friend: {
        tag: targetUser.tag,
        name: targetUser.name,
        avatar: targetUser.avatar,
        customStatus: targetUser.customStatus,
        online: targetUser.online
      }
    });
  });

  // 4. Get friends list
  socket.on('get_friends', (callback) => {
    if (!currentTag || !state.users[currentTag]) return callback?.([]);

    const friendsList = state.users[currentTag].friends.map(fTag => {
      const u = state.users[fTag];
      if (!u) return { tag: fTag, name: fTag, online: false };
      return {
        tag: u.tag,
        name: u.name,
        avatar: u.avatar,
        customStatus: u.customStatus || '',
        online: !!u.online
      };
    });

    callback?.(friendsList);
  });

  // 5. Get 1-on-1 chat history
  socket.on('get_messages', ({ targetTag }, callback) => {
    if (!currentTag) return callback?.([]);
    const roomKey = getRoomKey(currentTag, targetTag);
    callback?.(state.messages[roomKey] || []);
  });

  // 6. Send 1-on-1 message (INSTANT DELIVERY TO ROOMS)
  socket.on('send_message', ({ toTag, text, photoUrl, voiceUrl }, callback) => {
    if (!currentTag) return callback?.({ success: false, error: 'Не авторизован' });

    const cleanTo = toTag.trim().toLowerCase().replace(/^@+/, '');
    const roomKey = getRoomKey(currentTag, cleanTo);

    if (!state.messages[roomKey]) {
      state.messages[roomKey] = [];
    }

    const senderUser = state.users[currentTag];

    const newMsg = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      sender: currentTag,
      senderName: senderUser ? senderUser.name : currentTag,
      senderAvatar: senderUser ? senderUser.avatar : null,
      receiver: cleanTo,
      text: text || '',
      photoUrl: photoUrl || null,
      voiceUrl: voiceUrl || null,
      reactions: {},
      timestamp: Date.now()
    };

    state.messages[roomKey].push(newMsg);
    saveData();

    // Broadcast instantly to recipient room AND sender room!
    io.to(`user_${cleanTo}`).emit('new_message', newMsg);
    io.to(`user_${currentTag}`).emit('new_message', newMsg);

    callback?.({ success: true, message: newMsg });
  });

  // 7. Group chats: Create group
  socket.on('create_group', ({ name, avatar, memberTags }, callback) => {
    if (!currentTag) return callback?.({ success: false, error: 'Не авторизован' });

    const cleanName = (name || '').trim();
    if (!cleanName) return callback?.({ success: false, error: 'Укажите название группы' });

    const groupId = `grp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const members = Array.from(new Set([currentTag, ...(memberTags || []).map(t => t.toLowerCase().replace(/^@+/, ''))]));

    const newGroup = {
      id: groupId,
      name: cleanName,
      avatar: avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${groupId}`,
      creator: currentTag,
      members,
      createdAt: Date.now()
    };

    state.groups[groupId] = newGroup;
    state.messages[`group_${groupId}`] = [];
    saveData();

    // Auto-join creator socket to the group room
    socket.join(`group_${groupId}`);

    // Notify all members instantly via their personal rooms
    members.forEach(mTag => {
      io.to(`user_${mTag}`).emit('group_created', newGroup);
    });

    callback?.({ success: true, group: newGroup });
  });

  // 8. Group chats: Get user's groups
  socket.on('get_groups', (callback) => {
    if (!currentTag) return callback?.([]);
    const myGroups = Object.values(state.groups).filter(g => g.members && g.members.includes(currentTag));
    // Ensure this socket is in all these rooms
    myGroups.forEach(g => socket.join(`group_${g.id}`));
    callback?.(myGroups);
  });

  // 9. Group chats: Get group messages
  socket.on('get_group_messages', ({ groupId }, callback) => {
    if (!currentTag) return callback?.([]);
    const group = state.groups[groupId];
    if (!group || !group.members.includes(currentTag)) {
      return callback?.([]);
    }
    socket.join(`group_${groupId}`);
    callback?.(state.messages[`group_${groupId}`] || []);
  });

  // 10. Group chats: Send group message (INSTANT TO ALL GROUP MEMBERS)
  socket.on('send_group_message', ({ groupId, text, photoUrl, voiceUrl }, callback) => {
    if (!currentTag) return callback?.({ success: false, error: 'Не авторизован' });

    const group = state.groups[groupId];
    if (!group || !group.members.includes(currentTag)) {
      return callback?.({ success: false, error: 'Вы не состоите в этой группе' });
    }

    const senderUser = state.users[currentTag];
    const roomKey = `group_${groupId}`;
    if (!state.messages[roomKey]) state.messages[roomKey] = [];

    const newMsg = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      groupId,
      sender: currentTag,
      senderName: senderUser ? senderUser.name : currentTag,
      senderAvatar: senderUser ? senderUser.avatar : null,
      text: text || '',
      photoUrl: photoUrl || null,
      voiceUrl: voiceUrl || null,
      reactions: {},
      timestamp: Date.now()
    };

    state.messages[roomKey].push(newMsg);
    saveData();

    // Broadcast instantly to the group room AND directly to all members
    io.to(`group_${groupId}`).emit('new_group_message', newMsg);
    group.members.forEach(mTag => {
      io.to(`user_${mTag}`).emit('new_group_message', newMsg);
    });

    callback?.({ success: true, message: newMsg });
  });

  // 11. Group chats: Add member
  socket.on('add_group_member', ({ groupId, memberTag }, callback) => {
    if (!currentTag) return callback?.({ success: false });
    const group = state.groups[groupId];
    if (!group) return callback?.({ success: false, error: 'Группа не найдена' });

    const cleanTag = memberTag.trim().toLowerCase().replace(/^@+/, '');
    if (!state.users[cleanTag]) {
      return callback?.({ success: false, error: `Пользователь @${cleanTag} не найден` });
    }

    if (!group.members.includes(cleanTag)) {
      group.members.push(cleanTag);
      saveData();

      io.to(`user_${cleanTag}`).emit('group_created', group);
      io.to(`group_${groupId}`).emit('group_updated', group);
    }

    callback?.({ success: true, group });
  });

  // 12. Group chats: Leave group
  socket.on('leave_group', ({ groupId }, callback) => {
    if (!currentTag) return callback?.({ success: false });
    const group = state.groups[groupId];
    if (!group) return callback?.({ success: false });

    group.members = group.members.filter(m => m !== currentTag);
    socket.leave(`group_${groupId}`);

    if (group.members.length === 0) {
      delete state.groups[groupId];
      delete state.messages[`group_${groupId}`];
    } else {
      io.to(`group_${groupId}`).emit('group_updated', group);
    }

    saveData();
    callback?.({ success: true });
  });

  // 13. Message Reactions
  socket.on('message_react', ({ roomKey, messageId, emoji }, callback) => {
    if (!currentTag) return callback?.({ success: false });

    const msgList = state.messages[roomKey];
    if (!msgList) return callback?.({ success: false });

    const msg = msgList.find(m => m.id === messageId);
    if (!msg) return callback?.({ success: false });

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

    const existingIndex = msg.reactions[emoji].indexOf(currentTag);
    if (existingIndex >= 0) {
      msg.reactions[emoji].splice(existingIndex, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji].push(currentTag);
    }

    saveData();

    if (roomKey.startsWith('group_')) {
      io.to(roomKey).emit('message_reacted', { roomKey, messageId, reactions: msg.reactions });
    } else {
      const parts = roomKey.split('__');
      parts.forEach(pTag => {
        io.to(`user_${pTag}`).emit('message_reacted', { roomKey, messageId, reactions: msg.reactions });
      });
    }

    callback?.({ success: true, reactions: msg.reactions });
  });

  // 14. Real-time Typing indicators
  socket.on('typing_start', ({ toTag, groupId }) => {
    if (!currentTag) return;
    const sender = state.users[currentTag];
    const data = {
      tag: currentTag,
      name: sender ? sender.name : currentTag,
      groupId
    };

    if (groupId) {
      socket.to(`group_${groupId}`).emit('user_typing', data);
    } else if (toTag) {
      const cleanTo = toTag.toLowerCase().replace(/^@+/, '');
      io.to(`user_${cleanTo}`).emit('user_typing', data);
    }
  });

  socket.on('typing_stop', ({ toTag, groupId }) => {
    if (!currentTag) return;
    if (groupId) {
      socket.to(`group_${groupId}`).emit('user_stop_typing', { tag: currentTag, groupId });
    } else if (toTag) {
      const cleanTo = toTag.toLowerCase().replace(/^@+/, '');
      io.to(`user_${cleanTo}`).emit('user_stop_typing', { tag: currentTag });
    }
  });

  // 15. WebRTC Calling Signaling
  socket.on('call_request', ({ toTag, callType, offer }) => {
    if (!currentTag) return;
    const cleanTo = toTag.trim().toLowerCase().replace(/^@+/, '');
    const target = state.users[cleanTo];

    if (!target || !target.online) {
      socket.emit('call_failed', { reason: 'Пользователь сейчас не в сети' });
      return;
    }

    const caller = state.users[currentTag];
    io.to(`user_${cleanTo}`).emit('incoming_call', {
      callerTag: currentTag,
      callerName: caller ? caller.name : currentTag,
      callerAvatar: caller ? caller.avatar : null,
      callType: callType || 'video',
      offer
    });
  });

  socket.on('call_accept', ({ toTag, answer }) => {
    const cleanTo = toTag.trim().toLowerCase().replace(/^@+/, '');
    io.to(`user_${cleanTo}`).emit('call_accepted', {
      fromTag: currentTag,
      answer
    });
  });

  socket.on('call_reject', ({ toTag, reason }) => {
    const cleanTo = toTag.trim().toLowerCase().replace(/^@+/, '');
    io.to(`user_${cleanTo}`).emit('call_rejected', {
      fromTag: currentTag,
      reason: reason || 'Вызов отклонен'
    });
  });

  socket.on('call_end', ({ toTag }) => {
    if (!toTag) return;
    const cleanTo = toTag.trim().toLowerCase().replace(/^@+/, '');
    io.to(`user_${cleanTo}`).emit('call_ended', {
      fromTag: currentTag
    });
  });

  socket.on('ice_candidate', ({ toTag, candidate }) => {
    const cleanTo = toTag.trim().toLowerCase().replace(/^@+/, '');
    io.to(`user_${cleanTo}`).emit('ice_candidate', {
      fromTag: currentTag,
      candidate
    });
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    if (currentTag && state.users[currentTag]) {
      // Check if user has other active connections in their room
      const room = io.sockets.adapter.rooms.get(`user_${currentTag}`);
      const remainingSockets = room ? room.size : 0;
      if (remainingSockets === 0) {
        state.users[currentTag].online = false;
        notifyFriendsStatus(currentTag, false);
        saveData();
      }
    }
  });

  function notifyFriendsStatus(userTag, isOnline) {
    const user = state.users[userTag];
    if (!user || !user.friends) return;

    user.friends.forEach(fTag => {
      io.to(`user_${fTag}`).emit('friend_status', {
        tag: userTag,
        online: isOnline
      });
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`🚀 JoTiApp Server 2.0 is running on port ${PORT}`);
  console.log(`📡 Instant Room Delivery: Chats, Groups, Calls!`);
  console.log(`===============================================`);
});
