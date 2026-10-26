/**
 * Sensor options for the dnd-kit `useSensor` calls, as module constants.
 *
 * dnd-kit memoizes `useSensor` on the options object's identity, and `useSensors` on the
 * sensors it returns. An inline literal is a new object on every render, so every render
 * of a component that owns a `DndContext` built new sensors, then new activators, then a
 * new internal context value, and every `useSortable` under it re-rendered past its
 * `React.memo`. On the board that was every card and every column on every board reload:
 * one agent's update to one task re-rendered 378 components in a 25 to 29 ms commit (dev).
 * `tests/unit/dnd-sensor-options.test.ts` fails an inline literal.
 */
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

/** A pointer drag starts after 5 px of travel, so a click on a sortable stays a click. */
export const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } };

/** Arrow keys move a lifted item to the next sortable slot. */
export const KEYBOARD_SENSOR_OPTIONS = { coordinateGetter: sortableKeyboardCoordinates };
