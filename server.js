//server.js :
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");
const mysql = require("mysql");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
let roomCounter = 1;
let currentObject = "";
const currentDrawers = {};
let roomPlayers = {};
let pointsToWin = 0;
let selectedTheme = "";
let currentTurns = {};
const roomAnswers = {};
const correctGuessers = {};
const gameStatus = {};
const gameTimers = {};

const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "quick_draw",
});

db.connect((err) => {
  if (err) {
    console.error("Database connection failed:", err);
    return;
  }
  console.log("Connected to the database");
});

const themeObjects = {
  general: [
    "Arduino",
    "Parfume",
    "Scissors",
    "Printer",
    "Gas Cylinder",
    "Tree",
  ],
  animal: ["Cat", "Monkey", "Rabbit", "Lion", "Duck", "Giraffe"],
  object: ["Table", "Bed", "Hat", "Calculator", "Iron", "Bag"],
  food: ["Mie", "Pizza", "Burger", "Ice Cream", "Bread", "Sushi"],
  hardware: ["Computer", "Mouse", "Keyboard", "Tablet", "Printer", "Router"],
};

io.on("connection", (socket) => {
  socket.on("create room with config", (configuration) => {
    console.log("Configuration received:", configuration);
    const { players, points, theme } = configuration;

    const roomCode = `QD${String(roomCounter).padStart(3, "0")}`;
    roomCounter++;

    selectedTheme = configuration.theme;

    console.log("Inserting room with code:", roomCode);
    db.query(
      "INSERT INTO rooms (kode_room, tema, poin, jumlah_pemain) VALUES (?, ?, ?, ?)",
      [roomCode, theme, points, players],
      (err, result) => {
        if (err) {
          console.error("Error creating room:", err);
          return;
        }
        try {
          console.log("Room created successfully:", roomCode);
          socket.join(roomCode);
          roomPlayers[roomCode] = {};
          pointsToWin = parseInt(configuration.points);

          // Emit room created event immediately
          socket.emit("room created", roomCode);
        } catch (error) {
          console.error("Error in room creation:", error);
          socket.emit("room creation error", "Server error");
        }
      }
    );
  });

  socket.on("themeSelected", (theme) => {
    selectedTheme = theme;
  });

  socket.on("get room info", (roomCode) => {
    console.log("Getting info for room:", roomCode);

    if (!roomCode) {
      console.log("No room code provided");
      return;
    }

    db.query(
      "SELECT * FROM rooms WHERE kode_room = ?",
      [roomCode],
      (err, results) => {
        if (err) {
          console.error("Error fetching room info:", err);
          return;
        }

        console.log("Query results:", results);

        if (results && results.length > 0) {
          console.log("Found room info:", results[0]);
          socket.emit("room info", {
            kode_room: results[0].kode_room,
            tema: results[0].tema,
            poin: results[0].poin,
            jumlah_pemain: results[0].jumlah_pemain,
          });
        } else {
          console.log("No room found with code:", roomCode);
          socket.emit("room info", {
            kode_room: "Room not found",
            tema: "Not available",
            poin: "Not available",
            jumlah_pemain: "Not available",
          });
        }
        gameStatus[roomCode] = {
          inProgress: false,
        };
      }
    );
  });

  socket.on("join", (username, room) => {
    console.log(`Join request received - Username: ${username}, Room: ${room}`);

    db.query(
      "SELECT * FROM rooms WHERE kode_room = ?",
      [room],
      (err, results) => {
        if (err) {
          console.error("Database error:", err);
          socket.emit("joinError", "Kesalahan database");
          return;
        }

        if (results.length === 0) {
          console.log(`Room ${room} not found`);
          socket.emit("joinError", "Ruangan tidak ditemukan");
          return;
        }

        const roomInfo = results[0];
        const maxPlayers = parseInt(roomInfo.jumlah_pemain);

        if (!roomPlayers[room]) {
          roomPlayers[room] = {};
        }

        if (Object.keys(roomPlayers[room]).length >= maxPlayers) {
          console.log(`Room ${room} is full`);
          socket.emit("room full", "The room is full");
          return;
        }

        socket.emit("join success");

        socket.emit("game status", gameStatus[room] || { inProgress: false });

        const avatar = socket.handshake.auth.avatar || "👤";
        roomPlayers[room][username] = {
          username: username,
          avatar: avatar,
          score: 0,
        };

        socket.join(room);
        socket.username = username;
        socket.currentRoom = room;

        const roomData = {
          players: Object.values(roomPlayers[room]),
          maxPlayers: maxPlayers,
          theme: roomInfo.tema,
          points: roomInfo.poin,
        };

        io.to(room).emit("roomData", roomData);
      }
    );
  });

  socket.on("disconnect", () => {
    if (socket.currentRoom && socket.username) {
      // Cleanup room data
      if (roomPlayers[socket.currentRoom]) {
        delete roomPlayers[socket.currentRoom][socket.username];

        // Jika pemain yang disconnect adalah drawer saat ini
        if (currentDrawers[socket.currentRoom] === socket.username) {
          const players = Object.keys(roomPlayers[socket.currentRoom]);
          if (players.length > 0) {
            const nextPlayer = players[0];
            currentTurns[socket.currentRoom] = nextPlayer;
            io.to(socket.currentRoom).emit("playerTurn", {
              player: nextPlayer,
              theme: selectedTheme,
            });
          }
        }

        io.to(socket.currentRoom).emit("roomData", {
          players: Object.values(roomPlayers[socket.currentRoom]),
        });

        if (Object.keys(roomPlayers[socket.currentRoom]).length === 0) {
          delete roomPlayers[socket.currentRoom];
          delete gameStatus[socket.currentRoom];
          delete currentDrawers[socket.currentRoom];
          delete correctGuessers[socket.currentRoom];
          delete roomAnswers[socket.currentRoom];
        }
      }
    }
  });

  socket.on("start game", (roomCode) => {
    gameStatus[roomCode] = {
      inProgress: true,
    };
    const hostPlayer = Object.keys(roomPlayers[roomCode])[0];
    currentTurns[roomCode] = hostPlayer;

    db.query(
      "SELECT tema FROM rooms WHERE kode_room = ?",
      [roomCode],
      (err, results) => {
        if (err || !results.length) {
          console.error("Error getting theme:", err);
          return;
        }

        const theme = results[0].tema;

        io.to(roomCode).emit("game started", {
          firstDrawer: hostPlayer,
          theme: theme,
        });

        io.to(roomCode).emit("playerTurn", {
          player: hostPlayer,
          theme: theme,
        });
      }
    );
  });

  socket.on("check game status", (roomCode) => {
    const status = gameStatus[roomCode] || { inProgress: false };
    socket.emit("game status", status);
  });

  socket.on("draw", ({ roomId, drawData }) => {
    socket.to(roomId).emit("draw", drawData);
  });

  socket.on("objectSelected", ({ object, roomId }) => {
    if (!object) {
      console.error("No object selected");
      return;
    }

    // Reset state untuk ronde baru
    currentObject = object;
    currentDrawers[roomId] = socket.username;
    roomAnswers[roomId] = [];
    correctGuessers[roomId] = new Set();

    io.to(roomId).emit("startDrawing", {
      drawer: socket.username,
      object: object,
    });
  });
  socket.on("skipTurn", ({ roomId }) => {
    console.log(`${socket.id} doesn't select the object.`);
    io.to(roomId).emit("nextTurn", { skippedBy: socket.username });
  });

  socket.on("timeUp", ({ roomId }) => {
    console.log("Time up event received for room:", roomId);

    if (!roomPlayers[roomId]) return;

    const players = Object.keys(roomPlayers[roomId]);
    const currentDrawer = currentDrawers[roomId];
    const currentIndex = players.indexOf(currentDrawer);
    const nextIndex = (currentIndex + 1) % players.length;
    const nextPlayer = players[nextIndex];

    // Bersihkan state untuk ronde saat ini
    delete currentDrawers[roomId];
    if (correctGuessers[roomId]) {
      correctGuessers[roomId].clear();
    }

    // Pindah ke pemain berikutnya
    currentTurns[roomId] = nextPlayer;

    // Emit events ke client
    io.to(roomId).emit("timeUp", { nextPlayer });
    io.to(roomId).emit("playerTurn", {
      player: nextPlayer,
      theme: selectedTheme,
    });
  });

  // socket.on("objectSelected", ({ object, roomId }) => {
  //   if (!object) {
  //       console.error("No object selected");
  //       return;
  //   }
  //   currentObject = object;
  //   currentDrawers[roomId] = socket.username;

  //   roomAnswers[roomId] = [];
  //   correctGuessers[roomId] = new Set();

  //   io.to(roomId).emit("startDrawing", {
  //       drawer: socket.username,
  //       object: object
  //   });
  // });

  socket.on("guess", ({ answer, roomId, username }) => {
    const correctAnswer = currentObject.toLowerCase();
    const drawer = currentDrawers[roomId];

    if (username === drawer) return;
    if (correctGuessers[roomId]?.has(username)) return;

    if (answer === correctAnswer && !correctGuessers[roomId]?.has(username)) {
      if (!correctGuessers[roomId]) correctGuessers[roomId] = new Set();
      correctGuessers[roomId].add(username);

      roomPlayers[roomId][username].score += 10;
      roomPlayers[roomId][drawer].score += 5;

      const hasWinner = Object.values(roomPlayers[roomId]).some(
        (player) => player.score >= pointsToWin
      );

      io.to(roomId).emit("newGuess", {
        username,
        message: `${username} get 10 points!`,
        isCorrect: true,
      });

      io.to(roomId).emit("roomData", {
        players: Object.values(roomPlayers[roomId]),
      });

      if (hasWinner) {
        const winner = Object.values(roomPlayers[roomId]).find(
          (player) => player.score >= pointsToWin
        );

        io.to(roomId).emit("gameOver", {
          winner: winner.username,
          finalScores: Object.values(roomPlayers[roomId]),
        });

        // Cleanup game state
        delete gameStatus[roomId];
        delete roomPlayers[roomId];
        delete currentDrawers[roomId];
        delete correctGuessers[roomId];
        delete roomAnswers[roomId];
        return;
      }

      const totalPlayers = Object.keys(roomPlayers[roomId]).length;
      const totalCorrectGuessers = correctGuessers[roomId].size;
      const allPlayersGuessedCorrectly =
        totalCorrectGuessers >= totalPlayers - 1;

      if (allPlayersGuessedCorrectly) {
        const players = Object.keys(roomPlayers[roomId]);
        const currentIndex = players.indexOf(drawer);
        const nextIndex = (currentIndex + 1) % players.length;
        const nextPlayer = players[nextIndex];
        currentTurns[roomId] = nextPlayer;

        // Beri waktu singkat sebelum pindah ke pemain berikutnya
        setTimeout(() => {
          io.to(roomId).emit("playerTurn", {
            player: nextPlayer,
            theme: selectedTheme,
          });
        }, 2000);
      }
    } else {
      io.to(roomId).emit("newGuess", {
        username,
        message: answer,
        isCorrect: false,
      });
    }
  });
});

app.use(express.static(path.join(__dirname)));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "halUtm.html"));
});

app.get("/tema", (_req, res) => {
  res.sendFile(path.join(__dirname, "tema.html"));
});

app.get("/room", (_req, res) => {
  res.sendFile(path.join(__dirname, "room.html"));
});

const IP = "172.125.2.79";
server.listen(3001, IP, () => {
  console.log(`Server running at http://${IP}:3001`);
});
