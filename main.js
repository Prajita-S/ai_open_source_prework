(function () {
  const canvas = document.getElementById('world-canvas');
  const context = canvas.getContext('2d');

  const worldImage = new Image();
  worldImage.src = 'world.jpg';

  let worldLoaded = false;

  // View/camera state
  let devicePixelRatioCached = Math.max(window.devicePixelRatio || 1, 1);
  let viewportCssWidth = 0;
  let viewportCssHeight = 0;
  let cameraX = 0;
  let cameraY = 0;

  // Game state (subset for this milestone)
  const SERVER_URL = 'wss://codepath-mmorg.onrender.com';
  const USERNAME = 'Prajita';
  let socket = null;
  let myPlayerId = null;
  let playersById = {}; // server-shaped data
  let avatarsByName = {}; // raw frames as data URLs from server
  let avatarImagesCache = {}; // { avatarName: { north: Image[], south: Image[], east: Image[] } }
  const AVATAR_SCALE = 1.5; // make avatar a little bigger while preserving aspect ratio

  // Render scheduling
  let needsRedraw = true;
  const downKeys = new Set();
  const keyToDir = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right'
  };

  // Jump state (client-side visual only)
  let isJumping = false;
  let jumpStartMs = 0;
  let jumpOffsetPx = 0;
  const JUMP_DURATION_MS = 600;
  const JUMP_HEIGHT_PX = 28; // vertical lift in pixels

  function updateJumpOffset(nowMs) {
    if (!isJumping) { jumpOffsetPx = 0; return; }
    const t = (nowMs - jumpStartMs) / JUMP_DURATION_MS;
    if (t >= 1) { isJumping = false; jumpOffsetPx = 0; return; }
    // Smooth arc using sine: 0 -> pi
    jumpOffsetPx = Math.round(Math.sin(t * Math.PI) * JUMP_HEIGHT_PX);
  }

  function resizeCanvasToWindow() {
    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    devicePixelRatioCached = dpr;

    // Set canvas CSS size to viewport
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';

    // Match internal pixel buffer to CSS size * DPR for crisp rendering
    viewportCssWidth = Math.floor(window.innerWidth);
    viewportCssHeight = Math.floor(window.innerHeight);
    canvas.width = Math.max(1, Math.floor(viewportCssWidth * dpr));
    canvas.height = Math.max(1, Math.floor(viewportCssHeight * dpr));

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.scale(dpr, dpr);

    updateCameraToCenterMyAvatar();
    scheduleRedraw();
  }

  function scheduleRedraw() {
    needsRedraw = true;
  }

  function clearCanvas() {
    context.clearRect(0, 0, viewportCssWidth, viewportCssHeight);
  }

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function updateCameraToCenterMyAvatar() {
    if (!worldLoaded) return;
    if (!myPlayerId || !playersById[myPlayerId]) return;
    const me = playersById[myPlayerId];
    const mapWidth = worldImage.width;
    const mapHeight = worldImage.height;

    const halfW = Math.floor(viewportCssWidth / 2);
    const halfH = Math.floor(viewportCssHeight / 2);
    let desiredCameraX = Math.floor(me.x - halfW);
    let desiredCameraY = Math.floor(me.y - halfH);

    const maxCamX = Math.max(0, mapWidth - viewportCssWidth);
    const maxCamY = Math.max(0, mapHeight - viewportCssHeight);
    cameraX = clamp(desiredCameraX, 0, maxCamX);
    cameraY = clamp(desiredCameraY, 0, maxCamY);
  }

  function getMyAvatarFrameImage() {
    if (!myPlayerId) return null;
    const me = playersById[myPlayerId];
    if (!me) return null;
    const avatarName = me.avatar;
    const facing = me.facing || 'south';
    const frameIndex = me.animationFrame || 0;
    const cache = avatarImagesCache[avatarName];
    if (!cache) return null;
    if (facing === 'west') {
      // We'll draw by flipping the east frame at render time
      const eastFrames = cache.east || [];
      return { image: eastFrames[frameIndex % eastFrames.length] || null, flipX: true };
    }
    const frames = cache[facing] || [];
    return { image: frames[frameIndex % frames.length] || null, flipX: false };
  }

  function drawWorld() {
    // Draw visible portion of the world to fill the viewport, no scaling (1:1)
    const sx = cameraX;
    const sy = cameraY;
    const sw = Math.min(viewportCssWidth, worldImage.width - sx);
    const sh = Math.min(viewportCssHeight, worldImage.height - sy);
    if (sw > 0 && sh > 0) {
      context.drawImage(worldImage, sx, sy, sw, sh, 0, 0, sw, sh);
    }
  }

  function getAvatarFrameImageFor(player) {
    if (!player) return null;
    const avatarName = player.avatar;
    const facing = player.facing || 'south';
    const frameIndex = player.animationFrame || 0;
    const cache = avatarImagesCache[avatarName];
    if (!cache) return null;
    if (facing === 'west') {
      const eastFrames = cache.east || [];
      return { image: eastFrames.length ? eastFrames[frameIndex % eastFrames.length] : null, flipX: true };
    }
    const frames = cache[facing] || [];
    return { image: frames.length ? frames[frameIndex % frames.length] : null, flipX: false };
  }

  function drawPlayer(player) {
    const screenX = Math.floor(player.x - cameraX);
    let screenY = Math.floor(player.y - cameraY);
    // Apply jump lift to my avatar only
    if (player.id === myPlayerId && jumpOffsetPx > 0) {
      screenY -= jumpOffsetPx;
    }

    const frame = getAvatarFrameImageFor(player);
    if (frame && frame.image) {
      const img = frame.image;
      const drawWidth = Math.max(1, Math.round(img.width * AVATAR_SCALE));
      const drawHeight = Math.max(1, Math.round(img.height * AVATAR_SCALE));

      // Off-screen culling
      const left = Math.floor(screenX - drawWidth / 2);
      const top = Math.floor(screenY - drawHeight + 4);
      if (left > viewportCssWidth || top > viewportCssHeight || left + drawWidth < 0 || top + drawHeight < 0) {
        return;
      }

      if (player.id === myPlayerId && jumpOffsetPx > 0) {
        // Simple shadow under the avatar when jumping
        const shadowY = Math.floor(player.y - cameraY + 2);
        const shadowW = Math.floor(drawWidth * 0.5);
        const shadowH = Math.max(3, Math.floor(drawHeight * 0.12));
        context.save();
        context.globalAlpha = 0.25;
        context.fillStyle = '#000';
        context.beginPath();
        context.ellipse(screenX, shadowY, Math.floor(shadowW / 2), Math.floor(shadowH / 2), 0, 0, Math.PI * 2);
        context.fill();
        context.restore();
      }

      if (frame.flipX) {
        context.save();
        context.translate(screenX, 0);
        context.scale(-1, 1);
        context.drawImage(img, Math.floor(-drawWidth / 2), top, drawWidth, drawHeight);
        context.restore();
      } else {
        context.drawImage(img, left, top, drawWidth, drawHeight);
      }
    }

    const label = player.username || (player.id === myPlayerId ? 'Prajita' : '');
    if (label) {
      context.font = '14px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'bottom';
      context.lineWidth = 3;
      context.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      context.strokeText(label, screenX, Math.floor(screenY - 10));
      context.fillStyle = '#fff';
      context.fillText(label, screenX, Math.floor(screenY - 10));
    }
  }

  function drawAllPlayers() {
    const list = Object.values(playersById);
    list.sort(function (a, b) { return a.y - b.y; });
    for (let i = 0; i < list.length; i++) {
      drawPlayer(list[i]);
    }
  }

  function drawMyAvatarAndLabel() {
    if (!myPlayerId || !playersById[myPlayerId]) return;
    const me = playersById[myPlayerId];
    const screenX = Math.floor(me.x - cameraX);
    const screenY = Math.floor(me.y - cameraY);

    const frame = getMyAvatarFrameImage();
    if (frame && frame.image) {
      const img = frame.image;
      const drawWidth = Math.max(1, Math.round(img.width * AVATAR_SCALE));
      const drawHeight = Math.max(1, Math.round(img.height * AVATAR_SCALE));
      const drawX = Math.floor(screenX - drawWidth / 2);
      const drawY = Math.floor(screenY - drawHeight + 4); // position feet at y

      if (frame.flipX) {
        context.save();
        context.translate(screenX, 0);
        context.scale(-1, 1);
        // Draw image centered via negative half width after flip, with scaling
        context.drawImage(img, Math.floor(-drawWidth / 2), drawY, drawWidth, drawHeight);
        context.restore();
      } else {
        context.drawImage(img, drawX, drawY, drawWidth, drawHeight);
      }
    }

    // Username label
    const label = 'Prajita';
    context.font = '14px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'bottom';
    // Outline for readability
    context.lineWidth = 3;
    context.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    context.strokeText(label, screenX, Math.floor(screenY - 10));
    context.fillStyle = '#fff';
    context.fillText(label, screenX, Math.floor(screenY - 10));
  }

  function draw() {
    if (!needsRedraw) return;
    needsRedraw = false;

    clearCanvas();
    if (!worldLoaded) return;

    // Update jump animation and ensure redraw continues while jumping
    const now = performance.now();
    updateJumpOffset(now);
    if (isJumping) { needsRedraw = true; }

    drawWorld();
    drawAllPlayers();
  }

  function loop() {
    draw();
    requestAnimationFrame(loop);
  }

  function connectWebSocket() {
    try {
      socket = new WebSocket(SERVER_URL);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('WebSocket init error', err);
      return;
    }

    socket.addEventListener('open', function () {
      const msg = { action: 'join_game', username: USERNAME };
      socket.send(JSON.stringify(msg));
    });

    socket.addEventListener('message', function (event) {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      if (data.action === 'join_game' && data.success) {
        myPlayerId = data.playerId;
        playersById = data.players || {};
        avatarsByName = data.avatars || {};
        prepareAvatarImageCache(avatarsByName).then(function () {
          updateCameraToCenterMyAvatar();
          scheduleRedraw();
        });
        return;
      }

      if (data.action === 'players_moved' && data.players) {
        // Merge updates
        for (const pid in data.players) {
          if (!Object.prototype.hasOwnProperty.call(data.players, pid)) continue;
          playersById[pid] = { ...(playersById[pid] || {}), ...data.players[pid] };
        }
        if (myPlayerId && data.players[myPlayerId]) {
          updateCameraToCenterMyAvatar();
        }
        scheduleRedraw();
        return;
      }

      if (data.action === 'player_joined' && data.player) {
        playersById[data.player.id] = data.player;
        if (data.avatar) {
          // Cache any new avatar provided
          prepareAvatarImageCache({ [data.avatar.name]: data.avatar }).then(scheduleRedraw);
        } else {
          scheduleRedraw();
        }
        return;
      }

      if (data.action === 'player_left' && data.playerId) {
        delete playersById[data.playerId];
        scheduleRedraw();
      }

      if (data.success === false) {
        // eslint-disable-next-line no-console
        console.warn('Server error for action', data.action, data.error);
      }
    });

    socket.addEventListener('close', function () {
      // eslint-disable-next-line no-console
      console.warn('WebSocket closed');
    });

    socket.addEventListener('error', function (e) {
      // eslint-disable-next-line no-console
      console.error('WebSocket error', e);
    });
  }

  function sendMove(direction) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ action: 'move', direction: direction }));
    } catch (_) {}
  }

  function sendStop() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ action: 'stop' }));
    } catch (_) {}
  }

  function onKeyDown(e) {
    const dir = keyToDir[e.key];
    if (!dir) {
      // Space to jump (client-side only visual)
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (!isJumping) {
          isJumping = true;
          jumpStartMs = performance.now();
          scheduleRedraw();
        }
      }
      return;
    }
    // Prevent scrolling the page with arrow keys
    e.preventDefault();
    // Ignore auto-repeats; send one move per keydown
    if (e.repeat) return;
    downKeys.add(dir);
    sendMove(dir);
  }

  function onKeyUp(e) {
    const dir = keyToDir[e.key];
    if (!dir) {
      // Also prevent Space default on keyup to avoid page scroll
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
      }
      return;
    }
    e.preventDefault();
    downKeys.delete(dir);
    if (downKeys.size === 0) {
      sendStop();
    } else {
      // Prefer the most recently pressed that is still held: take the last added
      // Since Set iteration preserves insertion order, reconstruct to get the last
      let last = null;
      downKeys.forEach(function (d) { last = d; });
      if (last) sendMove(last);
    }
  }

  function onKeyPress(e) {
    // Some browsers may also trigger default scrolling on keypress
    if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
    }
  }

  function prepareAvatarImageCache(avatars) {
    // avatars: { name: { frames: { north: [url...], south: [...], east: [...] } } }
    const promises = [];
    for (const name in avatars) {
      if (!Object.prototype.hasOwnProperty.call(avatars, name)) continue;
      const avatar = avatars[name];
      if (!avatar || !avatar.frames) continue;
      if (!avatarImagesCache[name]) avatarImagesCache[name] = { north: [], south: [], east: [] };

      ['north', 'south', 'east'].forEach(function (dir) {
        const list = avatar.frames[dir] || [];
        const cacheList = avatarImagesCache[name][dir];
        for (let i = 0; i < list.length; i++) {
          const url = list[i];
          if (cacheList[i]) continue;
          const img = new Image();
          const p = new Promise(function (resolve) {
            img.onload = resolve;
            img.onerror = resolve; // tolerate failures
          });
          img.src = url;
          cacheList[i] = img;
          promises.push(p);
        }
      });
    }
    return Promise.all(promises);
  }

  worldImage.onload = function () {
    worldLoaded = true;
    updateCameraToCenterMyAvatar();
    scheduleRedraw();
  };

  window.addEventListener('resize', resizeCanvasToWindow);
  window.addEventListener('orientationchange', resizeCanvasToWindow);

  // Initialize
  resizeCanvasToWindow();
  connectWebSocket();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('keypress', onKeyPress);
  loop();
})();


