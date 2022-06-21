import { TapRecognizer, MAX_TAP_INTERVAL } from './tap_recognizer';
export default class TapDragZoomHandler {
    constructor() {
        this._tap = new TapRecognizer({
            numTouches: 1,
            numTaps: 1
        });
        this.reset();
    }
    reset() {
        this._active = false;
        delete this._swipePoint;
        delete this._swipeTouch;
        delete this._tapTime;
        this._tap.reset();
    }
    touchstart(e, points, mapTouches) {
        if (this._swipePoint)
            return;
        if (this._tapTime && e.timeStamp - this._tapTime > MAX_TAP_INTERVAL) {
            this.reset();
        }
        if (!this._tapTime) {
            this._tap.touchstart(e, points, mapTouches);
        }
        else if (mapTouches.length > 0) {
            this._swipePoint = points[0];
            this._swipeTouch = mapTouches[0].identifier;
        }
    }
    touchmove(e, points, mapTouches) {
        if (!this._tapTime) {
            this._tap.touchmove(e, points, mapTouches);
        }
        else if (this._swipePoint) {
            if (mapTouches[0].identifier !== this._swipeTouch) {
                return;
            }
            const newSwipePoint = points[0];
            const dist = newSwipePoint.y - this._swipePoint.y;
            this._swipePoint = newSwipePoint;
            e.preventDefault();
            this._active = true;
            return {
                zoomDelta: dist / 128
            };
        }
    }
    touchend(e, points, mapTouches) {
        if (!this._tapTime) {
            const point = this._tap.touchend(e, points, mapTouches);
            if (point) {
                this._tapTime = e.timeStamp;
            }
        }
        else if (this._swipePoint) {
            if (mapTouches.length === 0) {
                this.reset();
            }
        }
    }
    touchcancel() {
        this.reset();
    }
    enable() {
        this._enabled = true;
    }
    disable() {
        this._enabled = false;
        this.reset();
    }
    isEnabled() {
        return this._enabled;
    }
    isActive() {
        return this._active;
    }
}
//# sourceMappingURL=tap_drag_zoom.js.map