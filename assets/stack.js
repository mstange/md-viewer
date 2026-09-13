/**
 * stack-viewer — switching between the commits of a stack, and copying the
 * review of the whole stack out.
 *
 * Each commit's page is the diff page diff-viewer serves, held in an iframe.
 * The pages are same-origin with this one, so this script can reach into a
 * frame: to hear how many comments it has, to forward the keys that switch
 * commits, and to read its comments out when the stack's review is copied.
 */
(function () {
  'use strict';

  var root = document.getElementById('sv-root');
  var pane = document.getElementById('sv-pane');
  var list = document.getElementById('sv-list');
  var review = document.getElementById('sv-review');
  var reviewCount = review.querySelector('.sv-review-count');
  var copyAll = document.getElementById('sv-review-copy');
  var listToggle = document.getElementById('sv-list-toggle');
  var entries = list.querySelectorAll('.sv-entry');

  /** @type {{sha: string, label: string, subject: string}[]} */
  var meta = JSON.parse(document.getElementById('sv-meta').textContent);
  /** The frame for each commit, once the reader has opened it. */
  var frames = new Array(meta.length);
  /** Comments on each commit so far, as its frame last reported them. */
  var counts = new Array(meta.length);
  var current = -1;

  // ---------------------------------------------------------------------------
  // Frames
  // ---------------------------------------------------------------------------

  /**
   * The frame for commit `i`, made on first use. Its document is set before
   * the frame joins the page: a frame that is navigated after it is in the
   * page adds an entry to the tab's history, and the back button would then
   * step through commits opened rather than pages visited.
   */
  function frameFor(i) {
    if (frames[i]) return frames[i];
    var frame = document.createElement('iframe');
    frame.className = 'sv-frame';
    frame.title = meta[i].subject || meta[i].label;
    frame.srcdoc = JSON.parse(document.getElementById('sv-page-' + i).textContent);
    frame.addEventListener('load', function () {
      attach(frame, i);
    });
    pane.appendChild(frame);
    frames[i] = frame;
    return frame;
  }

  /** Listen to a frame's page once it has loaded. */
  function attach(frame, i) {
    var win = frame.contentWindow;
    var doc = frame.contentDocument;
    if (!win || !doc) return;
    doc.addEventListener('mdv-review-change', function (event) {
      setCount(i, event.detail.count);
    });
    win.addEventListener('keydown', onKeyDown);
    if (i === current) win.focus();
  }

  function show(i) {
    if (i < 0 || i >= meta.length || i === current) return;
    var frame = frameFor(i);
    for (var j = 0; j < frames.length; j++) {
      if (frames[j]) frames[j].classList.toggle('sv-frame-current', j === i);
    }
    for (j = 0; j < entries.length; j++) {
      if (j === i) {
        entries[j].setAttribute('aria-current', 'true');
      } else {
        entries[j].removeAttribute('aria-current');
      }
    }
    current = i;
    if (entries[i].scrollIntoView) entries[i].scrollIntoView({ block: 'nearest' });
    document.title = (meta[i].subject || meta[i].label) + ' — ' + root.dataset.title;
    // The hash is where the reader is, so a reload comes back to the same
    // commit. Replaced rather than pushed: the back button should leave the
    // page, not retrace a review.
    history.replaceState(null, '', '#' + (i + 1));
    // The keys that switch commits are read from the frame, so it should
    // hold the focus. A frame still loading takes it when it arrives.
    if (frame.contentWindow && frame.contentDocument && frame.contentDocument.readyState === 'complete') {
      frame.contentWindow.focus();
    }
  }

  function fromHash() {
    var n = parseInt(location.hash.slice(1), 10);
    return n >= 1 && n <= meta.length ? n - 1 : 0;
  }

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  function setCount(i, count) {
    counts[i] = count;
    var badge = entries[i].querySelector('.sv-entry-comments');
    badge.hidden = !count;
    badge.textContent = count;

    var total = 0;
    var commits = 0;
    for (var j = 0; j < counts.length; j++) {
      if (counts[j]) {
        total += counts[j];
        commits++;
      }
    }
    review.hidden = total === 0;
    reviewCount.textContent =
      total +
      (total === 1 ? ' comment' : ' comments') +
      ' on ' +
      commits +
      (commits === 1 ? ' commit' : ' commits');
  }

  /**
   * The review of the whole stack: one preamble, then each commit that has
   * comments under a heading naming it, in the stack's order. Each commit's
   * entries are written by its own page, so a comment reads the same here as
   * it does copied out of that page alone.
   */
  function prompt() {
    var out = ['Please address these review comments on the following commits:', ''];
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      var win = frame && frame.contentWindow;
      if (!win || !win.mdvReviewComments || !win.mdvReviewEntries) continue;
      var comments = win.mdvReviewComments();
      if (!comments.length) continue;
      var heading = 'commit ' + meta[i].sha;
      if (meta[i].subject) heading += ' (' + meta[i].subject + ')';
      out.push('## ' + heading, '', win.mdvReviewEntries(comments).replace(/\s+$/, ''), '');
    }
    return out.join('\n');
  }

  function flash(button, message) {
    var original = button.textContent;
    button.textContent = message;
    button.disabled = true;
    setTimeout(function () {
      button.textContent = original;
      button.disabled = false;
    }, 1200);
  }

  copyAll.addEventListener('click', function () {
    var text = prompt();
    navigator.clipboard.writeText(text).then(
      function () {
        flash(copyAll, 'Copied');
      },
      function () {
        flash(copyAll, 'Copy failed');
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Keys and clicks
  // ---------------------------------------------------------------------------

  /**
   * Alt+Up and Alt+Down step through the stack, Alt+L hides the list. Alt
   * rather than bare letters, because a commit's page turns the first letter
   * typed after a selection into the start of a comment; and not while a text
   * field has the focus, where Alt+arrow moves the caret by a word.
   */
  function onKeyDown(event) {
    if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    var target = event.target;
    if (target && target.closest && target.closest('textarea, input, [contenteditable]')) return;
    if (event.key === 'ArrowDown') {
      show(current + 1);
    } else if (event.key === 'ArrowUp') {
      show(current - 1);
    } else if (event.key === 'l' || event.key === 'L' || event.code === 'KeyL') {
      toggleList();
    } else {
      return;
    }
    event.preventDefault();
  }

  function toggleList() {
    root.classList.toggle('sv-list-hidden');
  }

  list.addEventListener('click', function (event) {
    var entry = event.target.closest('.sv-entry');
    if (entry) show(Number(entry.dataset.index));
  });
  listToggle.addEventListener('click', toggleList);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('hashchange', function () {
    show(fromHash());
  });

  show(fromHash());
})();
