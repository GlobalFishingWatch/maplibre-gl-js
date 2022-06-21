import StyleLayer from '../style_layer';
import assert from 'assert';
import SymbolBucket from '../../data/bucket/symbol_bucket';
import resolveTokens from '../../util/resolve_tokens';
import properties from './symbol_style_layer_properties';
import { PossiblyEvaluatedPropertyValue } from '../properties';
import { isExpression, StyleExpression, ZoomConstantExpression, ZoomDependentExpression } from '../../style-spec/expression';
import { FormattedType } from '../../style-spec/expression/types';
import { typeOf } from '../../style-spec/expression/values';
import Formatted from '../../style-spec/expression/types/formatted';
import FormatSectionOverride from '../format_section_override';
import FormatExpression from '../../style-spec/expression/definitions/format';
import Literal from '../../style-spec/expression/definitions/literal';
class SymbolStyleLayer extends StyleLayer {
    constructor(layer) {
        super(layer, properties);
    }
    recalculate(parameters, availableImages) {
        super.recalculate(parameters, availableImages);
        if (this.layout.get('icon-rotation-alignment') === 'auto') {
            if (this.layout.get('symbol-placement') !== 'point') {
                this.layout._values['icon-rotation-alignment'] = 'map';
            }
            else {
                this.layout._values['icon-rotation-alignment'] = 'viewport';
            }
        }
        if (this.layout.get('text-rotation-alignment') === 'auto') {
            if (this.layout.get('symbol-placement') !== 'point') {
                this.layout._values['text-rotation-alignment'] = 'map';
            }
            else {
                this.layout._values['text-rotation-alignment'] = 'viewport';
            }
        }
        // If unspecified, `*-pitch-alignment` inherits `*-rotation-alignment`
        if (this.layout.get('text-pitch-alignment') === 'auto') {
            this.layout._values['text-pitch-alignment'] = this.layout.get('text-rotation-alignment');
        }
        if (this.layout.get('icon-pitch-alignment') === 'auto') {
            this.layout._values['icon-pitch-alignment'] = this.layout.get('icon-rotation-alignment');
        }
        if (this.layout.get('symbol-placement') === 'point') {
            const writingModes = this.layout.get('text-writing-mode');
            if (writingModes) {
                // remove duplicates, preserving order
                const deduped = [];
                for (const m of writingModes) {
                    if (deduped.indexOf(m) < 0)
                        deduped.push(m);
                }
                this.layout._values['text-writing-mode'] = deduped;
            }
            else {
                this.layout._values['text-writing-mode'] = ['horizontal'];
            }
        }
        this._setPaintOverrides();
    }
    getValueAndResolveTokens(name, feature, canonical, availableImages) {
        const value = this.layout.get(name).evaluate(feature, {}, canonical, availableImages);
        const unevaluated = this._unevaluatedLayout._values[name];
        if (!unevaluated.isDataDriven() && !isExpression(unevaluated.value) && value) {
            return resolveTokens(feature.properties, value);
        }
        return value;
    }
    createBucket(parameters) {
        return new SymbolBucket(parameters);
    }
    queryRadius() {
        return 0;
    }
    queryIntersectsFeature() {
        assert(false); // Should take a different path in FeatureIndex
        return false;
    }
    _setPaintOverrides() {
        for (const overridable of properties.paint.overridableProperties) {
            if (!SymbolStyleLayer.hasPaintOverride(this.layout, overridable)) {
                continue;
            }
            const overriden = this.paint.get(overridable);
            const override = new FormatSectionOverride(overriden);
            const styleExpression = new StyleExpression(override, overriden.property.specification);
            let expression = null;
            if (overriden.value.kind === 'constant' || overriden.value.kind === 'source') {
                expression = new ZoomConstantExpression('source', styleExpression);
            }
            else {
                expression = new ZoomDependentExpression('composite', styleExpression, overriden.value.zoomStops, overriden.value._interpolationType);
            }
            this.paint._values[overridable] = new PossiblyEvaluatedPropertyValue(overriden.property, expression, overriden.parameters);
        }
    }
    _handleOverridablePaintPropertyUpdate(name, oldValue, newValue) {
        if (!this.layout || oldValue.isDataDriven() || newValue.isDataDriven()) {
            return false;
        }
        return SymbolStyleLayer.hasPaintOverride(this.layout, name);
    }
    static hasPaintOverride(layout, propertyName) {
        const textField = layout.get('text-field');
        const property = properties.paint.properties[propertyName];
        let hasOverrides = false;
        const checkSections = (sections) => {
            for (const section of sections) {
                if (property.overrides && property.overrides.hasOverride(section)) {
                    hasOverrides = true;
                    return;
                }
            }
        };
        if (textField.value.kind === 'constant' && textField.value.value instanceof Formatted) {
            checkSections(textField.value.value.sections);
        }
        else if (textField.value.kind === 'source') {
            const checkExpression = (expression) => {
                if (hasOverrides)
                    return;
                if (expression instanceof Literal && typeOf(expression.value) === FormattedType) {
                    const formatted = expression.value;
                    checkSections(formatted.sections);
                }
                else if (expression instanceof FormatExpression) {
                    checkSections(expression.sections);
                }
                else {
                    expression.eachChild(checkExpression);
                }
            };
            const expr = textField.value;
            if (expr._styleExpression) {
                checkExpression(expr._styleExpression.expression);
            }
        }
        return hasOverrides;
    }
}
export function getOverlapMode(layout, overlapProp, allowOverlapProp) {
    let result = 'never';
    const overlap = layout.get(overlapProp);
    if (overlap) {
        // if -overlap is set, use it
        result = overlap;
    }
    else if (layout.get(allowOverlapProp)) {
        // fall back to -allow-overlap, with false='never', true='always'
        result = 'always';
    }
    return result;
}
export default SymbolStyleLayer;
//# sourceMappingURL=symbol_style_layer.js.map