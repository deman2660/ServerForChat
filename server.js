// server.js
const fs = require("fs");                // <-- Added for SSL cert reading
const https = require("https");          // <-- Replaces 'http' for HTTPS
const express = require("express");
const socketIo = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
app.use(express.json());

// ---------------------
// SSL CERTIFICATE OPTIONS
// ---------------------
// Adjust the file paths for your actual SSL certificate and key.
const options = {
  key: fs.readFileSync("/etc/letsencrypt/live/robloxchatenhance.duckdns.org/privkey.pem"),
  cert: fs.readFileSync("/etc/letsencrypt/live/robloxchatenhance.duckdns.org/fullchain.pem"),
};

// ---------------------
// CREATE HTTPS SERVER (replaces the plain HTTP server)
// ---------------------
const server = https.createServer(options, app);

const io = socketIo(server, {
  cors: {
    origin: [
      "chrome-extension://gbibdfkjimflbogckcbmncoehfdonleh",
      "https://www.roblox.com"
    ]
  }
});

// In-memory storage for connected users.
const activeUsers = new Map();
// (We still have a small in-memory messageQueues map if needed.)
const messageQueues = new Map();

// ---------------------
// DATABASE SETUP
// ---------------------

// Create the messages table if it doesn't exist.
// Added a new column "pending" (default 1) to mark messages that are not yet delivered.
dbInit();

function dbInit() {
  const db = new sqlite3.Database("chat.db", (err) => {
    if (err) {
      console.error("Error opening database:", err.message);
    } else {
      console.log("Connected to the SQLite database.");
    }
  });
  
  db.run(
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_user_id TEXT,
      recipient_user_id TEXT,
      content TEXT,
      timestamp TEXT,
      message_type TEXT DEFAULT 'text',
      pending INTEGER DEFAULT 1
    )`,
    (err) => {
      if (err) {
        console.error("Error creating messages table:", err.message);
      } else {
        console.log("Messages table ready.");
      }
    }
  );
  
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
  
  // Expose the db connection globally for this file.
  module.exports.db = db;
}
const db = module.exports.db; // Use the same DB instance throughout

// ---------------------
// SOCKET.IO EVENT HANDLERS
// ---------------------

io.on("connection", (socket) => {
  console.log("[Server] New Socket.IO connection established.");

  socket.on("register", (data, ack) => {
    const userId = String(data.userId);
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
    activeUsers.set(id, socket);
    console.log(`[Server] User ${id} identified and online.`);
    
    // Query for any offline (pending) messages for this user.
    db.all(
      `SELECT * FROM messages WHERE recipient_user_id = ? AND pending = 1 ORDER BY timestamp ASC`,
      [id],
      (err, rows) => {
        if (err) {
          console.error("[Server] Error fetching pending messages for", id, ":", err.message);
        } else if (rows && rows.length) {
          rows.forEach((msg) => {
            socket.emit("message", msg);
            console.log(`[Server] Delivered pending message (id: ${msg.id}) to user ${id}`);
            // Mark the message as delivered.
            db.run(
              `UPDATE messages SET pending = 0 WHERE id = ?`,
              [msg.id],
              (err) => {
                if (err) {
                  console.error(`[Server] Error updating message id ${msg.id}:`, err.message);
                }
              }
            );
          });
        }
      }
    );
    
    // Also deliver any in-memory queued messages (if used)
    if (messageQueues.has(id)) {
      const queuedMessages = messageQueues.get(id);
      queuedMessages.forEach((msg) => socket.emit("message", msg));
      messageQueues.delete(id);
      console.log(`[Server] Delivered queued messages to user ${id}`);
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

  socket.on("message", (data) => {
    const senderId = String(data.sender_user_id);
    const recipientId = String(data.recipient_user_id);
    const content = data.content;
    const timestamp = data.timestamp;
    const messageType = data.image ? "image" : "text";
    
    // Insert the message into the database with pending = 1.
    const stmt = db.prepare(
      `INSERT INTO messages (sender_user_id, recipient_user_id, content, timestamp, message_type, pending)
       VALUES (?, ?, ?, ?, ?, 1)`
    );
    stmt.run(senderId, recipientId, content, timestamp, messageType, function (err) {
      if (err) {
        console.error("[Server] Error saving message:", err.message);
      } else {
        console.log(`[Server] Message saved with id ${this.lastID}`);
      }
    });
    stmt.finalize();
    
    // If the recipient is online, deliver immediately and mark as not pending.
    const recipientSocket = activeUsers.get(recipientId);
    if (recipientSocket && recipientSocket.connected) {
      recipientSocket.emit("message", data);
      console.log(`[Server] Delivered message to online user ${recipientId}`);
      db.run(
        `UPDATE messages SET pending = 0 WHERE id = (SELECT id FROM messages ORDER BY id DESC LIMIT 1)`,
        (err) => {
          if (err) console.error(`[Server] Error marking message as delivered:`, err.message);
        }
      );
    } else {
      console.log(`[Server] User ${recipientId} is not online. Message remains pending.`);
    }
  });

  // Fetch history with pagination.
  // When offset == 0, load 10 messages; otherwise, load 50 messages.
  socket.on("fetch_history", (data) => {
    const senderId = String(data.sender_user_id);
    const friendId = String(data.friend_user_id);
    const requestId = data.requestId;
    const offset = Number(data.offset) || 0;
    const limit = (offset === 0) ? 10 : 50;
    
    console.log(`[Server] Received fetch_history request from ${senderId} for conversation with ${friendId} (requestId: ${requestId}) - offset: ${offset}, limit: ${limit}`);
    
    const countQuery = `
      SELECT COUNT(*) as count FROM messages
      WHERE (sender_user_id = ? AND recipient_user_id = ?)
         OR (sender_user_id = ? AND recipient_user_id = ?)
    `;
    db.get(countQuery, [senderId, friendId, friendId, senderId], (err, countRow) => {
      if (err) {
        console.error("[Server] Error fetching history count:", err.message);
        socket.emit("history", { friend_user_id: friendId, history: [], requestId, offset, totalMessages: 0 });
      } else {
        const totalMessages = countRow.count;
        const query = `
          SELECT * FROM (
            SELECT * FROM messages
            WHERE (sender_user_id = ? AND recipient_user_id = ?)
               OR (sender_user_id = ? AND recipient_user_id = ?)
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
          ) sub
          ORDER BY timestamp ASC
        `;
        db.all(query, [senderId, friendId, friendId, senderId, limit, offset], (err, rows) => {
          if (err) {
            console.error("[Server] Error fetching history:", err.message);
            socket.emit("history", { friend_user_id: friendId, history: [], requestId, offset, totalMessages });
          } else {
            rows = rows.map(row => {
              row.image = (row.message_type === "image");
              return row;
            });
            socket.emit("history", { friend_user_id: friendId, history: rows, requestId, offset, totalMessages });
          }
        });
      }
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

// ---------------------
// CLEANUP JOB: Clear old pending notifications (older than 2 weeks)
// ---------------------
setInterval(() => {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  db.run(
    `UPDATE messages SET pending = 0 WHERE pending = 1 AND timestamp < ?`,
    [cutoff],
    (err) => {
      if (err) {
        console.error("[Server] Error cleaning up old pending messages:", err.message);
      } else {
        console.log("[Server] Old pending messages cleaned up (older than 2 weeks).");
      }
    }
  );
}, 60 * 60 * 1000); // Run every hour

server.listen(8080, () => {
  console.log("[Server] Socket.IO server running on port 8080");
});
console.log("Server initialization complete.");
