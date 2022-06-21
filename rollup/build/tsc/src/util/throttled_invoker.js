/**
 * Invokes the wrapped function in a non-blocking way when trigger() is called. Invocation requests
 * are ignored until the function was actually invoked.
 *
 * @private
 */
class ThrottledInvoker {
    constructor(callback) {
        this._callback = callback;
        this._triggered = false;
        if (typeof MessageChannel !== 'undefined') {
            this._channel = new MessageChannel();
            this._channel.port2.onmessage = () => {
                this._triggered = false;
                this._callback();
            };
        }
    }
    trigger() {
        if (!this._triggered) {
            this._triggered = true;
            if (this._channel) {
                this._channel.port1.postMessage(true);
            }
            else {
                setTimeout(() => {
                    this._triggered = false;
                    this._callback();
                }, 0);
            }
        }
    }
    remove() {
        delete this._channel;
        this._callback = () => { };
    }
}
export default ThrottledInvoker;
//# sourceMappingURL=throttled_invoker.js.map