(function () {
  'use strict';

  var root = document.getElementById('mdv-root');
  var article = document.getElementById('mdv-content');
  var status = document.getElementById('mdv-status');
  var file = root.dataset.file;
  var failures = 0;
  var flashTimer = null;

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = kind ? 'mdv-status ' + kind : 'mdv-status';
  }

  function flash() {
    root.classList.add('mdv-updated');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      root.classList.remove('mdv-updated');
    }, 700);
  }

  function addCopyButtons() {
    var blocks = article.querySelectorAll('pre > code');
    for (var i = 0; i < blocks.length; i++) {
      (function (code) {
        var pre = code.parentNode;
        if (pre.querySelector('.mdv-copy')) return;
        var button = document.createElement('button');
        button.className = 'mdv-copy';
        button.type = 'button';
        button.textContent = 'Copy';
        button.addEventListener('click', function () {
          navigator.clipboard.writeText(code.textContent).then(function () {
            button.textContent = 'Copied';
            setTimeout(function () {
              button.textContent = 'Copy';
            }, 1200);
          });
        });
        pre.appendChild(button);
      })(blocks[i]);
    }
  }

  function refresh() {
    fetch('/api/content?f=' + encodeURIComponent(file), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('http ' + response.status);
        return response.json();
      })
      .then(function (data) {
        if (data.missing) {
          setStatus('file deleted', 'warn');
          return;
        }
        setStatus('');
        article.innerHTML = data.html;
        document.title = data.title;
        addCopyButtons();
        flash();
      })
      .catch(function () {
        setStatus('reload failed', 'warn');
      });
  }

  function connect() {
    var source = new EventSource('/api/events?f=' + encodeURIComponent(file));
    source.addEventListener('open', function () {
      failures = 0;
      setStatus('');
    });
    source.addEventListener('change', refresh);
    source.addEventListener('gone', function () {
      setStatus('file deleted', 'warn');
    });
    // EventSource reconnects on its own; only complain once it keeps failing,
    // which normally means md-viewer has exited.
    source.addEventListener('error', function () {
      if (++failures > 2) setStatus('md-viewer stopped', 'dead');
    });
  }

  // Let the server know the document is going away, so that closing the tab
  // returns the shell prompt at once instead of waiting out a timeout. A reload
  // or a navigation sends this too, which the server sorts out for itself.
  window.addEventListener('pagehide', function (event) {
    // Entering the back/forward cache is not going away: this same document
    // comes back, event stream and all, with no request in between for the
    // server to notice.
    if (event.persisted) return;
    navigator.sendBeacon('/api/bye', '');
  });

  addCopyButtons();
  connect();
})();
