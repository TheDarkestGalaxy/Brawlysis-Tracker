// ---------------------------------------------------------------------------
// Shared tile-collision helper + collectible items (power-ups and coin pops).
//
// Entities only hold STATE and movement logic here; all drawing lives in
// renderer.js so the pixel-art style stays in one place.
// ---------------------------------------------------------------------------

const Physics = {
  // Move an entity by its velocity and resolve against solid level tiles.
  // Returns collision info, including any solid tiles the head hit (for the
  // player's block-bump logic).
  moveAndCollide(e, level) {
    const T = CONFIG.TILE;
    const info = {
      onGround: false,
      hitLeft: false,
      hitRight: false,
      headTiles: [],
    };

    // ---- Horizontal ----
    e.x += e.vx;
    let top = Math.floor(e.y / T);
    let bottom = Math.floor((e.y + e.h - 1) / T);
    if (e.vx > 0) {
      const col = Math.floor((e.x + e.w - 1) / T);
      for (let r = top; r <= bottom; r++) {
        if (level.isSolidTile(col, r)) {
          e.x = col * T - e.w;
          e.vx = 0;
          info.hitRight = true;
          break;
        }
      }
    } else if (e.vx < 0) {
      const col = Math.floor(e.x / T);
      for (let r = top; r <= bottom; r++) {
        if (level.isSolidTile(col, r)) {
          e.x = (col + 1) * T;
          e.vx = 0;
          info.hitLeft = true;
          break;
        }
      }
    }

    // ---- Vertical ----
    e.y += e.vy;
    let left = Math.floor(e.x / T);
    let right = Math.floor((e.x + e.w - 1) / T);
    if (e.vy > 0) {
      const row = Math.floor((e.y + e.h - 1) / T);
      for (let c = left; c <= right; c++) {
        if (level.isSolidTile(c, row)) {
          e.y = row * T - e.h;
          e.vy = 0;
          info.onGround = true;
          break;
        }
      }
    } else if (e.vy < 0) {
      const row = Math.floor(e.y / T);
      let hit = false;
      for (let c = left; c <= right; c++) {
        if (level.isSolidTile(c, row)) {
          e.y = (row + 1) * T;
          info.headTiles.push({ col: c, row });
          hit = true;
        }
      }
      if (hit) e.vy = 0;
    }

    return info;
  },

  // Axis-aligned bounding-box overlap test.
  overlap(a, b) {
    return (
      a.x < b.x + b.w &&
      a.x + a.w > b.x &&
      a.y < b.y + b.h &&
      a.y + a.h > b.y
    );
  },
};

class Item {
  // kind: "mushroom" | "flower" | "star" | "coinpop"
  constructor(kind, col, row) {
    this.kind = kind;
    this.type = kind; // used by renderer
    this.x = col * CONFIG.TILE;
    this.y = row * CONFIG.TILE;
    this.w = CONFIG.TILE;
    this.h = CONFIG.TILE;
    this.vx = 0;
    this.vy = 0;
    this.dead = false;
    this.collectible = false;

    if (kind === "coinpop") {
      this.vy = -6;
      this.timer = 30;
      this.collectible = false;
    } else {
      // Power-ups rise out of the block over ~16px before becoming active.
      this.emerge = CONFIG.TILE;
      if (kind === "flower") {
        this.vx = 0; // flowers stay put
      } else {
        this.vx = CONFIG.ENEMY_SPEED * 2; // mushroom/star walk right
      }
    }
  }

  update(level) {
    if (this.kind === "coinpop") {
      this.y += this.vy;
      this.vy += 0.4;
      this.timer--;
      if (this.timer <= 0) this.dead = true;
      return;
    }

    // Emerging out of the block (no collision during this phase).
    if (this.emerge > 0) {
      const step = 1;
      this.y -= step;
      this.emerge -= step;
      if (this.emerge <= 0) this.collectible = true;
      return;
    }

    this.collectible = true;

    if (this.kind === "flower") return; // stationary

    // Mushroom / star: gravity + walk + bounce off walls, bounce off ground.
    this.vy = Math.min(this.vy + CONFIG.GRAVITY, CONFIG.MAX_FALL);
    const info = Physics.moveAndCollide(this, level);
    if (info.hitLeft) this.vx = Math.abs(this.vx);
    if (info.hitRight) this.vx = -Math.abs(this.vx);
    if (this.kind === "star" && info.onGround) this.vy = -6; // hop

    // Fell into a pit.
    if (this.y > level.pixelHeight + 64) this.dead = true;
  }
}
