import assert from 'assert';
import { NullType } from '../style-spec/expression/types';
import { register } from '../util/web_worker_transfer';
// This is an internal expression class. It is only used in GL JS and
// has GL JS dependencies which can break the standalone style-spec module
export default class FormatSectionOverride {
    constructor(defaultValue) {
        assert(defaultValue.property.overrides !== undefined);
        this.type = defaultValue.property.overrides ? defaultValue.property.overrides.runtimeType : NullType;
        this.defaultValue = defaultValue;
    }
    evaluate(ctx) {
        if (ctx.formattedSection) {
            const overrides = this.defaultValue.property.overrides;
            if (overrides && overrides.hasOverride(ctx.formattedSection)) {
                return overrides.getOverride(ctx.formattedSection);
            }
        }
        if (ctx.feature && ctx.featureState) {
            return this.defaultValue.evaluate(ctx.feature, ctx.featureState);
        }
        return this.defaultValue.property.specification.default;
    }
    eachChild(fn) {
        if (!this.defaultValue.isConstant()) {
            const expr = this.defaultValue.value;
            fn(expr._styleExpression.expression);
        }
    }
    // Cannot be statically evaluated, as the output depends on the evaluation context.
    outputDefined() {
        return false;
    }
    serialize() {
        return null;
    }
}
register('FormatSectionOverride', FormatSectionOverride, { omit: ['defaultValue'] });
//# sourceMappingURL=format_section_override.js.map