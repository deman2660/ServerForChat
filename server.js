// server.js
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// Create an Express app and HTTP server.
const app = express();
app.use(express.json()); // For parsing JSON bodies
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: [
      "chrome-extension://gbibdfkjimflbogckcbmncoehfdonleh",
      "https://www.roblox.com"
    ]
  }
});


// In-memory storage for connected users and queued messages.
const activeUsers = new Map();
const messageQueues = new Map();

// Open (or create) the SQLite database file.
const db = new sqlite3.Database("chat.db", (err) => {
  if (err) {
    console.error("Error opening database:", err.message);
  } else {
    console.log("Connected to the SQLite database.");
  }
});

// Create the messages table if it doesn't exist.
// Now includes a "message_type" column (default 'text').
db.run(
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_user_id TEXT,
    recipient_user_id TEXT,
    content TEXT,
    timestamp TEXT,
    message_type TEXT DEFAULT 'text'
  )`,
  (err) => {
    if (err) {
      console.error("Error creating messages table:", err.message);
    } else {
      console.log("Messages table ready.");
    }
  }
);

// Create the registered_users table if it doesn't exist.
db.run(
  `CREATE TABLE IF NOT EXISTS registered_users (
    user_id TEXT PRIMARY KEY,
    registered_at TEXT
  )`,
  (err) => {
    if (err) {
      console.error("Error creating registered_users table:", err.message);
    } else {
      console.log("registered_users table ready.");
    }
  }
);

// --- Socket.IO Event Handlers ---
io.on("connection", (socket) => {
  console.log("[Server] New Socket.IO connection established.");

  // Handle registration over Socket.IO.
  socket.on("register", (data, ack) => {
    const userId = String(data.userId);  // Ensure it's a string
    const registeredAt = new Date().toISOString();
    db.run(
      `INSERT OR REPLACE INTO registered_users (user_id, registered_at) VALUES (?, ?)`,
      [userId, registeredAt],
      function (err) {
        if (err) {
          console.error("Error registering user:", err.message);
          return ack({ error: "Database error" });
        }
        console.log(`[Server] Registered user ${userId}`);
        ack({ status: "registered", userId, registeredAt });
      }
    );
  });

  socket.on("identify", (userId) => {
    const id = String(userId);
    socket.userId = id;
    activeUsers.set(id, socket); // Save this socket in our activeUsers map.
    console.log(`[Server] User ${id} identified and online.`);
    // Deliver queued messages if any.
    if (messageQueues.has(id)) {
      const queuedMessages = messageQueues.get(id);
      queuedMessages.forEach((msg) => socket.emit("message", msg));
      messageQueues.delete(id);
      console.log(`[Server] Delivered queued messages to user ${id}`);
    }
  });

  socket.on("message", (data) => {
    const senderId = String(data.sender_user_id);
    const recipientId = String(data.recipient_user_id);
    const content = data.content;
    const timestamp = data.timestamp;
    // Determine the message type based on data.image.
    const messageType = data.image ? "image" : "text";

    const stmt = db.prepare(
      `INSERT INTO messages (sender_user_id, recipient_user_id, content, timestamp, message_type)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(senderId, recipientId, content, timestamp, messageType, function (err) {
      if (err) {
        console.error("[Server] Error saving message:", err.message);
      } else {
        console.log(`[Server] Message saved with id ${this.lastID}`);
      }
    });
    stmt.finalize();

    // Deliver message if recipient is online.
    const recipientSocket = activeUsers.get(recipientId);
    if (recipientSocket && recipientSocket.connected) {
      // For live messages, the data sent from the client already includes data.image if applicable.
      recipientSocket.emit("message", data);
      console.log(`[Server] Delivered message to online user ${recipientId}`);
    } else {
      console.log(`[Server] User ${recipientId} is not online. Queueing message.`);
      if (!messageQueues.has(recipientId)) {
        messageQueues.set(recipientId, []);
      }
      messageQueues.get(recipientId).push(data);
    }
  });

  socket.on("fetch_history", (data) => {
    const senderId = String(data.sender_user_id);
    const friendId = String(data.friend_user_id);
    const requestId = data.requestId;
    const fullHistory = data.fullHistory === true;

    console.log(
      `[Server] Received fetch_history request from ${senderId} for conversation with ${friendId} (requestId: ${requestId}) - fullHistory: ${fullHistory}`
    );

    if (fullHistory) {
      const query = `
        SELECT * FROM messages
        WHERE (sender_user_id = ? AND recipient_user_id = ?)
           OR (sender_user_id = ? AND recipient_user_id = ?)
        ORDER BY timestamp ASC
      `;
      db.all(query, [senderId, friendId, friendId, senderId], (err, rows) => {
        if (err) {
          console.error("[Server] Error fetching history:", err.message);
          socket.emit("history", { friend_user_id: friendId, history: [], requestId, fullHistory, totalMessages: 0 });
        } else {
          // Add an "image" property to each row if message_type is 'image'
          rows = rows.map(row => {
            row.image = (row.message_type === "image");
            return row;
          });
          socket.emit("history", { friend_user_id: friendId, history: rows, requestId, fullHistory, totalMessages: rows.length });
        }
      });
    } else {
      const countQuery = `
        SELECT COUNT(*) as count FROM messages
        WHERE (sender_user_id = ? AND recipient_user_id = ?)
           OR (sender_user_id = ? AND recipient_user_id = ?)
      `;
      db.get(countQuery, [senderId, friendId, friendId, senderId], (err, countRow) => {
        if (err) {
          console.error("[Server] Error fetching history count:", err.message);
          socket.emit("history", { friend_user_id: friendId, history: [], requestId, fullHistory, totalMessages: 0 });
        } else {
          const totalMessages = countRow.count;
          const query = `
            SELECT * FROM (
              SELECT * FROM messages
              WHERE (sender_user_id = ? AND recipient_user_id = ?)
                 OR (sender_user_id = ? AND recipient_user_id = ?)
              ORDER BY timestamp DESC LIMIT 10
            ) sub
            ORDER BY timestamp ASC
          `;
          db.all(query, [senderId, friendId, friendId, senderId], (err, rows) => {
            if (err) {
              console.error("[Server] Error fetching history:", err.message);
              socket.emit("history", { friend_user_id: friendId, history: [], requestId, fullHistory, totalMessages });
            } else {
              // Add an "image" property to each row if message_type is 'image'
              rows = rows.map(row => {
                row.image = (row.message_type === "image");
                return row;
              });
              socket.emit("history", { friend_user_id: friendId, history: rows, requestId, fullHistory, totalMessages });
            }
          });
        }
      });
    }
  });

  socket.on("get_registered_friends", (data, ack) => {
    if (!data.friendIds || !Array.isArray(data.friendIds)) {
      return ack({ error: "Invalid friendIds" });
    }
    const friendIds = data.friendIds.map(id => String(id));
    const placeholders = friendIds.map(() => "?").join(",");
    const query = `SELECT user_id FROM registered_users WHERE user_id IN (${placeholders})`;
    db.all(query, friendIds, (err, rows) => {
      if (err) {
        console.error("Error fetching registered friends:", err.message);
        return ack({ error: "Database error" });
      }
      const registeredFriendIds = rows.map(row => row.user_id);
      ack({ registeredFriendIds });
    });
  });

  socket.on("typing", (data) => {
    const { sender_user_id, recipient_user_id } = data;
    const recipientSocket = activeUsers.get(String(recipient_user_id));
    if (recipientSocket) {
      recipientSocket.emit("typing", { sender_user_id });
    }
  });

  socket.on("disconnect", () => {
    if (socket.userId) {
      console.log(`[Server] User ${socket.userId} disconnected.`);
      activeUsers.delete(socket.userId);
    }
  });
});

server.listen(8080, () => {
  console.log("[Server] Socket.IO server running on port 8080");
});
console.log("Server initialization complete.");
