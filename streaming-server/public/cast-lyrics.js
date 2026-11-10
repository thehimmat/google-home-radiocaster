/**
 * Lyrics on the Cast receiver (cast-skin.html): follows the shabad being sung on the station the
 * device is playing, from the radio's /now-playing/<slug>/events stream, and draws it beside the
 * station card. Plain script (no build step); the same functions are required by Jest.
 *
 * Manual test (needs a Hub registered as a test device for app 85E83F4E in the Cast console):
 *   1. Check https://stream.atthebunga.com/now-playing/golden-temple shows "state":"showing".
 *   2. `npm run cast-now "Golden Temple"` (or cast from radio.atthebunga.com in Chrome).
 *   3. The Hub shows the card on the left and the shabad on the right, the sung line bright.
 *      Within a few seconds of the follower moving on, the highlight moves.
 *   4. When the follower goes idle (pauses, Fateh), the screen returns to the centered card.
 *   5. Cast a station without lyrics: only the centered card, nothing broken.
 */
(function (root) {
  'use strict';

  /** The now-playing event stream for a stream URL like https://host/<slug>/stream. */
  function eventsUrl(mediaUrl) {
    try {
      var u = new URL(mediaUrl);
      var slug = u.pathname.split('/').filter(Boolean)[0];
      return slug ? u.origin + '/now-playing/' + encodeURIComponent(slug) + '/events' : null;
    } catch (e) {
      return null;
    }
  }

  /** What the screen shows for one now-playing answer, or null to show the plain station card. */
  function lyricsView(data) {
    if (!data || data.state !== 'showing' || !data.shabad || !Array.isArray(data.lines)) return null;
    return {
      source: data.shabad.section + ', Ang ' + data.shabad.page,
      lines: data.lines,
      current: data.line && typeof data.line.index === 'number' ? data.line.index : -1,
      shabadId: String(data.shabad.id),
    };
  }

  /** Calls onChange with each new view (null when nothing is shown). Returns the stop function. */
  function follow(mediaUrl, onChange, EventSourceImpl) {
    var url = eventsUrl(mediaUrl);
    if (!url) return function () {};
    var source = new EventSourceImpl(url);
    source.onmessage = function (e) {
      var data;
      try {
        data = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      onChange(lyricsView(data));
    };
    // EventSource reconnects by itself; clear the screen until it does.
    source.onerror = function () {
      onChange(null);
    };
    return function () {
      source.close();
    };
  }

  /** Draws views into the receiver page. Rebuilds the lines only when the shabad changes. */
  function createRenderer(doc) {
    var shownId = null;
    var listEl = doc.getElementById('lyricsLines');
    return function render(view) {
      doc.body.classList.toggle('has-lyrics', !!view);
      if (!view) return;
      doc.getElementById('lyricsSource').textContent = view.source;
      if (view.shabadId !== shownId) {
        shownId = view.shabadId;
        listEl.textContent = '';
        view.lines.forEach(function (text) {
          var li = doc.createElement('li');
          li.textContent = text;
          listEl.appendChild(li);
        });
      }
      var items = listEl.children;
      for (var i = 0; i < items.length; i++) items[i].classList.toggle('current', i === view.current);
      var active = items[view.current];
      // Keep the sung line about a third of the way down the panel.
      if (active) listEl.scrollTop = active.offsetTop - listEl.clientHeight / 3;
    };
  }

  var api = { eventsUrl: eventsUrl, lyricsView: lyricsView, follow: follow, createRenderer: createRenderer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.castLyrics = api;
})(typeof self !== 'undefined' ? self : this);
