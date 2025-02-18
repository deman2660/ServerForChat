const express = require("express");
const fs = require("fs");
const https = require("https");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
app.use(express.json());

// Create an HTTPS server with SSL certificates
const server = https.createServer(
  {
    key: fs.readFileSync("/etc/letsencrypt/live/robloxchatenhance.duckdns.org/privkey.pem"),
    cert: fs.readFileSync("/etc/letsencrypt/live/robloxchatenhance.duckdns.org/fullchain.pem")
  },
  app
);

const io = new Server(server, {
  cors: {
    origin: [
      "chrome-extension://epdofibfckoofjphnlgfphfhjaapojkb",
      "https://www.roblox.com"
    ]
  }
});

const activeUsers = new Map();
const messageQueues = new Map();

function dbInit() {
  const db = new sqlite3.Database("chat.db", (err) => {
    if (err) {
      console.error("Error opening database:", err.message);
    } else {
      console.log("Connected to the SQLite database.");
      console.log("Using DB file:", path.resolve("chat.db"));
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
      registered_at TEXT,
      flex_robux INTEGER DEFAULT 0,
      show_rap INTEGER DEFAULT 0,
      pronouns TEXT DEFAULT '',
      age TEXT DEFAULT '',
      status TEXT DEFAULT '',
      robux INTEGER DEFAULT 0,
      rap INTEGER DEFAULT 0,
      banned INTEGER DEFAULT 0
    )`,
    (err) => {
      if (err) {
        console.error("Error creating registered_users table:", err.message);
      } else {
        console.log("registered_users table ready.");
      }
    }
  );
  
  // Attempt to add a 'username' column if it doesn't exist
  db.run(
    `ALTER TABLE registered_users ADD COLUMN username TEXT`,
    (err) => {
      if (err) {
        console.log("[Server] Possibly ignoring error adding 'username' column:", err.message);
      }
    }
  );
  
  // Attempt to add an 'avatar_url' column if it doesn't exist
  db.run(
    `ALTER TABLE registered_users ADD COLUMN avatar_url TEXT`,
    (err) => {
      if (err) {
        console.log("[Server] Possibly ignoring error adding 'avatar_url' column:", err.message);
      }
    }
  );
  
  module.exports.db = db;
}
dbInit();
const db = module.exports.db;

// Helper: fetch the player's username from Roblox
async function fetchUsernameFromRoblox(userId) {
  try {
    const url = `https://users.roblox.com/v1/users/${userId}`;
    console.log(`[Server] Fetching username from: ${url}`);
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`[Server] Failed fetching username for ${userId}: HTTP ${resp.status}`);
      return "UnknownUser";
    }
    const json = await resp.json();
    console.log("[Server] Roblox API returned data:", json);
    return json.name || "UnknownUser";
  } catch (err) {
    console.error("Error in fetchUsernameFromRoblox:", err);
    return "UnknownUser";
  }
}

// Helper: fetch a user's avatar URL from Roblox (server-side)
async function fetchAvatarUrlFromRobloxServer(userId) {
  try {
    const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`;
    console.log(`[Server] Fetching avatar from: ${url}`);
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`[Server] Failed fetching avatar for ${userId}: HTTP ${resp.status}`);
      return null;
    }
    const json = await resp.json();
    if (json.data && json.data[0] && json.data[0].state === "Completed") {
      return json.data[0].imageUrl;
    }
    return null;
  } catch (err) {
    console.error("Error in fetchAvatarUrlFromRobloxServer:", err);
    return null;
  }
}

io.on("connection", (socket) => {
  console.log("[Server] New Socket.IO connection established.");

  socket.on("register", async (data, ack) => {
    console.log("[DEBUG] register: Type of userId:", typeof data.userId, "and after conversion:", String(data.userId));
    const userId = String(data.userId);
    const registeredAt = new Date().toISOString();

    const username = data.username || await fetchUsernameFromRoblox(userId);
    const avatarUrl = await fetchAvatarUrlFromRobloxServer(userId);

    db.run(
      `INSERT OR REPLACE INTO registered_users (user_id, username, registered_at, avatar_url) VALUES (?, ?, ?, ?)`,
      [userId, username, registeredAt, avatarUrl],
      function (err) {
        if (err) {
          console.error("[Server] Error registering user:", err.message);
          return ack({ error: "Database error" });
        }
        console.log(`[Server] Registered user ${userId} (username: ${username})`);
        ack({ status: "registered", userId, registeredAt });
      }
    );
  });

  socket.on("identify", (userId) => {
    console.log("[DEBUG] identify: Type of userId:", typeof userId, "and after conversion:", String(userId));
    const id = String(userId);
    socket.userId = id;
    activeUsers.set(id, socket);
    console.log(`[Server] User ${id} identified and online.`);
    
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
  });

  socket.on("get_community_users", (callback) => {
    console.log("[Server] Received request for 'get_community_users' from userId:", socket.userId);
    db.all(
      `SELECT user_id, username, status, pronouns, age, flex_robux, show_rap, robux, rap 
       FROM registered_users 
       WHERE user_id != ? 
       ORDER BY registered_at DESC 
       LIMIT 50`,
      [socket.userId],
      (err, users) => {
        if (err) {
          console.error("[Server] Error fetching community users:", err);
          callback({ error: "Database error" });
        } else {
          console.log("[Server] get_community_users => found rows:", users);
          callback({ users });
        }
      }
    );
  });

  socket.on("message", (data) => {
    const senderId = String(data.sender_user_id);
    const recipientId = String(data.recipient_user_id);

    // Check if sender is banned
    db.get(
      `SELECT banned FROM registered_users WHERE user_id = ?`,
      [senderId],
      (err, row) => {
        if (err) {
          console.error("[Server] Error checking ban status for user", senderId, ":", err.message);
          return;
        }
        if (row && row.banned == 1) {
          console.log(`[Server] User ${senderId} is banned. Message will not be processed.`);
          // Optionally notify the sender:
          socket.emit("error", { message: "You are banned from sending messages." });
          return;
        }
        // Otherwise, process the message normally:
        const content = data.content;
        const timestamp = data.timestamp;
        const messageType = data.image ? "image" : "text";
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
      }
    );
  });

  socket.on("global_message", (data) => {
    const senderId = String(data.sender_user_id);
    // Check if sender is banned before broadcasting global messages
    db.get(
      `SELECT banned FROM registered_users WHERE user_id = ?`,
      [senderId],
      (err, row) => {
        if (err) {
          console.error("[Server] Error checking ban status for user", senderId, ":", err.message);
          return;
        }
        if (row && row.banned == 1) {
          console.log(`[Server] User ${senderId} is banned. Global message will not be processed.`);
          socket.emit("error", { message: "You are banned from sending global messages." });
          return;
        }
        const senderUsername = data.sender_username;
        const content = data.content;
        const timestamp = data.timestamp;
        const messageType = data.image ? "image" : "text";

        const stmt = db.prepare(
          `INSERT INTO global_messages (sender_user_id, sender_username, content, timestamp, message_type)
           VALUES (?, ?, ?, ?, ?)`
        );
        stmt.run(senderId, senderUsername, content, timestamp, messageType, function(err) {
          if (err) {
            console.error("[Server] Error saving global message:", err.message);
          } else {
            console.log(`[Server] Global message saved with id ${this.lastID}`);
            io.emit("global_message", data);
          }
        });
        stmt.finalize();
      }
    );
  });

  socket.on("fetch_global_history", (callback) => {
    console.log("[Server] fetch_global_history event from:", socket.userId);
    db.all(
      `SELECT * FROM global_messages 
       ORDER BY timestamp DESC 
       LIMIT 50`,
      (err, rows) => {
        if (err) {
          console.error("[Server] Error fetching global history:", err.message);
          callback({ error: "Database error" });
        } else {
          rows = rows.map(row => {
            row.image = (row.message_type === "image");
            return row;
          });
          callback({ messages: rows.reverse() });
        }
      }
    );
  });

  socket.on("typing", (data) => {
    console.log("[Server] typing event from:", data.sender_user_id);
    const { sender_user_id, recipient_user_id } = data;
    const recipientSocket = activeUsers.get(String(recipient_user_id));
    if (recipientSocket) {
      recipientSocket.emit("typing", { sender_user_id });
    }
  });

  socket.on("get_profile_settings", async (data, ack) => {
    const uid = String(data.userId);
    console.log("[DEBUG] get_profile_settings: Type of userId:", typeof data.userId, "and after conversion:", uid);
    console.log("[Server] get_profile_settings for user:", uid);
    if (!uid) return ack({ error: "Missing user ID" });
    try {
      db.get(
        `SELECT flex_robux, show_rap, pronouns, age, status, robux, rap 
         FROM registered_users 
         WHERE user_id = ?`,
        [uid],
        (err, settings) => {
          if (err) {
            console.error("Error fetching profile settings:", err);
            return ack({ error: "Database error" });
          }
          ack({ status: "success", settings });
        }
      );
    } catch (error) {
      console.error("Error in get_profile_settings:", error);
      ack({ error: "Server error" });
    }
  });

  socket.on("save_profile_settings", async (data, ack) => {
    const uid = String(data.userId);
    console.log("[DEBUG] save_profile_settings: Type of userId:", typeof data.userId, "and after conversion:", uid);
    console.log("[Server] save_profile_settings for user:", uid, " new data:", data.settings);
    if (!uid) return ack({ error: "Missing user ID" });

    try {
      db.run(
        `UPDATE registered_users 
         SET flex_robux = ?, show_rap = ?, pronouns = ?, age = ?, status = ? 
         WHERE user_id = ?`,
        [
          data.settings.flex_robux,
          data.settings.show_rap,
          data.settings.pronouns,
          data.settings.age,
          data.settings.status,
          uid
        ],
        function (err) {
          if (err) {
            console.error("Error saving profile settings:", err);
            return ack({ error: "Database error" });
          }
          
          console.log("[Server] save_profile_settings: rows updated =>", this.changes);
          db.get(
            `SELECT flex_robux, show_rap, pronouns, age, status
             FROM registered_users
             WHERE user_id = ?`,
            [uid],
            (err2, row) => {
              if (err2) {
                console.error("[Server] Error verifying updated row:", err2);
              } else {
                console.log("[Server] Row after update =>", row);
              }
            }
          );

          ack({ status: "success" });
          
          socket.broadcast.emit("user_profile_updated", {
            userId: uid,
            settings: data.settings
          });
        }
      );
    } catch (error) {
      console.error("Error in save_profile_settings:", error);
      ack({ error: "Server error" });
    }
  });

  socket.on("update_stats", async (data) => {
    const uid = String(data.userId);
    console.log("[DEBUG] update_stats: Type of userId:", typeof data.userId, "and after conversion:", uid);
    console.log("[Server] update_stats for user:", uid, data.robux, data.rap);
    if (!uid) return;

    try {
      db.run(
        `UPDATE registered_users 
         SET robux = ?, rap = ? 
         WHERE user_id = ?`,
        [data.robux, data.rap, uid],
        function (err) {
          if (err) {
            console.error("Error updating user stats:", err);
          } else {
            console.log("[Server] update_stats: rows updated =>", this.changes);
            db.get(
              `SELECT robux, rap FROM registered_users WHERE user_id = ?`,
              [uid],
              (err2, row) => {
                if (err2) {
                  console.error("[Server] Error verifying updated row (stats):", err2);
                } else {
                  console.log("[Server] Row after stats update =>", row);
                }
              }
            );
          }
        }
      );
    } catch (error) {
      console.error("Error in update_stats:", error);
    }
  });

  socket.on("fetch_history", (data) => {
    console.log("[Server] fetch_history event from:", data.sender_user_id, " for friend:", data.friend_user_id);
    const senderId = String(data.sender_user_id);
    const friendId = String(data.friend_user_id);
    const requestId = data.requestId;
    const offset = Number(data.offset) || 0;
    const limit = (offset === 0) ? 10 : 50;

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

  socket.on("get_registered_friends", (data, ack) => {
    console.log("[Server] get_registered_friends with friendIds:", data.friendIds);
    const friendIds = (data.friendIds || []).map(String);
    if (!friendIds.length) {
      return ack({ registeredFriendIds: [] });
    }
    const placeholders = friendIds.map(() => '?').join(',');
    db.all(
      `SELECT user_id FROM registered_users WHERE user_id IN (${placeholders})`,
      friendIds,
      (err, rows) => {
        if (err) {
          console.error("[Server] Error fetching registered friends:", err);
          return ack({ error: "Database error" });
        }
        const registeredFriendIds = rows.map(r => r.user_id);
        ack({ registeredFriendIds });
      }
    );
  });

  socket.on("disconnect", () => {
    if (socket.userId) {
      console.log(`[Server] User ${socket.userId} disconnected.`);
      activeUsers.delete(socket.userId);
    }
  });
});

// Cleanup for old pending messages
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
}, 60 * 60 * 1000);

// Cleanup for old global messages
setInterval(() => {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.run(
    `DELETE FROM global_messages WHERE timestamp < ?`,
    [cutoff],
    (err) => {
      if (err) {
        console.error("[Server] Error cleaning up old global messages:", err.message);
      } else {
        console.log("[Server] Old global messages cleaned up (older than 30 days).");
      }
    }
  );
}, 24 * 60 * 60 * 1000);

server.listen(8080, () => {
  console.log("[Server] Socket.IO server running on port 8080 (HTTPS)");
});
