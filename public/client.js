const socket = io();

let roomCode = null;
let roomState = null;
let players = [];
let scores = {};
let currentTurn = null;
let usedNumbers = [];
let pendingPick = null;

let activeQuestion = null;
let countdownInterval = null;
let countdownEndAt = null;

function $(id) { return document.getElementById(id); }

function startCountdown(durationMs) {
  stopCountdown();
  countdownEndAt = Date.now() + durationMs;
  tickCountdown();
  countdownInterval = setInterval(tickCountdown, 200);
}
function stopCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = null;
  countdownEndAt = null;
  const t = $("timer");
  if (t) t.textContent = "—";
}
function tickCountdown() {
  const t = $("timer");
  if (!t || !countdownEndAt) return;
  const left = Math.max(0, countdownEndAt - Date.now());
  t.textContent = `${Math.ceil(left / 1000)}s`;
  if (left <= 0) stopCountdown();
}

function renderScores(targetId) {
  const el = $(targetId);
  if (!el) return;
  if (!players.length) { el.textContent = "—"; return; }
  el.innerHTML = players.map(p => {
    const s = scores[p.socketId] ?? 0;
    return `<div>${p.name}: <b>${s}</b></div>`;
  }).join("");
}

function renderHostGrid() {
  const grid = $("grid");
  if (!grid) return;
  grid.innerHTML = "";
  for (let i = 1; i <= 25; i++) {
    const btn = document.createElement("button");
    btn.textContent = i;
    const isUsed = usedNumbers.includes(i);
    if (isUsed) btn.classList.add("used");
    btn.disabled = isUsed;

    btn.onclick = () => {
      if (!roomCode) return;
      // host confirms only if pendingPick exists and matches
      socket.emit("hostConfirmNumber", { code: roomCode, number: i });
    };
    grid.appendChild(btn);
  }
}

function renderPlayerGrid() {
  const grid = $("pickGrid");
  if (!grid) return;
  grid.innerHTML = "";
  for (let i = 1; i <= 25; i++) {
    const btn = document.createElement("button");
    btn.textContent = i;

    const isUsed = usedNumbers.includes(i);
    if (isUsed) btn.classList.add("used");
    btn.disabled = isUsed;

    btn.onclick = () => {
      if (!roomCode) return;
      socket.emit("playerPickNumber", { code: roomCode, number: i });
      const msg = $("pickMsg");
      if (msg) msg.textContent = `Requested number ${i}. Wait for host to confirm.`;
    };

    grid.appendChild(btn);
  }
}

function setQuestionUI(question, options, role) {
  activeQuestion = { question, options };
  const qt = $("questionText");
  if (qt) qt.textContent = question || "—";

  if (role === "host") {
    const hostOpt = $("optionsHost");
    if (hostOpt) {
      hostOpt.innerHTML = options.map((o, idx) => `<div>${idx+1}) ${o}</div>`).join("");
    }
  } else {
    const opt = $("options");
    if (opt) {
      opt.innerHTML = "";
      options.forEach((o, idx) => {
        const b = document.createElement("button");
        b.style.margin = "8px 8px 0 0";
        b.textContent = o;
        b.onclick = () => {
          socket.emit("playerSubmitAnswer", { code: roomCode, answerIndex: idx });
          // disable buttons after click to reduce spam (server still enforces)
          [...opt.querySelectorAll("button")].forEach(x => x.disabled = true);
        };
        opt.appendChild(b);
      });
    }
  }
}

function clearQuestionUI(role) {
  activeQuestion = null;
  const qt = $("questionText");
  if (qt) qt.textContent = role === "player" ? "Waiting..." : "—";

  if (role === "player") {
    const opt = $("options");
    if (opt) opt.innerHTML = "";
  } else {
    const hostOpt = $("optionsHost");
    if (hostOpt) hostOpt.innerHTML = "";
  }
  stopCountdown();
}

function updateTurnBadge(role) {
  if (role !== "player") return;
  const badge = $("turnBadge");
  if (!badge) return;
  if (!players.length) return;
  const isMine = socket.id === currentTurn;
  badge.textContent = isMine ? "YOUR TURN" : "not your turn";
}

function updateHostTurnInfo() {
  const el = $("turnInfo");
  if (!el) return;
  if (!players.length || !currentTurn) { el.textContent = "—"; return; }
  const p = players.find(x => x.socketId === currentTurn);
  el.innerHTML = `Current turn: <b>${p ? p.name : currentTurn}</b>`;
}

// ---------------------------
// Host-specific boot
// ---------------------------
if (window.DUO_ROLE === "host") {
  const createBtn = $("createRoomBtn");
  if (createBtn) {
    createBtn.onclick = () => {
      socket.emit("hostCreateRoom");
    };
  }
}

// ---------------------------
// Player-specific boot
// ---------------------------
if (window.DUO_ROLE === "player") {
  const joinBtn = $("joinBtn");
  if (joinBtn) {
    joinBtn.onclick = () => {
      const code = ($("codeInput")?.value || "").trim();
      const name = ($("nameInput")?.value || "").trim();
      socket.emit("playerJoinRoom", { code, name });
    };
  }
  renderPlayerGrid(); // empty initial grid
}

// ---------------------------
// Socket events
// ---------------------------
socket.on("roomCreated", ({ code }) => {
  roomCode = code;
  if ($("roomCode")) $("roomCode").textContent = code;
});

socket.on("joinError", ({ message }) => {
  alert(message);
});

socket.on("actionError", ({ message }) => {
  // small inline for player, alert for host
  if (window.DUO_ROLE === "player") {
    const msg = $("answerMsg") || $("pickMsg");
    if (msg) msg.textContent = message;
  } else {
    alert(message);
  }
});

socket.on("gameStarted", ({ currentTurn: ct, players: pls }) => {
  players = pls;
  currentTurn = ct;

  if (window.DUO_ROLE === "player") {
    $("joinedRoom").textContent = roomCode || "—";
    updateTurnBadge("player");
    renderPlayerGrid();
  } else {
    renderHostGrid();
    updateHostTurnInfo();
  }

  renderScores(window.DUO_ROLE === "host" ? "scoresList" : "scores");
});

socket.on("roomUpdate", (info) => {
  roomCode = info.code;
  roomState = info.state;
  players = info.players;
  scores = info.scores || {};
  currentTurn = info.currentTurn;
  usedNumbers = info.usedNumbers || [];
  pendingPick = info.pendingPick;

  if ($("stateBadge")) $("stateBadge").textContent = roomState || "—";

  // host UI
  if (window.DUO_ROLE === "host") {
    if ($("roomCode")) $("roomCode").textContent = roomCode || "—";
    if ($("playersList")) {
      $("playersList").innerHTML = players.length
        ? players.map(p => `<div>${p.name}</div>`).join("")
        : "Waiting...";
    }
    renderScores("scoresList");
    renderHostGrid();
    updateHostTurnInfo();

    const pInfo = $("pendingInfo");
    if (pInfo) {
      if (pendingPick) {
        const by = players.find(x => x.socketId === pendingPick.bySocketId)?.name || "Player";
        pInfo.innerHTML = `Pending: <b>${pendingPick.number}</b> (requested by <b>${by}</b>). Click the same number on the grid to confirm.`;
      } else {
        pInfo.textContent = "No pending pick.";
      }
    }
  }

  // player UI
  if (window.DUO_ROLE === "player") {
    if ($("joinedRoom")) $("joinedRoom").textContent = roomCode || "—";
    updateTurnBadge("player");
    renderScores("scores");
    renderPlayerGrid();
  }
});

socket.on("pendingPick", ({ number, byName }) => {
  if (window.DUO_ROLE === "host") {
    const pInfo = $("pendingInfo");
    if (pInfo) pInfo.innerHTML = `Pending: <b>${number}</b> (requested by <b>${byName}</b>). Click it on your grid to confirm.`;
  }
});

socket.on("questionStarted", ({ gridNumber, question, options, durationMs }) => {
  const role = window.DUO_ROLE;

  if (role === "host") {
    const msg = $("roundMsg");
    if (msg) msg.innerHTML = `Question started for grid <b>${gridNumber}</b>.`;
  } else {
    const am = $("answerMsg");
    if (am) am.textContent = "";
    const pm = $("pickMsg");
    if (pm) pm.textContent = "";
  }

  setQuestionUI(question, options, role);
  startCountdown(durationMs);
});

socket.on("answerResult", ({ correct }) => {
  const role = window.DUO_ROLE;
  if (role !== "player") return;
  const am = $("answerMsg");
  if (!am) return;
  am.innerHTML = correct ? `<span class="success">Correct!</span>` : `<span class="fail">Wrong!</span>`;
});

socket.on("roundWinner", ({ winnerName, timeTakenMs, scores: newScores }) => {
  scores = newScores || scores;
  renderScores(window.DUO_ROLE === "host" ? "scoresList" : "scores");

  const role = window.DUO_ROLE;
  if (role === "host") {
    const msg = $("roundMsg");
    if (msg) msg.innerHTML = `Winner: <b>${winnerName}</b> (${Math.round(timeTakenMs)} ms)`;
  } else {
    const am = $("answerMsg");
    if (am) am.innerHTML = `Winner: <b>${winnerName}</b> (${Math.round(timeTakenMs)} ms)`;
  }
});

socket.on("questionEnded", ({ reason, winnerSocketId, scores: newScores, currentTurn: ct }) => {
  scores = newScores || scores;
  currentTurn = ct;

  clearQuestionUI(window.DUO_ROLE);
  renderScores(window.DUO_ROLE === "host" ? "scoresList" : "scores");

  if (window.DUO_ROLE === "host") {
    updateHostTurnInfo();
  } else {
    updateTurnBadge("player");
  }

  const msg = window.DUO_ROLE === "host" ? $("roundMsg") : $("answerMsg");
  if (msg) {
    msg.innerHTML = `Round ended: <b>${reason}</b>.`;
  }
});

socket.on("gameEnded", ({ scores: finalScores }) => {
  scores = finalScores || scores;
  renderScores(window.DUO_ROLE === "host" ? "scoresList" : "scores");
  alert("Game ended! Check the final scores.");
});

socket.on("roomClosed", ({ message }) => {
  alert(message);
  window.location.href = "/";
});