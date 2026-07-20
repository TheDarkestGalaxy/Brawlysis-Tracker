// ---------------------------------------------------------------------------
// Keyboard input. Tracks "held" state plus one-frame "pressed" edges so the
// game loop can distinguish a fresh jump press from a button being held.
//
// Usage per simulation step:
//   Input.beginFrame();  // compute edge flags (jumpPressed, ...)
//   ... game reads Input.* ...
//   Input.endFrame();    // remember state, clear one-shot flags
// ---------------------------------------------------------------------------

const Input = {
  left: false,
  right: false,
  up: false,
  down: false,
  jump: false,
  run: false,

  jumpPressed: false, // true for exactly one step after jump goes down
  runPressed: false, // true for exactly one step after run goes down
  pausePressed: false, // one-shot, set on keydown
  mutePressed: false, // one-shot, set on keydown
  anyPressed: false, // one-shot, any key this frame

  // Jump input buffer: a jump press stays "queued" for a few steps so a press
  // made slightly before landing still triggers a jump. This makes the
  // controls feel far more consistent/responsive.
  JUMP_BUFFER: 7,
  jumpBuffer: 0,

  _prevJump: false,
  _prevRun: false,

  init() {
    // Multiple keys map to each action. The extra letter keys (Z/X, J/K)
    // give combinations that avoid "keyboard ghosting", where many keyboards
    // cannot register Shift + an arrow + Space at the same time.
    const map = {
      ArrowLeft: "left",
      KeyA: "left",
      ArrowRight: "right",
      KeyD: "right",
      ArrowUp: "jump",
      KeyW: "jump",
      Space: "jump",
      KeyZ: "jump",
      KeyK: "jump",
      ArrowDown: "down",
      KeyS: "down",
      ShiftLeft: "run",
      ShiftRight: "run",
      KeyX: "run",
      KeyJ: "run",
    };

    window.addEventListener("keydown", (e) => {
      if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(
          e.code
        )
      ) {
        e.preventDefault();
      }
      if (e.repeat) return;
      this.anyPressed = true;
      if (e.code === "KeyP") this.pausePressed = true;
      if (e.code === "KeyM") this.mutePressed = true;
      const action = map[e.code];
      if (action) this[action] = true;
      if (action === "jump") this.jumpBuffer = this.JUMP_BUFFER;
    });

    window.addEventListener("keyup", (e) => {
      const action = map[e.code];
      if (action) this[action] = false;
    });

    window.addEventListener("blur", () => {
      this.left = this.right = this.up = this.down = false;
      this.jump = this.run = false;
      this.jumpBuffer = 0;
    });
  },

  beginFrame() {
    this.jumpPressed = this.jump && !this._prevJump;
    this.runPressed = this.run && !this._prevRun;
  },

  // Called by the player when a jump is actually performed.
  consumeJump() {
    if (this.jumpBuffer > 0) {
      this.jumpBuffer = 0;
      return true;
    }
    return false;
  },

  endFrame() {
    this._prevJump = this.jump;
    this._prevRun = this.run;
    if (this.jumpBuffer > 0) this.jumpBuffer--;
    this.pausePressed = false;
    this.mutePressed = false;
    this.anyPressed = false;
  },
};
