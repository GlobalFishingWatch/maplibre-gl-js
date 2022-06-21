import Benchmark from '../lib/benchmark';
import validateStyle from '../../src/style-spec/validate_style.min';
import fetchStyle from '../lib/fetch_style';
export default class StyleValidate extends Benchmark {
    constructor(style) {
        super();
        this.style = style;
    }
    setup() {
        return fetchStyle(this.style)
            .then(json => { this.json = json; });
    }
    bench() {
        validateStyle(this.json);
    }
}
//# sourceMappingURL=style_validate.js.map