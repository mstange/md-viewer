/**
 * diff-viewer — the parts of the page that are not the diff itself: the
 * unified/side-by-side toggle, and the hooks review.js asks for so that a
 * comment can name the file and lines it lands on, read only the column it was
 * drawn in, and be copied out as something a patch reader can follow.
 */
(function () {
  'use strict';

  /** Below this, two columns of code are too narrow to read. */
  var SPLIT_MIN_WIDTH = 1400;
  /** Lines of the diff quoted either side of the lines a comment covers. */
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
   * The lines of the diff a comment covers, plus a few either side. Line
   * numbers drift between revisions of a patch, so an agent given the
   * surrounding text can still find the passage when the numbers no longer
   * match.
   *
   * The window runs from the comment's first line to its last, not outwards
   * from wherever it started: a comment on four added lines used to quote two
   * lines either side of the first of them, cutting off the code it was about.
   */
  function contextOf(first, last) {
    var table = first.closest('.dv-table');
    if (!table) return [];
    var lines = patchOrder(table);
    var start = lines.indexOf(first);
    var end = lines.indexOf(last || first);
    if (start === -1) return [];
    if (end < start) end = start;

    var out = [];
    var from = Math.max(0, start - CONTEXT_LINES);
    var to = Math.min(lines.length - 1, end + CONTEXT_LINES);
    for (var i = from; i <= to; i++) {
      out.push({ text: markerOf(lines[i]) + textOf(lines[i]), here: i >= start && i <= end });
    }
    return out;
  }

  /**
   * A file's lines in the order the patch has them.
   *
   * The page pairs each deletion with the insertion that replaced it, so that
   * side by side can draw the two on one line; in the markup they then
   * alternate. A patch does not alternate — it gives a run of deletions and
   * then the run of insertions that replaced them — and a quote that reads
   * `-old +new -old +new` is not a diff anyone or anything can apply. So each
   * run of changed lines is put back in the order it was in, which unchanged
   * lines break.
   */
  function patchOrder(table) {
    // The mirrored copy of an unchanged line is the same line drawn again in
    // the other column, not a line of the diff, so it is left out of the quote.
    var lines = table.querySelectorAll('.dv-line:not(.dv-line-mirror)');
    var out = [];
    var dels = [];
    var adds = [];
    var flush = function () {
      out = out.concat(dels, adds);
      dels = [];
      adds = [];
    };

    for (var i = 0; i < lines.length; i++) {
      var side = lines[i].dataset.side;
      if (side === 'del') {
        dels.push(lines[i]);
      } else if (side === 'add') {
        adds.push(lines[i]);
      } else {
        flush();
        out.push(lines[i]);
      }
    }
    flush();
    return out;
  }

  /**
   * The half of the diff a comment written at this node belongs to.
   *
   * Side by side draws two versions of a file in two columns, but a changed
   * line puts its deletion and its insertion next to each other in the markup,
   * so a range dragged down one column runs through the other on the way. A
   * comment means the column it was drawn in, and this is what says so.
   *
   * Unified has one column, and there is nothing to separate: every line of it
   * is text the reader is reading, in the order they read it.
   */
  window.mdvReviewScope = function (which) {
    // A name is a comment asking for the scope it recorded; a node is a live
    // selection, which only has a side to be on when the columns are drawn.
    var side = which.name;
    if (!side) {
      if (!root.classList.contains('dv-split')) return null;
      var line = lineOf(which.node);
      if (!line) return null;
      side = line.dataset.side;
      // An unchanged line is drawn in both columns, so a selection starting on
      // one says nothing yet about which side is meant. It keeps both, and
      // reads as a unified diff does: deletion, then what replaced it.
      if (side !== 'del' && side !== 'add') return null;
    }

    var other = side === 'del' ? 'add' : 'del';
    return {
      name: side,
      test: function (textNode) {
        var at = lineOf(textNode);
        // Context lines are shared ground: they read the same on both sides.
        return !at || at.dataset.side !== other;
      },
    };
  };

  window.mdvReviewPlace = function (node, range) {
    var line = lineOf(node);
    if (!line) return null;
    var file = line.closest('.dv-file');
    // The end of a range can sit just past the last line it covers — on the
    // row after it, or on a node with no line at all — in which case the line
    // the comment started on is the best last line there is.
    var last = (range && lineOf(range.endContainer)) || line;

    // A comment on the commit message. Its number is a line of the message,
    // which is not a line of any file, so it is reported as its own kind of
    // place rather than as a path — a review that said "foo.js:3" for a claim
    // in the message would send the reader to the wrong text entirely.
    if (line.dataset.side === 'msg') {
      return {
        message: true,
        line: Number(line.dataset.msgLine) || null,
        context: contextOf(line, last),
      };
    }

    return {
      path: file ? file.dataset.path : null,
      // A deletion has no line in the new file; say which side its number came
      // from, so it is not read against the wrong version.
      side: line.dataset.side === 'del' ? 'old' : 'new',
      context: contextOf(line, last),
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
    return ['Please address these review comments on ' + what + ':', '', entries(comments)].join('\n');
  };

  /**
   * The comments as the entries of a review, without the line that says what
   * the review is of. A page holding several of these pages writes that line
   * itself, once, and then a heading per commit above each commit's entries.
   */
  window.mdvReviewEntries = entries;

  function entries(comments) {
    var out = [];
    for (var i = 0; i < comments.length; i++) {
      var comment = comments[i];
      var place = comment.place || {};
      var where;
      if (place.message) {
        // A comment on the message names the message, not a file. Its number
        // counts lines of the message text, which is worth saying: it is not a
        // line of anything the patch touches.
        where = 'the commit message';
        if (place.line) where += ', line ' + place.line;
      } else {
        where = place.path || 'unknown file';
        if (comment.line) {
          where += ':' + comment.line;
          // Only worth saying when it changes how the number should be read.
          if (place.side === 'old') where += ' (line number in the original file)';
        }
      }

      var context = place.context || [];
      var covered = context.filter(function (entry) {
        return entry.here;
      });
      // Where a comment sits within one line, the words it is about are worth
      // saying outright. Where it spans lines they are not: the quote runs
      // several lines of code together on one, which is harder to read than the
      // diff below — and less exact, since the diff says which lines they were.
      if (covered.length > 1) {
        // Drop the +/- marker: it is in the diff below, and reads as part of
        // the code when the line is quoted on its own.
        var opening = covered[0].text.slice(1).trim();
        out.push('- ' + where + ' — ' + covered.length + ' lines from "' + opening + '"');
      } else {
        out.push('- ' + where + ' — "' + comment.quote + '"');
      }

      if (context.length) {
        out.push('');
        // The block stays a diff anyone can apply, so the lines the comment is
        // about are not marked inside it — the line number and the quote above
        // are what point into it. The message is prose rather than a patch, so
        // it is quoted as text: calling it a diff would put a marker column in
        // front of English sentences and invite an agent to apply it.
        out.push(place.message ? '  ```' : '  ```diff');
        for (var j = 0; j < context.length; j++) {
          // Every message line carries the marker a context line would; on
          // prose that leading space is noise, so it comes back off.
          out.push('  ' + (place.message ? context[j].text.slice(1) : context[j].text));
        }
        out.push('  ```');
        out.push('');
      }
      out.push('  ' + comment.text.replace(/\n/g, '\n  '));
      out.push('');
    }
    return out.join('\n');
  }
})();
