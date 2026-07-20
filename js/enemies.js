// ---------------------------------------------------------------------------
// Enemies: Goomba and Koopa Troopa.
//
// Goomba : walks; stomp flattens it; shells/fireballs/stars flip it away.
// Koopa  : walks; stomp retracts it into a shell; touching an idle shell
//          kicks it into a fast-moving shell that mows down other enemies.
// ---------------------------------------------------------------------------

class Enemy {
  constructor(type, xPix, yPixBottom) {
    this.type = type;
    if (type === "koopa") {
      this.w = 16;
      this.h = 22;
    } else {
      this.w = 16;
      this.h = 16;
    }
    this.x = xPix;
    this.y = yPixBottom - this.h; // align bottom to the ground
    this.vx = -CONFIG.ENEMY_SPEED;
    this.vy = 0;
    this.dir = -1;
    this.dead = false;
    this.state = "walk"; // walk | flat | shell | shellMove | flipped
    this.timer = 0;
    this.animTime = 0;
  }

  // Can this enemy currently hurt the player on contact?
  get dangerous() {
    return (
      this.state === "walk" ||
      this.state === "shellMove"
    );
  }

  // Can the player stomp it to squash/interact?
  get stompable() {
    return this.state !== "flipped" && this.state !== "flat";
  }

  update(level) {
    this.animTime++;

    if (this.state === "flat") {
      this.timer--;
      if (this.timer <= 0) this.dead = true;
      return;
    }

    if (this.state === "flipped") {
      this.vy = Math.min(this.vy + CONFIG.GRAVITY, CONFIG.MAX_FALL);
      this.x += this.vx;
      this.y += this.vy;
      if (this.y > level.pixelHeight + 80) this.dead = true;
      return;
    }

    // Gravity for grounded states.
    this.vy = Math.min(this.vy + CONFIG.GRAVITY, CONFIG.MAX_FALL);

    if (this.state === "walk") {
      this.vx = this.dir * CONFIG.ENEMY_SPEED;
    } else if (this.state === "shell") {
      this.vx = 0;
    } else if (this.state === "shellMove") {
      this.vx = this.dir * CONFIG.SHELL_SPEED;
    }

    const info = Physics.moveAndCollide(this, level);
    if (info.hitLeft) {
      this.dir = 1;
    } else if (info.hitRight) {
      this.dir = -1;
    }

    if (this.y > level.pixelHeight + 80) this.dead = true;
  }

  // Player landed on top of us.
  stomp(playerCenterX) {
    if (this.type === "goomba") {
      this.state = "flat";
      this.timer = 28;
      this.vx = 0;
      return "squash";
    }
    // Koopa
    if (this.state === "walk") {
      this.state = "shell";
      this.vx = 0;
      this.timer = 0;
      return "shell";
    }
    if (this.state === "shellMove") {
      this.state = "shell";
      this.vx = 0;
      return "stop";
    }
    if (this.state === "shell") {
      // Kick it away from the player.
      this.dir = playerCenterX < this.x + this.w / 2 ? 1 : -1;
      this.state = "shellMove";
      return "kick";
    }
    return "none";
  }

  // Killed from the side by a moving shell, a fireball, or an invincible star
  // player: flip over and tumble off the screen.
  flip(dir) {
    this.state = "flipped";
    this.vx = 0.8 * (dir || 1);
    this.vy = -5;
  }
}
