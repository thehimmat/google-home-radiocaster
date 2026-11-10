/**
 * Stall watchdog for the Cast receiver (cast-skin.html). A Nest Hub playing the raw /stream can
 * freeze in BUFFERING after a network blip: it keeps reopening the connection but never resumes.
 * Reloading the same media rejoins the live edge, so do that whenever the playback clock hasn't
 * moved for stallMs while the player should be playing. Plain script; also required by Jest.
 */
(function (root) {
  'use strict';

  function createStallWatchdog(opts) {
    var stallMs = opts.stallMs || 10000;
    var lastTime = opts.getTime();
    var lastMoved = opts.now();

    return {
      /** Call every couple of seconds. */
      check: function () {
        var now = opts.now();
        var state = opts.getState();
        var time = opts.getTime();
        // Any change counts as progress, including a reload restarting the clock at zero.
        if (time !== lastTime || (state !== 'PLAYING' && state !== 'BUFFERING')) {
          lastTime = time;
          lastMoved = now;
          return;
        }
        if (now - lastMoved >= stallMs) {
          lastMoved = now;
          opts.reload();
        }
      },
    };
  }

  var api = { createStallWatchdog: createStallWatchdog };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.castRecover = api;
})(typeof self !== 'undefined' ? self : this);
