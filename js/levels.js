// ---------------------------------------------------------------------------
// Custom level designs.
//
// Levels are described declaratively in TILE coordinates (not pixels), which
// keeps vertical features perfectly aligned and makes hand-editing painless.
//
// Coordinate system:
//   - The grid is `width` tiles wide and 15 tiles tall (rows 0..14).
//   - Row 0 is the top of the screen, row 14 is the bottom.
//   - GROUND_ROW (13) is the top surface of the two-tile-thick ground.
//   - "y" for blocks/enemies is a row index; smaller y = higher up.
//
// Fields:
//   ground : array of [startCol, endCol] inclusive spans of solid ground.
//            Anything not covered by a span is a bottomless pit.
//   pipes  : { x, h }              green pipe at column x, h tiles tall.
//   blocks : { x, y, type }        type: "brick" | "?" | "!" | "X" | "coin"
//   runs   : { x, y, type, n }     n copies of a block type laid horizontally.
//   stairs : { x, h, dir }         staircase; dir "up" or "down", h tiles tall.
//   enemies: { x, y, type }        type: "goomba" | "koopa"
//   coins  : { x, y }              floating coin.
//   flag   : x                     flagpole column (level goal).
//   start  : { x, y }              player spawn.
// ---------------------------------------------------------------------------

const GROUND_ROW = 13;

const Levels = {
  GROUND_ROW,

  LIST: [
    // =====================================================================
    // LEVEL 1 — "Green Hills"  (a gentle warm-up, classic 1-1 vibe)
    // =====================================================================
    {
      name: "1-1  GREEN HILLS",
      width: 140,
      time: 300,
      start: { x: 3, y: 12 },
      ground: [
        [0, 42],
        [46, 70],
        [74, 139],
      ],
      pipes: [
        { x: 30, h: 2 },
        { x: 52, h: 3 },
        { x: 88, h: 2 },
        { x: 96, h: 4 },
      ],
      blocks: [
        { x: 18, y: 9, type: "brick" },
        { x: 19, y: 9, type: "?" },
        { x: 20, y: 9, type: "brick" },
        { x: 21, y: 9, type: "!" }, // power-up
        { x: 22, y: 9, type: "brick" },
        { x: 20, y: 5, type: "?" }, // high coin block
        { x: 60, y: 9, type: "brick" },
        { x: 61, y: 9, type: "?" },
        { x: 62, y: 9, type: "brick" },
      ],
      coins: [
        { x: 43, y: 10 },
        { x: 44, y: 10 },
        { x: 45, y: 10 },
        { x: 34, y: 8 },
        { x: 35, y: 8 },
      ],
      stairs: [
        { x: 118, h: 4, dir: "up" },
        { x: 123, h: 4, dir: "down" },
      ],
      enemies: [
        { x: 26, y: 12, type: "goomba" },
        { x: 40, y: 12, type: "goomba" },
        { x: 58, y: 12, type: "koopa" },
        { x: 78, y: 12, type: "goomba" },
        { x: 82, y: 12, type: "goomba" },
        { x: 110, y: 12, type: "goomba" },
      ],
      flag: 133,
    },

    // =====================================================================
    // LEVEL 2 — "Sky Steps"  (more platforming, floating brick islands)
    // Gaps are kept to ~2 tiles (walk-jumpable). The "sky steps" are 2-wide
    // platforms, not single bricks, so landings are fair.
    // =====================================================================
    {
      name: "1-2  SKY STEPS",
      width: 160,
      time: 300,
      start: { x: 3, y: 12 },
      ground: [
        [0, 22],
        [25, 32], // 2-tile pit
        // sky-steps section bridges 33..44 via floating platforms
        [45, 54],
        [57, 72], // 2-tile pit
        [75, 90], // 2-tile pit
        [93, 159], // 2-tile pit (was an unfair 5-tile death gap)
      ],
      pipes: [
        { x: 16, h: 2 },
        { x: 64, h: 3 },
        { x: 108, h: 4 },
        { x: 112, h: 2 },
      ],
      blocks: [
        // optional floating reward above early ground
        { x: 27, y: 8, type: "brick" },
        { x: 28, y: 8, type: "?" },
        { x: 29, y: 8, type: "brick" },
        // sky steps over the pit (2-wide platforms, ~2-tile gaps, gentle climb)
        { x: 34, y: 11, type: "brick" },
        { x: 35, y: 11, type: "brick" },
        { x: 38, y: 9, type: "?" },
        { x: 39, y: 9, type: "brick" },
        { x: 42, y: 10, type: "brick" },
        { x: 43, y: 10, type: "brick" },
        // power-up island
        { x: 60, y: 7, type: "!" },
        { x: 61, y: 7, type: "brick" },
        // high coin bricks
        { x: 80, y: 6, type: "?" },
        { x: 81, y: 6, type: "brick" },
        { x: 82, y: 6, type: "?" },
      ],
      coins: [
        { x: 36, y: 8 },
        { x: 37, y: 8 },
        { x: 40, y: 7 },
        { x: 41, y: 7 },
        { x: 73, y: 9 },
        { x: 74, y: 9 },
        { x: 91, y: 9 },
        { x: 92, y: 9 },
      ],
      stairs: [
        { x: 130, h: 4, dir: "up" },
        { x: 135, h: 4, dir: "down" },
      ],
      enemies: [
        { x: 12, y: 12, type: "goomba" },
        { x: 28, y: 12, type: "koopa" },
        { x: 50, y: 12, type: "goomba" },
        { x: 52, y: 12, type: "goomba" },
        { x: 68, y: 12, type: "koopa" },
        { x: 85, y: 12, type: "goomba" },
        { x: 100, y: 12, type: "goomba" },
        { x: 120, y: 12, type: "koopa" },
      ],
      flag: 152,
    },

    // =====================================================================
    // LEVEL 3 — "Pipe Gauntlet"  (tougher: tight gaps, enemy clusters)
    // =====================================================================
    {
      name: "1-3  PIPE GAUNTLET",
      width: 180,
      time: 320,
      start: { x: 3, y: 12 },
      ground: [
        [0, 18],
        [21, 26], // 2-tile pits (walk-jumpable)
        [29, 34],
        [37, 60],
        [63, 84], // was a 5-tile death gap
        [87, 92],
        [95, 128],
        [131, 179], // was a 5-tile death gap
      ],
      pipes: [
        { x: 10, h: 3 },
        { x: 44, h: 4 },
        { x: 48, h: 2 },
        { x: 74, h: 5 },
        { x: 104, h: 3 },
        { x: 120, h: 4 },
      ],
      blocks: [
        { x: 23, y: 9, type: "?" },
        { x: 31, y: 9, type: "!" },
        { x: 54, y: 7, type: "brick" },
        { x: 55, y: 7, type: "?" },
        { x: 56, y: 7, type: "brick" },
        { x: 100, y: 8, type: "brick" },
        { x: 101, y: 8, type: "?" },
        { x: 102, y: 8, type: "brick" },
        { x: 103, y: 8, type: "!" },
        { x: 104, y: 8, type: "brick" },
      ],
      coins: [
        { x: 27, y: 8 },
        { x: 28, y: 7 },
        { x: 35, y: 8 },
        { x: 36, y: 7 },
        { x: 89, y: 9 },
        { x: 90, y: 9 },
        { x: 91, y: 9 },
      ],
      stairs: [
        { x: 150, h: 5, dir: "up" },
        { x: 156, h: 5, dir: "down" },
      ],
      enemies: [
        { x: 15, y: 12, type: "goomba" },
        { x: 40, y: 12, type: "goomba" },
        { x: 42, y: 12, type: "goomba" },
        { x: 52, y: 12, type: "koopa" },
        { x: 58, y: 12, type: "goomba" },
        { x: 70, y: 12, type: "goomba" },
        { x: 78, y: 12, type: "koopa" },
        { x: 98, y: 12, type: "goomba" },
        { x: 110, y: 12, type: "koopa" },
        { x: 115, y: 12, type: "goomba" },
        { x: 140, y: 12, type: "goomba" },
        { x: 143, y: 12, type: "goomba" },
      ],
      flag: 172,
    },
  ],
};
