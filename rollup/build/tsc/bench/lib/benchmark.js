var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
// According to https://developer.mozilla.org/en-US/docs/Web/API/Performance/now,
// performance.now() should be accurate to 0.005ms. Set the minimum running
// time for a single measurement at 5ms, so that the error due to timer
// precision is < 0.1%.
const minTimeForMeasurement = 0.005 * 1000;
class Benchmark {
    /**
     * The `setup` method is intended to be overridden by subclasses. It will be called once, prior to
     * running any benchmark iterations, and may set state on `this` which the benchmark later accesses.
     * If the setup involves an asynchronous step, `setup` may return a promise.
     */
    setup() { }
    /**
     * The `bench` method is intended to be overridden by subclasses. It should contain the code to be
     * benchmarked. It may access state on `this` set by the `setup` function (but should not modify this
     * state). It will be called multiple times, the total number to be determined by the harness. If
     * the benchmark involves an asynchronous step, `bench` may return a promise.
     */
    bench() { }
    /**
     * The `teardown` method is intended to be overridden by subclasses. It will be called once, after
     * running all benchmark iterations, and may perform any necessary cleanup. If cleaning up involves
     * an asynchronous step, `teardown` may return a promise.
     */
    teardown() { }
    /**
     * Run the benchmark by executing `setup` once, sampling the execution time of `bench` some number of
     * times, and then executing `teardown`. Yields an array of execution times.
     */
    run() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.setup();
                return this._begin();
            }
            catch (e) {
                // The bench run will break here but should at least provide helpful information:
                console.error(e);
            }
        });
    }
    _done() {
        // 210 samples => 20 observations for regression
        return this._elapsed >= 500 && this._measurements.length > 210;
    }
    _begin() {
        this._measurements = [];
        this._elapsed = 0;
        this._iterationsPerMeasurement = 1;
        this._start = performance.now();
        const bench = this.bench();
        if (bench instanceof Promise) {
            return bench.then(() => this._measureAsync());
        }
        else {
            return this._measureSync();
        }
    }
    _measureSync() {
        // Avoid Promise overhead for sync benchmarks.
        while (true) {
            const time = performance.now() - this._start;
            this._elapsed += time;
            if (time < minTimeForMeasurement) {
                this._iterationsPerMeasurement++;
            }
            else {
                this._measurements.push({ time, iterations: this._iterationsPerMeasurement });
            }
            if (this._done()) {
                return this._end();
            }
            this._start = performance.now();
            for (let i = this._iterationsPerMeasurement; i > 0; --i) {
                this.bench();
            }
        }
    }
    _measureAsync() {
        const time = performance.now() - this._start;
        this._elapsed += time;
        if (time < minTimeForMeasurement) {
            this._iterationsPerMeasurement++;
        }
        else {
            this._measurements.push({ time, iterations: this._iterationsPerMeasurement });
        }
        if (this._done()) {
            return this._end();
        }
        this._start = performance.now();
        return this._runAsync(this._iterationsPerMeasurement).then(() => this._measureAsync());
    }
    _runAsync(n) {
        const bench = this.bench();
        if (n === 1) {
            return bench;
        }
        else {
            return bench.then(() => this._runAsync(n - 1));
        }
    }
    _end() {
        return Promise.resolve(this.teardown()).then(() => this._measurements);
    }
}
export default Benchmark;
//# sourceMappingURL=benchmark.js.map