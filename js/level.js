// ---------------------------------------------------------------------------
// Level: compiles a declarative level definition (see levels.js) into a tile
// grid, tracks dynamic tile state (bumped/used blocks, collected coins), and
// answers collision queries used by the physics code.
// ---------------------------------------------------------------------------

class Level {
  constructor(def) {
    this.def = def;
    this.name = def.name;
    this.cols = def.width;
    this.rows = 15;
    this.time = def.time || CONFIG.LEVEL_TIME;

    // grid[row][col] = tile id
    this.grid = [];
    for (let r = 0; r < this.rows; r++) {
      this.grid.push(new Array(this.cols).fill(T.EMPTY));
    }

    // Short-lived "bump" animations keyed by "col,row".
    this.bumps = new Map();

    // Entity spawn descriptors (rebuilt fresh on every reset()).
    this.enemySpawns = def.enemies ? def.enemies.slice() : [];

    this.startX = def.start.x * CONFIG.TILE;
    this.startY = def.start.y * CONFIG.TILE;
    this.flagX = def.flag * CONFIG.TILE;
    this.pixelWidth = this.cols * CONFIG.TILE;
    this.pixelHeight = this.rows * CONFIG.TILE;

    this._build();
  }

  _set(col, row, id) {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;
    this.grid[row][col] = id;
  }

  _build() {
    const d = this.def;

    // Ground spans (two tiles thick).
    (d.ground || []).forEach(([s, e]) => {
      for (let c = s; c <= e; c++) {
        this._set(c, GROUND_ROW, T.GROUND);
        this._set(c, GROUND_ROW + 1, T.GROUND);
      }
    });

    // Pipes (2 tiles wide, h tiles tall).
    (d.pipes || []).forEach((p) => {
      const top = GROUND_ROW - p.h;
      for (let r = top; r < GROUND_ROW; r++) {
        if (r === top) {
          this._set(p.x, r, T.PIPE_TL);
          this._set(p.x + 1, r, T.PIPE_TR);
        } else {
          this._set(p.x, r, T.PIPE_L);
          this._set(p.x + 1, r, T.PIPE_R);
        }
      }
    });

    // Individual blocks.
    (d.blocks || []).forEach((b) => this._set(b.x, b.y, this._typeId(b.type)));

    // Horizontal runs of a block type.
    (d.runs || []).forEach((run) => {
      for (let i = 0; i < run.n; i++) {
        this._set(run.x + i, run.y, this._typeId(run.type));
      }
    });

    // Floating coins.
    (d.coins || []).forEach((c) => this._set(c.x, c.y, T.COIN));

    // Staircases made of hard blocks.
    (d.stairs || []).forEach((st) => {
      for (let i = 0; i < st.h; i++) {
        const col = st.x + i;
        const height = st.dir === "down" ? st.h - i : i + 1;
        for (let s = 0; s < height; s++) {
          this._set(col, GROUND_ROW - 1 - s, T.BLOCK);
        }
      }
    });
  }

  _typeId(type) {
    switch (type) {
      case "brick":
        return T.BRICK;
      case "?":
        return T.QUESTION_COIN;
      case "!":
        return T.QUESTION_POWER;
      case "X":
        return T.BLOCK;
      case "coin":
        return T.COIN;
      default:
        return T.EMPTY;
    }
  }

  tileAt(col, row) {
    if (row < 0 || col < 0 || col >= this.cols) return T.EMPTY;
    if (row >= this.rows) return T.EMPTY; // below the world = empty (pits)
    return this.grid[row][col];
  }

  isSolidTile(col, row) {
    return SOLID.has(this.tileAt(col, row));
  }

  isSolidAtPixel(px, py) {
    const col = Math.floor(px / CONFIG.TILE);
    const row = Math.floor(py / CONFIG.TILE);
    return this.isSolidTile(col, row);
  }

  setTile(col, row, id) {
    this._set(col, row, id);
  }

  // Player head-butts a block from below. `big` = whether player is powered up.
  // Returns a descriptor of what happened so the game can react (spawn items,
  // play sounds, add score).
  bump(col, row, big) {
    const id = this.tileAt(col, row);
    this._startBump(col, row);

    if (id === T.QUESTION_COIN) {
      this._set(col, row, T.USED);
      return { kind: "coin", col, row };
    }
    if (id === T.QUESTION_POWER) {
      this._set(col, row, T.USED);
      return { kind: "power", col, row };
    }
    if (id === T.BRICK) {
      if (big) {
        this._set(col, row, T.EMPTY);
        return { kind: "break", col, row };
      }
      return { kind: "bump", col, row };
    }
    return { kind: "solid", col, row };
  }

  _startBump(col, row) {
    this.bumps.set(`${col},${row}`, { col, row, t: 10 });
  }

  bumpOffset(col, row) {
    const b = this.bumps.get(`${col},${row}`);
    if (!b) return 0;
    // A quick up-then-down hop (max ~5px).
    return -Math.sin((b.t / 10) * Math.PI) * 5;
  }

  update() {
    for (const [key, b] of this.bumps) {
      b.t--;
      if (b.t <= 0) this.bumps.delete(key);
    }
  }
}
