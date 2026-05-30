const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { Client } = require('discord.js-selfbot-v13');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Create public directory if it doesn't exist
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

// Load or create configuration
let config = {
  tokens: [],
  guildId: "",
  channelId: "",
  settings: {
    selfMute: true,
    selfDeaf: true,
    autoReconnect: true,
    delayMin: 2000,
    delayMax: 6000,
    customStatus: "AFK Voice 🎧",
    customStatusType: "LISTENING",
    webPort: 3000
  }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      config = JSON.parse(raw);
    } else {
      saveConfig();
    }
  } catch (err) {
    console.error('Error loading config.json:', err);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving config.json:', err);
  }
}

loadConfig();

// App and Servers setup
const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Active selfbots pool
// Key: full token
// Value: { client, status, username, avatar, userId, reconnectTimer }
const clientPool = new Map();

// Helper to mask tokens for security in WebSocket/API logs
function maskToken(token) {
  if (!token || token.length < 15) return 'invalid_token';
  return `${token.substring(0, 6)}...${token.substring(token.length - 6)}`;
}

// WebSocket broadcast helper
function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(wsClient => {
    if (wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(payload);
    }
  });
}

// System logging helper
const logsBuffer = [];
const MAX_LOGS = 100;

function log(level, message, tokenMask = 'SYSTEM') {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = { timestamp, level, message, tokenMask };
  
  // Format console output with simple terminal styling
  let color = '\x1b[37m'; // White
  if (level === 'success') color = '\x1b[32m'; // Green
  if (level === 'warn') color = '\x1b[33m'; // Yellow
  if (level === 'error') color = '\x1b[31m'; // Red
  if (level === 'info') color = '\x1b[36m'; // Cyan
  
  console.log(`${color}[${timestamp}] [${level.toUpperCase()}] [${tokenMask}] ${message}\x1b[0m`);
  
  logsBuffer.push(logEntry);
  if (logsBuffer.length > MAX_LOGS) {
    logsBuffer.shift();
  }
  
  broadcast({ type: 'log', data: logEntry });
}

// Library voice join helper
async function joinVoiceChannel(client, guildId, channelId, mute, deaf) {
  if (!client || !client.ws || client.ws.status !== 0) return false;
  try {
    // Check if we are already in the target channel to avoid redundant handshakes
    const me = client.guilds.cache.get(guildId)?.me;
    if (me && me.voice && me.voice.channelId === channelId) {
      return true;
    }

    await client.voice.joinChannel(channelId, {
      selfMute: !!mute,
      selfDeaf: !!deaf,
      video: false
    });
    return true;
  } catch (err) {
    console.error(`[${client.user ? client.user.username : 'CLIENT'}] Error joining voice:`, err);
    return false;
  }
}

// Library voice leave helper
function leaveVoiceChannel(client, guildId) {
  if (!client || !client.voice) return;
  try {
    const connection = client.voice.connections.get(guildId);
    if (connection) {
      connection.disconnect();
    } else {
      client.voice.connections.forEach(conn => conn.disconnect());
    }
  } catch (err) {
    console.error('Error leaving voice channel:', err);
  }
}

// Start a single selfbot client
async function startClient(tokenObj) {
  const token = tokenObj.token;
  const tokenMask = maskToken(token);
  
  // Check if already running
  if (clientPool.has(token)) {
    const existing = clientPool.get(token);
    if (existing.status !== 'Disconnected') {
      log('info', 'Client is already active or connecting.', tokenMask);
      return;
    }
  }

  log('info', 'Initializing connection...', tokenMask);
  
  const client = new Client({
    checkUpdate: false,
  });

  const poolEntry = {
    client,
    status: 'Connecting',
    username: tokenObj.label || 'Discord User',
    avatar: '',
    userId: '',
    reconnectTimer: null
  };
  
  clientPool.set(token, poolEntry);
  broadcastStatusUpdate(token, poolEntry);

  // Setup Event Listeners
  client.on('ready', async () => {
    poolEntry.status = 'Online';
    poolEntry.username = client.user.username;
    poolEntry.avatar = client.user.avatarURL() || `https://cdn.discordapp.com/embed/avatars/${parseInt(client.user.discriminator) % 5}.png`;
    poolEntry.userId = client.user.id;
    
    log('success', `Logged in as ${client.user.tag} (${client.user.id})`, tokenMask);
    
    // Set Custom Status
    try {
      if (config.settings.customStatus) {
        client.user.setPresence({
          activities: [{
            name: "CustomStatus",
            type: "CUSTOM",
            state: config.settings.customStatus
          }],
          status: 'online'
        });
      }
    } catch (err) {
      log('warn', `Could not set custom presence: ${err.message}`, tokenMask);
    }
    
    // Join voice if config has target
    if (config.guildId && config.channelId) {
      log('info', `Attempting to join voice channel ${config.channelId} in guild ${config.guildId}...`, tokenMask);
      const ok = await joinVoiceChannel(client, config.guildId, config.channelId, config.settings.selfMute, config.settings.selfDeaf);
      if (ok) {
        poolEntry.status = 'In Voice';
        log('success', `Sent request to join voice channel!`, tokenMask);
      }
    }
    
    broadcastStatusUpdate(token, poolEntry);
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.member && newState.member.id === client.user.id) {
      const channelId = newState.channelId;
      if (channelId) {
        if (channelId === config.channelId) {
          poolEntry.status = 'In Voice';
          log('success', `Successfully connected to target Voice Channel!`, tokenMask);
        } else {
          poolEntry.status = 'Online';
          log('info', `Moved to voice channel: ${channelId}`, tokenMask);
        }
      } else {
        poolEntry.status = 'Online';
        log('warn', `Disconnected from voice channel.`, tokenMask);
        
        // Auto rejoin trigger
        if (config.guildId && config.channelId) {
          log('info', `Auto-rejoining voice in 5 seconds...`, tokenMask);
          setTimeout(async () => {
            if (poolEntry.status === 'Online' && config.guildId && config.channelId) {
              await joinVoiceChannel(client, config.guildId, config.channelId, config.settings.selfMute, config.settings.selfDeaf);
            }
          }, 5000);
        }
      }
      broadcastStatusUpdate(token, poolEntry);
    }
  });

  client.on('error', (err) => {
    log('error', `Connection error: ${err.message}`, tokenMask);
  });

  client.on('disconnect', () => {
    poolEntry.status = 'Disconnected';
    log('warn', 'Disconnected from Discord Gateway.', tokenMask);
    broadcastStatusUpdate(token, poolEntry);
    
    if (config.settings.autoReconnect) {
      triggerReconnect(tokenObj);
    }
  });

  // Attempt standard login
  try {
    await client.login(token);
  } catch (err) {
    poolEntry.status = 'Disconnected';
    log('error', `Login failed: ${err.message}`, tokenMask);
    broadcastStatusUpdate(token, poolEntry);
    
    if (config.settings.autoReconnect) {
      triggerReconnect(tokenObj);
    }
  }
}

// Stop a single selfbot client
function stopClient(token) {
  const tokenMask = maskToken(token);
  const item = clientPool.get(token);
  if (!item) return;

  if (item.reconnectTimer) {
    clearTimeout(item.reconnectTimer);
    item.reconnectTimer = null;
  }

  log('info', 'Stopping client connection...', tokenMask);

  try {
    if (config.guildId) {
      leaveVoiceChannel(item.client, config.guildId);
    }
    item.client.destroy();
  } catch (err) {
    log('warn', `Error during clean disconnect: ${err.message}`, tokenMask);
  }

  item.status = 'Disconnected';
  broadcastStatusUpdate(token, item);
  log('info', 'Client stopped successfully.', tokenMask);
}

// Reconnect logic (immediate reconnection)
function triggerReconnect(tokenObj) {
  const token = tokenObj.token;
  const tokenMask = maskToken(token);
  const item = clientPool.get(token);
  if (!item) return;

  if (item.reconnectTimer) return; // Reconnect already scheduled

  log('info', `Scheduling immediate reconnection...`, tokenMask);
  
  item.reconnectTimer = setTimeout(() => {
    item.reconnectTimer = null;
    startClient(tokenObj);
  }, 50);
}

// Broadcast client status utility
function broadcastStatusUpdate(token, poolEntry) {
  broadcast({
    type: 'status',
    data: {
      tokenMask: maskToken(token),
      status: poolEntry.status,
      username: poolEntry.username,
      avatar: poolEntry.avatar,
      userId: poolEntry.userId
    }
  });
}

// Periodic session keeper loop
// Re-applies the voice connection state every 15s to keep websocket AFK session alive
setInterval(() => {
  if (!config.guildId || !config.channelId) return;
  
  clientPool.forEach(async (item, token) => {
    if (item.status === 'Online' || item.status === 'In Voice') {
      const ok = await joinVoiceChannel(item.client, config.guildId, config.channelId, config.settings.selfMute, config.settings.selfDeaf);
      if (ok && item.status !== 'In Voice') {
        item.status = 'In Voice';
        broadcastStatusUpdate(token, item);
      }
    }
  });
}, 15000);

// API Endpoints
// Get full application state (without exposing raw tokens)
app.get('/api/state', (req, res) => {
  const tokenList = config.tokens.map(t => {
    const active = clientPool.get(t.token);
    return {
      tokenMask: maskToken(t.token),
      label: t.label,
      enabled: t.enabled,
      status: active ? active.status : 'Disconnected',
      username: active ? active.username : t.label,
      avatar: active ? active.avatar : '',
      userId: active ? active.userId : ''
    };
  });

  res.json({
    config: {
      guildId: config.guildId,
      channelId: config.channelId,
      settings: config.settings
    },
    tokens: tokenList,
    logs: logsBuffer
  });
});

// Update global config
app.post('/api/config', (req, res) => {
  const { guildId, channelId, settings } = req.body;
  
  if (guildId !== undefined) config.guildId = guildId.trim();
  if (channelId !== undefined) config.channelId = channelId.trim();
  if (settings) {
    config.settings = { ...config.settings, ...settings };
  }

  saveConfig();
  log('success', 'Global configuration updated.');
  
  // Re-apply voice channel to active clients if changed
  if (config.guildId && config.channelId) {
    clientPool.forEach(async (item, token) => {
      if (item.status === 'Online' || item.status === 'In Voice') {
        log('info', `Updating voice channel targets...`, maskToken(token));
        await joinVoiceChannel(item.client, config.guildId, config.channelId, config.settings.selfMute, config.settings.selfDeaf);
      }
    });
  }

  res.json({ success: true, config });
});

// Add a token
app.post('/api/tokens', (req, res) => {
  const { token, label } = req.body;
  if (!token || token.trim().length < 15) {
    return res.status(400).json({ error: 'Invalid token format' });
  }

  const cleanToken = token.trim();
  const cleanLabel = (label || '').trim() || `User_${config.tokens.length + 1}`;
  
  // Check duplicate
  if (config.tokens.some(t => t.token === cleanToken)) {
    return res.status(400).json({ error: 'Token already exists' });
  }

  const tokenObj = { token: cleanToken, label: cleanLabel, enabled: true };
  config.tokens.push(tokenObj);
  saveConfig();

  log('success', `Added new token: ${cleanLabel} (${maskToken(cleanToken)})`);
  
  res.json({
    success: true,
    token: {
      tokenMask: maskToken(cleanToken),
      label: cleanLabel,
      enabled: true,
      status: 'Disconnected'
    }
  });
});

// Delete a token
app.delete('/api/tokens/:mask', (req, res) => {
  const mask = req.params.mask;
  const tokenIdx = config.tokens.findIndex(t => maskToken(t.token) === mask);
  
  if (tokenIdx === -1) {
    return res.status(404).json({ error: 'Token not found' });
  }

  const tokenObj = config.tokens[tokenIdx];
  
  // Stop if active
  if (clientPool.has(tokenObj.token)) {
    stopClient(tokenObj.token);
    clientPool.delete(tokenObj.token);
  }

  config.tokens.splice(tokenIdx, 1);
  saveConfig();

  log('success', `Deleted token: ${tokenObj.label} (${mask})`);
  res.json({ success: true });
});

// Control API: Start specific token
app.post('/api/control/start', async (req, res) => {
  const { mask } = req.body;
  const tokenObj = config.tokens.find(t => maskToken(t.token) === mask);
  
  if (!tokenObj) {
    return res.status(404).json({ error: 'Token not found' });
  }

  res.json({ success: true });
  await startClient(tokenObj);
});

// Control API: Stop specific token
app.post('/api/control/stop', (req, res) => {
  const { mask } = req.body;
  const tokenObj = config.tokens.find(t => maskToken(t.token) === mask);
  
  if (!tokenObj) {
    return res.status(404).json({ error: 'Token not found' });
  }

  stopClient(tokenObj.token);
  res.json({ success: true });
});

// Control API: Start All
app.post('/api/control/start-all', async (req, res) => {
  res.json({ success: true });
  log('info', `Starting all tokens immediately and simultaneously.`);
  
  for (const tokenObj of config.tokens) {
    // Check if already active
    const active = clientPool.get(tokenObj.token);
    if (active && active.status !== 'Disconnected') continue;

    startClient(tokenObj);
  }
});

// Control API: Stop All
app.post('/api/control/stop-all', (req, res) => {
  log('info', 'Stopping all active accounts...');
  config.tokens.forEach(t => {
    if (clientPool.has(t.token)) {
      stopClient(t.token);
    }
  });
  res.json({ success: true });
});

// WebSocket Connection Handler
wss.on('connection', ws => {
  log('info', 'UI Client connected to monitoring panel.');
  
  // Send current state on connection
  const tokenList = config.tokens.map(t => {
    const active = clientPool.get(t.token);
    return {
      tokenMask: maskToken(t.token),
      label: t.label,
      enabled: t.enabled,
      status: active ? active.status : 'Disconnected',
      username: active ? active.username : t.label,
      avatar: active ? active.avatar : '',
      userId: active ? active.userId : ''
    };
  });

  ws.send(JSON.stringify({
    type: 'sync',
    data: {
      config: {
        guildId: config.guildId,
        channelId: config.channelId,
        settings: config.settings
      },
      tokens: tokenList,
      logs: logsBuffer
    }
  }));

  ws.on('close', () => {
    console.log('UI Client disconnected from monitoring panel.');
  });
});

// Start Web Server
const PORT = config.settings.webPort || 3000;
server.listen(PORT, '0.0.0.0', () => {
  log('success', `AFK Token Dashboard is running at http://localhost:${PORT}`);
  log('info', `Open this address in your browser or point your VPS public IP to port ${PORT} to manage your bots.`);
});
