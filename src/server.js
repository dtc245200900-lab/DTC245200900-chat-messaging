const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pino = require('pino');
const pinoHttp = require('pino-http');
const prom = require('prom-client');

for (const key of ['DATABASE_URL', 'JWT_SECRET']) {
  if (!process.env[key]) throw Error(`${key} required`);
}
if (process.env.JWT_SECRET.length < 32) {
  throw Error('JWT_SECRET must be at least 32 characters');
}
if (/^(replace-with|change-me)/i.test(process.env.JWT_SECRET)) {
  throw Error('JWT_SECRET must be replaced with a unique random secret');
}

const log = pino({ level: 'info' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const registry = new prom.Registry();
const maxUploadBytes = 100 * 1024 * 1024;
const allowedFileTypes = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/plain',
]);
const mediaFileExtensions = new Set([
  '.3gp', '.avi', '.avif', '.bmp', '.dng', '.flv', '.gif', '.heic', '.heif', '.ico',
  '.jfif', '.jpe', '.jpeg', '.jpg', '.m2ts', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg',
  '.mpg', '.mts', '.ogv', '.png', '.raw', '.rm', '.rmvb', '.svg', '.tif', '.tiff',
  '.ts', '.vob', '.webm', '.webp', '.wmv', '.yuv',
]);
const activeCalls = new Map();

prom.collectDefaultMetrics({ register: registry });
const httpRequests = new prom.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by method, route, and status.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});
const activeSockets = new prom.Gauge({
  name: 'chat_active_sockets',
  help: 'Active Socket.IO connections.',
  registers: [registry],
});

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  frameguard: { action: 'deny' },
  permissionsPolicy: {
    directives: {
      camera: ['self'],
      microphone: ['self'],
      geolocation: [],
    },
  },
}));
const standardJsonParser = express.json({ limit: '7mb' });
const fileJsonParser = express.json({ limit: '140mb' });
const fileRawParser = express.raw({ type: () => true, limit: '100mb' });
app.use((request, response, next) => {
  if (request.method === 'POST' && request.path === '/api/files') return next();
  return standardJsonParser(request, response, next);
});
function parseFileUpload(request, response, next) {
  if (request.is('application/json')) return fileJsonParser(request, response, next);
  return fileRawParser(request, response, next);
}
app.use(cookieParser());
app.use(pinoHttp({
  logger: log,
  serializers: {
    req: (request) => ({
      id: request.id,
      method: request.method,
      url: request.url,
      remoteAddress: request.remoteAddress,
    }),
    res: (response) => ({ statusCode: response.statusCode }),
  },
}));
app.use((request, response, next) => {
  response.on('finish', () => {
    if (request.path === '/metrics') return;
    const route = request.route?.path
      ? (request.baseUrl || '') + request.route.path
      : request.path === '/health'
        ? '/health'
        : request.path.startsWith('/api/')
          ? '/api/*'
          : '/static/*';
    httpRequests.inc({
      method: request.method,
      route,
      status_code: String(response.statusCode),
    });
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (handler) => (request, response, next) => (
  Promise.resolve(handler(request, response, next)).catch(next)
);
const loginLimiter = rateLimit({ windowMs: 900000, limit: 20 });
const sign = (user) => jwt.sign(
  { sub: String(user.id), username: user.username },
  process.env.JWT_SECRET,
  { expiresIn: '8h', issuer: 'chat' },
);

function auth(request, response, next) {
  try {
    request.user = jwt.verify(
      request.cookies.chat_token,
      process.env.JWT_SECRET,
      { issuer: 'chat' },
    );
    next();
  } catch {
    response.status(401).json({ error: 'Login required' });
  }
}

function validId(value) {
  const id = String(value);
  return /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n;
}

function profileResponse(user) {
  const profile = { ...user };
  const hasAvatar = profile.has_avatar;
  delete profile.has_avatar;
  delete profile.password_hash;
  return {
    ...profile,
    avatar_url: hasAvatar ? `/api/users/${user.id}/avatar?v=${Date.now()}` : null,
  };
}

function validAvatar(contentType, content) {
  if (contentType === 'image/png') {
    return content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (contentType === 'image/jpeg') {
    return content.length >= 3 && content[0] === 255 && content[1] === 216 && content[2] === 255;
  }
  if (contentType === 'image/webp') {
    return content.length >= 12
      && content.toString('ascii', 0, 4) === 'RIFF'
      && content.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

app.get('/health', wrap(async (request, response) => {
  await pool.query('SELECT 1');
  response.json({ status: 'ok' });
}));
app.get('/metrics', wrap(async (request, response) => {
  response.type(registry.contentType).send(await registry.metrics());
}));

app.post('/api/register', loginLimiter, wrap(async (request, response) => {
  const username = String(request.body.username || '');
  const password = String(request.body.password || '');
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username) || password.length < 10 || password.length > 128) {
    return response.status(400).json({ error: 'Invalid username or password' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO users(username,password_hash,display_name)
       VALUES($1,$2,$1)
       RETURNING id,username,display_name,department,job_title,bio,false AS has_avatar`,
      [username, await bcrypt.hash(password, 12)],
    );
    response.cookie('chat_token', sign(rows[0]), {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 28800000,
    });
    response.status(201).json({ user: profileResponse(rows[0]) });
  } catch (error) {
    if (error.code === '23505') return response.status(409).json({ error: 'Username exists' });
    throw error;
  }
}));

app.post('/api/login', loginLimiter, wrap(async (request, response) => {
  const { rows } = await pool.query(
    `SELECT id,username,password_hash,COALESCE(display_name,username) AS display_name,
      department,job_title,bio,avatar_data IS NOT NULL AS has_avatar
     FROM users WHERE username=$1`,
    [String(request.body.username || '')],
  );
  if (!rows[0] || !await bcrypt.compare(String(request.body.password || ''), rows[0].password_hash)) {
    return response.status(401).json({ error: 'Invalid credentials' });
  }
  response.cookie('chat_token', sign(rows[0]), {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 28800000,
  });
  response.json({ user: profileResponse(rows[0]) });
}));

app.post('/api/logout', (request, response) => {
  response.clearCookie('chat_token', { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true' });
  response.status(204).end();
});

app.get('/api/me', auth, wrap(async (request, response) => {
  const { rows } = await pool.query(
    `SELECT id,username,COALESCE(display_name,username) AS display_name,
      department,job_title,bio,avatar_data IS NOT NULL AS has_avatar
     FROM users WHERE id=$1`,
    [request.user.sub],
  );
  if (!rows[0]) return response.status(401).json({ error: 'Login required' });
  response.json({ user: profileResponse(rows[0]) });
}));

app.patch('/api/me', auth, wrap(async (request, response) => {
  const fields = [
    ['display_name', 60, 'Display name'],
    ['department', 80, 'Department'],
    ['job_title', 80, 'Job title'],
    ['bio', 280, 'Introduction'],
  ];
  const values = [];
  for (const [key, limit, label] of fields) {
    if (request.body[key] === undefined) {
      values.push(null);
      continue;
    }
    const value = String(request.body[key] || '').trim();
    if ((key === 'display_name' && !value) || value.length > limit) {
      return response.status(400).json({ error: `${label} is invalid` });
    }
    values.push(value);
  }

  let avatarChanged = false;
  let avatarData = null;
  let avatarContentType = null;
  if (request.body.avatar_data !== undefined) {
    avatarChanged = true;
    if (request.body.avatar_data !== null) {
      const encoded = String(request.body.avatar_data);
      avatarContentType = String(request.body.avatar_content_type || '').toLowerCase();
      if (!encoded || encoded.length > 699052
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        return response.status(400).json({ error: 'Avatar must be a PNG, JPEG, or WebP image smaller than 512 KB' });
      }
      avatarData = Buffer.from(encoded, 'base64');
      if (!avatarData.length || avatarData.length > 524288
        || avatarData.toString('base64') !== encoded
        || !validAvatar(avatarContentType, avatarData)) {
        return response.status(400).json({ error: 'Avatar must be a PNG, JPEG, or WebP image smaller than 512 KB' });
      }
    }
  }

  const { rows } = await pool.query(
    `UPDATE users SET
      display_name=COALESCE($1,display_name),
      department=COALESCE($2,department),
      job_title=COALESCE($3,job_title),
      bio=COALESCE($4,bio),
      avatar_data=CASE WHEN $5 THEN $6::bytea ELSE avatar_data END,
      avatar_content_type=CASE WHEN $5 THEN $7 ELSE avatar_content_type END
     WHERE id=$8
     RETURNING id,username,COALESCE(display_name,username) AS display_name,
       department,job_title,bio,avatar_data IS NOT NULL AS has_avatar`,
    [...values, avatarChanged, avatarData, avatarContentType, request.user.sub],
  );
  if (!rows[0]) return response.status(401).json({ error: 'Login required' });
  response.json({ user: profileResponse(rows[0]) });
}));

app.get('/api/users/:id/avatar', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Avatar not found' });
  const { rows } = await pool.query(
    'SELECT avatar_data,avatar_content_type FROM users WHERE id=$1 AND avatar_data IS NOT NULL',
    [request.params.id],
  );
  if (!rows[0]) return response.status(404).json({ error: 'Avatar not found' });
  response.set({
    'Content-Type': rows[0].avatar_content_type,
    'Content-Length': rows[0].avatar_data.length,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  }).send(rows[0].avatar_data);
}));

app.post('/api/me/password', auth, wrap(async (request, response) => {
  const currentPassword = String(request.body.current_password || '');
  const newPassword = String(request.body.new_password || '');
  if (newPassword.length < 10 || newPassword.length > 128) {
    return response.status(400).json({ error: 'New password must be 10-128 characters' });
  }
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [request.user.sub]);
  if (!rows[0] || !await bcrypt.compare(currentPassword, rows[0].password_hash)) {
    return response.status(400).json({ error: 'Current password is incorrect' });
  }
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [
    await bcrypt.hash(newPassword, 12),
    request.user.sub,
  ]);
  response.json({ changed: true });
}));

app.get('/api/rooms', auth, wrap(async (request, response) => {
  const { rows } = await pool.query(
    `SELECT r.id,r.name,r.description,r.is_public,
      (SELECT COUNT(*) FROM room_members all_members WHERE all_members.room_id=r.id) AS member_count,
      EXISTS(SELECT 1 FROM room_favorites f WHERE f.room_id=r.id AND f.user_id=$1) AS is_favorite,
      (SELECT MAX(created_at) FROM messages WHERE room_id=r.id) AS last_message_at
     FROM rooms r JOIN room_members m ON m.room_id=r.id
     WHERE m.user_id=$1
     ORDER BY last_message_at DESC NULLS LAST,r.name`,
    [request.user.sub],
  );
  response.json({ rooms: rows });
}));

app.get('/api/rooms/:id/overview', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Room not found' });
  const { rows: roomsFound } = await pool.query(
    `SELECT r.id,r.name,r.description,r.is_public,r.created_by,
      EXISTS(SELECT 1 FROM room_favorites f WHERE f.room_id=r.id AND f.user_id=$2) AS is_favorite,
      COUNT(m.user_id)::int AS member_count
     FROM rooms r JOIN room_members m ON m.room_id=r.id
     WHERE r.id=$1
     GROUP BY r.id
     HAVING BOOL_OR(m.user_id=$2)`,
    [request.params.id, request.user.sub],
  );
  if (!roomsFound[0]) return response.status(403).json({ error: 'Join the room first' });
  const [members, pins, files, tasks] = await Promise.all([
    pool.query(
      `SELECT u.id,u.username,COALESCE(u.display_name,u.username) AS display_name,
        u.department,u.job_title,u.bio,u.avatar_data IS NOT NULL AS has_avatar,
        (r.created_by=u.id) AS is_owner
       FROM room_members m JOIN users u ON u.id=m.user_id
       JOIN rooms r ON r.id=m.room_id
       WHERE m.room_id=$1 ORDER BY (r.created_by=u.id) DESC,u.username`,
      [request.params.id],
    ),
    pool.query(
      `SELECT m.id,m.body,m.created_at,u.username
       FROM pinned_messages p JOIN messages m ON m.id=p.message_id
       JOIN users u ON u.id=m.user_id
       WHERE p.room_id=$1 ORDER BY p.created_at DESC LIMIT 20`,
      [request.params.id],
    ),
    pool.query(
      `SELECT f.id,f.file_name,f.content_type,octet_length(f.content) AS size_bytes,
        f.created_at,u.username
       FROM files f JOIN users u ON u.id=f.uploaded_by
       WHERE f.room_id=$1 ORDER BY f.created_at DESC LIMIT 5`,
      [request.params.id],
    ),
    pool.query(
      `SELECT t.id,t.title,t.status,t.due_at,COALESCE(u.display_name,u.username) AS assigned_name
       FROM room_tasks t LEFT JOIN users u ON u.id=t.assigned_to
       WHERE t.room_id=$1 AND t.status<>'done'
       ORDER BY t.due_at NULLS LAST,t.created_at DESC LIMIT 5`,
      [request.params.id],
    ),
  ]);
  response.json({
    room: roomsFound[0],
    members: members.rows.map(profileResponse),
    pinned: pins.rows,
    files: files.rows,
    tasks: tasks.rows,
  });
}));

app.patch('/api/rooms/:id', auth, wrap(async (request, response) => {
  const name = String(request.body.name || '').trim();
  const description = String(request.body.description || '').trim();
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Room not found' });
  if (name.length < 2 || name.length > 80 || description.length > 240) {
    return response.status(400).json({ error: 'Room name must be 2-80 chars and description at most 240 chars' });
  }
  const { rows } = await pool.query(
    `UPDATE rooms r SET name=$1,description=$2
     WHERE r.id=$3 AND r.created_by=$4
       AND EXISTS(SELECT 1 FROM room_members WHERE room_id=r.id AND user_id=$4)
     RETURNING r.id,r.name,r.description,r.is_public`,
    [name, description, request.params.id, request.user.sub],
  );
  if (!rows[0]) return response.status(403).json({ error: 'Only the room creator can edit room details' });
  response.json({ room: rows[0] });
}));

app.get('/api/search', auth, wrap(async (request, response) => {
  const query = String(request.query.q || '').trim().slice(0, 100);
  if (query.length < 2) return response.json({ rooms: [], messages: [] });
  const { rows: roomsFound } = await pool.query(
    `SELECT r.id,r.name,r.description,
      EXISTS(SELECT 1 FROM room_favorites f WHERE f.room_id=r.id AND f.user_id=$1) AS is_favorite
     FROM rooms r JOIN room_members m ON m.room_id=r.id
     WHERE m.user_id=$1 AND r.name ILIKE '%' || $2 || '%'
     ORDER BY r.name LIMIT 10`,
    [request.user.sub, query],
  );
  const { rows: messagesFound } = await pool.query(
    `SELECT m.id,m.room_id,r.name AS room_name,m.body,m.created_at,u.username
     FROM messages m JOIN rooms r ON r.id=m.room_id
     JOIN users u ON u.id=m.user_id
     JOIN room_members membership ON membership.room_id=m.room_id AND membership.user_id=$1
     WHERE m.body ILIKE '%' || $2 || '%'
     ORDER BY m.created_at DESC,m.id DESC LIMIT 20`,
    [request.user.sub, query],
  );
  response.json({ rooms: roomsFound, messages: messagesFound });
}));

app.get('/api/groups', auth, wrap(async (request, response) => {
  const search = String(request.query.search || '').trim().slice(0, 80);
  const { rows } = await pool.query(
    `SELECT r.id,r.name,r.description,r.is_public,
      COUNT(m.user_id)::int AS member_count,
      BOOL_OR(m.user_id=$1) AS is_member
     FROM rooms r LEFT JOIN room_members m ON m.room_id=r.id
     WHERE r.is_public=true AND ($2='' OR r.name ILIKE '%' || $2 || '%' OR r.description ILIKE '%' || $2 || '%')
     GROUP BY r.id ORDER BY is_member DESC,r.name LIMIT 100`,
    [request.user.sub, search],
  );
  response.json({ groups: rows });
}));

app.post('/api/rooms', auth, wrap(async (request, response) => {
  const name = String(request.body.name || '').trim();
  const description = String(request.body.description || '').trim();
  const isPublic = request.body.is_public !== false;
  if (name.length < 2 || name.length > 80 || description.length > 240) {
    return response.status(400).json({ error: 'Room name must be 2-80 chars and description at most 240 chars' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO rooms(name,description,is_public,created_by) VALUES($1,$2,$3,$4) RETURNING id,name,description,is_public',
      [name, description, isPublic, request.user.sub],
    );
    await client.query('INSERT INTO room_members(room_id,user_id) VALUES($1,$2)', [rows[0].id, request.user.sub]);
    await client.query('COMMIT');
    response.status(201).json({ room: rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return response.status(409).json({ error: 'Room exists' });
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/rooms/:id/join', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Room not found' });
  const { rows } = await pool.query(
    `INSERT INTO room_members(room_id,user_id)
     SELECT id,$2 FROM rooms WHERE id=$1 AND (is_public=true OR EXISTS(
       SELECT 1 FROM room_members WHERE room_id=rooms.id AND user_id=$2
     ))
     ON CONFLICT DO NOTHING RETURNING room_id`,
    [request.params.id, request.user.sub],
  );
  if (!rows[0]) {
    const existing = await pool.query(
      `SELECT 1 FROM rooms r WHERE r.id=$1 AND (
        r.is_public=true OR EXISTS(
          SELECT 1 FROM room_members WHERE room_id=r.id AND user_id=$2
        )
      )`,
      [request.params.id, request.user.sub],
    );
    if (!existing.rowCount) return response.status(404).json({ error: 'Public room not found' });
  }
  response.json({ joined: true });
}));

app.get('/api/rooms/:id/messages', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Room not found' });
  const membership = await pool.query(
    'SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2',
    [request.params.id, request.user.sub],
  );
  if (!membership.rowCount) return response.status(403).json({ error: 'Join room first' });
  const { rows } = await pool.query(
    `SELECT m.id,m.body,m.created_at,u.username,m.room_id,
      COALESCE((
        SELECT json_agg(json_build_object('emoji', reaction_summary.emoji, 'count', reaction_summary.count, 'reacted', reaction_summary.reacted))
        FROM (
          SELECT mr.emoji,COUNT(*)::int AS count,BOOL_OR(mr.user_id=$2) AS reacted
          FROM message_reactions mr WHERE mr.message_id=m.id GROUP BY mr.emoji
        ) reaction_summary
      ),'[]'::json) AS reactions,
      EXISTS(SELECT 1 FROM pinned_messages p WHERE p.message_id=m.id AND p.room_id=m.room_id) AS is_pinned
     FROM messages m JOIN users u ON u.id=m.user_id
     WHERE m.room_id=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT 100`,
    [request.params.id, request.user.sub],
  );
  response.json({ messages: rows.reverse() });
}));

app.post('/api/rooms/:id/favorite', auth, wrap(async (request, response) => {
  const roomId = request.params.id;
  if (!validId(roomId)) return response.status(404).json({ error: 'Room not found' });
  const membership = await pool.query('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', [
    roomId,
    request.user.sub,
  ]);
  if (!membership.rowCount) return response.status(403).json({ error: 'Join the room first' });
  const favorite = request.body.favorite === true;
  if (favorite) {
    await pool.query(
      'INSERT INTO room_favorites(room_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [roomId, request.user.sub],
    );
  } else {
    await pool.query('DELETE FROM room_favorites WHERE room_id=$1 AND user_id=$2', [roomId, request.user.sub]);
  }
  response.json({ is_favorite: favorite });
}));

app.get('/api/rooms/:id/members', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Room not found' });
  const { rows } = await pool.query(
    `SELECT u.id,u.username,COALESCE(u.display_name,u.username) AS display_name,
      u.department,u.job_title,u.bio,u.avatar_data IS NOT NULL AS has_avatar,
      r.created_by::text=$2 AS is_owner
     FROM room_members m JOIN users u ON u.id=m.user_id
     JOIN rooms r ON r.id=m.room_id
     WHERE m.room_id=$1 AND EXISTS(
       SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2
     ) ORDER BY (r.created_by=u.id) DESC,u.username`,
    [request.params.id, request.user.sub],
  );
  const membership = await pool.query('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', [
    request.params.id,
    request.user.sub,
  ]);
  if (!membership.rowCount) return response.status(403).json({ error: 'Join the room first' });
  response.json({ members: rows.map(profileResponse) });
}));

app.post('/api/rooms/:id/members', auth, wrap(async (request, response) => {
  const roomId = request.params.id;
  const username = String(request.body.username || '').trim();
  if (!validId(roomId)) return response.status(404).json({ error: 'Room not found' });
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    return response.status(400).json({ error: 'Enter a valid username' });
  }
  const { rows } = await pool.query(
    `INSERT INTO room_members(room_id,user_id)
     SELECT $1,u.id FROM users u
     WHERE u.username=$2
       AND EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$3)
       AND EXISTS(SELECT 1 FROM contacts WHERE owner_id=$3 AND contact_id=u.id)
       AND EXISTS(SELECT 1 FROM contacts WHERE owner_id=u.id AND contact_id=$3)
     ON CONFLICT DO NOTHING RETURNING user_id`,
    [roomId, username, request.user.sub],
  );
  if (!rows[0]) {
    const existing = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2) AS is_member,
        EXISTS(SELECT 1 FROM users WHERE username=$3) AS user_exists,
        EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$4) AS actor_is_member`,
      [roomId, request.user.sub, username, request.user.sub],
    );
    if (!existing.rows[0]?.actor_is_member) return response.status(403).json({ error: 'Join the room first' });
    if (!existing.rows[0]?.user_exists) return response.status(404).json({ error: 'User not found' });
    if (existing.rows[0]?.is_member) return response.status(409).json({ error: 'Already a room member' });
    return response.status(403).json({ error: 'You can only invite accepted friends to this room' });
  }
  response.status(201).json({ added: true });
}));

app.get('/api/rooms/:id/tasks', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Room not found' });
  const { rows } = await pool.query(
    `SELECT t.id,t.room_id,t.title,t.description,t.assigned_to,t.due_at,t.status,t.created_at,
      assignee.username AS assigned_username,
      COALESCE(assignee.display_name,assignee.username) AS assigned_name,
      creator.username AS created_by
     FROM room_tasks t
     JOIN room_members membership ON membership.room_id=t.room_id AND membership.user_id=$2
     JOIN users creator ON creator.id=t.created_by
     LEFT JOIN users assignee ON assignee.id=t.assigned_to
     WHERE t.room_id=$1 ORDER BY (t.status='done'),t.due_at NULLS LAST,t.created_at DESC`,
    [request.params.id, request.user.sub],
  );
  const membership = await pool.query('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', [
    request.params.id,
    request.user.sub,
  ]);
  if (!membership.rowCount) return response.status(403).json({ error: 'Join the room first' });
  response.json({ tasks: rows });
}));

app.post('/api/rooms/:id/tasks', auth, wrap(async (request, response) => {
  const title = String(request.body.title || '').trim();
  const description = String(request.body.description || '').trim();
  const assignedUsername = String(request.body.assigned_username || '').trim();
  const dueAt = request.body.due_at || null;
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Room not found' });
  if (!title || title.length > 160 || description.length > 500) {
    return response.status(400).json({ error: 'Task title and description are invalid' });
  }
  if (dueAt && !/^\d{4}-\d{2}-\d{2}$/.test(String(dueAt))) {
    return response.status(400).json({ error: 'Due date is invalid' });
  }
  const { rows } = await pool.query(
    `INSERT INTO room_tasks(room_id,title,description,assigned_to,due_at,created_by)
     SELECT $1,$2,$3,assignee.id,$4,$5
     FROM rooms r LEFT JOIN users assignee ON assignee.username=NULLIF($6,'')
       AND EXISTS(SELECT 1 FROM room_members am WHERE am.room_id=r.id AND am.user_id=assignee.id)
     WHERE r.id=$1
       AND EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$5)
       AND ($6='' OR assignee.id IS NOT NULL)
     RETURNING id,title,description,assigned_to,due_at,status,created_at`,
    [request.params.id, title, description, dueAt, request.user.sub, assignedUsername],
  );
  if (!rows[0]) return response.status(400).json({ error: 'Join the room and assign tasks only to its members' });
  response.status(201).json({ task: rows[0] });
}));

app.patch('/api/rooms/:id/tasks/:taskId', auth, wrap(async (request, response) => {
  if (!validId(request.params.id) || !validId(request.params.taskId)) {
    return response.status(404).json({ error: 'Task not found' });
  }
  const status = request.body.status;
  if (!['open', 'in_progress', 'done'].includes(status)) {
    return response.status(400).json({ error: 'Task status is invalid' });
  }
  const { rows } = await pool.query(
    `UPDATE room_tasks t SET status=$1
     WHERE t.id=$2 AND t.room_id=$3 AND EXISTS(
       SELECT 1 FROM room_members WHERE room_id=t.room_id AND user_id=$4
     ) RETURNING t.id,t.status`,
    [status, request.params.taskId, request.params.id, request.user.sub],
  );
  if (!rows[0]) return response.status(404).json({ error: 'Task not found' });
  response.json({ task: rows[0] });
}));

app.delete('/api/rooms/:id/tasks/:taskId', auth, wrap(async (request, response) => {
  if (!validId(request.params.id) || !validId(request.params.taskId)) {
    return response.status(404).json({ error: 'Task not found' });
  }
  const result = await pool.query(
    `DELETE FROM room_tasks t WHERE t.id=$1 AND t.room_id=$2 AND EXISTS(
       SELECT 1 FROM room_members WHERE room_id=t.room_id AND user_id=$3
     )`,
    [request.params.taskId, request.params.id, request.user.sub],
  );
  if (!result.rowCount) return response.status(404).json({ error: 'Task not found' });
  response.status(204).end();
}));

app.get('/api/rooms/:id/notes', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Room not found' });
  const membership = await pool.query(
    `SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2`,
    [request.params.id, request.user.sub],
  );
  if (!membership.rowCount) return response.status(403).json({ error: 'Join the room first' });
  const { rows } = await pool.query(
    `SELECT n.body,n.updated_at,u.username AS updated_by
     FROM room_notes n JOIN users u ON u.id=n.updated_by WHERE n.room_id=$1`,
    [request.params.id],
  );
  response.json({ note: rows[0] || { body: '', updated_at: null, updated_by: null } });
}));

app.put('/api/rooms/:id/notes', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Room not found' });
  const body = typeof request.body.body === 'string' ? request.body.body : '';
  if (body.length > 10000) return response.status(400).json({ error: 'Notes must be at most 10000 characters' });
  const { rows } = await pool.query(
    `INSERT INTO room_notes(room_id,body,updated_by)
     SELECT $1,$2,$3 WHERE EXISTS(
       SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$3
     )
     ON CONFLICT(room_id) DO UPDATE SET body=EXCLUDED.body,updated_by=EXCLUDED.updated_by,updated_at=NOW()
     RETURNING body,updated_at`,
    [request.params.id, body, request.user.sub],
  );
  if (!rows[0]) return response.status(403).json({ error: 'Join the room first' });
  response.json({ note: rows[0] });
}));

app.get('/api/rooms/:id/events', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Room not found' });
  const { rows } = await pool.query(
    `SELECT e.id,e.title,e.details,e.starts_at,u.username AS created_by
     FROM room_events e JOIN users u ON u.id=e.created_by
     JOIN room_members m ON m.room_id=e.room_id AND m.user_id=$2
     WHERE e.room_id=$1 ORDER BY e.starts_at LIMIT 100`,
    [request.params.id, request.user.sub],
  );
  const membership = await pool.query('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', [
    request.params.id,
    request.user.sub,
  ]);
  if (!membership.rowCount) return response.status(403).json({ error: 'Join the room first' });
  response.json({ events: rows });
}));

app.post('/api/rooms/:id/events', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Room not found' });
  const title = String(request.body.title || '').trim();
  const details = String(request.body.details || '').trim();
  const startsAt = new Date(request.body.starts_at);
  if (!title || title.length > 160 || details.length > 500 || Number.isNaN(startsAt.getTime())) {
    return response.status(400).json({ error: 'Meeting details are invalid' });
  }
  const { rows } = await pool.query(
    `INSERT INTO room_events(room_id,title,details,starts_at,created_by)
     SELECT $1,$2,$3,$4,$5 WHERE EXISTS(
       SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$5
     ) RETURNING id,title,details,starts_at`,
    [request.params.id, title, details, startsAt.toISOString(), request.user.sub],
  );
  if (!rows[0]) return response.status(403).json({ error: 'Join the room first' });
  response.status(201).json({ event: rows[0] });
}));

app.delete('/api/rooms/:id/events/:eventId', auth, wrap(async (request, response) => {
  if (!validId(request.params.id) || !validId(request.params.eventId)) {
    return response.status(404).json({ error: 'Meeting not found' });
  }
  const result = await pool.query(
    `DELETE FROM room_events e WHERE e.id=$1 AND e.room_id=$2 AND EXISTS(
       SELECT 1 FROM room_members WHERE room_id=e.room_id AND user_id=$3
     )`,
    [request.params.eventId, request.params.id, request.user.sub],
  );
  if (!result.rowCount) return response.status(404).json({ error: 'Meeting not found' });
  response.status(204).end();
}));

app.post('/api/rooms/:id/messages/:messageId/pin', auth, wrap(async (request, response) => {
  if (!validId(request.params.id) || !validId(request.params.messageId)) {
    return response.status(404).json({ error: 'Message not found' });
  }
  const membership = await pool.query(
    'SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2',
    [request.params.id, request.user.sub],
  );
  if (!membership.rowCount) return response.status(403).json({ error: 'Join the room first' });
  const { rows } = await pool.query(
    `INSERT INTO pinned_messages(room_id,message_id,pinned_by)
     SELECT m.room_id,m.id,$3 FROM messages m
     WHERE m.room_id=$1 AND m.id=$2
     ON CONFLICT DO NOTHING RETURNING message_id`,
    [request.params.id, request.params.messageId, request.user.sub],
  );
  if (!rows[0]) {
    const exists = await pool.query(
      'SELECT 1 FROM pinned_messages WHERE room_id=$1 AND message_id=$2',
      [request.params.id, request.params.messageId],
    );
    if (!exists.rowCount) return response.status(404).json({ error: 'Message not found in this room' });
  }
  response.json({ pinned: true });
}));

app.delete('/api/rooms/:id/messages/:messageId/pin', auth, wrap(async (request, response) => {
  if (!validId(request.params.id) || !validId(request.params.messageId)) {
    return response.status(404).json({ error: 'Pinned message not found' });
  }
  const result = await pool.query(
    `DELETE FROM pinned_messages p WHERE p.room_id=$1 AND p.message_id=$2 AND EXISTS(
       SELECT 1 FROM room_members WHERE room_id=p.room_id AND user_id=$3
     )`,
    [request.params.id, request.params.messageId, request.user.sub],
  );
  if (!result.rowCount) return response.status(404).json({ error: 'Pinned message not found' });
  response.status(204).end();
}));

app.post('/api/rooms/:id/messages/:messageId/reactions', auth, wrap(async (request, response) => {
  if (!validId(request.params.id) || !validId(request.params.messageId)) {
    return response.status(404).json({ error: 'Message not found' });
  }
  const emoji = String(request.body.emoji || '');
  if (!['👍', '❤️', '😂', '🎉', '😮'].includes(emoji)) {
    return response.status(400).json({ error: 'Reaction is not supported' });
  }
  const message = await pool.query(
    `SELECT m.id FROM messages m JOIN room_members membership
       ON membership.room_id=m.room_id AND membership.user_id=$3
     WHERE m.room_id=$1 AND m.id=$2`,
    [request.params.id, request.params.messageId, request.user.sub],
  );
  if (!message.rowCount) return response.status(404).json({ error: 'Message not found in this room' });
  const prior = await pool.query(
    'DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3 RETURNING emoji',
    [request.params.messageId, request.user.sub, emoji],
  );
  if (!prior.rowCount) {
    await pool.query(
      'INSERT INTO message_reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [request.params.messageId, request.user.sub, emoji],
    );
  }
  const { rows } = await pool.query(
    `SELECT emoji,COUNT(*)::int AS count,BOOL_OR(user_id=$2) AS reacted
     FROM message_reactions WHERE message_id=$1 GROUP BY emoji ORDER BY emoji`,
    [request.params.messageId, request.user.sub],
  );
  response.json({ reactions: rows });
}));

app.get('/api/users', auth, wrap(async (request, response) => {
  const search = String(request.query.search || '').trim().slice(0, 80);
  if (search.length < 2) return response.json({ users: [] });
  const { rows } = await pool.query(
    `SELECT u.id,u.username,COALESCE(u.display_name,u.username) AS display_name,
      u.department,u.job_title,u.bio,u.avatar_data IS NOT NULL AS has_avatar,
      EXISTS(SELECT 1 FROM contacts c WHERE c.owner_id=$1 AND c.contact_id=u.id) AS is_friend,
      (SELECT id FROM friend_requests WHERE sender_id=$1 AND recipient_id=u.id) AS sent_request_id,
      (SELECT id FROM friend_requests WHERE sender_id=u.id AND recipient_id=$1) AS received_request_id
      FROM users u WHERE u.id<>$1 AND (
        u.username ILIKE '%' || $2 || '%' OR u.display_name ILIKE '%' || $2 || '%'
      )
     ORDER BY u.username LIMIT 30`,
    [request.user.sub, search],
  );
  response.json({ users: rows.map(profileResponse) });
}));

app.get('/api/contacts', auth, wrap(async (request, response) => {
  const { rows } = await pool.query(
    `SELECT u.id,u.username,COALESCE(u.display_name,u.username) AS display_name,
      u.department,u.job_title,u.bio,u.avatar_data IS NOT NULL AS has_avatar
     FROM contacts c JOIN users u ON u.id=c.contact_id
     WHERE c.owner_id=$1 ORDER BY u.username`,
    [request.user.sub],
  );
  response.json({ contacts: rows.map(profileResponse) });
}));

app.get('/api/friend-requests', auth, wrap(async (request, response) => {
  const { rows } = await pool.query(
    `SELECT fr.id AS request_id,fr.recipient_id=$1 AS incoming,
      u.id,u.username,COALESCE(u.display_name,u.username) AS display_name,
      u.department,u.job_title,u.bio,u.avatar_data IS NOT NULL AS has_avatar
     FROM friend_requests fr
     JOIN users u ON u.id=CASE WHEN fr.sender_id=$1 THEN fr.recipient_id ELSE fr.sender_id END
     WHERE fr.sender_id=$1 OR fr.recipient_id=$1
     ORDER BY fr.created_at DESC`,
    [request.user.sub],
  );
  response.json({
    incoming: rows.filter((row) => row.incoming).map(profileResponse),
    outgoing: rows.filter((row) => !row.incoming).map(profileResponse),
  });
}));

app.post('/api/friend-requests', auth, wrap(async (request, response) => {
  const username = String(request.body.username || '').trim();
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    return response.status(400).json({ error: 'Enter a valid username' });
  }
  const { rows: users } = await pool.query('SELECT id FROM users WHERE username=$1 AND id<>$2', [
    username,
    request.user.sub,
  ]);
  if (!users[0]) return response.status(404).json({ error: 'Không tìm thấy tài khoản này' });
  const recipientId = users[0].id;
  const friendship = await pool.query(
    'SELECT 1 FROM contacts WHERE owner_id=$1 AND contact_id=$2',
    [request.user.sub, recipientId],
  );
  if (friendship.rowCount) return response.status(409).json({ error: 'Hai bạn đã là bạn bè' });
  const incoming = await pool.query(
    'SELECT id FROM friend_requests WHERE sender_id=$1 AND recipient_id=$2',
    [recipientId, request.user.sub],
  );
  if (incoming.rowCount) return response.status(409).json({ error: 'Người này đã gửi lời mời. Hãy chấp nhận trong mục lời mời kết bạn.' });
  const { rows } = await pool.query(
    `INSERT INTO friend_requests(sender_id,recipient_id)
     VALUES($1,$2) ON CONFLICT(sender_id,recipient_id) DO NOTHING
     RETURNING id`,
    [request.user.sub, recipientId],
  );
  response.status(rows[0] ? 201 : 200).json({ sent: true, request_id: rows[0]?.id });
}));

app.post('/api/friend-requests/:id/accept', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Friend request not found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT sender_id,recipient_id FROM friend_requests WHERE id=$1 AND recipient_id=$2 FOR UPDATE',
      [request.params.id, request.user.sub],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'Friend request not found' });
    }
    const { sender_id: senderId, recipient_id: recipientId } = rows[0];
    await client.query(
      `INSERT INTO contacts(owner_id,contact_id)
       VALUES($1,$2),($2,$1) ON CONFLICT DO NOTHING`,
      [senderId, recipientId],
    );
    await client.query(
      'DELETE FROM friend_requests WHERE (sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1)',
      [senderId, recipientId],
    );
    await client.query('COMMIT');
    response.json({ accepted: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.delete('/api/friend-requests/:id', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Friend request not found' });
  const result = await pool.query(
    'DELETE FROM friend_requests WHERE id=$1 AND (sender_id=$2 OR recipient_id=$2)',
    [request.params.id, request.user.sub],
  );
  if (!result.rowCount) return response.status(404).json({ error: 'Friend request not found' });
  response.status(204).end();
}));

app.delete('/api/contacts/:id', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'Contact not found' });
  const result = await pool.query(
    'DELETE FROM contacts WHERE (owner_id=$1 AND contact_id=$2) OR (owner_id=$2 AND contact_id=$1)',
    [request.user.sub, request.params.id],
  );
  if (!result.rowCount) return response.status(404).json({ error: 'Contact not found' });
  response.status(204).end();
}));

app.get('/api/history', auth, wrap(async (request, response) => {
  const search = String(request.query.search || '').trim().slice(0, 100);
  const { rows } = await pool.query(
    `SELECT m.id,m.room_id,r.name AS room_name,m.body,m.created_at,u.username
     FROM messages m JOIN rooms r ON r.id=m.room_id JOIN users u ON u.id=m.user_id
     JOIN room_members membership ON membership.room_id=m.room_id AND membership.user_id=$1
     WHERE ($2='' OR m.body ILIKE '%' || $2 || '%' OR r.name ILIKE '%' || $2 || '%')
     ORDER BY m.created_at DESC,m.id DESC LIMIT 100`,
    [request.user.sub, search],
  );
  response.json({ messages: rows });
}));

app.get('/api/files', auth, wrap(async (request, response) => {
  const { rows } = await pool.query(
    `SELECT f.id,f.room_id,f.file_name,f.content_type,octet_length(f.content) AS size_bytes,
      f.created_at,u.username,r.name AS room_name
     FROM files f JOIN rooms r ON r.id=f.room_id JOIN users u ON u.id=f.uploaded_by
     JOIN room_members membership ON membership.room_id=f.room_id AND membership.user_id=$1
     ORDER BY f.created_at DESC LIMIT 200`,
    [request.user.sub],
  );
  response.json({ files: rows });
}));

app.post('/api/files', auth, parseFileUpload, wrap(async (request, response) => {
  const rawUpload = Buffer.isBuffer(request.body);
  const body = rawUpload ? {} : request.body || {};
  const roomId = String(rawUpload ? request.get('x-upload-room-id') || '' : body.room_id || '');
  let name;
  try {
    const originalName = rawUpload
      ? decodeURIComponent(request.get('x-upload-file-name') || '')
      : String(body.file_name || '');
    name = originalName.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  } catch {
    return response.status(400).json({ error: 'File name is invalid' });
  }
  let contentType = String(rawUpload ? request.get('content-type') || '' : body.content_type || '')
    .split(';', 1)[0].trim().toLowerCase();
  const encoded = String(body.data || '');
  if (!validId(roomId)) return response.status(400).json({ error: 'Select a valid room' });
  if (!name || name.length > 255) return response.status(400).json({ error: 'File name must be 1-255 characters' });
  const isMediaType = contentType.startsWith('image/') || contentType.startsWith('video/');
  const hasMediaExtension = mediaFileExtensions.has(path.extname(name).toLowerCase());
  if (!allowedFileTypes.has(contentType) && !isMediaType && !hasMediaExtension) {
    return response.status(400).json({ error: 'This file type is not supported' });
  }
  if (!contentType && hasMediaExtension) contentType = 'application/octet-stream';
  let content;
  if (rawUpload) {
    content = request.body;
  } else {
    if (!encoded || encoded.length > Math.ceil(maxUploadBytes * 4 / 3) + 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      return response.status(413).json({ error: 'File must be no larger than 100 MB' });
    }
    content = Buffer.from(encoded, 'base64');
    if (content.toString('base64') !== encoded) {
      return response.status(413).json({ error: 'File must be no larger than 100 MB' });
    }
  }
  if (!content.length) return response.status(400).json({ error: 'File cannot be empty' });
  if (content.length > maxUploadBytes || (!rawUpload && content.toString('base64') !== encoded)) {
    return response.status(413).json({ error: 'File must be no larger than 100 MB' });
  }
  const { rows } = await pool.query(
    `INSERT INTO files(room_id,uploaded_by,file_name,content_type,content)
     SELECT $1,$2,$3,$4,$5 WHERE EXISTS(
       SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2
     ) RETURNING id,room_id,file_name,content_type,octet_length(content) AS size_bytes,created_at`,
    [roomId, request.user.sub, name, contentType, content],
  );
  if (!rows[0]) return response.status(403).json({ error: 'Join the room before uploading files' });
  response.status(201).json({ file: rows[0] });
}));

app.get('/api/files/:id/download', auth, wrap(async (request, response) => {
  if (!validId(request.params.id)) return response.status(404).json({ error: 'File not found' });
  const { rows } = await pool.query(
    `SELECT f.file_name,f.content_type,f.content
     FROM files f JOIN room_members m ON m.room_id=f.room_id
     WHERE f.id=$1 AND m.user_id=$2`,
    [request.params.id, request.user.sub],
  );
  if (!rows[0]) return response.status(404).json({ error: 'File not found' });
  const filename = rows[0].file_name.replace(/["\\\r\n]/g, '_');
  response.set({
    'Content-Type': rows[0].content_type,
    'Content-Length': rows[0].content.length,
    'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(rows[0].file_name)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.send(rows[0].content);
}));

io.use((socket, next) => {
  try {
    socket.user = jwt.verify(
      socket.handshake.headers.cookie?.match(/chat_token=([^;]+)/)?.[1],
      process.env.JWT_SECRET,
      { issuer: 'chat' },
    );
    socket.data.user = socket.user;
    next();
  } catch {
    next(Error('unauthorized'));
  }
});

function getActiveCall(socketId) {
  return [...activeCalls.values()].find((call) => (
    call.callerSocketId === socketId || call.recipientSocketId === socketId
  ));
}

function endCall(call, reason, endingSocketId) {
  activeCalls.delete(call.id);
  clearTimeout(call.timeoutId);
  if (reason === 'no-answer') {
    io.to(call.callerSocketId).emit('call:ended', { callId: call.id, reason });
    io.to(call.recipientSocketId).emit('call:ended', { callId: call.id, reason });
    return;
  }
  const otherSocketId = call.callerSocketId === endingSocketId
    ? call.recipientSocketId
    : call.callerSocketId;
  io.to(otherSocketId).emit('call:ended', { callId: call.id, reason });
}

io.on('connection', (socket) => {
  activeSockets.inc();
  socket.on('disconnect', () => {
    activeSockets.dec();
    const call = getActiveCall(socket.id);
    if (call) endCall(call, 'disconnected', socket.id);
  });
  socket.on('leave-room', (id) => {
    if (validId(id)) {
      const call = getActiveCall(socket.id);
      if (call?.roomId === id) endCall(call, 'left-room', socket.id);
      socket.leave(`room:${id}`);
    }
  });
  socket.on('join-room', async (id, acknowledge = () => {}) => {
    try {
      if (!validId(id)) return acknowledge({ error: 'Room not found' });
      const membership = await pool.query(
        'SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2',
        [id, socket.user.sub],
      );
      if (!membership.rowCount) return acknowledge({ error: 'Join first' });
      socket.join(`room:${id}`);
      acknowledge({ ok: true });
    } catch (error) {
      socket.emit('operation-error', { error: 'Could not join the room' });
      acknowledge({ error: 'Could not join the room' });
      log.error({ err: error }, 'socket room join failed');
    }
  });
  socket.on('chat-message', async ({ roomId, body } = {}, acknowledge = () => {}) => {
    try {
      body = typeof body === 'string' ? body.trim() : '';
      if (!validId(roomId) || !body || body.length > 2000 || !socket.rooms.has(`room:${roomId}`)) {
        return acknowledge({ error: 'Invalid room/message' });
      }
      const { rows } = await pool.query(
        `INSERT INTO messages(room_id,user_id,body)
         SELECT $1,$2,$3 WHERE EXISTS(
           SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2
         ) RETURNING id,room_id,body,created_at`,
        [roomId, socket.user.sub, body],
      );
      if (!rows[0]) return acknowledge({ error: 'Join the room before sending messages' });
      io.to(`room:${roomId}`).emit('chat-message', { ...rows[0], username: socket.user.username });
      acknowledge({ ok: true });
    } catch (error) {
      socket.emit('operation-error', { error: 'Could not send the message' });
      acknowledge({ error: 'Could not send the message' });
      log.error({ err: error }, 'socket message send failed');
    }
  });
  socket.on('call:invite', async ({ roomId, targetUserId, video } = {}, acknowledge = () => {}) => {
    try {
      if (!validId(roomId) || !validId(targetUserId) || socket.user.sub === String(targetUserId)
        || !socket.rooms.has(`room:${roomId}`)) {
        return acknowledge({ error: 'Choose a valid member of this room' });
      }
      if (getActiveCall(socket.id)) return acknowledge({ error: 'You are already in a call' });
      const roomSockets = await io.in(`room:${roomId}`).fetchSockets();
      const recipient = roomSockets.find((peer) => (
        peer.data.user.sub === String(targetUserId) && !getActiveCall(peer.id)
      ));
      if (!recipient) return acknowledge({ error: 'That member is not online or is already in a call' });

      const call = {
        id: crypto.randomUUID(),
        roomId,
        callerSocketId: socket.id,
        recipientSocketId: recipient.id,
        video: video === true,
      };
      activeCalls.set(call.id, call);
      call.timeoutId = setTimeout(() => {
        if (activeCalls.get(call.id) === call && !call.accepted) endCall(call, 'no-answer');
      }, 30000);
      recipient.emit('call:incoming', {
        callId: call.id,
        roomId,
        callerSocketId: socket.id,
        callerName: socket.user.username,
        video: call.video,
      });
      acknowledge({ ok: true, callId: call.id, recipientSocketId: recipient.id });
    } catch (error) {
      socket.emit('operation-error', { error: 'Could not start the call' });
      acknowledge({ error: 'Could not start the call' });
      log.error({ err: error }, 'call invitation failed');
    }
  });
  socket.on('call:accept', ({ callId } = {}, acknowledge = () => {}) => {
    const call = activeCalls.get(callId);
    if (!call || call.recipientSocketId !== socket.id || call.accepted) {
      return acknowledge({ error: 'This call is no longer available' });
    }
    call.accepted = true;
    clearTimeout(call.timeoutId);
    io.to(call.callerSocketId).emit('call:accepted', {
      callId: call.id,
      peerSocketId: socket.id,
    });
    acknowledge({ ok: true, peerSocketId: call.callerSocketId });
  });
  socket.on('call:decline', ({ callId } = {}, acknowledge = () => {}) => {
    const call = activeCalls.get(callId);
    if (!call || call.recipientSocketId !== socket.id) return acknowledge({ error: 'This call is no longer available' });
    endCall(call, 'declined', socket.id);
    acknowledge({ ok: true });
  });
  socket.on('call:signal', ({ callId, signal } = {}, acknowledge = () => {}) => {
    const call = activeCalls.get(callId);
    if (!call?.accepted || (socket.id !== call.callerSocketId && socket.id !== call.recipientSocketId)) {
      return acknowledge({ error: 'This call is no longer available' });
    }
    if (!signal || !['offer', 'answer', 'candidate'].includes(signal.type)
      || Buffer.byteLength(JSON.stringify(signal), 'utf8') > 65536) {
      return acknowledge({ error: 'Invalid call signal' });
    }
    const peerSocketId = socket.id === call.callerSocketId ? call.recipientSocketId : call.callerSocketId;
    io.to(peerSocketId).emit('call:signal', { callId: call.id, signal });
    acknowledge({ ok: true });
  });
  socket.on('call:end', ({ callId } = {}, acknowledge = () => {}) => {
    const call = activeCalls.get(callId);
    if (!call || (socket.id !== call.callerSocketId && socket.id !== call.recipientSocketId)) {
      return acknowledge({ error: 'This call is no longer available' });
    }
    endCall(call, 'ended', socket.id);
    acknowledge({ ok: true });
  });
});

app.use((error, request, response, next) => {
  request.log?.error({ err: error });
  if (error.type === 'entity.too.large') return response.status(413).json({ error: 'Request is too large' });
  if (error instanceof SyntaxError && 'body' in error) {
    return response.status(400).json({ error: 'Invalid JSON body' });
  }
  response.status(500).json({ error: 'Internal error' });
});

async function start() {
  const migrationsDirectory = path.join(__dirname, '..', 'db', 'migrations');
  const migrations = fs.readdirSync(migrationsDirectory)
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  for (const filename of migrations) {
    await pool.query(fs.readFileSync(path.join(migrationsDirectory, filename), 'utf8'));
  }
  await hardenDatabaseRoles();
  server.listen(3000, '0.0.0.0', () => log.info('server started'));
}

async function hardenDatabaseRoles() {
  const appUser = process.env.POSTGRES_USER || '';
  const exporterUser = process.env.POSTGRES_EXPORTER_USER || 'chat_exporter';
  const exporterPassword = process.env.POSTGRES_EXPORTER_PASSWORD || '';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(appUser)) {
    throw Error('POSTGRES_USER must identify the restricted application database role');
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(exporterUser)) {
    throw Error('POSTGRES_EXPORTER_USER must be a valid PostgreSQL role name');
  }
  if (exporterPassword.length < 24 || /^(replace-with|change-me)/i.test(exporterPassword)) {
    throw Error('Set POSTGRES_EXPORTER_PASSWORD to a unique random secret of at least 24 characters');
  }

  const { rows } = await pool.query(
    `SELECT current_user AS role_name, app_role.rolsuper,
      COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname='postgres'),false) AS admin_is_superuser,
      COALESCE(exporter.rolsuper,false) AS exporter_is_superuser,
      COALESCE(exporter.rolcreatedb,false) AS exporter_can_create_db,
      COALESCE(exporter.rolcreaterole,false) AS exporter_can_create_role,
      EXISTS(
        SELECT 1 FROM pg_auth_members membership
        JOIN pg_roles granted_role ON granted_role.oid=membership.roleid
        JOIN pg_roles member_role ON member_role.oid=membership.member
        WHERE granted_role.rolname='pg_monitor' AND member_role.rolname=$1
      ) AS exporter_has_monitor,
      exporter.rolname IS NOT NULL AS exporter_exists,
      EXISTS(
        SELECT 1 FROM pg_database
        WHERE datname=current_database() AND pg_get_userbyid(datdba)=current_user
      ) AS app_owns_database
     FROM pg_roles AS app_role
     LEFT JOIN pg_roles AS exporter ON exporter.rolname=$1
     WHERE app_role.rolname=current_user`,
    [exporterUser],
  );
  const currentRole = rows[0];
  if (appUser !== currentRole.role_name || exporterUser === currentRole.role_name) {
    throw Error('The PostgreSQL exporter must use a separate database role from the application');
  }
  if (currentRole.rolsuper || !currentRole.app_owns_database) {
    throw Error('The application database role must be a non-superuser owner of its database');
  }
  if (!currentRole.admin_is_superuser) {
    throw Error('The local postgres administrator role must exist and be a superuser');
  }
  if (!currentRole.exporter_exists) {
    throw Error('The restricted PostgreSQL exporter role must be provisioned before startup');
  }
  if (currentRole.exporter_is_superuser || currentRole.exporter_can_create_db
    || currentRole.exporter_can_create_role) {
    throw Error('The PostgreSQL exporter role has excessive privileges; reduce it to LOGIN and pg_monitor');
  }
  if (!currentRole.exporter_has_monitor) {
    throw Error('The PostgreSQL exporter role must have pg_monitor before application startup');
  }
}

start().catch((error) => {
  log.fatal({ err: error }, 'application startup failed');
  process.exitCode = 1;
});
