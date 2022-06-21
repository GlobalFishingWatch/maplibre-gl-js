import ZoomHistory from './zoom_history';
import { isStringInSupportedScript } from '../util/script_detection';
import { plugin as rtlTextPlugin } from '../source/rtl_text_plugin';
class EvaluationParameters {
    // "options" may also be another EvaluationParameters to copy, see CrossFadedProperty.possiblyEvaluate
    constructor(zoom, options) {
        this.zoom = zoom;
        if (options) {
            this.now = options.now;
            this.fadeDuration = options.fadeDuration;
            this.zoomHistory = options.zoomHistory;
            this.transition = options.transition;
        }
        else {
            this.now = 0;
            this.fadeDuration = 0;
            this.zoomHistory = new ZoomHistory();
            this.transition = {};
        }
    }
    isSupportedScript(str) {
        return isStringInSupportedScript(str, rtlTextPlugin.isLoaded());
    }
    crossFadingFactor() {
        if (this.fadeDuration === 0) {
            return 1;
        }
        else {
            return Math.min((this.now - this.zoomHistory.lastIntegerZoomTime) / this.fadeDuration, 1);
        }
    }
    getCrossfadeParameters() {
        const z = this.zoom;
        const fraction = z - Math.floor(z);
        const t = this.crossFadingFactor();
        return z > this.zoomHistory.lastIntegerZoom ?
            { fromScale: 2, toScale: 1, t: fraction + (1 - fraction) * t } :
            { fromScale: 0.5, toScale: 1, t: 1 - (1 - t) * fraction };
    }
}
export default EvaluationParameters;
//# sourceMappingURL=evaluation_parameters.js.map