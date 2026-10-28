import { i18n } from '@lingui/core';
import { msg, select } from '@lingui/core/runtime-macro';
import type { AriaLabelConfig } from '@xyflow/react';

/**
 * The hidden screen-reader text React Flow draws for the canvas, in the
 * session's language. The English is React Flow's own (`defaultAriaLabelConfig`)
 * except the node description: the canvas sets `deleteKeyCode={null}`, so the
 * Delete key does nothing and the description no longer says it removes a node.
 *
 * Only the keys the canvas renders are set: node descriptions, the live move
 * message and the port label. The canvas draws no controls, minimap or focusable
 * edges. Built when the canvas renders, after the session's catalog loads; the
 * live move message resolves each time a card is nudged with an arrow key.
 */
export function buildWorkflowAriaLabelConfig(): Partial<AriaLabelConfig> {
  return {
    'node.a11yDescription.default': i18n._(msg`Press enter or space to select a node. Press escape to cancel.`),
    'node.a11yDescription.keyboardDisabled': i18n._(
      msg`Press enter or space to select a node. You can then use the arrow keys to move the node around. Press escape to cancel.`,
    ),
    'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) => i18n._(
      msg`Moved selected node ${select({ direction }, { left: 'left', right: 'right', up: 'up', down: 'down', other: '' })}. New position, x: ${{ x }}, y: ${{ y }}`,
    ),
    'handle.ariaLabel': i18n._(msg({ message: 'Handle', context: 'canvas link port' })),
  };
}
