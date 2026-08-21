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

  /** @type {{id: string, text: string, anchor: object, quote: string, line: number|null}[]} */
  var comments = [];
  var nextId = 1;
  var pending = null;
  var selectionTimer = null;
  var mouseDown = false;

  // ---------------------------------------------------------------------------
  // Text walking
  // ---------------------------------------------------------------------------

  /** Call fn for each text node under root, stopping at the first truthy result. */
  function walkText(root, fn) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var result = fn(node);
      if (result) return result;
    }
    return null;
  }

  /** Character offset of a (node, offset) position within article.textContent. */
  function offsetOf(container, containerOffset) {
    var total = 0;
    var found = -1;
    walkText(article, function (node) {
      if (node === container) {
        found = total + containerOffset;
        return true;
      }
      total += node.textContent.length;
      return false;
    });
    return found;
  }

  // ---------------------------------------------------------------------------
  // Anchors: a Range becomes text plus its surroundings, and back again
  // ---------------------------------------------------------------------------

  function createAnchor(range) {
    var full = article.textContent;
    var exact = range.toString();
    var start = offsetOf(range.startContainer, range.startOffset);
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
  function findAnchor(anchor) {
    var full = article.textContent;
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
    return rangeOverOffsets(start, start + anchor.exact.length);
  }

  function rangeOverOffsets(start, end) {
    var seen = 0;
    var startNode = null;
    var startOffset = 0;
    var endNode = null;
    var endOffset = 0;

    walkText(article, function (node) {
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
    });

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

  // ---------------------------------------------------------------------------
  // Highlights
  // ---------------------------------------------------------------------------

  function highlight(range, id) {
    var marks = [];
    // surroundContents throws whenever the range crosses an element boundary,
    // which any selection spanning a link or a bold run does.
    try {
      var mark = newMark(id);
      range.surroundContents(mark);
      marks.push(mark);
    } catch (error) {
      marks = wrapAcrossNodes(range, id);
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
  function wrapAcrossNodes(range, id) {
    var nodes = [];
    walkText(range.commonAncestorContainer, function (node) {
      if (range.intersectsNode(node)) nodes.push(node);
      return false;
    });

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
      var range = findAnchor(comment.anchor);
      if (!range) continue;
      // The line may have moved with the edit that triggered the reload.
      var line = lineOf(range.startContainer);
      if (line) comment.line = line;
      highlight(range, comment.id);
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
    var text = selection.toString().trim();
    if (!text) return;

    var range = selection.getRangeAt(0);
    if (!article.contains(range.commonAncestorContainer)) return;

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

    pending = {
      anchor: createAnchor(range),
      quote: text,
      line: lineOf(range.startContainer),
    };

    var marks = highlight(range, null);
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
