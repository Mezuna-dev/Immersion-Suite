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

  function emitTrack(reason) {
    const resp = window.ytInitialPlayerResponse;
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

  // SPA navigations between videos — YouTube fires this on the document after
  // the player has loaded the new video's metadata.
  document.addEventListener('yt-navigate-finish', () => emitTrack('navigate'));
  document.addEventListener('yt-player-updated', () => emitTrack('player-updated'));
})();
