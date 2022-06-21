export default class ClickZoomHandler {
    constructor() {
        this.reset();
    }
    reset() {
        this._active = false;
    }
    dblclick(e, point) {
        e.preventDefault();
        return {
            cameraAnimation: (map) => {
                map.easeTo({
                    duration: 300,
                    zoom: map.getZoom() + (e.shiftKey ? -1 : 1),
                    around: map.unproject(point)
                }, { originalEvent: e });
            }
        };
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
//# sourceMappingURL=click_zoom.js.map