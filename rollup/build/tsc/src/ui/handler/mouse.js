import DOM from '../../util/dom';
const LEFT_BUTTON = 0;
const RIGHT_BUTTON = 2;
// the values for each button in MouseEvent.buttons
const BUTTONS_FLAGS = {
    [LEFT_BUTTON]: 1,
    [RIGHT_BUTTON]: 2
};
function buttonStillPressed(e, button) {
    const flag = BUTTONS_FLAGS[button];
    return e.buttons === undefined || (e.buttons & flag) !== flag;
}
class MouseHandler {
    constructor(options) {
        this.reset();
        this._clickTolerance = options.clickTolerance || 1;
    }
    reset() {
        this._active = false;
        this._moved = false;
        delete this._lastPoint;
        delete this._eventButton;
    }
    _correctButton(e, button) {
        return false; // implemented by child
    }
    _move(lastPoint, point) {
        return {}; // implemented by child
    }
    mousedown(e, point) {
        if (this._lastPoint)
            return;
        const eventButton = DOM.mouseButton(e);
        if (!this._correctButton(e, eventButton))
            return;
        this._lastPoint = point;
        this._eventButton = eventButton;
    }
    mousemoveWindow(e, point) {
        const lastPoint = this._lastPoint;
        if (!lastPoint)
            return;
        e.preventDefault();
        if (buttonStillPressed(e, this._eventButton)) {
            // Some browsers don't fire a `mouseup` when the mouseup occurs outside
            // the window or iframe:
            // https://github.com/mapbox/mapbox-gl-js/issues/4622
            //
            // If the button is no longer pressed during this `mousemove` it may have
            // been released outside of the window or iframe.
            this.reset();
            return;
        }
        if (!this._moved && point.dist(lastPoint) < this._clickTolerance)
            return;
        this._moved = true;
        this._lastPoint = point;
        // implemented by child class
        return this._move(lastPoint, point);
    }
    mouseupWindow(e) {
        if (!this._lastPoint)
            return;
        const eventButton = DOM.mouseButton(e);
        if (eventButton !== this._eventButton)
            return;
        if (this._moved)
            DOM.suppressClick();
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
export class MousePanHandler extends MouseHandler {
    mousedown(e, point) {
        super.mousedown(e, point);
        if (this._lastPoint)
            this._active = true;
    }
    _correctButton(e, button) {
        return button === LEFT_BUTTON && !e.ctrlKey;
    }
    _move(lastPoint, point) {
        return {
            around: point,
            panDelta: point.sub(lastPoint)
        };
    }
}
export class MouseRotateHandler extends MouseHandler {
    _correctButton(e, button) {
        return (button === LEFT_BUTTON && e.ctrlKey) || (button === RIGHT_BUTTON);
    }
    _move(lastPoint, point) {
        const degreesPerPixelMoved = 0.8;
        const bearingDelta = (point.x - lastPoint.x) * degreesPerPixelMoved;
        if (bearingDelta) {
            this._active = true;
            return { bearingDelta };
        }
    }
    contextmenu(e) {
        // prevent browser context menu when necessary; we don't allow it with rotation
        // because we can't discern rotation gesture start from contextmenu on Mac
        e.preventDefault();
    }
}
export class MousePitchHandler extends MouseHandler {
    _correctButton(e, button) {
        return (button === LEFT_BUTTON && e.ctrlKey) || (button === RIGHT_BUTTON);
    }
    _move(lastPoint, point) {
        const degreesPerPixelMoved = -0.5;
        const pitchDelta = (point.y - lastPoint.y) * degreesPerPixelMoved;
        if (pitchDelta) {
            this._active = true;
            return { pitchDelta };
        }
    }
    contextmenu(e) {
        // prevent browser context menu when necessary; we don't allow it with rotation
        // because we can't discern rotation gesture start from contextmenu on Mac
        e.preventDefault();
    }
}
//# sourceMappingURL=mouse.js.map