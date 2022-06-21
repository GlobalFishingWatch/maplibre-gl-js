import Point from '@mapbox/point-geometry';
import { indexTouches } from './handler_util';
function getCentroid(points) {
    const sum = new Point(0, 0);
    for (const point of points) {
        sum._add(point);
    }
    return sum.div(points.length);
}
export const MAX_TAP_INTERVAL = 500;
const MAX_TOUCH_TIME = 500;
const MAX_DIST = 30;
export class SingleTapRecognizer {
    constructor(options) {
        this.reset();
        this.numTouches = options.numTouches;
    }
    reset() {
        delete this.centroid;
        delete this.startTime;
        delete this.touches;
        this.aborted = false;
    }
    touchstart(e, points, mapTouches) {
        if (this.centroid || mapTouches.length > this.numTouches) {
            this.aborted = true;
        }
        if (this.aborted) {
            return;
        }
        if (this.startTime === undefined) {
            this.startTime = e.timeStamp;
        }
        if (mapTouches.length === this.numTouches) {
            this.centroid = getCentroid(points);
            this.touches = indexTouches(mapTouches, points);
        }
    }
    touchmove(e, points, mapTouches) {
        if (this.aborted || !this.centroid)
            return;
        const newTouches = indexTouches(mapTouches, points);
        for (const id in this.touches) {
            const prevPos = this.touches[id];
            const pos = newTouches[id];
            if (!pos || pos.dist(prevPos) > MAX_DIST) {
                this.aborted = true;
            }
        }
    }
    touchend(e, points, mapTouches) {
        if (!this.centroid || e.timeStamp - this.startTime > MAX_TOUCH_TIME) {
            this.aborted = true;
        }
        if (mapTouches.length === 0) {
            const centroid = !this.aborted && this.centroid;
            this.reset();
            if (centroid)
                return centroid;
        }
    }
}
export class TapRecognizer {
    constructor(options) {
        this.singleTap = new SingleTapRecognizer(options);
        this.numTaps = options.numTaps;
        this.reset();
    }
    reset() {
        this.lastTime = Infinity;
        delete this.lastTap;
        this.count = 0;
        this.singleTap.reset();
    }
    touchstart(e, points, mapTouches) {
        this.singleTap.touchstart(e, points, mapTouches);
    }
    touchmove(e, points, mapTouches) {
        this.singleTap.touchmove(e, points, mapTouches);
    }
    touchend(e, points, mapTouches) {
        const tap = this.singleTap.touchend(e, points, mapTouches);
        if (tap) {
            const soonEnough = e.timeStamp - this.lastTime < MAX_TAP_INTERVAL;
            const closeEnough = !this.lastTap || this.lastTap.dist(tap) < MAX_DIST;
            if (!soonEnough || !closeEnough) {
                this.reset();
            }
            this.count++;
            this.lastTime = e.timeStamp;
            this.lastTap = tap;
            if (this.count === this.numTaps) {
                this.reset();
                return tap;
            }
        }
    }
}
//# sourceMappingURL=tap_recognizer.js.map