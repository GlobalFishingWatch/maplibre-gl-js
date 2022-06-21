import { TapRecognizer } from './tap_recognizer';
export default class TapZoomHandler {
    constructor() {
        this._zoomIn = new TapRecognizer({
            numTouches: 1,
            numTaps: 2
        });
        this._zoomOut = new TapRecognizer({
            numTouches: 2,
            numTaps: 1
        });
        this.reset();
    }
    reset() {
        this._active = false;
        this._zoomIn.reset();
        this._zoomOut.reset();
    }
    touchstart(e, points, mapTouches) {
        this._zoomIn.touchstart(e, points, mapTouches);
        this._zoomOut.touchstart(e, points, mapTouches);
    }
    touchmove(e, points, mapTouches) {
        this._zoomIn.touchmove(e, points, mapTouches);
        this._zoomOut.touchmove(e, points, mapTouches);
    }
    touchend(e, points, mapTouches) {
        const zoomInPoint = this._zoomIn.touchend(e, points, mapTouches);
        const zoomOutPoint = this._zoomOut.touchend(e, points, mapTouches);
        if (zoomInPoint) {
            this._active = true;
            e.preventDefault();
            setTimeout(() => this.reset(), 0);
            return {
                cameraAnimation: (map) => map.easeTo({
                    duration: 300,
                    zoom: map.getZoom() + 1,
                    around: map.unproject(zoomInPoint)
                }, { originalEvent: e })
            };
        }
        else if (zoomOutPoint) {
            this._active = true;
            e.preventDefault();
            setTimeout(() => this.reset(), 0);
            return {
                cameraAnimation: (map) => map.easeTo({
                    duration: 300,
                    zoom: map.getZoom() - 1,
                    around: map.unproject(zoomOutPoint)
                }, { originalEvent: e })
            };
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
//# sourceMappingURL=tap_zoom.js.map