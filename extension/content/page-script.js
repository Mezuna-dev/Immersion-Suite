(function () {
  'use strict';

  if (window.__immYTPageScript) return;
  window.__immYTPageScript = true;

  function pickTrack(tracks, preferredLang) {
    if (!tracks || !tracks.length) return null;
    if (preferredLang) {
      const exact = tracks.find(t => t.languageCode === preferredLang);
      if (exact) return exact;
      const prefix = tracks.find(t => (t.languageCode || '').startsWith(preferredLang));
      if (prefix) return prefix;
    }
    return tracks[0];
  }

  // window.ytInitialPlayerResponse is only reliable for the FIRST video - SPA
  // navigations often leave it stale, which used to re-announce the previous
  // video's id/track (and the content script then kept the old queue). Prefer
  // the navigate event's own payload, then the live player API, and use the
  // global only as a last resort.
  function getPlayerResponse(override) {
    if (override && override.videoDetails) return override;
    const player = document.getElementById('movie_player');
    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        const r = player.getPlayerResponse();
        if (r && r.videoDetails) return r;
      } catch (_) { /* fall through */ }
    }
    return window.ytInitialPlayerResponse;
  }

  function emitTrack(reason, respOverride) {
    const resp = getPlayerResponse(respOverride);
    const tracks = resp
      && resp.captions
      && resp.captions.playerCaptionsTracklistRenderer
      && resp.captions.playerCaptionsTracklistRenderer.captionTracks;

    const videoId = resp && resp.videoDetails && resp.videoDetails.videoId;
    const track = pickTrack(tracks, 'ja');

    window.postMessage({
      source: 'imm-yt',
      type: 'track',
      reason: reason,
      videoId: videoId || null,
      url: track ? track.baseUrl : null,
      languageCode: track ? track.languageCode : null,
      availableLanguages: (tracks || []).map(t => t.languageCode),
    }, '*');
  }

  emitTrack('initial');

  // SPA navigations between videos - YouTube fires this on the document after
  // the player has loaded the new video's metadata. The event detail carries
  // the fresh player response; pass it through so we never read stale globals.
  document.addEventListener('yt-navigate-finish', (e) => {
    const d = e && e.detail;
    emitTrack('navigate', d && d.response && d.response.playerResponse);
  });
  document.addEventListener('yt-player-updated', () => emitTrack('player-updated'));
})();
