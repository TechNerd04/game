const path = require("path");
const fs = require("fs");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8"));

// ------------------------
// In-memory room storage
// ------------------------
/**
room = {
  code,
  hostSocketId,
  players: [{socketId, name}],
  state: "lobby" | "playing" | "ended",
  scores: { [socketId]: number },
  currentTurn: socketId,
  winnerLastRound: socketId | null,
  usedNumbers: Set<number>,
  pendingPick: { number, bySocketId } | null,  // player asked for number; host must confirm
  activeQuestion: { q, gridNumber, startedAt, answeredBy, locked } | null,
  timer: NodeJS.Timeout | null
}
*/
const rooms = new Map();

function generateRoomCode() {
  // 6-digit numeric code, avoid collisions
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));
  return code;
}

function pickQuestionForGridNumber(gridNumber) {
  // deterministic-ish mapping: choose by gridNumber + random offset
  // simplest: random question
  const idx = Math.floor(Math.random() * QUESTIONS.length);
  return QUESTIONS[idx];
}

function publicRoomInfo(room) {
  return {
    code: room.code,
    state: room.state,
    players: room.players.map(p => ({ name: p.name, socketId: p.socketId })),
    scores: room.scores,
    currentTurn: room.currentTurn,
    usedNumbers: Array.from(room.usedNumbers),
    pendingPick: room.pendingPick ? { number: room.pendingPick.number, bySocketId: room.pendingPick.bySocketId } : null
  };
}

function endActiveQuestion(room, reason) {
  if (!room.activeQuestion) return;

  // clear timer
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }

  const aq = room.activeQuestion;
  room.activeQuestion = null;

  // If no winner (no correct), switch turn
  let winner = aq.answeredBy || null;

  if (!winner) {
    // switch turn to the other player if 2 players exist
    if (room.players.length === 2) {
      const [p1, p2] = room.players;
      room.currentTurn = (room.currentTurn === p1.socketId) ? p2.socketId : p1.socketId;
    }
  } else {
    // winner keeps turn
    room.currentTurn = winner;
  }

  // broadcast end-of-question state
  io.to(room.code).emit("questionEnded", {
    reason,
    winnerSocketId: winner,
    scores: room.scores,
    currentTurn: room.currentTurn
  });

  // End game if all 25 used
  if (room.usedNumbers.size >= 25) {
    room.state = "ended";
    io.to(room.code).emit("gameEnded", { scores: room.scores });
  } else {
    // allow next pick
    io.to(room.code).emit("roomUpdate", publicRoomInfo(room));
  }
}

function lockAndScore(room, winnerSocketId, timeTakenMs) {
  // scoring: base 100, minus 0..60 based on speed (fast = more)
  // timeTakenMs capped at 15000
  const capped = Math.min(Math.max(timeTakenMs, 0), 15000);
  const bonus = Math.round((15000 - capped) / 250); // up to 60
  const points = 40 + bonus; // 40..100

  room.scores[winnerSocketId] = (room.scores[winnerSocketId] || 0) + points;
}

io.on("connection", (socket) => {
  // ------------------------
  // HOST creates room
  // ------------------------
  socket.on("hostCreateRoom", () => {
    const code = generateRoomCode();

    const room = {
      code,
      hostSocketId: socket.id,
      players: [],
      state: "lobby",
      scores: {},
      currentTurn: null,
      winnerLastRound: null,
      usedNumbers: new Set(),
      pendingPick: null,
      activeQuestion: null,
      timer: null
    };

    rooms.set(code, room);
    socket.join(code);

    socket.emit("roomCreated", { code });
    socket.emit("roomUpdate", publicRoomInfo(room));
  });

  // ------------------------
  // PLAYER joins room
  // ------------------------
  socket.on("playerJoinRoom", ({ code, name }) => {
    const room = rooms.get(code);
    if (!room) {
      socket.emit("joinError", { message: "Room not found." });
      return;
    }
    if (room.state !== "lobby") {
      socket.emit("joinError", { message: "Game already started." });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit("joinError", { message: "Room already has 2 players." });
      return;
    }

    room.players.push({ socketId: socket.id, name: (name || "Player").slice(0, 20) });
    room.scores[socket.id] = 0;

    socket.join(code);
    io.to(code).emit("roomUpdate", publicRoomInfo(room));

    // auto-start when 2 players joined
    if (room.players.length === 2) {
      // first turn: player1
      room.state = "playing";
      room.currentTurn = room.players[0].socketId;
      io.to(code).emit("gameStarted", {
        currentTurn: room.currentTurn,
        players: room.players
      });
      io.to(code).emit("roomUpdate", publicRoomInfo(room));
    }
  });

  // ------------------------
  // CURRENT TURN player requests a number
  // ------------------------
  socket.on("playerPickNumber", ({ code, number }) => {
    const room = rooms.get(code);
    if (!room || room.state !== "playing") return;

    if (socket.id !== room.currentTurn) {
      socket.emit("actionError", { message: "Not your turn." });
      return;
    }

    const n = Number(number);
    if (!Number.isInteger(n) || n < 1 || n > 25) return;
    if (room.usedNumbers.has(n)) {
      socket.emit("actionError", { message: "Number already used." });
      return;
    }

    if (room.activeQuestion || room.pendingPick) {
      socket.emit("actionError", { message: "Wait for the current round." });
      return;
    }

    // set pending pick (host must confirm by clicking)
    room.pendingPick = { number: n, bySocketId: socket.id };

    io.to(code).emit("pendingPick", {
      number: n,
      bySocketId: socket.id,
      byName: room.players.find(p => p.socketId === socket.id)?.name || "Player"
    });

    io.to(code).emit("roomUpdate", publicRoomInfo(room));
  });

  // ------------------------
  // HOST confirms number (must match pendingPick)
  // ------------------------
  socket.on("hostConfirmNumber", ({ code, number }) => {
    const room = rooms.get(code);
    if (!room || room.state !== "playing") return;
    if (socket.id !== room.hostSocketId) return;

    if (!room.pendingPick) {
      socket.emit("actionError", { message: "No pending pick." });
      return;
    }

    const n = Number(number);
    if (n !== room.pendingPick.number) {
      socket.emit("actionError", { message: "That is not the pending number." });
      return;
    }

    // consume number
    room.usedNumbers.add(n);

    // start question
    const q = pickQuestionForGridNumber(n);
    const startedAt = Date.now();

    room.activeQuestion = {
      q,
      gridNumber: n,
      startedAt,
      answeredBy: null,
      locked: false
    };

    // clear pending
    room.pendingPick = null;

    io.to(code).emit("questionStarted", {
      gridNumber: n,
      question: q.question,
      options: q.options,
      durationMs: 15000
    });

    // server timer
    room.timer = setTimeout(() => {
      endActiveQuestion(room, "timeout");
    }, 15000);

    io.to(code).emit("roomUpdate", publicRoomInfo(room));
  });

  // ------------------------
  // PLAYER answers
  // ------------------------
  socket.on("playerSubmitAnswer", ({ code, answerIndex }) => {
    const room = rooms.get(code);
    if (!room || room.state !== "playing") return;
    if (!room.activeQuestion) {
      socket.emit("actionError", { message: "No active question." });
      return;
    }

    // Only allow room players to answer
    if (!room.players.some(p => p.socketId === socket.id)) return;

    const aq = room.activeQuestion;
    if (aq.locked) return;

    const idx = Number(answerIndex);
    if (!Number.isInteger(idx)) return;

    const correct = idx === aq.q.answerIndex;
    const now = Date.now();
    const timeTaken = now - aq.startedAt;

    // Broadcast each answer result to that player only (privacy)
    socket.emit("answerResult", { correct });

    if (correct) {
      // first correct locks in
      aq.locked = true;
      aq.answeredBy = socket.id;

      lockAndScore(room, socket.id, timeTaken);

      io.to(code).emit("roundWinner", {
        winnerSocketId: socket.id,
        winnerName: room.players.find(p => p.socketId === socket.id)?.name || "Player",
        timeTakenMs: timeTaken,
        scores: room.scores
      });

      endActiveQuestion(room, "correct");
    }
    // If wrong: do nothing; round continues until someone correct or timeout
  });

  // ------------------------
  // Handle disconnects
  // ------------------------
  socket.on("disconnect", () => {
    // remove socket from any room
    for (const [code, room] of rooms.entries()) {
      const wasHost = room.hostSocketId === socket.id;
      const playerIdx = room.players.findIndex(p => p.socketId === socket.id);

      if (wasHost || playerIdx !== -1) {
        // end room
        if (room.timer) clearTimeout(room.timer);
        io.to(code).emit("roomClosed", { message: "A host/player disconnected. Room closed." });
        rooms.delete(code);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});