/**
 * diff-viewer — the parts of the page that are not the diff itself: the
 * unified/side-by-side toggle, and the two hooks review.js asks for so that a
 * comment can name the file and line it lands on.
 */
(function () {
  'use strict';

  /** Below this, two columns of code are too narrow to read. */
  var SPLIT_MIN_WIDTH = 1400;
  /** Lines of the diff quoted around a comment, on each side. */
  var CONTEXT_LINES = 2;

  var root = document.getElementById('mdv-root');
  var toggle = document.getElementById('dv-layout');

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  /** Whether the reader has picked a layout, which then outranks any guess. */
  var chosen = false;

  function apply(split) {
    root.classList.toggle('dv-split', split);
    root.classList.toggle('dv-unified', !split);
    toggle.checked = split;
  }

  function wideEnough() {
    return document.documentElement.clientWidth >= SPLIT_MIN_WIDTH;
  }

  function guess() {
    if (!chosen) {
      apply(wideEnough());
    }
  }

  // The width this reads is not final yet. A page zoom is applied while the
  // document loads, so a script running at the end of the body can see the
  // unzoomed width and a moment later the zoomed one — and at 90% zoom a window
  // that is too narrow for two columns becomes wide enough. Guessing once, from
  // whichever value happened to be current, is why two tabs of the same size
  // could disagree. So the guess is repeated as the width settles, and stops
  // the moment the reader picks for themselves.
  guess();
  window.addEventListener('DOMContentLoaded', guess);
  window.addEventListener('load', guess);
  window.addEventListener('resize', guess);

  toggle.addEventListener('change', function () {
    // From here on the layout is the reader's, and no width changes it back —
    // reflowing the page under someone part way through a review is worse than
    // showing them a layout they can undo.
    chosen = true;
    apply(toggle.checked);
  });

  // ---------------------------------------------------------------------------
  // Where a comment landed
  // ---------------------------------------------------------------------------

  /** The line a node sits in, which is what carries the number and the side. */
  function lineOf(node) {
    var element = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    return element && element.closest ? element.closest('.dv-line') : null;
  }

  /** The text of one line, without its gutters or its +/- marker. */
  function textOf(line) {
    var text = line.querySelector('.dv-text');
    return text ? text.textContent : '';
  }

  /** The diff marker a line would carry in a patch. */
  function markerOf(line) {
    var side = line.dataset.side;
    return side === 'add' ? '+' : side === 'del' ? '-' : ' ';
  }

  /**
   * The lines around a comment, as they appear in the diff. Line numbers drift
   * between revisions of a patch, so an agent given the surrounding text can
   * still find the passage when the numbers no longer match.
   */
  function contextOf(line) {
    var table = line.closest('.dv-table');
    if (!table) return [];
    // The mirrored copy of an unchanged line is the same line drawn again in
    // the other column, not a line of the diff, so it is left out of the quote.
    var lines = table.querySelectorAll('.dv-line:not(.dv-line-mirror)');
    var at = Array.prototype.indexOf.call(lines, line);
    if (at === -1) return [];

    var out = [];
    var from = Math.max(0, at - CONTEXT_LINES);
    var to = Math.min(lines.length - 1, at + CONTEXT_LINES);
    for (var i = from; i <= to; i++) {
      out.push({ text: markerOf(lines[i]) + textOf(lines[i]), here: i === at });
    }
    return out;
  }

  window.mdvReviewPlace = function (node) {
    var line = lineOf(node);
    if (!line) return null;
    var file = line.closest('.dv-file');
    return {
      path: file ? file.dataset.path : null,
      // A deletion has no line in the new file; say which side its number came
      // from, so it is not read against the wrong version.
      side: line.dataset.side === 'del' ? 'old' : 'new',
      context: contextOf(line),
    };
  };

  // ---------------------------------------------------------------------------
  // Copying the review out
  // ---------------------------------------------------------------------------

  window.mdvReviewPrompt = function (comments) {
    // Name the commit when the page is one. A reviewer reading a stack opens a
    // tab per sha and pastes each review somewhere else; without the id in the
    // text, two of these are indistinguishable once they leave the page — and
    // the sha is also what the receiving end needs in order to check out the
    // change being talked about.
    var sha = root.dataset.commit;
    var subject = root.dataset.subject;
    var what = sha
      ? 'commit ' + sha + (subject ? ' (' + subject + ')' : '')
      : 'the following diff';
    var out = ['Please address these review comments on ' + what + ':', ''];
    for (var i = 0; i < comments.length; i++) {
      var comment = comments[i];
      var place = comment.place || {};
      var where = place.path || 'unknown file';
      if (comment.line) {
        where += ':' + comment.line;
        // Only worth saying when it changes how the number should be read.
        if (place.side === 'old') where += ' (line number in the original file)';
      }

      out.push('- ' + where + ' — "' + comment.quote + '"');
      if (place.context && place.context.length) {
        out.push('');
        out.push('  ```diff');
        for (var j = 0; j < place.context.length; j++) {
          out.push('  ' + place.context[j].text);
        }
        out.push('  ```');
        out.push('');
      }
      out.push('  ' + comment.text.replace(/\n/g, '\n  '));
      out.push('');
    }
    return out.join('\n');
  };
})();
