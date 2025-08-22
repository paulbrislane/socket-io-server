import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

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

// Simple in-memory sessions store shared across connections
// NOTE: in production use a real database or external store
const sessions = global.__SESSIONS ||= new Map();

// --- Application socket events -------------------------------
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('session:create', (sessionName, facilitatorName, categories) => {
    const sessionId = uuidv4();
    const session = {
      id: sessionId,
      name: sessionName,
      facilitator: facilitatorName,
      createdAt: new Date().toISOString(),
      currentCategoryIndex: 0,
      categories: categories || [],
      members: [],
      results: [],
      isActive: true,
      isCompleted: false,
    };

    sessions.set(sessionId, session);
    socket.join(sessionId);
    socket.emit('session:updated', session);

    console.log(`Session created: ${sessionId} by ${facilitatorName}`);
  });

  socket.on('session:join', (sessionId, memberName) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit('error', 'Session not found');
      return;
    }

    if (session.isCompleted) {
      socket.emit('error', 'Session has already been completed');
      return;
    }

    const memberId = uuidv4();
    const member = { id: memberId, name: memberName, isOnline: true };

    const exists = session.members.find(m => m.name === memberName);
    if (exists) {
      socket.emit('error', 'A member with this name is already in the session');
      return;
    }

    session.members.push(member);
    socket.join(sessionId);

    socket.data = socket.data || {};
    socket.data.sessionId = sessionId;
    socket.data.memberId = memberId;
    socket.data.memberName = memberName;

    io.to(sessionId).emit('session:updated', session);
    io.to(sessionId).emit('member:joined', member);

    console.log(`${memberName} joined session ${sessionId}`);
  });

  socket.on('session:leave', (sessionId, memberId) => {
    const session = sessions.get(sessionId);
    if (!session) return;

    session.members = session.members.filter(m => m.id !== memberId);
    socket.leave(sessionId);

    io.to(sessionId).emit('session:updated', session);
    io.to(sessionId).emit('member:left', memberId);

    console.log(`Member ${memberId} left session ${sessionId}`);
  });

  socket.on('score:submit', (sessionId, categoryId, memberId, memberName, score) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit('error', 'Session not found');
      return;
    }

    const currentCategory = session.categories[session.currentCategoryIndex];
    if (currentCategory && currentCategory.id !== categoryId) {
      socket.emit('error', 'Invalid category for current session state');
      return;
    }

    let categoryResult = session.results.find(r => r.categoryId === categoryId);
    if (!categoryResult) {
      categoryResult = {
        categoryId,
        categoryName: currentCategory ? currentCategory.name : categoryId,
        scores: [],
        meanScore: 0,
        totalResponses: 0,
        expectedResponses: session.members.length,
      };
      session.results.push(categoryResult);
    }

    categoryResult.scores = categoryResult.scores.filter(s => s.memberId !== memberId);
    const categoryScore = { categoryId, memberId, memberName, score, timestamp: new Date().toISOString() };
    categoryResult.scores.push(categoryScore);

    categoryResult.totalResponses = categoryResult.scores.length;
    categoryResult.meanScore = categoryResult.scores.reduce((sum, s) => sum + s.score, 0) / (categoryResult.totalResponses || 1);
    categoryResult.expectedResponses = session.members.length;

    sessions.set(sessionId, session);

    io.to(sessionId).emit('score:submitted', categoryResult);
    io.to(sessionId).emit('session:updated', session);

    console.log(`Score submitted: ${memberName} scored ${score} for ${currentCategory ? currentCategory.name : categoryId}`);
  });

  socket.on('category:advance', (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit('error', 'Session not found');
      return;
    }

    if (session.currentCategoryIndex < session.categories.length - 1) {
      session.currentCategoryIndex++;
      sessions.set(sessionId, session);

      io.to(sessionId).emit('category:next', session.currentCategoryIndex);
      io.to(sessionId).emit('session:updated', session);

      console.log(`Advanced to category ${session.currentCategoryIndex} in session ${sessionId}`);
    } else {
      session.isCompleted = true;
      session.isActive = false;
      sessions.set(sessionId, session);

      io.to(sessionId).emit('session:completed', session.results);
      io.to(sessionId).emit('session:updated', session);

      console.log(`Session ${sessionId} completed`);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    const data = socket.data || {};
    const { sessionId, memberId } = data;
    if (sessionId && memberId) {
      const session = sessions.get(sessionId);
      if (session) {
        const member = session.members.find(m => m.id === memberId);
        if (member) {
          member.isOnline = false;
          io.to(sessionId).emit('session:updated', session);
        }
      }
    }
  });
});
// -------------------------------------------------------------

const port = process.env.PORT || 10000;
server.listen(port, () => {
  console.log(`Socket server listening on :${port}`);
});
