// When Rollup builds the main bundle this file is replaced with ./build/web_worker_replacement.js
// See package.json 'browser' field and rollup documentation.
// This file is intended for use in the GL-JS test suite when they run on node since node doesn't support workers.
// It implements a MessageBus main thread interface
import MaplibreWorker from '../source/worker';
class MessageBus {
    constructor(addListeners, postListeners) {
        this.addListeners = addListeners;
        this.postListeners = postListeners;
    }
    addEventListener(event, callback) {
        if (event === 'message') {
            this.addListeners.push(callback);
        }
    }
    removeEventListener(event, callback) {
        const i = this.addListeners.indexOf(callback);
        if (i >= 0) {
            this.addListeners.splice(i, 1);
        }
    }
    postMessage(data) {
        setTimeout(() => {
            try {
                for (const listener of this.postListeners) {
                    listener({ data, target: this.target });
                }
            }
            catch (e) {
                console.error(e);
            }
        }, 0);
    }
    terminate() {
        this.addListeners.splice(0, this.addListeners.length);
        this.postListeners.splice(0, this.postListeners.length);
    }
    importScripts() { }
}
export default function workerFactory() {
    const parentListeners = [], workerListeners = [], parentBus = new MessageBus(workerListeners, parentListeners), workerBus = new MessageBus(parentListeners, workerListeners);
    parentBus.target = workerBus;
    workerBus.target = parentBus;
    new workerFactory.Worker(workerBus);
    return parentBus;
}
// expose to allow stubbing in unit tests
workerFactory.Worker = MaplibreWorker;
//# sourceMappingURL=web_worker.js.map