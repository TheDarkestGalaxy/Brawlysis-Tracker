// ---------------------------------------------------------------------------
// Fireball projectile thrown by fire-powered player. Bounces along the ground
// and pops on contact with a wall or enemy.
// ---------------------------------------------------------------------------

class Fireball {
  constructor(x, y, dir) {
    this.type = "fireball";
    this.w = 8;
    this.h = 8;
    this.x = x;
    this.y = y;
    this.vx = dir * CONFIG.FIREBALL_SPEED;
    this.vy = 2;
    this.dead = false;
    this.explodeTimer = 0;
    this.animTime = 0;
  }

  update(level) {
    this.animTime++;

    if (this.explodeTimer > 0) {
      this.explodeTimer--;
      if (this.explodeTimer <= 0) this.dead = true;
      return;
    }

    this.vy = Math.min(this.vy + CONFIG.GRAVITY, CONFIG.MAX_FALL);
    const info = Physics.moveAndCollide(this, level);

    // Bounce off the ground.
    if (info.onGround) this.vy = -4;
    // Pop when hitting a wall.
    if (info.hitLeft || info.hitRight) this.explode();
    // Off the bottom of the world.
    if (this.y > level.pixelHeight + 32) this.dead = true;
  }

  explode() {
    this.explodeTimer = 8;
    this.vx = 0;
    this.vy = 0;
  }
}
