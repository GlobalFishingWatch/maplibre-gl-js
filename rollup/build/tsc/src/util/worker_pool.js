import webWorkerFactory from './web_worker';
import browser from './browser';
export const PRELOAD_POOL_ID = 'mapboxgl_preloaded_worker_pool';
/**
 * Constructs a worker pool.
 * @private
 */
export default class WorkerPool {
    constructor() {
        this.active = {};
    }
    acquire(mapId) {
        if (!this.workers) {
            // Lazily look up the value of mapboxgl.workerCount so that
            // client code has had a chance to set it.
            this.workers = [];
            while (this.workers.length < WorkerPool.workerCount) {
                this.workers.push(webWorkerFactory());
            }
        }
        this.active[mapId] = true;
        return this.workers.slice();
    }
    release(mapId) {
        delete this.active[mapId];
        if (this.numActive() === 0) {
            this.workers.forEach((w) => {
                w.terminate();
            });
            this.workers = null;
        }
    }
    isPreloaded() {
        return !!this.active[PRELOAD_POOL_ID];
    }
    numActive() {
        return Object.keys(this.active).length;
    }
}
const availableLogicalProcessors = Math.floor(browser.hardwareConcurrency / 2);
WorkerPool.workerCount = Math.max(Math.min(availableLogicalProcessors, 6), 1);
//# sourceMappingURL=worker_pool.js.map