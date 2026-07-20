// ---------------------------------------------------------------------------
// Global configuration & constants.
// All gameplay units are in "game pixels" at a fixed 60 FPS simulation step.
// ---------------------------------------------------------------------------

const CONFIG = {
  TILE: 16, // size of one tile in game pixels
  VIEW_W: 256, // internal render width  (16 tiles)
  VIEW_H: 240, // internal render height (15 tiles)
  FPS: 60,
  STEP: 1000 / 60, // ms per fixed simulation step

  // --- Player physics -------------------------------------------------------
  GRAVITY: 0.62,
  JUMP_GRAVITY: 0.5, // lighter gravity while rising and holding jump
  MAX_FALL: 9,

  WALK_ACCEL: 0.28,
  RUN_ACCEL: 0.42,
  MAX_WALK: 1.9,
  MAX_RUN: 3.4,
  FRICTION: 0.24,
  AIR_FRICTION: 0.06,
  TURN_BOOST: 0.55, // extra deceleration when reversing direction

  JUMP_SPEED: 8.4, // initial upward speed on jump
  BOUNCE_SPEED: 6.5, // upward speed after stomping an enemy

  // --- Enemies --------------------------------------------------------------
  ENEMY_SPEED: 0.55,
  SHELL_SPEED: 4.2,

  // --- Misc -----------------------------------------------------------------
  FIREBALL_SPEED: 4.5,
  STAR_TIME: 10 * 60, // invincibility duration in frames
  LEVEL_TIME: 300, // in-game seconds per level
};

// Tile type ids -------------------------------------------------------------
const T = {
  EMPTY: 0,
  GROUND: 1,
  BRICK: 2,
  QUESTION_COIN: 3,
  QUESTION_POWER: 4,
  BLOCK: 5, // hard/stair block
  PIPE_TL: 6,
  PIPE_TR: 7,
  PIPE_L: 8,
  PIPE_R: 9,
  USED: 10, // bumped/emptied block (solid)
  COIN: 11, // free-floating collectible coin (not solid)
  FLAG: 12, // flagpole
};

// Which tiles are solid (block movement).
const SOLID = new Set([
  T.GROUND,
  T.BRICK,
  T.QUESTION_COIN,
  T.QUESTION_POWER,
  T.BLOCK,
  T.PIPE_TL,
  T.PIPE_TR,
  T.PIPE_L,
  T.PIPE_R,
  T.USED,
]);

// Which tiles can be "bumped" from below.
const BUMPABLE = new Set([T.BRICK, T.QUESTION_COIN, T.QUESTION_POWER]);

// Maps the characters used in level strings to tile ids / spawn markers.
// Characters not listed here are treated as empty space.
const LEGEND = {
  "#": T.GROUND,
  B: T.BRICK,
  "?": T.QUESTION_COIN,
  "!": T.QUESTION_POWER,
  X: T.BLOCK,
  T: T.PIPE_TL,
  t: T.PIPE_TR,
  I: T.PIPE_L,
  i: T.PIPE_R,
  o: T.COIN,
  F: T.FLAG,
};

// Spawn markers handled separately from tiles (become entities, not tiles).
const SPAWN_CHARS = {
  g: "goomba",
  k: "koopa",
  S: "start",
};
