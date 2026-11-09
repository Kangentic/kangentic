// Where each annotation badge goes on the page, written as SOURCE TEXT rather
// than as compiled functions. It runs inside the guest page (embedded in
// `annotationLayerScript.ts`), and the unit test runs this same text through
// `new Function`, so the guest and the test can never run two different
// transforms of it. Plain ES2017, no imports, no closures over module scope.
//
// Every coordinate is CSS px of the whole page (document coordinates). A badge
// is placed by its CENTRE.
//
// The rules (decision 45 in docs/architecture/embedded-browser/decision-log.md):
// - An element's badge sits on its box's top-left corner.
// - A drawing's badge sits on the first point drawn. No shape is recognised, so
//   a tick, a bracket or a scribble needs no rule of its own.
// - Every badge stays 9px inside the page.
// - A drawing badge that would land on another badge or under a blocked area
//   (the floating bar) walks forward along its own points until it is clear,
//   so it stays on its ink.
// - A drawing smaller than 24px both ways would vanish under its badge, so the
//   badge sits just left of it instead.

export const ANNOTATION_LAYOUT_SOURCE = String.raw`
var KNG_BADGE_EDGE = 9;
var KNG_TINY_MARK = 24;
var KNG_BADGE_CLEARANCE = 20;

function kngStrokeBox(strokes) {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var s = 0; s < strokes.length; s++) {
    var stroke = strokes[s];
    for (var p = 0; p < stroke.length; p++) {
      var point = stroke[p];
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function kngClampBadge(x, y, pageWidth) {
  var maxX = Math.max(KNG_BADGE_EDGE, pageWidth - KNG_BADGE_EDGE);
  return {
    x: Math.max(KNG_BADGE_EDGE, Math.min(maxX, x)),
    y: Math.max(KNG_BADGE_EDGE, y),
  };
}

function kngBadgeBlocked(center, placed, blocked) {
  for (var i = 0; i < placed.length; i++) {
    var dx = placed[i].x - center.x;
    var dy = placed[i].y - center.y;
    if (dx * dx + dy * dy < KNG_BADGE_CLEARANCE * KNG_BADGE_CLEARANCE) return true;
  }
  for (var j = 0; j < blocked.length; j++) {
    var rect = blocked[j];
    if (center.x + KNG_BADGE_EDGE > rect.x && center.x - KNG_BADGE_EDGE < rect.x + rect.width
      && center.y + KNG_BADGE_EDGE > rect.y && center.y - KNG_BADGE_EDGE < rect.y + rect.height) {
      return true;
    }
  }
  return false;
}

/**
 * input: { pageWidth, blocked: [rect], items: [{ key, kind: 'element', rect }
 *          | { key, kind: 'drawing', strokes }] }
 * returns: { [key]: { x, y } } badge centres. Elements are placed first, then
 * drawings in order, each clear of every badge placed before it.
 */
function kngPlaceBadges(input) {
  var placed = [];
  var result = {};
  var blocked = input.blocked || [];
  var pageWidth = input.pageWidth;
  var items = input.items || [];
  for (var e = 0; e < items.length; e++) {
    var element = items[e];
    if (element.kind !== 'element' || !element.rect) continue;
    var elementCenter = kngClampBadge(element.rect.x, element.rect.y, pageWidth);
    placed.push(elementCenter);
    result[element.key] = elementCenter;
  }
  for (var d = 0; d < items.length; d++) {
    var drawing = items[d];
    if (drawing.kind !== 'drawing') continue;
    var box = kngStrokeBox(drawing.strokes || []);
    if (!box) continue;
    var center;
    if (box.width < KNG_TINY_MARK && box.height < KNG_TINY_MARK) {
      center = kngClampBadge(box.x - KNG_BADGE_EDGE - 2, box.y + box.height / 2, pageWidth);
    } else {
      var first = null;
      center = null;
      for (var s = 0; s < drawing.strokes.length && !center; s++) {
        var stroke = drawing.strokes[s];
        for (var p = 0; p < stroke.length; p++) {
          var candidate = kngClampBadge(stroke[p].x, stroke[p].y, pageWidth);
          if (!first) first = candidate;
          if (!kngBadgeBlocked(candidate, placed, blocked)) {
            center = candidate;
            break;
          }
        }
      }
      if (!center) center = first;
    }
    placed.push(center);
    result[drawing.key] = center;
  }
  return result;
}
`;
