// ---------------------------------------------------------------------------
// Game controller: owns the world, runs the fixed-timestep simulation, handles
// all inter-entity collisions, scoring, and the level/lives state machine.
// ---------------------------------------------------------------------------

class Game {
  constructor(canvas, overlayEl) {
    this.canvas = canvas;
    this.overlayEl = overlayEl;
    this.camera = new Camera();

    this.levelIndex = 0;
    this.level = null;
    this.player = null;
    this.enemies = [];
    this.items = [];
    this.fireballs = [];

    this.score = 0;
    this.coins = 0;
    this.lives = 3;
    this.time = 300;
    this._timeFrac = 0;
    this.animTime = 0;

    this.mode = "title"; // title|levelIntro|playing|paused|dying|levelclear|gameover|gamewin
    this.modeTimer = 0;

    this._acc = 0;
    this._last = 0;
    this._raf = null;
  }

  // --- Lifecycle ------------------------------------------------------------
  startNewGame() {
    this.score = 0;
    this.coins = 0;
    this.lives = 3;
    this.levelIndex = 0;
    this.hideOverlay();
    this.loadLevel(0);
  }

  loadLevel(index) {
    this.level = new Level(Levels.LIST[index]);
    this.level.flagDrop = 0;
    this.player = new Player(this.level.startX, this.level.startY);
    this.camera.reset();
    this.enemies = [];
    this.items = [];
    this.fireballs = [];
    this._spawnEnemies();
    this.time = this.level.time;
    this._timeFrac = 0;
    this.mode = "levelIntro";
    this.modeTimer = 110;
    Sound.stopMusic();
  }

  _spawnEnemies() {
    const T = CONFIG.TILE;
    for (const s of this.level.enemySpawns) {
      const xPix = s.x * T;
      const bottomPix = (s.y + 1) * T;
      this.enemies.push(new Enemy(s.type, xPix, bottomPix));
    }
  }

  hideOverlay() {
    if (this.overlayEl) this.overlayEl.classList.add("hidden");
  }
  showOverlay() {
    if (this.overlayEl) this.overlayEl.classList.remove("hidden");
  }

  // --- Main loop ------------------------------------------------------------
  run() {
    this._last = performance.now();
    const frame = (now) => {
      this._raf = requestAnimationFrame(frame);
      let delta = now - this._last;
      this._last = now;
      if (delta > 250) delta = 250; // clamp after tab switch
      this._acc += delta;
      while (this._acc >= CONFIG.STEP) {
        this.step();
        this._acc -= CONFIG.STEP;
      }
      Renderer.draw(this);
    };
    this._raf = requestAnimationFrame(frame);
  }

  step() {
    Input.beginFrame();
    this.animTime++;

    // Global keys.
    if (Input.mutePressed) Sound.toggleMute();
    if (Input.pausePressed) this._togglePause();

    switch (this.mode) {
      case "levelIntro":
        this._stepLevelIntro();
        break;
      case "playing":
        this._stepPlaying();
        break;
      case "dying":
        this._stepDying();
        break;
      case "levelclear":
        this._stepLevelClear();
        break;
      case "gameover":
      case "gamewin":
        if (Input.jumpPressed || Input.anyPressed) {
          if (this._acceptRestart) {
            this.mode = "title";
            this.showOverlay();
            this._acceptRestart = false;
          }
        }
        break;
    }

    Input.endFrame();
  }

  _stepLevelIntro() {
    this.modeTimer--;
    if (this.modeTimer <= 0) {
      this.mode = "playing";
      Sound.resume();
      Sound.startMusic();
    }
  }

  _stepPlaying() {
    const level = this.level;
    this.player.update(level, this);
    this.enemies.forEach((e) => e.update(level));
    this.items.forEach((it) => it.update(level));
    this.fireballs.forEach((f) => f.update(level));
    level.update();

    this._collide();

    // Reap dead things.
    this.enemies = this.enemies.filter((e) => !e.dead);
    this.items = this.items.filter((it) => !it.dead);
    this.fireballs = this.fireballs.filter((f) => !f.dead);

    this.camera.follow(this.player, level.pixelWidth);

    // Countdown timer (roughly 0.4s of real time per game-second, SMB-style).
    this._timeFrac += 1;
    if (this._timeFrac >= 24) {
      this._timeFrac = 0;
      this.time--;
      if (this.time <= 0) {
        this.time = 0;
        this.player.die();
      }
    }

    // Reached the flag?
    if (this.player.x + this.player.w >= level.flagX && this.player.state === "normal") {
      this._beginLevelClear();
    }

    // Died?
    if (this.player.state === "dying") {
      this.mode = "dying";
    }
  }

  _stepDying() {
    this.player.update(this.level, this);
    if (this.player.dead) {
      this._loseLife();
    }
  }

  _beginLevelClear() {
    this.player.state = "clear";
    this.mode = "levelclear";
    this.modeTimer = 200;
    Sound.stopMusic();
    Sound.win();
    // Time bonus.
    this.addScore(Math.ceil(this.time) * 50);
    this.time = 0;
  }

  _stepLevelClear() {
    this.player.update(this.level, this);
    if (this.level.flagDrop < 120) this.level.flagDrop += 3;
    this.modeTimer--;
    if (this.modeTimer <= 0) this._nextLevel();
  }

  _nextLevel() {
    this.levelIndex++;
    if (this.levelIndex >= Levels.LIST.length) {
      this.mode = "gamewin";
      this._acceptRestart = false;
      setTimeout(() => (this._acceptRestart = true), 800);
      Sound.win();
    } else {
      this.loadLevel(this.levelIndex);
    }
  }

  _loseLife() {
    this.lives--;
    if (this.lives < 0) {
      this.mode = "gameover";
      this._acceptRestart = false;
      Sound.gameOver();
      setTimeout(() => (this._acceptRestart = true), 1000);
    } else {
      this.loadLevel(this.levelIndex);
    }
  }

  _togglePause() {
    if (this.mode === "playing") {
      this.mode = "paused";
      Sound.stopMusic();
    } else if (this.mode === "paused") {
      this.mode = "playing";
      Sound.startMusic();
    }
  }

  // --- Collision handling ---------------------------------------------------
  _collide() {
    const p = this.player;

    // Player vs enemies.
    for (const e of this.enemies) {
      if (e.dead || e.state === "flipped" || e.state === "flat") continue;
      if (!Physics.overlap(p, e)) continue;

      const pb = p.y + p.h;
      const stomping = p.vy > 0 && pb <= e.y + e.h * 0.6;

      if (p.invincible) {
        e.flip(p.centerX < e.x ? 1 : -1);
        this.addScore(100);
        Sound.kick();
        continue;
      }

      if (stomping && e.stompable) {
        const result = e.stomp(p.centerX);
        p.vy = Input.jump ? -CONFIG.JUMP_SPEED * 0.8 : -CONFIG.BOUNCE_SPEED;
        if (result === "squash" || result === "shell") {
          this.addScore(100);
          Sound.stomp();
        } else if (result === "kick") {
          this.addScore(400);
          Sound.kick();
        } else if (result === "stop") {
          Sound.stomp();
        }
        continue;
      }

      // Side contact.
      if (e.state === "shell") {
        // Kick an idle shell we walked into.
        e.stomp(p.centerX);
        Sound.kick();
        this.addScore(400);
      } else if (e.dangerous) {
        p.damage();
        if (p.state === "dying") return;
      }
    }

    // Moving shells mow down other enemies.
    for (const shell of this.enemies) {
      if (shell.state !== "shellMove") continue;
      for (const e of this.enemies) {
        if (e === shell || e.dead || e.state === "flipped") continue;
        if (Physics.overlap(shell, e)) {
          e.flip(shell.vx > 0 ? 1 : -1);
          this.addScore(200);
          Sound.kick();
        }
      }
    }

    // Fireballs vs enemies.
    for (const f of this.fireballs) {
      if (f.explodeTimer > 0) continue;
      for (const e of this.enemies) {
        if (e.dead || e.state === "flipped" || e.state === "flat") continue;
        if (Physics.overlap(f, e)) {
          e.flip(f.vx > 0 ? 1 : -1);
          f.explode();
          this.addScore(100);
          Sound.stomp();
          break;
        }
      }
    }

    // Player vs items.
    for (const it of this.items) {
      if (it.dead || !it.collectible || it.kind === "coinpop") continue;
      if (!Physics.overlap(p, it)) continue;
      it.dead = true;
      if (it.kind === "mushroom") p.grow();
      else if (it.kind === "flower") p.giveFire();
      else if (it.kind === "star") p.giveStar();
      this.addScore(1000);
    }
  }

  // --- Callbacks used by the player ----------------------------------------
  bumpBlock(col, row, player) {
    const result = this.level.bump(col, row, player.big);
    switch (result.kind) {
      case "coin":
        this.collectCoin();
        this.items.push(new Item("coinpop", col, row - 1));
        break;
      case "power": {
        Sound.powerAppear();
        const kind = player.power === "small" ? "mushroom" : "flower";
        // Spawn inside the block; it rises out onto the block's top.
        this.items.push(new Item(kind, col, row));
        break;
      }
      case "break":
        this.addScore(50);
        Sound.brick();
        break;
      case "bump":
      case "solid":
        Sound.bump();
        break;
    }
    // Flip enemies standing on top of the bumped block.
    const bx = col * CONFIG.TILE;
    const by = row * CONFIG.TILE;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const feet = e.y + e.h;
      if (
        Math.abs(feet - by) < 6 &&
        e.x + e.w > bx &&
        e.x < bx + CONFIG.TILE
      ) {
        e.flip(e.dir);
        this.addScore(100);
      }
    }
  }

  collectCoin() {
    this.coins++;
    this.addScore(200);
    Sound.coin();
    if (this.coins >= 100) {
      this.coins -= 100;
      this.lives++;
    }
  }

  addScore(n) {
    this.score += n;
  }
}
