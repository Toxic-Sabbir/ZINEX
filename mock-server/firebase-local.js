/*
 * Local Firebase redirection shim.
 *
 * The mirrored frontend was built against Firebase. This script points the
 * Firebase Auth REST calls and the Realtime Database WebSocket at the local
 * mock backend so registration, login and the internal interfaces all work
 * offline with any dummy credentials. It is injected by mock-server/server.js
 * and does not modify the mirrored HTML on disk.
 */
(function () {
  'use strict';

  var LOCALS = ['localhost', '127.0.0.1'];
  // Inherit the page's scheme so the mirror also works behind an HTTPS proxy
  // (an http:// origin on an https:// page is blocked as mixed content).
  var LOCAL_ORIGIN = (location.protocol || 'http:') + '//' + (location.host || 'localhost:12000');

  // Drop stale Firebase caches left by any earlier session so the SDK
  // re-resolves the database host against this local mirror.
  try {
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var key = localStorage.key(i);
      if (key && (key.indexOf('firebase:host:') === 0 || key === 'firebase:previous_websocket_failure')) {
        localStorage.removeItem(key);
      }
    }
  } catch (e) {
    /* storage unavailable */
  }

  function isLocalHost(host) {
    return LOCALS.some(function (h) {
      return host === h || host.indexOf(h + ':') === 0;
    });
  }

  function rewrite(url) {
    try {
      var abs = new URL(url, location.href);
      // Firebase Auth REST (identitytoolkit / securetoken)
      if (/identitytoolkit\.googleapis\.com$/.test(abs.host) || /securetoken\.googleapis\.com$/.test(abs.host)) {
        return LOCAL_ORIGIN + abs.pathname + abs.search;
      }
      // Firebase Realtime Database
      if (/firebasedatabase\.app$/.test(abs.host) || /firebaseio\.com$/.test(abs.host)) {
        return LOCAL_ORIGIN + abs.pathname + abs.search;
      }
    } catch (e) {
      /* leave url untouched */
    }
    return url;
  }

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      input = rewrite(input);
    } else if (input && input.url) {
      var rewritten = rewrite(input.url);
      if (rewritten !== input.url) input = new Request(rewritten, input);
    }
    return nativeFetch(input, init);
  };

  var NativeWebSocket = window.WebSocket;
  function LocalWebSocket(url, protocols) {
    if (typeof url === 'string') {
      var absolute = url;
      if (absolute.indexOf('ws://') !== 0 && absolute.indexOf('wss://') !== 0) {
        absolute = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + url;
      }
      try {
        var parsed = new URL(absolute);
        if (/firebasedatabase\.app$/.test(parsed.host) || /firebaseio\.com$/.test(parsed.host)) {
          parsed.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          parsed.host = location.host;
          url = parsed.toString();
        }
      } catch (e) {
        /* leave url untouched */
      }
    }
    return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
  }
  LocalWebSocket.prototype = NativeWebSocket.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
    LocalWebSocket[k] = NativeWebSocket[k];
  });
  window.WebSocket = LocalWebSocket;

  window.__COCO_LOCAL__ = true;
})();
