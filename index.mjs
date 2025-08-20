import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();

// Be strict later; go permissive first to prove it works.
const allowed = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / health checks
      if (!allowed.length) return cb(null, true); // dev: allow all
      cb(null, allowed.includes(origin));
    },
    credentials: true,
  })
);

app.get('/', (_req, res) => res.send('OK'));

const server = createServer(app);

const io = new Server(server, {
  cors: { origin: allowed.length ? allowed : true, credentials: true },
  path: '/socket.io', // default; keep client default too
});

// --- Replace these with your app’s events --------------------
io.on('connection', (socket) => {
  // Example room join
  socket.on('join', (roomId) => socket.join(roomId));

  // Example “vote” event (broadcast to room)
  socket.on('vote', ({ roomId, payload }) => {
    socket.to(roomId).emit('vote:updated', payload);
  });

  // Example reset
  socket.on('reset', (roomId) => {
    io.to(roomId).emit('reset:done');
  });
});
// -------------------------------------------------------------

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Socket server listening on :${port}`);
});
