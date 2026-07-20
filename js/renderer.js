// ---------------------------------------------------------------------------
// Renderer: all drawing lives here. Everything is drawn with canvas
// primitives (rectangles / paths) in an original pixel-art style, so the game
// needs no image asset files.
// ---------------------------------------------------------------------------

const Renderer = {
  canvas: null,
  ctx: null,
  sx: 1,
  sy: 1,

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.resize();
    window.addEventListener("resize", () => this.resize());
  },

  // Match the canvas backing store to its real on-screen size (times the
  // device pixel ratio) so everything is drawn crisply instead of being a
  // tiny bitmap stretched by the browser. Drawing still happens in the
  // 256x240 "world" coordinate space via a scale transform.
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.sx = this.canvas.width / CONFIG.VIEW_W;
    this.sy = this.canvas.height / CONFIG.VIEW_H;
  },

  draw(game) {
    const ctx = this.ctx;
    const cam = game.camera;
    // Reset to the scaled world transform each frame.
    ctx.setTransform(this.sx, 0, 0, this.sy, 0, 0);

    this._sky(game);

    // Title screen: only the sky is shown behind the DOM overlay.
    if (!game.level || game.mode === "title") return;

    this._background(cam, game.level);
    this._tiles(game);
    game.items.forEach((it) => this._item(ctx, it, cam));
    game.enemies.forEach((e) => this._enemy(ctx, e, cam));
    game.fireballs.forEach((f) => this._fireball(ctx, f, cam));
    this._flag(ctx, game.level, cam);
    this._player(ctx, game.player, cam);
    this._hud(ctx, game);
    this._overlays(ctx, game);
  },

  // --- Helpers --------------------------------------------------------------
  _px(x, cam) {
    return x - cam.x;
  },

  rect(x, y, w, h, color) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, w, h);
  },

  // Draw text with the built-in 5x7 bitmap font. `size` is the glyph height
  // in world pixels; `y` is the top of the text. Includes a 1px drop shadow.
  text(str, x, y, color = "#fff", align = "left", size = 8) {
    str = String(str);
    const px = size / FONT_H; // world px per font pixel
    const advance = (FONT_W + 1) * px; // per-character horizontal step
    const totalW = str.length * advance - px;
    let startX = x;
    if (align === "center") startX = x - totalW / 2;
    else if (align === "right") startX = x - totalW;
    this._drawText(str, startX + px, y + px, "#000", px, advance); // shadow
    this._drawText(str, startX, y, color, px, advance);
  },

  _drawText(str, x, y, color, px, advance) {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    for (let i = 0; i < str.length; i++) {
      let ch = str[i];
      const glyph = FONT[ch] || FONT[ch.toUpperCase()] || FONT[" "];
      const gx = x + i * advance;
      for (let r = 0; r < FONT_H; r++) {
        const row = glyph[r];
        for (let c = 0; c < FONT_W; c++) {
          if (row[c] === "X") ctx.fillRect(gx + c * px, y + r * px, px, px);
        }
      }
    }
  },

  // --- Background -----------------------------------------------------------
  _sky(game) {
    const ctx = this.ctx;
    const night = game.level && game.level.def.night;
    const grad = ctx.createLinearGradient(0, 0, 0, CONFIG.VIEW_H);
    if (night) {
      grad.addColorStop(0, "#0a0a2a");
      grad.addColorStop(1, "#241a4a");
    } else {
      grad.addColorStop(0, "#5c94fc");
      grad.addColorStop(1, "#8fc0ff");
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CONFIG.VIEW_W, CONFIG.VIEW_H);
  },

  _background(cam, level) {
    if (!level) return;
    const groundTop = GROUND_ROW * CONFIG.TILE;

    // Clouds (far parallax).
    for (let i = 0; i < 40; i++) {
      const wx = i * 150 + 40;
      const sx = wx - cam.x * 0.35;
      if (sx < -60 || sx > CONFIG.VIEW_W + 60) continue;
      const wy = 24 + ((i * 53) % 60);
      this._cloud(sx, wy);
    }

    // Hills (mid parallax). Only drawn where there is solid ground beneath
    // their base, so they never float over a pit.
    for (let i = 0; i < 40; i++) {
      const wx = i * 180 + 20;
      const sx = wx - cam.x * 0.55;
      if (sx < -80 || sx > CONFIG.VIEW_W + 80) continue;
      const big = i % 2 === 0;
      const w = big ? 80 : 52;
      if (!this._hasGround(level, wx + w / 2)) continue;
      this._hill(sx, groundTop, big);
    }

    // Bushes (same scroll speed as tiles, sit on the ground line).
    for (let i = 0; i < 60; i++) {
      const wx = i * 96 + 70;
      const sx = wx - cam.x;
      if (sx < -50 || sx > CONFIG.VIEW_W + 50) continue;
      if (!this._hasGround(level, wx + 12)) continue;
      this._bush(sx, groundTop);
    }
  },

  // Is there solid ground at the top ground row under this world x?
  _hasGround(level, worldX) {
    const col = Math.floor(worldX / CONFIG.TILE);
    return level.isSolidTile(col, GROUND_ROW);
  },

  _cloud(x, y) {
    const c = "#ffffff";
    this.rect(x, y + 6, 10, 8, c);
    this.rect(x + 6, y, 12, 14, c);
    this.rect(x + 16, y + 4, 10, 10, c);
    this.rect(x + 4, y + 12, 22, 4, c);
  },

  _hill(x, groundTop, big) {
    const g1 = "#3aa02a";
    const g2 = "#2c7d20";
    const h = big ? 48 : 30;
    const w = big ? 80 : 52;
    const ctx = this.ctx;
    ctx.fillStyle = g1;
    ctx.beginPath();
    ctx.moveTo(x, groundTop);
    ctx.lineTo(x + w / 2, groundTop - h);
    ctx.lineTo(x + w, groundTop);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = g2;
    ctx.fillRect(x + w / 2 - 3, groundTop - h + 6, 6, h - 6);
  },

  _bush(x, groundTop) {
    const g = "#2c9d2c";
    const y = groundTop - 10;
    this.rect(x, y + 4, 10, 6, g);
    this.rect(x + 7, y, 10, 10, g);
    this.rect(x + 15, y + 4, 10, 6, g);
  },

  // --- Tiles ----------------------------------------------------------------
  _tiles(game) {
    const cam = game.camera;
    const level = game.level;
    const T = CONFIG.TILE;
    const startCol = Math.max(0, Math.floor(cam.x / T));
    const endCol = Math.min(
      level.cols - 1,
      Math.ceil((cam.x + CONFIG.VIEW_W) / T)
    );

    for (let r = 0; r < level.rows; r++) {
      for (let c = startCol; c <= endCol; c++) {
        const id = level.tileAt(c, r);
        if (id === T_EMPTY) continue;
        const x = c * T - cam.x;
        const y = r * T + level.bumpOffset(c, r);
        this._tile(id, x, y, game.animTime);
      }
    }
  },

  _tile(id, x, y, animTime) {
    const T = CONFIG.TILE;
    switch (id) {
      case 1: // GROUND
        this.rect(x, y, T, T, "#c26c1c");
        this.rect(x, y, T, 4, "#e8a860");
        this.rect(x, y + T - 2, T, 2, "#8a4a10");
        this.rect(x + 6, y + 6, 4, 4, "#8a4a10");
        break;
      case 2: // BRICK
        this.rect(x, y, T, T, "#c65a20");
        this.rect(x, y, T, 1, "#e89050");
        // mortar lines
        this.ctx.fillStyle = "#7a3510";
        this.ctx.fillRect(x, y + 7, T, 1);
        this.ctx.fillRect(x + 4, y + 1, 1, 6);
        this.ctx.fillRect(x + 12, y + 1, 1, 6);
        this.ctx.fillRect(x + 8, y + 8, 1, 7);
        break;
      case 3: // QUESTION (coin)
      case 4: // QUESTION (power)
        this._question(x, y, animTime);
        break;
      case 5: // BLOCK (hard)
        this.rect(x, y, T, T, "#b06a12");
        this.rect(x, y, T, 2, "#e0a860");
        this.rect(x, y, 2, T, "#e0a860");
        this.rect(x + T - 2, y, 2, T, "#7a4408");
        this.rect(x, y + T - 2, T, 2, "#7a4408");
        break;
      case 10: // USED block
        this.rect(x, y, T, T, "#a5620f");
        this.rect(x, y, T, 2, "#c98a3a");
        this.rect(x, y + T - 2, T, 2, "#6e3f08");
        break;
      case 6: // PIPE_TL
        this._pipe(x, y, "tl");
        break;
      case 7: // PIPE_TR
        this._pipe(x, y, "tr");
        break;
      case 8: // PIPE_L
        this._pipe(x, y, "l");
        break;
      case 9: // PIPE_R
        this._pipe(x, y, "r");
        break;
      case 11: // COIN tile
        this._coin(x + 4, y + 2, animTime);
        break;
    }
  },

  _question(x, y, animTime) {
    const T = CONFIG.TILE;
    const blink = Math.floor(animTime / 12) % 3;
    const base = blink === 0 ? "#f8b800" : blink === 1 ? "#f0a000" : "#e08800";
    this.rect(x, y, T, T, base);
    this.rect(x, y, T, 2, "#ffe080");
    this.rect(x, y + T - 2, T, 2, "#a05800");
    // rivets
    this.rect(x + 1, y + 1, 2, 2, "#7a4400");
    this.rect(x + T - 3, y + 1, 2, 2, "#7a4400");
    this.rect(x + 1, y + T - 3, 2, 2, "#7a4400");
    this.rect(x + T - 3, y + T - 3, 2, 2, "#7a4400");
    // '?' glyph
    const q = "#7a4400";
    this.rect(x + 6, y + 4, 4, 2, q);
    this.rect(x + 9, y + 5, 2, 3, q);
    this.rect(x + 7, y + 8, 3, 2, q);
    this.rect(x + 7, y + 11, 2, 2, q);
  },

  _pipe(x, y, part) {
    const T = CONFIG.TILE;
    const main = "#2ea01e";
    const light = "#7be26a";
    const dark = "#136510";
    if (part === "tl" || part === "tr") {
      // Rim overhang.
      this.rect(x, y, T, 4, main);
      this.rect(x, y, T, 2, light);
      this.rect(x, y + 4, T, T - 4, main);
      if (part === "tl") {
        this.rect(x + 2, y + 4, 3, T - 4, light);
        this.rect(x, y, 2, 4, dark);
      } else {
        this.rect(x + T - 5, y + 4, 3, T - 4, dark);
        this.rect(x + T - 2, y, 2, 4, dark);
      }
    } else {
      this.rect(x, y, T, T, main);
      if (part === "l") this.rect(x + 3, y, 3, T, light);
      else this.rect(x + T - 5, y, 3, T, dark);
    }
  },

  _coin(x, y, animTime) {
    const frame = Math.floor(animTime / 8) % 4;
    const widths = [8, 5, 2, 5];
    const w = widths[frame];
    const cx = x + 4;
    this.rect(cx - w / 2, y, w, 12, "#f8d000");
    this.rect(cx - w / 2, y, w, 2, "#ffe870");
    if (w > 3) this.rect(cx - 1, y + 3, 2, 6, "#b58900");
  },

  // --- Flag / goal ----------------------------------------------------------
  _flag(ctx, level, cam) {
    const x = level.flagX - cam.x;
    const topY = 2 * CONFIG.TILE;
    const baseY = GROUND_ROW * CONFIG.TILE;
    // pole
    this.rect(x + 7, topY, 2, baseY - topY, "#bcbcbc");
    // ball on top
    this.rect(x + 5, topY - 4, 6, 6, "#3aa02a");
    // flag banner (drawn relative to current raise state)
    const fy = topY + 2 + (level.flagDrop || 0);
    ctx.fillStyle = "#2ea01e";
    ctx.beginPath();
    ctx.moveTo(x + 7, fy);
    ctx.lineTo(x - 9, fy + 6);
    ctx.lineTo(x + 7, fy + 12);
    ctx.closePath();
    ctx.fill();
    // base block
    this.rect(x + 2, baseY, 12, CONFIG.TILE, "#e0e0e0");
    this.rect(x + 2, baseY, 12, 3, "#ffffff");
  },

  // --- Player ---------------------------------------------------------------
  _player(ctx, p, cam) {
    if (!p) return;
    // Flicker while hurt (i-frames).
    if (p.hurtTimer > 0 && Math.floor(p.hurtTimer / 3) % 2 === 0) return;

    const x = p.x - cam.x;
    const y = p.y;
    const w = p.w;
    const h = p.h;
    const f = p.facing;

    // Colour palette varies with power state and star invincibility.
    let shirt = "#e52521";
    let overall = "#2038c0";
    const skin = "#f8b878";
    const shoe = "#7a3b10";
    const hair = "#5a2c08";
    if (p.power === "fire") {
      shirt = "#e52521";
      overall = "#f8f8f8";
    }
    if (p.invincible) {
      const c = Math.floor(p.animTime / 4) % 4;
      const pal = ["#e52521", "#f8b800", "#2ea01e", "#ffffff"];
      shirt = pal[c];
      overall = pal[(c + 2) % 4];
    }

    // Proportions relative to height.
    const capH = Math.round(h * 0.22);
    const faceH = Math.round(h * 0.25);
    const bodyH = Math.round(h * 0.35);
    const legY = y + capH + faceH + bodyH;
    const legH = y + h - legY;

    // Cap.
    this.rect(x, y + Math.round(capH * 0.4), w, Math.round(capH * 0.6), shirt);
    this.rect(x + (f > 0 ? 3 : 0), y, w - 3, Math.round(capH * 0.5), shirt);
    // Face.
    this.rect(x, y + capH, w, faceH, skin);
    // Hair / sideburn + eye depending on facing.
    if (f > 0) {
      this.rect(x, y + capH, 3, faceH, hair);
      this.rect(x + w - 4, y + capH + 2, 2, 3, "#000"); // eye
    } else {
      this.rect(x + w - 3, y + capH, 3, faceH, hair);
      this.rect(x + 2, y + capH + 2, 2, 3, "#000");
    }
    // Body / overalls.
    this.rect(x, legY - bodyH, w, bodyH, overall);
    // Shirt shoulders/arms.
    this.rect(x, legY - bodyH, w, Math.round(bodyH * 0.4), shirt);
    // overall straps
    this.rect(x + 3, legY - bodyH, 2, bodyH, overall);
    // Legs / shoes with a simple walk cycle.
    const moving = Math.abs(p.vx) > 0.3 && p.onGround;
    const step = moving ? Math.floor(p.animTime / 5) % 2 : 0;
    if (!p.onGround) {
      // jumping pose: both legs together
      this.rect(x, legY, w, legH, overall);
      this.rect(x, y + h - 3, w, 3, shoe);
    } else if (step === 0) {
      this.rect(x, legY, w - 3, legH, overall);
      this.rect(x, y + h - 3, w - 2, 3, shoe);
    } else {
      this.rect(x + 3, legY, w - 3, legH, overall);
      this.rect(x + 2, y + h - 3, w - 2, 3, shoe);
    }
  },

  // --- Enemies --------------------------------------------------------------
  _enemy(ctx, e, cam) {
    const x = e.x - cam.x;
    const y = e.y;
    if (e.type === "goomba") this._goomba(x, y, e);
    else this._koopa(x, y, e);
  },

  _goomba(x, y, e) {
    const body = "#8a5018";
    const dark = "#5a3208";
    const foot = "#3a2004";
    if (e.state === "flat") {
      this.rect(x, y + 12, 16, 4, body);
      this.rect(x + 2, y + 10, 12, 2, dark);
      return;
    }
    let dy = 0;
    if (e.state === "flipped") dy = 0; // simple falling squash
    // dome body
    this.rect(x + 1, y + 2, 14, 10, body);
    this.rect(x + 3, y, 10, 3, body);
    this.rect(x + 1, y + 2, 14, 2, "#a5651f");
    // eyes
    this.rect(x + 3, y + 5, 3, 4, "#fff");
    this.rect(x + 10, y + 5, 3, 4, "#fff");
    this.rect(x + 4, y + 6, 2, 3, "#000");
    this.rect(x + 11, y + 6, 2, 3, "#000");
    // eyebrows (angry)
    this.rect(x + 3, y + 4, 4, 1, dark);
    this.rect(x + 9, y + 4, 4, 1, dark);
    // feet (animated)
    const swing = Math.floor(e.animTime / 8) % 2;
    if (swing === 0) {
      this.rect(x + 1, y + 12, 6, 4, foot);
      this.rect(x + 10, y + 12, 5, 3, foot);
    } else {
      this.rect(x + 1, y + 12, 5, 3, foot);
      this.rect(x + 9, y + 12, 6, 4, foot);
    }
  },

  _koopa(x, y, e) {
    const shellC = e.type === "koopa" ? "#28a828" : "#28a828";
    const shellDark = "#12660f";
    const skin = "#f8d038";
    if (e.state === "shell" || e.state === "shellMove") {
      // just the shell
      this.rect(x + 1, y + 8, 14, 12, shellC);
      this.rect(x + 1, y + 8, 14, 3, "#7be26a");
      this.rect(x + 3, y + 11, 10, 6, shellDark);
      // spin streaks when moving
      if (e.state === "shellMove" && Math.floor(e.animTime / 3) % 2) {
        this.rect(x - 3, y + 12, 3, 2, "#ffffff");
        this.rect(x + 16, y + 12, 3, 2, "#ffffff");
      }
      return;
    }
    if (e.state === "flipped") {
      this.rect(x + 1, y + 2, 14, 12, shellDark);
      this.rect(x + 3, y + 4, 10, 8, shellC);
      return;
    }
    // walking koopa (16x22)
    // head
    this.rect(x + (e.dir < 0 ? 1 : 7), y, 8, 8, skin);
    this.rect(x + (e.dir < 0 ? 2 : 12), y + 2, 2, 2, "#000"); // eye
    // shell body
    this.rect(x + 1, y + 7, 14, 11, shellC);
    this.rect(x + 1, y + 7, 14, 3, "#7be26a");
    this.rect(x + 3, y + 10, 10, 6, shellDark);
    // feet
    const swing = Math.floor(e.animTime / 8) % 2;
    this.rect(x + 2, y + 18, 5, 4, skin);
    this.rect(x + 9, y + 18, 5, 4, skin);
    if (swing) this.rect(x + 9, y + 19, 5, 3, "#d8b020");
    else this.rect(x + 2, y + 19, 5, 3, "#d8b020");
  },

  // --- Items ----------------------------------------------------------------
  _item(ctx, it, cam) {
    const x = it.x - cam.x;
    const y = it.y;
    if (it.kind === "mushroom") {
      this.rect(x + 2, y + 8, 12, 8, "#e0a060"); // stem
      this.rect(x + 1, y + 1, 14, 8, "#e02020"); // cap
      this.rect(x + 1, y + 1, 14, 2, "#ff6040");
      this.rect(x + 3, y + 3, 3, 3, "#fff"); // spots
      this.rect(x + 10, y + 3, 3, 3, "#fff");
      this.rect(x + 4, y + 10, 2, 3, "#000"); // eyes
      this.rect(x + 10, y + 10, 2, 3, "#000");
    } else if (it.kind === "flower") {
      const wob = Math.floor(it.animTime ? it.animTime / 6 : 0) % 2;
      this.rect(x + 6, y + 8, 4, 8, "#2ea01e"); // stem
      this.rect(x + 3, y + 2, 10, 8, "#f84018"); // petals
      this.rect(x + 3, y + 2, 10, 3, "#ff8030");
      this.rect(x + 5, y + 4, 6, 4, "#f8f800"); // center
      this.rect(x + 6, y + 5, 4, 2, "#fff");
      if (wob) this.rect(x + 2, y + 5, 2, 3, "#2ea01e");
    } else if (it.kind === "star") {
      const c = Math.floor((it.animTime || 0) / 4) % 2 ? "#f8f800" : "#ffb000";
      this.rect(x + 6, y, 4, 16, c);
      this.rect(x, y + 6, 16, 4, c);
      this.rect(x + 3, y + 3, 10, 10, c);
      this.rect(x + 4, y + 6, 2, 3, "#000");
      this.rect(x + 10, y + 6, 2, 3, "#000");
    } else if (it.kind === "coinpop") {
      this._coin(x + 4, y + 2, it.animTime || 0);
    }
  },

  _fireball(ctx, f, cam) {
    const x = f.x - cam.x;
    const y = f.y;
    if (f.explodeTimer > 0) {
      const r = 10 - f.explodeTimer;
      this.rect(x - r, y - r, r * 2 + 8, r * 2 + 8, "rgba(255,180,60,0.6)");
      return;
    }
    this.rect(x, y, 8, 8, "#f85018");
    this.rect(x + 2, y + 2, 4, 4, "#ffd020");
  },

  // --- HUD ------------------------------------------------------------------
  _hud(ctx, game) {
    // Score.
    this.text("PLUMBER", 8, 5, "#fff");
    this.text(String(game.score).padStart(6, "0"), 8, 15, "#fff");

    // Coin count (row 1) with a little coin icon.
    this.rect(94, 5, 6, 8, "#f8d000");
    this.rect(95, 5, 4, 2, "#ffe870");
    this.rect(96, 7, 2, 4, "#b58900");
    this.text("x" + String(game.coins).padStart(2, "0"), 103, 5, "#fff");

    // Lives (row 2) with a little life icon.
    this.rect(94, 16, 6, 8, "#e52521");
    this.rect(95, 15, 4, 2, "#f8b878");
    this.text("x" + game.lives, 103, 15, "#fff");

    // World.
    this.text("WORLD", 150, 5, "#fff");
    this.text(game.level ? game.level.name.split("  ")[0] : "1-1", 158, 15, "#fff");

    // Time.
    this.text("TIME", 210, 5, "#fff");
    this.text(String(Math.ceil(game.time)).padStart(3, "0"), 214, 15, "#fff");
  },

  // --- Overlays -------------------------------------------------------------
  _overlays(ctx, game) {
    if (game.mode === "paused") {
      this._banner("PAUSED", "#fff");
    } else if (game.mode === "levelIntro") {
      this._dim();
      this.text(
        game.level.name,
        CONFIG.VIEW_W / 2,
        CONFIG.VIEW_H / 2 - 20,
        "#fff",
        "center",
        12
      );
      this.text(
        "x  " + game.lives,
        CONFIG.VIEW_W / 2,
        CONFIG.VIEW_H / 2 + 6,
        "#fff",
        "center",
        10
      );
      this.rect(CONFIG.VIEW_W / 2 - 22, CONFIG.VIEW_H / 2 + 5, 8, 10, "#e52521");
    } else if (game.mode === "gameover") {
      this._banner("GAME OVER", "#e52521");
    } else if (game.mode === "levelclear") {
      this._banner("LEVEL CLEAR!", "#fbd000");
    } else if (game.mode === "gamewin") {
      this._dim();
      this.text("YOU WIN!", CONFIG.VIEW_W / 2, 90, "#fbd000", "center", 16);
      this.text(
        "SCORE " + game.score,
        CONFIG.VIEW_W / 2,
        120,
        "#fff",
        "center",
        10
      );
      this.text(
        "PRESS ENTER / SPACE",
        CONFIG.VIEW_W / 2,
        150,
        "#fff",
        "center",
        8
      );
    }
  },

  _dim() {
    this.ctx.fillStyle = "rgba(0,0,0,0.55)";
    this.ctx.fillRect(0, 0, CONFIG.VIEW_W, CONFIG.VIEW_H);
  },

  _banner(msg, color) {
    this._dim();
    this.text(msg, CONFIG.VIEW_W / 2, CONFIG.VIEW_H / 2 - 6, color, "center", 14);
  },
};

// Convenience aliases used above (mirror the ids from config.js).
const T_EMPTY = 0;
