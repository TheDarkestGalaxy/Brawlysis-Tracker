// ---------------------------------------------------------------------------
// Horizontal-scrolling camera. Follows the player, keeping them roughly a
// third of the way from the left edge, clamped to the level bounds.
// ---------------------------------------------------------------------------

class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
  }

  follow(target, levelWidth) {
    // Desired: player sits ~40% across the screen.
    const desired = target.x + target.w / 2 - CONFIG.VIEW_W * 0.4;
    // Classic SMB never scrolls backwards past the furthest-right point.
    this.x = Math.max(this.x, desired);
    // Clamp to level bounds.
    this.x = Math.max(0, Math.min(this.x, levelWidth - CONFIG.VIEW_W));
  }

  reset() {
    this.x = 0;
    this.y = 0;
  }
}
