// ---------------------------------------------------------------------------
// Entry point: wire up the DOM, initialise subsystems, and kick off the loop.
// ---------------------------------------------------------------------------

window.addEventListener("load", () => {
  const canvas = document.getElementById("game");
  const overlay = document.getElementById("overlay");
  const startBtn = document.getElementById("start-btn");
  const subtitle = document.getElementById("overlay-subtitle");

  Renderer.init(canvas);
  Input.init();
  Sound.init();

  const game = new Game(canvas, overlay);
  window.game = game; // handy for debugging in the console
  game.run();

  const begin = () => {
    Sound.resume();
    // First user gesture: (re)create audio if the browser blocked it earlier.
    if (!Sound.ctx) Sound.init();
    game.startNewGame();
  };

  startBtn.addEventListener("click", begin);

  // Allow starting / restarting from the keyboard too.
  window.addEventListener("keydown", (e) => {
    if (
      (e.code === "Enter" || e.code === "Space") &&
      (game.mode === "title")
    ) {
      begin();
    }
  });

  // Update the title-screen subtitle with a tiny hint.
  if (subtitle) {
    subtitle.textContent = "3 custom levels · stomp, grow, throw fireballs";
  }
});
