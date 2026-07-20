// ---------------------------------------------------------------------------
// Player character: movement physics, jump, power-up states (small/big/fire),
// invincibility, fireball throwing, and block/coin interaction.
// ---------------------------------------------------------------------------

class Player {
  constructor(x, y) {
    this.startX = x;
    this.startY = y;
    this.type = "player";
    this.power = "small"; // small | big | fire
    this.w = 12;
    this.h = 16;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.facing = 1;
    this.onGround = false;
    this.coyote = 0; // grace frames to still jump just after leaving ground
    this.jumpHeld = false;

    this.state = "normal"; // normal | dying | clear
    this.starTimer = 0; // invincibility from a star
    this.hurtTimer = 0; // brief i-frames after taking damage
    this.fireCooldown = 0;
    this.animTime = 0;
    this.dead = false;
  }

  get big() {
    return this.power !== "small";
  }

  get invincible() {
    return this.starTimer > 0;
  }

  get centerX() {
    return this.x + this.w / 2;
  }

  // --- Power state transitions ---------------------------------------------
  _resize(newH) {
    // Keep the feet anchored when height changes.
    const feet = this.y + this.h;
    this.h = newH;
    this.y = feet - newH;
  }

  grow() {
    if (this.power === "small") {
      this.power = "big";
      this._resize(28);
      this.hurtTimer = 30;
      Sound.powerUp();
    } else {
      Sound.coin(); // already big: award like a 1000-pt bonus
    }
  }

  giveFire() {
    if (this.power === "small") {
      this.power = "big";
      this._resize(28);
    }
    this.power = "fire";
    this.hurtTimer = 30;
    Sound.powerUp();
  }

  giveStar() {
    this.starTimer = CONFIG.STAR_TIME;
    Sound.powerUp();
  }

  // Returns true if the hit killed the player.
  damage() {
    if (this.invincible || this.hurtTimer > 0 || this.state !== "normal") {
      return false;
    }
    if (this.power === "fire" || this.power === "big") {
      this.power = "small";
      this._resize(16);
      this.hurtTimer = 90;
      Sound.powerDown();
      return false;
    }
    this.die();
    return true;
  }

  die() {
    if (this.state === "dying") return;
    this.state = "dying";
    this.vy = -10;
    this.vx = 0;
    this.dead = false; // becomes true after the death animation
    Sound.stopMusic();
    Sound.die();
  }

  // --- Main update ----------------------------------------------------------
  update(level, game) {
    this.animTime++;
    if (this.starTimer > 0) this.starTimer--;
    if (this.hurtTimer > 0) this.hurtTimer--;
    if (this.fireCooldown > 0) this.fireCooldown--;

    if (this.state === "dying") {
      // Little death hop, then fall through everything.
      this.vy = Math.min(this.vy + CONFIG.GRAVITY, CONFIG.MAX_FALL);
      this.y += this.vy;
      if (this.y > level.pixelHeight + 40) this.dead = true;
      return;
    }

    if (this.state === "clear") {
      // Auto-walk to the right toward the castle after touching the flag.
      this.vx = 1.2;
      this.x += this.vx;
      this.vy = Math.min(this.vy + CONFIG.GRAVITY, CONFIG.MAX_FALL);
      Physics.moveAndCollide(this, level);
      return;
    }

    this._handleHorizontal();
    this._handleJump();

    // Variable-height jump: lighter gravity while rising and holding jump.
    const rising = this.vy < 0;
    const g = rising && Input.jump ? CONFIG.JUMP_GRAVITY : CONFIG.GRAVITY;
    this.vy = Math.min(this.vy + g, CONFIG.MAX_FALL);

    const info = Physics.moveAndCollide(this, level);
    this.onGround = info.onGround;
    // Refresh coyote-time window while grounded, otherwise count it down.
    if (this.onGround) this.coyote = 6;
    else if (this.coyote > 0) this.coyote--;

    // Head-butted one or more blocks: bump the one closest to our center.
    if (info.headTiles.length && this.vy <= 0) {
      let best = null;
      let bestDist = Infinity;
      for (const t of info.headTiles) {
        const cx = t.col * CONFIG.TILE + CONFIG.TILE / 2;
        const d = Math.abs(cx - this.centerX);
        if (d < bestDist) {
          bestDist = d;
          best = t;
        }
      }
      if (best) game.bumpBlock(best.col, best.row, this);
    }

    // Don't walk off the left edge of the world.
    if (this.x < 0) {
      this.x = 0;
      if (this.vx < 0) this.vx = 0;
    }

    // Fire on a fresh run-key press (classic "B button" behaviour).
    if (Input.runPressed) this.fire(game);
    this._collectCoinTiles(level, game);

    // Fell into a pit.
    if (this.y > level.pixelHeight + 16) {
      this.die();
    }
  }

  _handleHorizontal() {
    const running = Input.run;
    const maxSpeed = running ? CONFIG.MAX_RUN : CONFIG.MAX_WALK;
    const accel = running ? CONFIG.RUN_ACCEL : CONFIG.WALK_ACCEL;

    if (Input.left && !Input.right) {
      this.facing = -1;
      // Extra deceleration when reversing (skid).
      if (this.vx > 0) this.vx -= CONFIG.TURN_BOOST;
      this.vx -= accel;
    } else if (Input.right && !Input.left) {
      this.facing = 1;
      if (this.vx < 0) this.vx += CONFIG.TURN_BOOST;
      this.vx += accel;
    } else {
      // No input: apply friction.
      const f = this.onGround ? CONFIG.FRICTION : CONFIG.AIR_FRICTION;
      if (this.vx > f) this.vx -= f;
      else if (this.vx < -f) this.vx += f;
      else this.vx = 0;
    }

    if (this.vx > maxSpeed) this.vx = maxSpeed;
    if (this.vx < -maxSpeed) this.vx = -maxSpeed;
  }

  _handleJump() {
    // Jump if a press is buffered AND we're on the ground (or within the
    // short coyote-time window after walking off a ledge).
    const canJump = this.onGround || this.coyote > 0;
    if (canJump && Input.consumeJump()) {
      this.vy = -CONFIG.JUMP_SPEED;
      this.onGround = false;
      this.coyote = 0;
      Sound.jump();
    }
  }

  fire(game) {
    if (this.power !== "fire" || this.fireCooldown > 0) return;
    if (game.fireballs.length >= 2) return;
    const fx = this.facing > 0 ? this.x + this.w : this.x - 8;
    const fb = new Fireball(fx, this.y + this.h / 2 - 4, this.facing);
    game.fireballs.push(fb);
    this.fireCooldown = 18;
    Sound.fireball();
  }

  _collectCoinTiles(level, game) {
    const SZ = CONFIG.TILE;
    const left = Math.floor(this.x / SZ);
    const right = Math.floor((this.x + this.w - 1) / SZ);
    const top = Math.floor(this.y / SZ);
    const bottom = Math.floor((this.y + this.h - 1) / SZ);
    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        if (level.tileAt(c, r) === T.COIN) {
          level.setTile(c, r, T.EMPTY);
          game.collectCoin();
        }
      }
    }
  }

  respawn() {
    this.power = "small";
    this.w = 12;
    this.h = 16;
    this.x = this.startX;
    this.y = this.startY;
    this.vx = 0;
    this.vy = 0;
    this.facing = 1;
    this.state = "normal";
    this.starTimer = 0;
    this.hurtTimer = 0;
    this.dead = false;
  }
}
