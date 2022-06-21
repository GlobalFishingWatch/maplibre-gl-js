import { Event } from '../util/evented';
import DOM from '../util/dom';
import Point from '@mapbox/point-geometry';
import { extend } from '../util/util';
/**
 * `MapMouseEvent` is the event type for mouse-related map events.
 * @extends {Event}
 * @example
 * // The `click` event is an example of a `MapMouseEvent`.
 * // Set up an event listener on the map.
 * map.on('click', function(e) {
 *   // The event object (e) contains information like the
 *   // coordinates of the point on the map that was clicked.
 *   console.log('A click event has occurred at ' + e.lngLat);
 * });
 */
export class MapMouseEvent extends Event {
    /**
     * @private
     */
    constructor(type, map, originalEvent, data = {}) {
        const point = DOM.mousePos(map.getCanvasContainer(), originalEvent);
        const lngLat = map.unproject(point);
        super(type, extend({ point, lngLat, originalEvent }, data));
        this._defaultPrevented = false;
        this.target = map;
    }
    /**
     * Prevents subsequent default processing of the event by the map.
     *
     * Calling this method will prevent the following default map behaviors:
     *
     *   * On `mousedown` events, the behavior of {@link DragPanHandler}
     *   * On `mousedown` events, the behavior of {@link DragRotateHandler}
     *   * On `mousedown` events, the behavior of {@link BoxZoomHandler}
     *   * On `dblclick` events, the behavior of {@link DoubleClickZoomHandler}
     *
     */
    preventDefault() {
        this._defaultPrevented = true;
    }
    /**
     * `true` if `preventDefault` has been called.
     * @private
     */
    get defaultPrevented() {
        return this._defaultPrevented;
    }
}
/**
 * `MapTouchEvent` is the event type for touch-related map events.
 * @extends {Event}
 */
export class MapTouchEvent extends Event {
    /**
     * @private
     */
    constructor(type, map, originalEvent) {
        const touches = type === 'touchend' ? originalEvent.changedTouches : originalEvent.touches;
        const points = DOM.touchPos(map.getCanvasContainer(), touches);
        const lngLats = points.map((t) => map.unproject(t));
        const point = points.reduce((prev, curr, i, arr) => {
            return prev.add(curr.div(arr.length));
        }, new Point(0, 0));
        const lngLat = map.unproject(point);
        super(type, { points, point, lngLats, lngLat, originalEvent });
        this._defaultPrevented = false;
    }
    /**
     * Prevents subsequent default processing of the event by the map.
     *
     * Calling this method will prevent the following default map behaviors:
     *
     *   * On `touchstart` events, the behavior of {@link DragPanHandler}
     *   * On `touchstart` events, the behavior of {@link TouchZoomRotateHandler}
     *
     */
    preventDefault() {
        this._defaultPrevented = true;
    }
    /**
     * `true` if `preventDefault` has been called.
     * @private
     */
    get defaultPrevented() {
        return this._defaultPrevented;
    }
}
/**
 * `MapWheelEvent` is the event type for the `wheel` map event.
 * @extends {Object}
 */
export class MapWheelEvent extends Event {
    /**
     * @private
     */
    constructor(type, map, originalEvent) {
        super(type, { originalEvent });
        this._defaultPrevented = false;
    }
    /**
     * Prevents subsequent default processing of the event by the map.
     *
     * Calling this method will prevent the the behavior of {@link ScrollZoomHandler}.
     */
    preventDefault() {
        this._defaultPrevented = true;
    }
    /**
     * `true` if `preventDefault` has been called.
     * @private
     */
    get defaultPrevented() {
        return this._defaultPrevented;
    }
}
//# sourceMappingURL=events.js.map