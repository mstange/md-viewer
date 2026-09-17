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
   * The range, with its endpoints moved onto the text it covers.
   *
   * A selection's own endpoints need not sit on any of the text it selects. A
   * drag released at the start of a line ends on the row above it, and one
   * begun from the left of a line can start on the blank line above, which has
   * no text in it at all. Everything a comment records is read off those
   * endpoints — which column it was written in, its line, and the lines it is
   * reported to cover — so a comment on the last two lines of a commit message
   * came back as three lines quoted from "".
   *
   * Asides are skipped here as they are everywhere else, so an endpoint lands
   * on text the reader was reading and not on a gutter's line number.
   */
  function tighten(range) {
    var first = null;
    var last = null;
    walkText(walkRoot(range), function (node) {
      if (!range.intersectsNode(node)) return false;
      var from = node === range.startContainer ? range.startOffset : 0;
      var to = node === range.endContainer ? range.endOffset : node.textContent.length;
      var text = node.textContent.slice(from, to);
      var lead = text.search(/\S/);
      // A line the selection only reaches the whitespace of is not a line it
      // is about, so the endpoints pass it by.
      if (lead === -1) return false;
      if (!first) first = { node: node, offset: from + lead };
      last = { node: node, offset: from + text.replace(/\s+$/, '').length };
      return false;
    });
    if (!first) return range;
    var tightened = document.createRange();
    tightened.setStart(first.node, first.offset);
    tightened.setEnd(last.node, last.offset);
    return tightened;
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
    if (!box) return;
    // The box may have left a listener waiting for the reader to start typing.
    if (box.mdvStopAwaitingTyping) box.mdvStopAwaitingTyping();
    box.remove();
  }

  /**
   * Drop the open box and, if it was a comment being written rather than one
   * being edited, the highlight it was about. Escape reaches here from the
   * document as well as the textarea, since a box opened by a selection does
   * not hold the focus until the reader types.
   */
  function cancelBox() {
    var box = document.querySelector('.mdv-review-box');
    if (!box) return;
    if (!box.dataset.commentId) discardPending();
    closeBox();
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

  function openBox(anchorElement, id, keepSelection) {
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
        cancelBox();
      }
    });
    // Focusing a text control collapses the document selection into it, which
    // would take back the words the reader just selected. A box opened by a
    // fresh selection waits instead: typing moves the focus in, so the reader
    // can copy the passage or write about it without choosing up front.
    if (keepSelection) awaitTyping(box, textarea);
    else textarea.focus();
  }

  /**
   * True for the keystroke that pastes: Cmd+V or Ctrl+V, whichever this
   * platform means by it. Both are accepted rather than sniffing the platform,
   * because no platform binds either one to something that is not a paste.
   *
   * Ctrl+Alt is refused, since that is how a Windows keyboard writes AltGr: on
   * a layout where AltGr+V is a letter, it is a letter. Cmd+Alt+V is a paste
   * (the mac's paste-and-match-style), so Alt only disqualifies the Ctrl form.
   */
  function isPaste(event) {
    if (event.key !== 'v' && event.key !== 'V') return false;
    if (event.metaKey) return true;
    return event.ctrlKey && !event.altKey;
  }

  /**
   * Hand the box the focus at the first keystroke meant for it. Until then the
   * selection stays with the document, so the reader can still copy it.
   *
   * The keydown is not consumed: focusing during it moves the textarea into
   * place before the keystroke is acted on, so the letter that started the
   * typing — or the text a Cmd+V is about to paste — arrives on its own and
   * nothing has to be replayed.
   */
  function awaitTyping(box, textarea) {
    function stop() {
      box.mdvStopAwaitingTyping = null;
      document.removeEventListener('keydown', onKeyDown, true);
    }
    function onKeyDown(event) {
      if (document.activeElement === textarea) return;
      if (event.metaKey || event.ctrlKey || event.altKey) {
        // A shortcut belongs to the browser, and copying the selection is the
        // whole reason the focus is still out here — except paste, which says
        // the reader is writing just as plainly as a letter does, and which has
        // nowhere to go while the focus is still on the document.
        if (!isPaste(event)) return;
      } else if (event.key.length !== 1) {
        // Escape and the arrows are handled elsewhere, and Enter on an empty
        // box would mean nothing; a character is what says the reader is
        // writing.
        return;
      }
      stop();
      textarea.focus();
    }
    // Closing the box takes the listener with it, so selecting many passages
    // in turn does not leave one behind for each.
    box.mdvStopAwaitingTyping = stop;
    document.addEventListener('keydown', onKeyDown, true);
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
    // A page that embeds this one — stack-viewer shows one of these per commit
    // — keeps a count of its own beside each, and this is how it hears of a
    // change. The count is on the event rather than read out of the bar, so
    // the bar's wording is nobody's interface.
    document.dispatchEvent(new CustomEvent('mdv-review-change', { detail: { count: total } }));
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
    // Highlighting puts the selection back over the marks it just made, which
    // fires selectionchange again. Recognising our own handiwork stops it here
    // rather than discarding the pending comment and wrapping it a second time.
    if (isPendingSelection(range)) return;

    discardPending();
    // Unwrapping the old provisional mark rebuilt the text nodes the selection
    // pointed into, so take the selection again before trusting it.
    selection = window.getSelection();
    if (!selection.rangeCount || !selection.toString().trim()) return;
    // Tightened before anything is read off it. The line a comment reports and
    // the lines it covers are read off the endpoints, and the column it means
    // is read off where it starts, so all three want endpoints that are on the
    // text: a drag begun on the blank line above says nothing about any of it.
    range = tighten(selection.getRangeAt(0));
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
    closeBox();
    if (marks.length) openBox(marks[0], null, true);
    // After the box, not before, so that anything it does to the focus has
    // already happened by the time the selection goes back.
    reselect(selection, marks);
  }

  /** Does the range cover exactly the marks the last selection produced? */
  function isPendingSelection(range) {
    var marks = article.querySelectorAll('mark.mdv-mark-pending');
    if (!marks.length) return false;
    var test = document.createRange();
    test.setStartBefore(marks[0]);
    test.setEndAfter(marks[marks.length - 1]);
    return (
      range.compareBoundaryPoints(Range.START_TO_START, test) === 0 &&
      range.compareBoundaryPoints(Range.END_TO_END, test) === 0
    );
  }

  /**
   * Wrapping the text in marks rebuilt the nodes the selection pointed into,
   * which leaves it anchored to text that is no longer in the document. Put it
   * back over the marks so the reader can still copy what they just selected.
   */
  function reselect(selection, marks) {
    selection.removeAllRanges();
    if (!marks.length) return;
    var range = document.createRange();
    range.setStartBefore(marks[0]);
    range.setEndAfter(marks[marks.length - 1]);
    selection.addRange(range);
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
    if (event.key === 'Escape') cancelBox();
  });

  render();

  // The article element survives a reload but its contents do not, so the
  // highlights have to be put back each time.
  window.mdvReviewReattach = reattach;

  /**
   * The comments so far, for a page that embeds this one and copies several
   * reviews out at once. Asking saves whatever is being written first, as the
   * copy button does: the click that asks lands in the embedding page, so this
   * document's own listener never sees it.
   */
  window.mdvReviewComments = function () {
    commitBox();
    return comments.slice();
  };
})();
