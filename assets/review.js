/**
 * Review mode — select text in the preview, attach a comment, copy the lot out
 * as a prompt for an agent to act on.
 *
 * Comments live in this page only. A reload starts over, which is the point:
 * they are a scratchpad for one pass over a file, not a stored artefact.
 *
 * Each comment holds a content anchor (the selected text plus the text either
 * side of it) rather than a DOM position, so a comment survives the live-reload
 * re-render as long as the passage it refers to is still there.
 */
(function () {
  'use strict';

  /** Characters of context kept on each side of the selection. */
  var CONTEXT_CHARS = 50;
  /** Selection has to hold still this long before the comment box appears. */
  var SELECTION_SETTLE_MS = 200;

  var article = document.getElementById('mdv-content');
  var bar = document.getElementById('mdv-review');
  var count = bar.querySelector('.mdv-review-count');
  var copy = bar.querySelector('.mdv-review-copy');

  /**
   * @type {{id: string, text: string, anchor: object, quote: string,
   *   line: number|null, place: object|null, scope: string|null}[]}
   */
  var comments = [];
  var nextId = 1;
  var pending = null;
  var selectionTimer = null;
  var mouseDown = false;

  // ---------------------------------------------------------------------------
  // Text walking
  // ---------------------------------------------------------------------------

  /**
   * Call fn for each text node under root, stopping at the first truthy result.
   *
   * Text marked `.mdv-aside` is skipped: it is on the page to be looked at, not
   * to be read as part of the document. A diff uses it for the line numbers and
   * the +/- markers in the gutters, and for the second copy of an unchanged line
   * that side by side draws in the other column. Counting any of it would put
   * every anchor past it at the wrong offset, and paste a column of line numbers
   * into the middle of a quoted passage.
   *
   * `test`, when a scope supplies one, narrows the walk further — see scopeOf.
   */
  function walkText(root, fn, test) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (node.parentElement && node.parentElement.closest('.mdv-aside')) {
          return NodeFilter.FILTER_REJECT;
        }
        return test && !test(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    var node;
    while ((node = walker.nextNode())) {
      var result = fn(node);
      if (result) return result;
    }
    return null;
  }

  /**
   * What counts as one readable document, for a comment written at this node.
   *
   * Usually the whole article: a markdown file reads top to bottom and every
   * word of it belongs to the same text. A diff shown side by side does not.
   * Its two columns are two versions of a file drawn next to each other, and a
   * selection dragged down one of them means that column only — but the
   * deletions and insertions of a changed line are siblings in the markup, so
   * the browser's own range runs through both. Reading it straight is how a
   * comment on four new lines came back quoting a deleted one from between
   * them. So the page gets to say which text a comment can see, and everything
   * that reads text — the quote, the anchor, the highlight — reads through it.
   *
   * A scope is named as well as tested, because a comment outlives the nodes it
   * was written against: after a live reload its anchor has to be read back
   * against the same text it came from, and by then there is no selection left
   * to ask. The name is what a comment keeps.
   * @returns {{name: string, test: function(Node): boolean}|null}
   */
  function scopeOf(node) {
    return window.mdvReviewScope ? window.mdvReviewScope({ node: node }) : null;
  }

  /** The scope a comment recorded, rebuilt against the nodes now on the page. */
  function scopeNamed(name) {
    if (!name || !window.mdvReviewScope) return null;
    return window.mdvReviewScope({ name: name });
  }

  /** The predicate half of a scope, which is all walkText needs. */
  function testOf(scope) {
    return scope ? scope.test : null;
  }

  /** The text of the document a comment sits in, as walkText sees it. */
  function articleText(test) {
    var text = '';
    walkText(
      article,
      function (node) {
        text += node.textContent;
        return false;
      },
      test
    );
    return text;
  }

  /**
   * The text a range covers, as walkText sees it. `range.toString()` walks the
   * real DOM, so a selection spanning more than one line also picks up the line
   * numbers between them, and on a diff shown side by side the mirrored copy of
   * every unchanged line it crossed. What the reader means by their selection is
   * the text they can read, once, which is what this returns.
   */
  function rangeText(range, test) {
    var text = '';
    walkText(
      walkRoot(range),
      function (node) {
        if (!range.intersectsNode(node)) return false;
        var from = node === range.startContainer ? range.startOffset : 0;
        var to = node === range.endContainer ? range.endOffset : node.textContent.length;
        text += node.textContent.slice(from, to);
        return false;
      },
      test
    );
    return text;
  }

  /**
   * An element to walk a range from. A TreeWalker never visits its own root, so
   * a range that sits inside one text node — the usual case for a selection
   * within a paragraph — has to be walked from that node's parent.
   */
  function walkRoot(range) {
    var root = range.commonAncestorContainer;
    return root.nodeType === Node.TEXT_NODE ? root.parentNode : root;
  }

  /** Character offset of a (node, offset) position within articleText(). */
  function offsetOf(container, containerOffset, test) {
    var total = 0;
    var found = -1;
    walkText(
      article,
      function (node) {
        if (node === container) {
          found = total + containerOffset;
          return true;
        }
        total += node.textContent.length;
        return false;
      },
      test
    );
    return found;
  }

  // ---------------------------------------------------------------------------
  // Anchors: a Range becomes text plus its surroundings, and back again
  // ---------------------------------------------------------------------------

  function createAnchor(range, test) {
    var full = articleText(test);
    var exact = rangeText(range, test);
    var start = offsetOf(range.startContainer, range.startOffset, test);
    if (start === -1) start = full.indexOf(exact);
    var end = start + exact.length;

    return {
      prefix: full.slice(Math.max(0, start - CONTEXT_CHARS), start),
      exact: exact,
      suffix: full.slice(end, Math.min(full.length, end + CONTEXT_CHARS)),
    };
  }

  /**
   * Find where an anchor now sits, and return a Range over it. Tries the full
   * prefix+exact+suffix pattern first, so that a passage repeated verbatim
   * elsewhere in the file does not steal the comment, and falls back to the
   * selected text alone once an edit has disturbed the surroundings.
   */
  function findAnchor(anchor, test) {
    var full = articleText(test);
    var start = -1;

    var at = full.indexOf(anchor.prefix + anchor.exact + anchor.suffix);
    if (at !== -1) {
      start = at + anchor.prefix.length;
    } else {
      // Anchoring on one side still beats anchoring on neither.
      at = full.indexOf(anchor.prefix + anchor.exact);
      if (at !== -1) {
        start = at + anchor.prefix.length;
      } else {
        at = full.indexOf(anchor.exact + anchor.suffix);
        start = at !== -1 ? at : full.indexOf(anchor.exact);
      }
    }

    if (start === -1 || !anchor.exact) return null;
    return rangeOverOffsets(start, start + anchor.exact.length, test);
  }

  function rangeOverOffsets(start, end, test) {
    var seen = 0;
    var startNode = null;
    var startOffset = 0;
    var endNode = null;
    var endOffset = 0;

    walkText(
      article,
      function (node) {
        var len = node.textContent.length;
        if (!startNode && seen + len > start) {
          startNode = node;
          startOffset = start - seen;
        }
        if (startNode && seen + len >= end) {
          endNode = node;
          endOffset = end - seen;
          return true;
        }
        seen += len;
        return false;
      },
      test
    );

    if (!startNode || !endNode) return null;
    var range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  /** Source line of the block a node sits in, if the renderer recorded one. */
  function lineOf(node) {
    var element = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    var block = element && element.closest ? element.closest('[data-line]') : null;
    return block ? Number(block.dataset.line) : null;
  }

  /**
   * Where a comment points, beyond its line. A markdown document is one file,
   * so there is nothing more to say; a diff spans several, and sets this hook
   * to name the file and quote the surrounding lines.
   * @returns {object|null} extra fields merged into the comment
   */
  function placeOf(node, range) {
    return window.mdvReviewPlace ? window.mdvReviewPlace(node, range) : null;
  }

  // ---------------------------------------------------------------------------
  // Highlights
  // ---------------------------------------------------------------------------

  function highlight(range, id, test) {
    var marks = [];
    // surroundContents throws whenever the range crosses an element boundary,
    // which any selection spanning a link or a bold run does.
    try {
      var mark = newMark(id);
      range.surroundContents(mark);
      marks.push(mark);
    } catch (error) {
      marks = wrapAcrossNodes(range, id, test);
    }
    for (var i = 0; i < marks.length; i++) {
      bindMark(marks[i], id);
    }
    return marks;
  }

  function newMark(id) {
    var mark = document.createElement('mark');
    mark.className = 'mdv-mark';
    if (id) mark.dataset.commentId = id;
    return mark;
  }

  /** Wrap each text node the range touches, one mark per node. */
  function wrapAcrossNodes(range, id, test) {
    var nodes = [];
    walkText(
      walkRoot(range),
      function (node) {
        if (range.intersectsNode(node)) nodes.push(node);
        return false;
      },
      test
    );

    var marks = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var text = node.textContent;
      var from = node === range.startContainer ? range.startOffset : 0;
      var to = node === range.endContainer ? range.endOffset : text.length;
      if (from >= to) continue;

      var parent = node.parentNode;
      var mark = newMark(id);
      mark.textContent = text.slice(from, to);
      if (from) parent.insertBefore(document.createTextNode(text.slice(0, from)), node);
      parent.insertBefore(mark, node);
      if (to < text.length) parent.insertBefore(document.createTextNode(text.slice(to)), node);
      parent.removeChild(node);
      marks.push(mark);
    }
    return marks;
  }

  function bindMark(mark, id) {
    if (!id) return;
    mark.addEventListener('click', function (event) {
      event.stopPropagation();
      openBox(mark, id);
    });
  }

  function unwrap(mark) {
    var parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  }

  function clearMarks(selector) {
    var marks = article.querySelectorAll(selector);
    for (var i = 0; i < marks.length; i++) {
      unwrap(marks[i]);
    }
  }

  // ---------------------------------------------------------------------------
  // The comment box
  // ---------------------------------------------------------------------------

  function closeBox() {
    var box = document.querySelector('.mdv-review-box');
    if (box) box.remove();
  }

  /** Save whatever is in the open box, then close it. */
  function commitBox() {
    var box = document.querySelector('.mdv-review-box');
    if (!box) return;
    var text = box.querySelector('textarea').value.trim();
    var id = box.dataset.commentId;

    if (id) {
      var comment = find(id);
      if (!text) {
        remove(id);
      } else if (comment && comment.text !== text) {
        comment.text = text;
      }
    } else if (text) {
      keep(text);
    } else {
      discardPending();
    }
    closeBox();
  }

  function openBox(anchorElement, id) {
    var open = document.querySelector('.mdv-review-box');
    if (open && open.dataset.commentId === id) {
      open.querySelector('textarea').focus();
      return;
    }
    commitBox();

    var comment = id ? find(id) : null;
    var box = document.createElement('div');
    box.className = 'mdv-review-box';
    if (id) box.dataset.commentId = id;
    box.innerHTML =
      '<textarea rows="3" placeholder="Comment on the selected text…"></textarea>' +
      '<div class="mdv-review-hint"><span>↵ save</span>' +
      '<span>⇧↵ newline</span>' +
      (comment ? '<span>empty ↵ delete</span>' : '<span>esc cancel</span>') +
      '</div>';

    var rect = anchorElement.getBoundingClientRect();
    box.style.top = rect.bottom + window.scrollY + 8 + 'px';
    document.body.appendChild(box);

    // Placed after insertion so the box has a width to centre and clamp against.
    var width = box.offsetWidth;
    var centred = rect.left + window.scrollX + rect.width / 2 - width / 2;
    var margin = 8;
    var max = document.documentElement.clientWidth - width - margin;
    box.style.left = Math.max(margin, Math.min(centred, max)) + 'px';

    var textarea = box.querySelector('textarea');
    textarea.value = comment ? comment.text : '';
    textarea.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        commitBox();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (!id) discardPending();
        closeBox();
      }
    });
    textarea.focus();
  }

  // ---------------------------------------------------------------------------
  // The comment list
  // ---------------------------------------------------------------------------

  function find(id) {
    for (var i = 0; i < comments.length; i++) {
      if (comments[i].id === id) return comments[i];
    }
    return null;
  }

  function keep(text) {
    if (!pending) return;
    var id = 'c' + nextId++;
    comments.push({
      id: id,
      text: text,
      anchor: pending.anchor,
      quote: pending.quote,
      line: pending.line,
      place: pending.place,
      scope: pending.scope,
    });

    // The provisional highlight becomes this comment's own.
    var marks = article.querySelectorAll('mark.mdv-mark-pending');
    for (var i = 0; i < marks.length; i++) {
      marks[i].classList.remove('mdv-mark-pending');
      marks[i].dataset.commentId = id;
      bindMark(marks[i], id);
    }
    pending = null;
    render();
  }

  function remove(id) {
    for (var i = 0; i < comments.length; i++) {
      if (comments[i].id === id) {
        comments.splice(i, 1);
        break;
      }
    }
    clearMarks('mark.mdv-mark[data-comment-id="' + id + '"]');
    render();
  }

  function discardPending() {
    clearMarks('mark.mdv-mark-pending');
    pending = null;
  }

  function render() {
    var total = comments.length;
    bar.hidden = total === 0;
    count.textContent = total + (total === 1 ? ' comment' : ' comments');
  }

  /**
   * Re-attach the highlights after a live reload replaced the article. A
   * comment whose passage is gone keeps its text and still gets copied out,
   * it just has nothing left to point at.
   */
  function reattach() {
    for (var i = 0; i < comments.length; i++) {
      var comment = comments[i];
      // The anchor was recorded from one column's text, so it only reads back
      // against that same column — which is why the comment kept its name.
      var test = testOf(scopeNamed(comment.scope));
      var range = findAnchor(comment.anchor, test);
      if (!range) continue;
      // The line may have moved with the edit that triggered the reload.
      var line = lineOf(range.startContainer);
      if (line) comment.line = line;
      highlight(range, comment.id, test);
    }
    render();
  }

  // ---------------------------------------------------------------------------
  // Selecting text
  // ---------------------------------------------------------------------------

  function scheduleSelection() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(handleSelection, SELECTION_SETTLE_MS);
  }

  function handleSelection() {
    var selection = window.getSelection();
    if (!selection.rangeCount) return;
    if (!selection.toString().trim()) return;

    var range = selection.getRangeAt(0);
    if (!article.contains(range.commonAncestorContainer)) return;
    // Where the drag began is what says which column the reader meant, so the
    // scope comes from the start of the selection and not from its extent.
    var scope = scopeOf(range.startContainer);
    // Not selection.toString(): see rangeText().
    var text = rangeText(range, testOf(scope)).trim();
    if (!text) return;

    // Selecting inside an existing comment's highlight means editing it, and
    // selecting inside the box itself is just ordinary text selection.
    var node = range.startContainer;
    var element = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    if (element.closest('.mdv-review-box, .mdv-review-bar, mark.mdv-mark[data-comment-id]')) {
      return;
    }

    discardPending();
    // Unwrapping the old provisional mark rebuilt the text nodes the selection
    // pointed into, so take the selection again before trusting it.
    selection = window.getSelection();
    if (!selection.rangeCount || !selection.toString().trim()) return;
    range = selection.getRangeAt(0);
    scope = scopeOf(range.startContainer);
    text = rangeText(range, testOf(scope)).trim();
    if (!text) return;

    pending = {
      anchor: createAnchor(range, testOf(scope)),
      quote: text,
      line: lineOf(range.startContainer),
      place: placeOf(range.startContainer, range),
      scope: scope ? scope.name : null,
    };

    var marks = highlight(range, null, testOf(scope));
    for (var i = 0; i < marks.length; i++) {
      marks[i].classList.add('mdv-mark-pending');
    }
    selection.removeAllRanges();

    closeBox();
    if (marks.length) openBox(marks[0], null);
  }

  // ---------------------------------------------------------------------------
  // Copying the review out
  // ---------------------------------------------------------------------------

  function prompt(file) {
    // A diff spans many files and has no single subject, so it writes its own
    // preamble and entries; a markdown document keeps the wording below.
    if (window.mdvReviewPrompt) return window.mdvReviewPrompt(comments);

    var name = file.split('/').pop();
    var lines = ['Please address these review comments on ' + file + ':', ''];
    for (var i = 0; i < comments.length; i++) {
      var comment = comments[i];
      var where = comment.line ? name + ':' + comment.line : name;
      lines.push('- ' + where + ' — "' + comment.quote + '"');
      lines.push('  ' + comment.text.replace(/\n/g, '\n  '));
      lines.push('');
    }
    return lines.join('\n');
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

  // ---------------------------------------------------------------------------

  copy.addEventListener('click', function () {
    commitBox();
    if (!comments.length) return;
    navigator.clipboard.writeText(prompt(document.getElementById('mdv-root').dataset.file)).then(
      function () {
        flash(copy, 'Copied');
      },
      function () {
        flash(copy, 'Copy failed');
      },
    );
  });

  document.addEventListener('mousedown', function () {
    mouseDown = true;
  });
  document.addEventListener('mouseup', function () {
    mouseDown = false;
    scheduleSelection();
  });
  // Keyboard selections never see a mouseup; ignore the churn mid-drag.
  document.addEventListener('selectionchange', function () {
    if (!mouseDown) scheduleSelection();
  });
  document.addEventListener('click', function (event) {
    if (!event.target.closest('.mdv-review-box, .mdv-review-bar, mark.mdv-mark')) {
      commitBox();
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeBox();
  });

  render();

  // The article element survives a reload but its contents do not, so the
  // highlights have to be put back each time.
  window.mdvReviewReattach = reattach;
})();
